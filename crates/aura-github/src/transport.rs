//! HTTPS to GitHub's API, signed in with gh's token. One client serves the daemon: it keeps
//! the token, ETags, rate-limit budgets and login state that every loop shares.
use crate::{Github, Memo, Notified, RejectedRequest};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;

/// Concurrent requests across the daemon. GitHub's secondary rate limit punishes
/// bursts, and a refresh fans out over every listed PR.
const MAX_CONCURRENT: usize = 4;
/// How long GitHub is left alone after a rate limit that names no wait; its docs ask for at least a minute.
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(60);
/// Waits before retrying a read that failed with a GitHub server error.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(5)];
/// gh's token is read again after this long, so `gh auth switch` and a new login are noticed.
const TOKEN_TTL: Duration = Duration::from_secs(60);
/// While signed out, how often gh is asked for a new token. Reading it costs no request.
const SIGNED_OUT_TOKEN_TTL: Duration = Duration::from_secs(15);
/// A token GitHub refused is tried again after this long, in case the refusal passed.
const LOGIN_RECHECK: Duration = Duration::from_secs(10 * 60);
pub const LOGIN_EXPIRED: &str =
    "GitHub login expired. Run `gh auth login`; Aura reconnects by itself.";
const NO_GH: &str = "Install GitHub CLI and run `gh auth login` to connect pull requests.";
/// Answers kept for conditional requests; a 304 does not count against the rate limit.
const CACHE_ENTRIES: usize = 256;
const CACHE_BODY_LIMIT: usize = 2 << 20;
/// Recent notifications, read as a hint of which PRs changed.
const NOTIFICATIONS: &str = "notifications?all=true&per_page=50";
const NOTIFICATIONS_PAGE: usize = 50;
/// Without notifications (a token lacking the scope), they are not asked for again for this long.
const NOTIFICATIONS_OFF: Duration = Duration::from_secs(60 * 60);

/// What is left of one rate limit (`core`, `graphql`, `search`, …) until `reset` (Unix seconds).
#[derive(Debug, Clone, PartialEq)]
pub struct Budget {
    pub resource: String,
    pub limit: u64,
    pub remaining: u64,
    pub reset: u64,
}

