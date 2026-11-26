//! `aura.http.fetch`: text HTTP(S) requests with an optional ETag cache.

use crate::runtime::ModError;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::OnceLock;
use std::time::Duration;

const CACHE_ENTRIES: usize = 512;
const MAX_BODY: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchArgs {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub cache: Option<String>,
}

#[derive(Clone)]
struct Cached {
    etag: String,
    status: u16,
    headers: BTreeMap<String, String>,
    text: String,
}

/// One HTTP client and ETag cache shared by every mod. Cache keys include the
/// mod id and the request's Authorization header, so nothing is shared across
/// mods or accounts.
#[derive(Default)]
pub struct Http {
    client: OnceLock<reqwest::Client>,
    cache: Mutex<(HashMap<String, Cached>, VecDeque<String>)>,
}

impl Http {
    fn client(&self) -> Result<&reqwest::Client, ModError> {
        if let Some(c) = self.client.get() {
            return Ok(c);
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let c = reqwest::Client::builder()
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| ModError::failed(format!("start the HTTP client: {e}")))?;
        Ok(self.client.get_or_init(|| c))
    }

    fn cache_key(mod_id: &str, a: &FetchArgs) -> String {
        let auth = a
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        // Hash the credential rather than keeping it in the key.
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        auth.hash(&mut h);
        let accept = a
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("accept"))
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        format!("{mod_id}\u{0}{:x}\u{0}{accept}\u{0}{}", h.finish(), a.url)
    }

    pub async fn fetch(&self, mod_id: &str, a: FetchArgs) -> Result<Value, ModError> {
        let method = a.method.clone().unwrap_or_else(|| "GET".into()).to_uppercase();
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| ModError::invalid(format!("bad HTTP method {method}")))?;
        let cacheable = a.cache.as_deref() == Some("etag") && method == reqwest::Method::GET;
        let key = cacheable.then(|| Self::cache_key(mod_id, &a));
        let cached = key.as_ref().and_then(|k| self.cache.lock().0.get(k).cloned());

        let mut req = self
            .client()?
            .request(method, &a.url)
            .timeout(Duration::from_millis(a.timeout_ms.unwrap_or(30_000)));
        for (k, v) in &a.headers {
            req = req.header(k, v);
        }
        if let Some(c) = &cached {
            req = req.header("If-None-Match", &c.etag);
        }
        if let Some(body) = a.body {
            req = req.body(body);
        }
        let resp = req.send().await.map_err(|e| {
            if e.is_timeout() {
                ModError::new("timeout", format!("{}: timed out", a.url))
            } else {
                ModError::failed(format!("{}: {e}", a.url))
            }
        })?;
        let status = resp.status().as_u16();
        let mut headers = BTreeMap::new();
        for (k, v) in resp.headers() {
            if let Ok(v) = v.to_str() {
                headers
                    .entry(k.as_str().to_ascii_lowercase())
                    .and_modify(|e: &mut String| {
                        e.push_str(", ");
                        e.push_str(v);
                    })
                    .or_insert_with(|| v.to_string());
            }
        }
        if status == 304 {
            if let Some(c) = cached {
                // Fresh rate-limit headers of the 304 win over the stored ones.
                let mut merged = c.headers.clone();
                for (k, v) in &headers {
                    if k.starts_with("x-ratelimit") || k == "date" {
                        merged.insert(k.clone(), v.clone());
                    }
                }
                return Ok(json!({"status": c.status, "ok": true, "headers": merged, "text": c.text, "cached": true}));
            }
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ModError::failed(format!("{}: reading the answer: {e}", a.url)))?;
        if bytes.len() > MAX_BODY {
            return Err(ModError::failed(format!("{}: answer too large", a.url)));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if let (Some(key), 200, Some(etag)) = (key, status, headers.get("etag").cloned()) {
            let mut c = self.cache.lock();
            let (map, order) = &mut *c;
            if map
                .insert(
                    key.clone(),
                    Cached {
                        etag,
                        status,
                        headers: headers.clone(),
                        text: text.clone(),
                    },
                )
                .is_none()
            {
                order.push_back(key);
            }
            while order.len() > CACHE_ENTRIES {
                if let Some(old) = order.pop_front() {
                    map.remove(&old);
                }
            }
        }
        Ok(json!({
            "status": status,
            "ok": (200..300).contains(&status),
            "headers": headers,
            "text": text,
            "cached": false,
        }))
    }
}

/// The host of `url`, for the permission check. Only http(s) is allowed.
pub fn host_of(url: &str) -> Result<String, ModError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| ModError::invalid(format!("bad URL {url}: {e}")))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(ModError::invalid(format!("{url}: only http(s) is allowed")));
    }
    parsed
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .ok_or_else(|| ModError::invalid(format!("{url} has no host")))
}