/// How long to wait between polls meant to run every `base`: slower as the core and GraphQL
/// budgets run low, and until the reset once one is spent.
pub fn pace(base: Duration, budgets: &[Budget], now: u64) -> Duration {
    budgets
        .iter()
        .filter(|b| matches!(b.resource.as_str(), "core" | "graphql"))
        .filter(|b| b.reset > now && b.limit > 0)
        .map(|b| {
            let left = b.remaining as f64 / b.limit as f64;
            match left {
                _ if b.remaining == 0 => Duration::from_secs(b.reset - now).max(base),
                l if l < 0.1 => base * 8,
                l if l < 0.25 => base * 4,
                l if l < 0.5 => base * 2,
                _ => base,
            }
        })
        .max()
        .unwrap_or(base)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn clock(at: Instant) -> String {
    let left = at.saturating_duration_since(Instant::now());
    (chrono::Local::now() + left).format("%H:%M:%S").to_string()
}

/// GitHub refused for a rate limit. `wait` is what it asked for; `resource_only` when one
/// budget ran out, which the budgets already hold back, rather than a secondary limit.
#[derive(Debug)]
pub struct RateLimited {
    pub message: String,
    pub wait: Option<Duration>,
    pub resource_only: bool,
}
impl std::fmt::Display for RateLimited {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RateLimited {}

/// GitHub refused the credentials (HTTP 401).
#[derive(Debug)]
struct Unauthorized(String);
impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Unauthorized {}

/// Whether GitHub surely did not act on a request: it refused it, or it was never sent.
pub fn rejected(e: &anyhow::Error) -> bool {
    e.downcast_ref::<RejectedRequest>().is_some() || e.downcast_ref::<RateLimited>().is_some()
}

/// Paces every request. Shared by all [`GhCli`]s, since they spend one account's limits.
pub(crate) struct Gate {
    slots: tokio::sync::Semaphore,
    paused_until: std::sync::Mutex<Option<Instant>>,
    pause: Duration,
    retry_delays: &'static [Duration],
    budgets: std::sync::Mutex<Vec<Budget>>,
}
static GATE: Gate = Gate::new(MAX_CONCURRENT, RATE_LIMIT_PAUSE, &RETRY_DELAYS);

impl Gate {
    pub(crate) const fn new(
        slots: usize,
        pause: Duration,
        retry_delays: &'static [Duration],
    ) -> Self {
        Self {
            slots: tokio::sync::Semaphore::const_new(slots),
            paused_until: std::sync::Mutex::new(None),
            pause,
            retry_delays,
            budgets: std::sync::Mutex::new(vec![]),
        }
    }

    /// Why requests are refused unsent right now: a rate limit's pause.
    fn paused(&self) -> Option<String> {
        let until = (*self.paused_until.lock().unwrap())?;
        (until > Instant::now()).then(|| {
            format!(
                "GitHub rate limit reached; Aura resumes GitHub requests at {}",
                clock(until)
            )
        })
    }

    fn pause_for(&self, wait: Duration) {
        let until = Instant::now() + wait;
        let mut paused = self.paused_until.lock().unwrap();
        if paused.is_none_or(|p| p < until) {
            *paused = Some(until);
        }
    }

    /// Run `call`, retrying server errors when `retry` says the request is safe to
    /// repeat. After a rate limit every request is refused unsent until the pause ends.
    pub(crate) async fn run<T, F, Fut>(&self, retry: bool, mut call: F) -> Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let mut attempt = 0;
        loop {
            if let Some(message) = self.paused() {
                return Err(RejectedRequest(message).into());
            }
            let result = {
                let _slot = self.slots.acquire().await?;
                call().await
            };
            let Err(e) = &result else { return result };
            let message = format!("{e:#}");
            if let Some(limited) = e.downcast_ref::<RateLimited>() {
                if !limited.resource_only {
                    self.pause_for(limited.wait.unwrap_or(self.pause));
                }
                return result;
            }
            if is_rate_limited(&message) {
                self.pause_for(self.pause);
                return result;
            }
            match self.retry_delays.get(attempt) {
                Some(delay) if retry && is_server_error(&message) => {
                    tracing::debug!("GitHub server error, retrying in {delay:?}: {message}");
                    tokio::time::sleep(*delay).await;
                    attempt += 1;
                }
                _ => return result,
            }
        }
    }

    fn record(&self, headers: &reqwest::header::HeaderMap) {
        let num = |name: &str| header(headers, name).and_then(|v| v.parse::<u64>().ok());
        let (Some(resource), Some(limit), Some(remaining), Some(reset)) = (
            header(headers, "x-ratelimit-resource"),
            num("x-ratelimit-limit"),
            num("x-ratelimit-remaining"),
            num("x-ratelimit-reset"),
        ) else {
            return;
        };
        let budget = Budget {
            resource: resource.to_string(),
            limit,
            remaining,
            reset,
        };
        let mut budgets = self.budgets.lock().unwrap();
        budgets.retain(|b| b.resource != budget.resource);
        budgets.push(budget);
    }

    /// When the budget `resource` draws on is spent: its reset, as a message.
    fn exhausted(&self, resource: &str) -> Option<String> {
        let now = unix_now();
        self.budgets
            .lock()
            .unwrap()
            .iter()
            .find(|b| b.resource == resource && b.remaining == 0 && b.reset > now)
            .map(|b| {
                let at = chrono::DateTime::from_timestamp(b.reset as i64, 0)
                    .map(|t| {
                        t.with_timezone(&chrono::Local)
                            .format("%H:%M:%S")
                            .to_string()
                    })
                    .unwrap_or_default();
                format!("GitHub {resource} rate limit reached; Aura resumes those requests at {at}")
            })
    }

    fn pace(&self, base: Duration) -> Duration {
        pace(base, &self.budgets.lock().unwrap(), unix_now())
    }
}

/// gh reports primary, secondary and GraphQL limits with these words.
fn is_rate_limited(message: &str) -> bool {
    message.to_ascii_lowercase().contains("rate limit")
}

fn is_server_error(message: &str) -> bool {
    ["HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504"]
        .iter()
        .any(|status| message.contains(status))
}

/// Reads can be repeated. A write that failed with a server error may still have
/// been applied, so it is never retried.
pub(crate) fn is_read(method: &str, path: &str, body: Option<&Value>) -> bool {
    if path == "graphql" {
        return !body
            .and_then(|b| b["query"].as_str())
            .is_some_and(|q| q.trim_start().starts_with("mutation"));
    }
    method.eq_ignore_ascii_case("GET")
}

/// The rate limit a request draws on.
fn resource(path: &str) -> &'static str {
    if path == "graphql" {
        "graphql"
    } else if path.starts_with("search/") {
        "search"
    } else {
        "core"
    }
}

fn header<'a>(headers: &'a reqwest::header::HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn fingerprint(token: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

/// Why GitHub is not asked anything, and the token it refused.
struct SignedOut {
    reason: String,
    token: Option<u64>,
    checked: Instant,
}

impl SignedOut {
    /// Whether `token` should be tried: a different token than the refused one is tried at once.
    fn retry(&self, token: u64) -> bool {
        self.token != Some(token) || self.checked.elapsed() >= LOGIN_RECHECK
    }
}

#[derive(Clone)]
struct Cached {
    etag: Option<String>,
    modified: Option<String>,
    body: String,
    used: u64,
}

/// Answers by (token, URL), the least recently used dropped first.
#[derive(Default)]
struct Cache {
    entries: HashMap<(u64, String), Cached>,
    tick: u64,
}

impl Cache {
    fn get(&mut self, key: &(u64, String)) -> Option<Cached> {
        self.tick += 1;
        let entry = self.entries.get_mut(key)?;
        entry.used = self.tick;
        Some(entry.clone())
    }

    fn put(&mut self, key: (u64, String), mut cached: Cached) {
        self.tick += 1;
        cached.used = self.tick;
        self.entries.insert(key, cached);
        if self.entries.len() > CACHE_ENTRIES {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, c)| c.used)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
    }
}

#[derive(Default)]
struct Notes {
    /// When they were read, how long until they may be read again, and what they said.
    read: Option<(Instant, Duration, Option<Notified>)>,
    off_until: Option<Instant>,
}

struct Reply {
    body: String,
    poll_interval: Option<u64>,
}

#[derive(Default)]
struct Shared {
    client: OnceLock<reqwest::Client>,
    token: tokio::sync::Mutex<Option<(String, Instant)>>,
    /// Token fingerprint -> `host:login`.
    accounts: Mutex<HashMap<u64, String>>,
    /// Held while an account is looked up, so loops starting together ask once.
    looking_up: tokio::sync::Mutex<()>,
    signed_out: Mutex<Option<SignedOut>>,
    checking: tokio::sync::Mutex<()>,
    cache: Mutex<Cache>,
    notes: tokio::sync::Mutex<Notes>,
    memo: Memo,
}

/// GitHub through its API, signed in as gh is. Clones share their token, caches and login state.
#[derive(Clone)]
pub struct GhCli {
    host: String,
    shared: Arc<Shared>,
    /// The API's address, when not the host's (tests).
    api: Option<String>,
}

impl Default for GhCli {
    fn default() -> Self {
        Self::new("github.com")
    }
}

impl GhCli {
    pub fn new(host: &str) -> Self {
        Self {
            host: host.into(),
            shared: Arc::default(),
            api: None,
        }
    }

    fn client(&self) -> Result<&reqwest::Client> {
        if let Some(client) = self.shared.client.get() {
            return Ok(client);
        }
        // Another part of the process may have installed one already.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .context("Start the GitHub client")?;
        Ok(self.shared.client.get_or_init(|| client))
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("https://") {
            return path.into();
        }
        if let Some(api) = &self.api {
            return format!("{api}/{path}");
        }
        let api = if self.host == "github.com" {
            "https://api.github.com".to_string()
        } else if self.host.ends_with(".ghe.com") {
            format!("https://api.{}", self.host)
        } else if path == "graphql" {
            return format!("https://{}/api/graphql", self.host);
        } else {
            format!("https://{}/api/v3", self.host)
        };
        format!("{api}/{}", path.trim_start_matches('/'))
    }

    /// gh's token for the active account, read again now and then.
    async fn token(&self) -> Result<String> {
        let ttl = if self.shared.signed_out.lock().is_some() {
            SIGNED_OUT_TOKEN_TTL
        } else {
            TOKEN_TTL
        };
        let mut cached = self.shared.token.lock().await;
        if let Some((token, at)) = &*cached {
            if at.elapsed() < ttl {
                return Ok(token.clone());
            }
        }
        let token = gh_token(&self.host, None).await?;
        *cached = Some((token.clone(), Instant::now()));
        Ok(token)
    }

    fn sign_out(&self, reason: &str, token: Option<u64>) {
        let mut state = self.shared.signed_out.lock();
        if state.is_none() {
            tracing::warn!("GitHub requests stopped: {reason}");
        }
        *state = Some(SignedOut {
            reason: reason.into(),
            token,
            checked: Instant::now(),
        });
    }

    /// The token to send, or why GitHub is not asked: no login, or one GitHub refused. A token
    /// that may work again is tried with one cheap request.
    async fn ready_token(&self) -> Result<String> {
        let token = match self.token().await {
            Ok(token) => token,
            Err(e) => {
                let reason = format!("{e:#}");
                self.sign_out(&reason, None);
                return Err(RejectedRequest(reason).into());
            }
        };
        let fp = fingerprint(&token);
        let refused = {
            let state = self.shared.signed_out.lock();
            match &*state {
                None => return Ok(token),
                Some(s) if !s.retry(fp) => Some(s.reason.clone()),
                Some(_) => None,
            }
        };
        if let Some(reason) = refused {
            return Err(RejectedRequest(reason).into());
        }
        // One check at a time; requests meanwhile are refused.
        let Ok(_checking) = self.shared.checking.try_lock() else {
            return Err(RejectedRequest(LOGIN_EXPIRED.into()).into());
        };
        match self.fetch("GET", "user", None, false, &token, true).await {
            Ok(reply) => {
                let user: Value = serde_json::from_str(&reply.body)?;
                if let Some(login) = user["login"].as_str() {
                    self.shared
                        .accounts
                        .lock()
                        .insert(fp, format!("{}:{login}", self.host));
                }
                *self.shared.signed_out.lock() = None;
                tracing::info!("GitHub requests resumed");
                Ok(token)
            }
            Err(e) => {
                // A refusal waits for a new token or the next check; anything else (no network)
                // is tried again in a minute.
                if let Some(s) = self.shared.signed_out.lock().as_mut() {
                    s.token = Some(fp);
                    s.checked = if e.to_string() == LOGIN_EXPIRED {
                        Instant::now()
                    } else {
                        let soon = LOGIN_RECHECK - Duration::from_secs(60);
                        Instant::now()
                            .checked_sub(soon)
                            .unwrap_or_else(Instant::now)
                    };
                }
                tracing::debug!("GitHub login check failed: {e:#}");
                Err(RejectedRequest(LOGIN_EXPIRED.into()).into())
            }
        }
    }

    /// Send one request through the gate. A 401 on gh's own token stops GitHub requests until
    /// the login works again.
    async fn fetch(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        diff: bool,
        token: &str,
        own: bool,
    ) -> Result<Reply> {
        if let Some(message) = GATE.exhausted(resource(path)) {
            return Err(RejectedRequest(message).into());
        }
        let retry = is_read(method, path, body);
        let result = GATE
            .run(retry, || self.send(method, path, body, diff, token))
            .await;
        match result {
            Err(e) if e.downcast_ref::<Unauthorized>().is_some() => {
                if !own {
                    return Err(RejectedRequest(format!(
                        "Sign in to the account's GitHub login again: {e}"
                    ))
                    .into());
                }
                self.sign_out(LOGIN_EXPIRED, Some(fingerprint(token)));
                *self.shared.token.lock().await = None;
                Err(RejectedRequest(LOGIN_EXPIRED.into()).into())
            }
            other => other,
        }
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        diff: bool,
        token: &str,
    ) -> Result<Reply> {
        let url = self.url(path);
        let method_name = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
            .context("Invalid HTTP method")?;
        let mut request = self
            .client()?
            .request(method_name, &url)
            .bearer_auth(token)
            .header(
                "Accept",
                if diff {
                    "application/vnd.github.diff"
                } else {
                    "application/vnd.github+json"
                },
            )
            .header("X-GitHub-Api-Version", "2022-11-28");
        let key = (method.eq_ignore_ascii_case("GET") && !diff)
            .then(|| (fingerprint(token), url.clone()));
        let cached = key.as_ref().and_then(|k| self.shared.cache.lock().get(k));
        if let Some(c) = &cached {
            if let Some(etag) = &c.etag {
                request = request.header("If-None-Match", etag);
            } else if let Some(modified) = &c.modified {
                request = request.header("If-Modified-Since", modified);
            }
        }
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(body)?);
        }
        let response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                anyhow!("GitHub request timed out")
            } else {
                anyhow!("GitHub request failed: {e}")
            }
        })?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        GATE.record(&headers);
        tracing::debug!(status, "GitHub {method} {path}");
        let poll_interval = header(&headers, "x-poll-interval").and_then(|v| v.parse().ok());
        if status == 304 {
            if let Some(c) = cached {
                return Ok(Reply {
                    body: c.body,
                    poll_interval,
                });
            }
        }
        let text = response.text().await.context("Read GitHub's answer")?;
        if !(200..300).contains(&status) {
            return Err(failure(status, &headers, &text));
        }
        if path == "graphql" {
            graphql_failure(&headers, &text)?;
        }
        if let Some(key) = key {
            let etag = header(&headers, "etag").map(String::from);
            let modified = header(&headers, "last-modified").map(String::from);
            if (etag.is_some() || modified.is_some()) && text.len() <= CACHE_BODY_LIMIT {
                self.shared.cache.lock().put(
                    key,
                    Cached {
                        etag,
                        modified,
                        body: text.clone(),
                        used: 0,
                    },
                );
            }
        }
        Ok(Reply {
            body: text,
            poll_interval,
        })
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        diff: bool,
    ) -> Result<String> {
        let token = self.ready_token().await?;
        Ok(self
            .fetch(method, path, body.as_ref(), diff, &token, true)
            .await?
            .body)
    }
}

fn wait_from(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    if let Some(secs) = header(headers, "retry-after").and_then(|v| v.parse::<u64>().ok()) {
        return Some(Duration::from_secs(secs));
    }
    let reset = header(headers, "x-ratelimit-reset").and_then(|v| v.parse::<u64>().ok())?;
    (header(headers, "x-ratelimit-remaining") == Some("0"))
        .then(|| Duration::from_secs(reset.saturating_sub(unix_now()) + 1))
}

/// GitHub's refusal as an error: a rate limit, a 401, a request it rejected, or a failure.
fn failure(status: u16, headers: &reqwest::header::HeaderMap, text: &str) -> anyhow::Error {
    let said = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v["message"].as_str().map(String::from))
        .unwrap_or_else(|| text.trim().chars().take(300).collect());
    let message = format!("{said} (HTTP {status})");
    let spent = header(headers, "x-ratelimit-remaining") == Some("0");
    if matches!(status, 403 | 429)
        && (spent || headers.contains_key("retry-after") || is_rate_limited(&message))
    {
        return RateLimited {
            message,
            wait: wait_from(headers),
            resource_only: spent && !headers.contains_key("retry-after"),
        }
        .into();
    }
    match status {
        401 => Unauthorized(message).into(),
        400 | 403 | 404 | 405 | 422 | 429 => RejectedRequest(message).into(),
        _ => anyhow!(message),
    }
}

/// A GraphQL answer without data fails as a whole; one with data is kept, and callers read its
/// `errors`.
fn graphql_failure(headers: &reqwest::header::HeaderMap, text: &str) -> Result<()> {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Ok(());
    };
    if v["data"].is_object() || !v["errors"].is_array() {
        return Ok(());
    }
    let errors = v["errors"].as_array().cloned().unwrap_or_default();
    let message = errors
        .iter()
        .filter_map(|e| e["message"].as_str())
        .collect::<Vec<_>>()
        .join("; ");
    if errors.iter().any(|e| e["type"] == "RATE_LIMITED") || is_rate_limited(&message) {
        return Err(RateLimited {
            message,
            wait: wait_from(headers),
            resource_only: header(headers, "x-ratelimit-remaining") == Some("0"),
        }
        .into());
    }
    bail!("{message}")
}

/// gh's token for `host`, of `user` when given.
async fn gh_token(host: &str, user: Option<&str>) -> Result<String> {
    let bin = aura_core::which::find_binary("gh", "AURA_GH_BIN", &[]).context(NO_GH)?;
    let mut cmd = Command::new(bin);
    cmd.args(["auth", "token", "--hostname", host]);
    if let Some(user) = user {
        cmd.args(["--user", user]);
    }
    cmd.env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (child, _group) = aura_core::process::spawn_job(&mut cmd).context("Start GitHub CLI")?;
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .context("GitHub CLI timed out")??;
    let token = String::from_utf8(output.stdout)?.trim().to_string();
    if !output.status.success() || token.is_empty() {
        bail!("Not signed in to GitHub. Run `gh auth login`; Aura reconnects by itself.");
    }
    Ok(token)
}

fn json(raw: &str) -> Result<Value> {
    if raw.trim().is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_str(raw)?)
    }
}

#[async_trait]
impl Github for GhCli {
    fn host(&self) -> &str {
        &self.host
    }
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        json(&self.call(method, path, body, false).await?)
    }
    async fn request_for(
        &self,
        account: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        // Resolve and validate a token for the reviewed identity, then pin it to
        // the actual mutation. Switching gh accounts between requests cannot
        // cause a review to be posted as a different person.
        let token = async {
            let (host, login) = account.split_once(':').context("Invalid GitHub account")?;
            if host != self.host {
                bail!("Wrong GitHub host");
            }
            let token = gh_token(host, Some(login))
                .await
                .map_err(|_| anyhow!("Sign in to the review's GitHub account again"))?;
            let user = json(
                &self
                    .fetch("GET", "user", None, false, &token, false)
                    .await?
                    .body,
            )?;
            if user["login"].as_str() != Some(login) {
                bail!("GitHub credentials do not match the reviewed account");
            }
            Ok::<_, anyhow::Error>(token)
        }
        .await
        .map_err(|e| RejectedRequest(e.to_string()))?;
        json(
            &self
                .fetch(method, path, body.as_ref(), false, &token, false)
                .await?
                .body,
        )
    }
    async fn diff(&self, repo: &str, base: &str, head: &str) -> Result<String> {
        crate::validate_repo(repo)?;
        crate::validate_sha(base)?;
        crate::validate_sha(head)?;
        self.call(
            "GET",
            &format!("repos/{repo}/compare/{base}...{head}"),
            None,
            true,
        )
        .await
    }
    /// Looked up once per token: an account only changes with the login.
    async fn account(&self) -> Result<String> {
        let token = self.ready_token().await?;
        let fp = fingerprint(&token);
        let _looking_up = self.shared.looking_up.lock().await;
        if let Some(account) = self.shared.accounts.lock().get(&fp) {
            return Ok(account.clone());
        }
        let user = json(
            &self
                .fetch("GET", "user", None, false, &token, true)
                .await?
                .body,
        )?;
        let login = user["login"]
            .as_str()
            .context("GitHub did not return an account")?;
        let account = format!("{}:{login}", self.host);
        self.shared.accounts.lock().insert(fp, account.clone());
        Ok(account)
    }
    async fn blocked(&self) -> Option<String> {
        if let Err(e) = self.ready_token().await {
            return Some(e.to_string());
        }
        GATE.paused()
    }
    fn pace(&self, base: Duration) -> Duration {
        GATE.pace(base)
    }
    async fn notified(&self) -> Option<Notified> {
        let mut notes = self.shared.notes.lock().await;
        if let Some((at, every, last)) = &notes.read {
            if at.elapsed() < *every {
                return last.clone();
            }
        }
        if notes.off_until.is_some_and(|t| t > Instant::now()) {
            return None;
        }
        let token = self.ready_token().await.ok()?;
        match self
            .fetch("GET", NOTIFICATIONS, None, false, &token, true)
            .await
        {
            Ok(reply) => {
                let every = Duration::from_secs(reply.poll_interval.unwrap_or(60));
                let read = serde_json::from_str(&reply.body)
                    .ok()
                    .and_then(|v: Value| Notified::parse(&v, NOTIFICATIONS_PAGE));
                notes.read = Some((Instant::now(), every, read.clone()));
                read
            }
            Err(e) => {
                let message = format!("{e:#}");
                // A token without the notifications scope; PRs are then read on a schedule.
                if message.contains("HTTP 403") || message.contains("HTTP 404") {
                    tracing::debug!("notifications unavailable: {message}");
                    notes.off_until = Some(Instant::now() + NOTIFICATIONS_OFF);
                }
                None
            }
        }
    }
    fn memo(&self) -> Option<&Memo> {
        Some(&self.shared.memo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A request the test server got: its first line and headers, lowercase.
    #[derive(Debug, Clone)]
    struct Got {
        line: String,
        headers: HashMap<String, String>,
    }

    /// An HTTP server answering with `answer`, and a client signed in with `token` that talks to it.
    async fn server(
        answer: impl Fn(&Got) -> (u16, Vec<(&'static str, String)>, String) + Send + Sync + 'static,
    ) -> (GhCli, Arc<Mutex<Vec<Got>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let got = Arc::new(Mutex::new(vec![]));
        let seen = got.clone();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut raw = vec![];
                let mut buf = [0u8; 4096];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let text = String::from_utf8_lossy(&raw).to_string();
                let mut lines = text.split("\r\n");
                let request = Got {
                    line: lines.next().unwrap_or_default().to_string(),
                    headers: lines
                        .filter_map(|l| l.split_once(": "))
                        .map(|(k, v)| (k.to_lowercase(), v.to_string()))
                        .collect(),
                };
                seen.lock().push(request.clone());
                let (status, headers, body) = answer(&request);
                let mut reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (k, v) in headers {
                    reply += &format!("{k}: {v}\r\n");
                }
                reply += "\r\n";
                reply += &body;
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        let gh = GhCli {
            api: Some(format!("http://127.0.0.1:{port}")),
            ..GhCli::default()
        };
        sign_in(&gh, "t1").await;
        (gh, got)
    }

    /// As if gh had just handed out `token`.
    async fn sign_in(gh: &GhCli, token: &str) {
        *gh.shared.token.lock().await = Some((token.into(), Instant::now()));
    }

    #[tokio::test]
    async fn an_unchanged_answer_comes_from_the_cache() {
        let (gh, got) = server(|r| match r.headers.get("if-none-match") {
            Some(tag) if tag == "\"v1\"" => (304, vec![], String::new()),
            _ => (200, vec![("ETag", "\"v1\"".into())], r#"{"a":1}"#.into()),
        })
        .await;
        assert_eq!(
            gh.request("GET", "repos/o/r/labels", None).await.unwrap(),
            json!({"a":1})
        );
        assert_eq!(
            gh.request("GET", "repos/o/r/labels", None).await.unwrap(),
            json!({"a":1})
        );
        {
            let got = got.lock();
            assert_eq!(got.len(), 2);
            assert!(
                got[0].line.starts_with("GET /repos/o/r/labels "),
                "{}",
                got[0].line
            );
            assert_eq!(got[0].headers.get("if-none-match"), None);
            assert_eq!(
                got[1].headers.get("if-none-match").map(String::as_str),
                Some("\"v1\"")
            );
            assert_eq!(
                got[1].headers.get("authorization").map(String::as_str),
                Some("Bearer t1")
            );
        }
        sign_in(&gh, "t2").await;
        gh.request("GET", "repos/o/r/labels", None).await.unwrap();
        assert_eq!(
            got.lock()[2].headers.get("if-none-match"),
            None,
            "another login's answers are not reused"
        );
    }

    #[tokio::test]
    async fn a_refused_login_stops_requests_until_a_new_one_works() {
        let (gh, got) = server(|r| {
            if r.headers.get("authorization").map(String::as_str) == Some("Bearer t1") {
                (401, vec![], r#"{"message":"Bad credentials"}"#.into())
            } else {
                (200, vec![], r#"{"login":"me"}"#.into())
            }
        })
        .await;
        let e = gh.request("GET", "user", None).await.unwrap_err();
        assert_eq!(e.to_string(), LOGIN_EXPIRED);
        sign_in(&gh, "t1").await;
        assert_eq!(gh.blocked().await.as_deref(), Some(LOGIN_EXPIRED));
        assert!(gh.request("GET", "repos/o/r/pulls/1", None).await.is_err());
        assert!(gh.account().await.is_err());
        assert_eq!(
            got.lock().len(),
            1,
            "nothing more is sent with the refused token"
        );
        sign_in(&gh, "t2").await;
        assert_eq!(gh.blocked().await, None, "a new login is tried and works");
        assert_eq!(got.lock().len(), 2, "with one request");
        assert_eq!(
            gh.account().await.unwrap(),
            "github.com:me",
            "known from that check"
        );
        assert_eq!(got.lock().len(), 2);
    }

    fn counting<'a>(
        calls: &'a AtomicUsize,
        failures: usize,
        message: &'static str,
    ) -> impl FnMut() -> std::future::Ready<Result<String>> + 'a {
        move || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(if n < failures {
                Err(anyhow::anyhow!(message))
            } else {
                Ok("ok".into())
            })
        }
    }
    const NO_WAIT: [Duration; 2] = [Duration::ZERO, Duration::ZERO];
    #[tokio::test]
    async fn retries_reads_that_hit_a_server_error() {
        let gate = Gate::new(4, Duration::from_secs(60), &NO_WAIT);
        let calls = AtomicUsize::new(0);
        let r = gate
            .run(true, counting(&calls, 2, "Server Error (HTTP 504)"))
            .await;
        assert_eq!(r.unwrap(), "ok");
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        let calls = AtomicUsize::new(0);
        assert!(gate
            .run(true, counting(&calls, 9, "Bad Gateway (HTTP 502)"))
            .await
            .is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "gives up after the last delay"
        );
    }
    #[tokio::test]
    async fn never_retries_writes_or_client_errors() {
        let gate = Gate::new(4, Duration::from_secs(60), &NO_WAIT);
        let calls = AtomicUsize::new(0);
        assert!(gate
            .run(false, counting(&calls, 1, "Server Error (HTTP 504)"))
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let calls = AtomicUsize::new(0);
        assert!(gate
            .run(true, counting(&calls, 1, "Not Found (HTTP 404)"))
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn pauses_every_request_after_a_rate_limit() {
        let gate = Gate::new(4, Duration::from_millis(50), &NO_WAIT);
        let calls = AtomicUsize::new(0);
        let msg = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)";
        assert!(gate.run(true, counting(&calls, 1, msg)).await.is_err());
        let refused = gate.run(true, counting(&calls, 0, "")).await.unwrap_err();
        assert!(
            refused.downcast_ref::<RejectedRequest>().is_some(),
            "refused unsent: {refused}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "nothing reaches GitHub while paused"
        );
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(gate.run(true, counting(&calls, 0, "")).await.unwrap(), "ok");
    }
    #[tokio::test]
    async fn honours_retry_after_and_leaves_spent_budgets_to_their_resource() {
        let gate = Gate::new(4, Duration::from_secs(600), &NO_WAIT);
        let limited = |wait: u64, resource_only: bool| {
            move || {
                std::future::ready(Err::<String, _>(
                    RateLimited {
                        message: "secondary rate limit (HTTP 403)".into(),
                        wait: Some(Duration::from_millis(wait)),
                        resource_only,
                    }
                    .into(),
                ))
            }
        };
        assert!(gate.run(true, limited(40, false)).await.is_err());
        assert!(gate.paused().is_some(), "paused for Retry-After");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            gate.paused().is_none(),
            "Retry-After replaces the default pause"
        );
        assert!(gate.run(true, limited(10_000, true)).await.is_err());
        assert!(
            gate.paused().is_none(),
            "one spent budget does not stop the others"
        );
    }
    #[test]
    fn polls_slow_down_as_the_budget_runs_low() {
        let base = Duration::from_secs(60);
        let budget = |resource: &str, remaining| Budget {
            resource: resource.into(),
            limit: 5000,
            remaining,
            reset: 1_000 + 1_800,
        };
        let at = |remaining| pace(base, &[budget("core", remaining)], 1_000);
        assert_eq!(at(4000), base);
        assert_eq!(at(2000), base * 2);
        assert_eq!(at(1000), base * 4);
        assert_eq!(at(100), base * 8);
        assert_eq!(at(0), Duration::from_secs(1_800), "until the reset");
        assert_eq!(
            pace(base, &[budget("search", 0)], 1_000),
            base,
            "search has its own short limit"
        );
        assert_eq!(
            pace(
                base,
                &[budget("core", 4000), budget("graphql", 1000)],
                1_000
            ),
            base * 4,
            "the lowest budget decides"
        );
        assert_eq!(
            pace(base, &[budget("core", 0)], 5_000),
            base,
            "a budget past its reset is full again"
        );
    }
    #[test]
    fn polls_follow_the_budget_github_reports() {
        let gate = Gate::new(4, Duration::from_secs(60), &NO_WAIT);
        let base = Duration::from_secs(60);
        let report = |remaining: u64| {
            let mut headers = reqwest::header::HeaderMap::new();
            for (k, v) in [
                ("x-ratelimit-resource", "graphql".to_string()),
                ("x-ratelimit-limit", "5000".into()),
                ("x-ratelimit-remaining", remaining.to_string()),
                ("x-ratelimit-reset", (unix_now() + 1800).to_string()),
            ] {
                headers.insert(k, v.parse().unwrap());
            }
            gate.record(&headers);
            gate.pace(base)
        };
        assert_eq!(report(4900), base);
        assert_eq!(report(1500), base * 2);
        assert_eq!(report(300), base * 8);
        assert!(
            report(0) > Duration::from_secs(1700),
            "spent: wait for the reset"
        );
        assert!(gate.exhausted("graphql").is_some() && gate.exhausted("core").is_none());
    }
    #[test]
    fn rate_limits_401s_and_rejections_are_told_apart() {
        let mut headers = reqwest::header::HeaderMap::new();
        let e = failure(401, &headers, r#"{"message":"Bad credentials"}"#);
        assert!(e.downcast_ref::<Unauthorized>().is_some());
        let e = failure(404, &headers, r#"{"message":"Not Found"}"#);
        assert_eq!(e.to_string(), "Not Found (HTTP 404)");
        assert!(rejected(&e));
        let e = failure(502, &headers, "<html>");
        assert!(!rejected(&e) && is_server_error(&e.to_string()));
        headers.insert("retry-after", "30".parse().unwrap());
        let e = failure(
            403,
            &headers,
            r#"{"message":"You have exceeded a secondary rate limit"}"#,
        );
        let limited = e.downcast_ref::<RateLimited>().unwrap();
        assert_eq!(
            (limited.wait, limited.resource_only),
            (Some(Duration::from_secs(30)), false)
        );
        assert!(rejected(&e), "a refused write was not applied");
        let mut spent = reqwest::header::HeaderMap::new();
        spent.insert("x-ratelimit-remaining", "0".parse().unwrap());
        spent.insert(
            "x-ratelimit-reset",
            (unix_now() + 100).to_string().parse().unwrap(),
        );
        let e = failure(403, &spent, r#"{"message":"API rate limit exceeded"}"#);
        let limited = e.downcast_ref::<RateLimited>().unwrap();
        assert!(limited.resource_only && limited.wait.unwrap() >= Duration::from_secs(100));
        assert!(graphql_failure(&spent, r#"{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}"#)
            .unwrap_err()
            .downcast_ref::<RateLimited>()
            .is_some());
    }
    #[test]
    fn keeps_partial_graphql_answers() {
        let headers = reqwest::header::HeaderMap::new();
        assert!(graphql_failure(
            &headers,
            r#"{"data":{"r0":null},"errors":[{"message":"x"}]}"#
        )
        .is_ok());
        assert_eq!(
            graphql_failure(
                &headers,
                r#"{"data":null,"errors":[{"message":"Something went wrong"}]}"#
            )
            .unwrap_err()
            .to_string(),
            "Something went wrong"
        );
    }
    #[test]
    fn only_reads_count_as_repeatable() {
        assert!(is_read("GET", "repos/o/r/pulls/1", None));
        assert!(!is_read(
            "POST",
            "repos/o/r/pulls/1/reviews",
            Some(&json!({}))
        ));
        assert!(is_read(
            "POST",
            "graphql",
            Some(&json!({"query": "query{viewer{login}}"}))
        ));
        assert!(!is_read(
            "POST",
            "graphql",
            Some(&json!({"query": " mutation($id:ID!){x}"}))
        ));
    }
    #[test]
    fn api_urls_for_github_and_enterprise_hosts() {
        let gh = GhCli::default();
        assert_eq!(gh.url("user"), "https://api.github.com/user");
        assert_eq!(gh.url("graphql"), "https://api.github.com/graphql");
        let ghes = GhCli::new("git.example.com");
        assert_eq!(
            ghes.url("repos/o/r/pulls/1"),
            "https://git.example.com/api/v3/repos/o/r/pulls/1"
        );
        assert_eq!(ghes.url("graphql"), "https://git.example.com/api/graphql");
        assert_eq!(
            GhCli::new("acme.ghe.com").url("graphql"),
            "https://api.acme.ghe.com/graphql"
        );
    }
    #[test]
    fn a_refused_token_is_tried_again_only_when_it_changed_or_after_a_while() {
        let out = SignedOut {
            reason: LOGIN_EXPIRED.into(),
            token: Some(1),
            checked: Instant::now(),
        };
        assert!(!out.retry(1), "the same token waits");
        assert!(out.retry(2), "a new login is tried at once");
        let old = SignedOut {
            checked: Instant::now() - LOGIN_RECHECK,
            ..out
        };
        assert!(old.retry(1));
    }
    #[test]
    fn the_cache_drops_the_least_recently_used() {
        let mut cache = Cache::default();
        let entry = |body: &str| Cached {
            etag: Some("e".into()),
            modified: None,
            body: body.into(),
            used: 0,
        };
        for i in 0..CACHE_ENTRIES {
            cache.put((1, format!("u{i}")), entry("x"));
        }
        assert!(cache.get(&(1, "u0".into())).is_some());
        cache.put((1, "new".into()), entry("y"));
        assert!(cache.get(&(1, "u0".into())).is_some(), "used lately");
        assert!(cache.get(&(1, "u1".into())).is_none(), "the oldest went");
        assert!(cache.get(&(2, "new".into())).is_none(), "per token");
    }
}
