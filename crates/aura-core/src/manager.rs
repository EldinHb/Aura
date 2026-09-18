use crate::event::*;
use crate::provider::*;
use crate::store::*;
use crate::types::*;
use anyhow::{anyhow, bail, Context, Result};
use aura_pty::{PtyHandle, PtySpec};
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

/// Git worktree creation is provided by `aura-git`; the manager only needs this.
pub trait WorktreeBackend: Send + Sync {
    fn create(&self, cwd: &str, opts: &WorktreeOpts) -> Result<WorktreeInfo>;
    fn remove(&self, info: &WorktreeInfo) -> Result<()>;
}

#[derive(Default)]
struct Runtime {
    driver: Option<Arc<dyn Driver>>,
    pty: Option<PtyHandle>,
    pending_approvals: HashMap<String, Approval>,
    pending_inputs: HashMap<String, UserInputRequest>,
    current_turn: Option<Turn>,
    /// Items still streaming; replayed to late attachers.
    live_items: BTreeMap<String, Item>,
    /// Set while a resumed driver replays its native history: those items are
    /// already in the store, so they are broadcast but not persisted again.
    replaying: bool,
}

struct Inner {
    store: Arc<dyn Store>,
    providers: HashMap<ProviderKind, Arc<dyn Provider>>,
    worktrees: Option<Arc<dyn WorktreeBackend>>,
    sessions: Mutex<BTreeMap<SessionId, Session>>,
    runtimes: Mutex<HashMap<SessionId, Runtime>>,
    events: broadcast::Sender<Event>,
    pty_out: broadcast::Sender<PtyChunk>,
    sink: mpsc::UnboundedSender<Event>,
}

#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

impl Manager {
    pub fn new(
        store: Arc<dyn Store>,
        providers: Vec<Arc<dyn Provider>>,
        worktrees: Option<Arc<dyn WorktreeBackend>>,
    ) -> Self {
        let (events, _) = broadcast::channel(4096);
        let (pty_out, _) = broadcast::channel(4096);
        let (sink, sink_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            store,
            providers: providers.into_iter().map(|p| (p.kind(), p)).collect(),
            worktrees,
            sessions: Mutex::new(BTreeMap::new()),
            runtimes: Mutex::new(HashMap::new()),
            events,
            pty_out,
            sink,
        });
        let m = Self { inner };
        m.spawn_event_loop(sink_rx);
        m
    }

    // ---------------------------------------------------------------- queries

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }

    pub fn subscribe_pty(&self) -> broadcast::Receiver<PtyChunk> {
        self.inner.pty_out.subscribe()
    }

    pub fn list_sessions(&self) -> Vec<Session> {
        self.inner.sessions.lock().values().cloned().collect()
    }

    pub fn get_session(&self, id: &str) -> Result<Session> {
        self.inner.sessions.lock().get(id).cloned().ok_or_else(|| anyhow!("unknown session {id}"))
    }

    /// Provider info, with stale CLI detection refreshed first. The daemon
    /// outlives the app, so a CLI upgraded while it ran would otherwise keep
    /// being reported at the version seen at startup.
    pub async fn providers(&self) -> Vec<ProviderInfo> {
        let providers: Vec<_> = self.inner.providers.values().cloned().collect();
        for p in &providers {
            p.refresh().await;
        }
        let mut v: Vec<_> = providers.iter().map(|p| p.info()).collect();
        v.sort_by_key(|p| p.kind.as_str());
        v
    }

    pub fn provider(&self, kind: ProviderKind) -> Result<Arc<dyn Provider>> {
        self.inner.providers.get(&kind).cloned().ok_or_else(|| anyhow!("provider {kind:?} not registered"))
    }

    pub async fn list_native(&self, kind: ProviderKind) -> Result<Vec<NativeSession>> {
        self.provider(kind)?.list_native().await
    }

    pub async fn list_models(&self, kind: ProviderKind) -> Result<Vec<ModelInfo>> {
        self.provider(kind)?.list_models().await
    }

    pub async fn list_commands(&self, kind: ProviderKind, cwd: &str) -> Result<Vec<SlashCommand>> {
        self.provider(kind)?.list_commands(cwd).await
    }

    /// Persisted history plus a snapshot of anything still in flight.
    pub fn history(&self, id: &str, after_seq: u64, limit: usize) -> Result<Vec<StoredEvent>> {
        let mut evs = self.inner.store.events(id, after_seq, limit)?;
        let rt = self.inner.runtimes.lock();
        if let Some(rt) = rt.get(id) {
            let now = crate::now();
            let mut seq = evs.last().map(|e| e.seq).unwrap_or(after_seq);
            let mut push = |event: Event| {
                seq += 1;
                evs.push(StoredEvent { seq, ts: now, event });
            };
            if let Some(t) = &rt.current_turn {
                push(Event::TurnStarted { session_id: id.into(), turn: t.clone() });
            }
            for item in rt.live_items.values() {
                push(Event::ItemStarted { session_id: id.into(), item: item.clone() });
            }
            for a in rt.pending_approvals.values() {
                push(Event::ApprovalRequested { session_id: id.into(), approval: a.clone() });
            }
            for r in rt.pending_inputs.values() {
                push(Event::UserInputRequested { session_id: id.into(), request: r.clone() });
            }
        }
        Ok(evs)
    }

    pub fn pending(&self) -> (Vec<Approval>, Vec<UserInputRequest>) {
        let rt = self.inner.runtimes.lock();
        let mut a: Vec<Approval> = rt.values().flat_map(|r| r.pending_approvals.values().cloned()).collect();
        let mut u: Vec<UserInputRequest> = rt.values().flat_map(|r| r.pending_inputs.values().cloned()).collect();
        a.sort_by_key(|x| x.created_at);
        u.sort_by_key(|x| x.created_at);
        (a, u)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        self.inner.store.search(query, limit)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.inner.store.get_setting(key)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.inner.store.set_setting(key, value)
    }

    // -------------------------------------------------------------- lifecycle

    /// Load sessions from the store. Structured sessions become idle and are
    /// resumed lazily on the next message; terminal sessions are marked exited
    /// with their scrollback kept.
    pub fn restore(&self) -> Result<usize> {
        let stored = self.inner.store.list_sessions()?;
        let n = stored.len();
        let mut sessions = self.inner.sessions.lock();
        for mut s in stored {
            match s.mode {
                SessionMode::Terminal => {
                    if s.status != SessionStatus::Exited {
                        s.status = SessionStatus::Exited;
                        s.exit_code = None;
                    }
                }
                SessionMode::Structured => {
                    if s.status != SessionStatus::Error {
                        s.status = SessionStatus::Idle;
                    }
                }
            }
            s.pending_count = 0;
            let _ = self.inner.store.upsert_session(&s);
            self.inner.runtimes.lock().entry(s.id.clone()).or_default();
            sessions.insert(s.id.clone(), s);
        }
        Ok(n)
    }

    /// Stop every process and flush scrollback. Sessions stay resumable.
    pub async fn shutdown(&self) {
        let ids: Vec<String> = self.inner.sessions.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    pub async fn create_session(&self, mut opts: CreateSessionOpts) -> Result<Session> {
        if opts.cwd.is_empty() {
            opts.cwd = std::env::current_dir()?.to_string_lossy().to_string();
        }
        if !std::path::Path::new(&opts.cwd).is_dir() {
            bail!("cwd does not exist: {}", opts.cwd);
        }
        let provider = self.provider(opts.provider)?;
        let mut session = Session::new(&opts);
        if let Some(wt) = &opts.worktree {
            let backend = self.inner.worktrees.clone().ok_or_else(|| anyhow!("git worktrees not available"))?;
            let info = backend.create(&opts.cwd, wt).with_context(|| "create worktree")?;
            session.cwd = info.path.clone();
            session.worktree = Some(info);
            if opts.title.is_none() {
                session.title = format!("{} · {}", opts.provider.as_str(), wt.branch);
            }
        }
        if session.mode == SessionMode::Terminal && session.command.is_none() {
            session.command = Some(match opts.provider {
                ProviderKind::Terminal => aura_pty::default_shell(),
                _ => provider.terminal_command(&session),
            });
        }
        self.inner.store.upsert_session(&session)?;
        self.inner.sessions.lock().insert(session.id.clone(), session.clone());
        self.inner.runtimes.lock().insert(session.id.clone(), Runtime::default());
        self.broadcast(Event::SessionCreated { session: session.clone() });

        match session.mode {
            SessionMode::Terminal => {
                self.spawn_pty(&session.id).await?;
            }
            SessionMode::Structured => {
                if let Err(e) = self.ensure_driver(&session.id, opts.fork).await {
                    self.set_error(&session.id, &e.to_string());
                    return Err(e);
                }
                if let Some(p) = opts.initial_prompt.filter(|p| !p.trim().is_empty()) {
                    self.send(&session.id, Input { text: p, ..Default::default() }).await?;
                }
            }
        }
        self.get_session(&session.id)
    }

    /// Fork a structured session into a new native session.
    pub async fn fork(&self, id: &str) -> Result<Session> {
        let s = self.get_session(id)?;
        let native = s.native_id.clone().ok_or_else(|| anyhow!("session has no native id yet"))?;
        if !self.provider(s.provider)?.capabilities().fork {
            bail!("provider does not support fork");
        }
        self.create_session(CreateSessionOpts {
            provider: s.provider,
            cwd: s.cwd.clone(),
            title: Some(format!("{} (fork)", s.title)),
            group: s.group.clone(),
            mode: Some(SessionMode::Structured),
            command: None,
            model: s.model.clone(),
            effort: s.effort.clone(),
            permission_mode: s.permission_mode.clone(),
            sandbox_mode: s.sandbox_mode.clone(),
            worktree: None,
            initial_prompt: None,
            resume_native_id: Some(native),
            fork: true,
        })
        .await
    }

    pub async fn send(&self, id: &str, input: Input) -> Result<()> {
        let s = self.get_session(id)?;
        match s.mode {
            SessionMode::Terminal => {
                let mut data = input.text.into_bytes();
                data.push(b'\r');
                self.pty_input(id, &data)
            }
            SessionMode::Structured => {
                let driver = self.ensure_driver(id, false).await?;
                driver.send(input).await
            }
        }
    }

    pub async fn interrupt(&self, id: &str) -> Result<()> {
        let s = self.get_session(id)?;
        match s.mode {
            SessionMode::Terminal => self.pty_input(id, b"\x03"),
            SessionMode::Structured => match self.driver(id) {
                Some(d) => d.interrupt().await,
                None => Ok(()),
            },
        }
    }

    pub async fn respond_approval(&self, id: &str, approval_id: &str, decision: ApprovalDecision) -> Result<()> {
        let driver = self.driver(id).ok_or_else(|| anyhow!("session is not running"))?;
        let exists = self
            .inner
            .runtimes
            .lock()
            .get(id)
            .map(|r| r.pending_approvals.contains_key(approval_id))
            .unwrap_or(false);
        if !exists {
            bail!("unknown approval {approval_id}");
        }
        driver.respond_approval(approval_id, decision.clone()).await?;
        self.publish(Event::ApprovalResolved { session_id: id.into(), approval_id: approval_id.into(), decision });
        Ok(())
    }

    pub async fn respond_input(&self, id: &str, response: UserInputResponse) -> Result<()> {
        let driver = self.driver(id).ok_or_else(|| anyhow!("session is not running"))?;
        let exists = self
            .inner
            .runtimes
            .lock()
            .get(id)
            .map(|r| r.pending_inputs.contains_key(&response.request_id))
            .unwrap_or(false);
        if !exists {
            bail!("unknown input request {}", response.request_id);
        }
        driver.respond_input(response.clone()).await?;
        self.publish(Event::UserInputResolved {
            session_id: id.into(),
            request_id: response.request_id.clone(),
            response,
        });
        Ok(())
    }

    pub async fn set(&self, id: &str, setting: Setting) -> Result<()> {
        let _ = self.get_session(id)?;
        if let Some(d) = self.driver(id) {
            d.set(setting.clone()).await?;
        }
        // Applied locally too so the next (re)start uses it.
        self.publish(Event::SettingChanged { session_id: id.into(), setting });
        Ok(())
    }

    pub async fn action(&self, id: &str, name: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        let driver = self.ensure_driver(id, false).await?;
        driver.action(name, params).await
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<Session> {
        self.update_session(id, |s| s.title = title.to_string())
    }

    pub fn set_group(&self, id: &str, group: Option<String>) -> Result<Session> {
        self.update_session(id, |s| s.group = group.clone())
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<Session> {
        self.update_session(id, |s| s.pinned = pinned)
    }

    pub async fn set_archived(&self, id: &str, archived: bool) -> Result<Session> {
        if archived {
            self.stop(id).await?;
        }
        self.update_session(id, |s| s.archived = archived)
    }

    /// Stop the process(es) behind a session but keep it (resumable).
    pub async fn stop(&self, id: &str) -> Result<()> {
        let _ = self.get_session(id)?;
        let (driver, pty) = {
            let mut rt = self.inner.runtimes.lock();
            let rt = rt.entry(id.to_string()).or_default();
            (rt.driver.take(), rt.pty.take())
        };
        if let Some(d) = driver {
            let _ = d.stop().await;
        }
        if let Some(p) = pty {
            let _ = self.inner.store.save_scrollback(id, &p.scrollback());
            if !p.has_exited() {
                let _ = p.kill();
            }
        }
        let _ = self.update_session(id, |s| {
            s.status = match s.mode {
                SessionMode::Terminal => SessionStatus::Exited,
                SessionMode::Structured => SessionStatus::Idle,
            };
            s.pending_count = 0;
        });
        if let Some(rt) = self.inner.runtimes.lock().get_mut(id) {
            rt.pending_approvals.clear();
            rt.pending_inputs.clear();
            rt.current_turn = None;
            rt.live_items.clear();
        }
        Ok(())
    }

    /// Re-run the command of an exited terminal session.
    pub async fn restart(&self, id: &str) -> Result<Session> {
        let s = self.get_session(id)?;
        if s.mode != SessionMode::Terminal {
            bail!("only terminal sessions can be restarted");
        }
        self.stop(id).await?;
        self.spawn_pty(id).await?;
        self.get_session(id)
    }

    /// Stop and permanently remove a session and its history.
    pub async fn delete(&self, id: &str, remove_worktree: bool) -> Result<()> {
        let s = self.get_session(id)?;
        self.stop(id).await?;
        self.inner.runtimes.lock().remove(id);
        self.inner.sessions.lock().remove(id);
        self.inner.store.delete_session(id)?;
        if remove_worktree {
            if let (Some(wt), Some(backend)) = (&s.worktree, &self.inner.worktrees) {
                if let Err(e) = backend.remove(wt) {
                    tracing::warn!("remove worktree failed: {e}");
                }
            }
        }
        self.broadcast(Event::SessionRemoved { session_id: id.into() });
        Ok(())
    }

    /// Switch between the structured view and the provider's own TUI. The
    /// session can only run in one mode at a time.
    pub async fn switch_mode(&self, id: &str, mode: SessionMode) -> Result<Session> {
        let s = self.get_session(id)?;
        if s.mode == mode {
            return Ok(s);
        }
        let provider = self.provider(s.provider)?;
        match mode {
            SessionMode::Terminal => {
                let argv = provider.terminal_command(&s);
                if argv.is_empty() {
                    bail!("provider has no terminal command");
                }
                self.stop(id).await?;
                self.update_session(id, |x| {
                    x.mode = SessionMode::Terminal;
                    x.command = Some(argv.clone());
                })?;
                self.spawn_pty(id).await?;
            }
            SessionMode::Structured => {
                if !provider.capabilities().structured {
                    bail!("provider has no structured mode");
                }
                self.stop(id).await?;
                self.update_session(id, |x| {
                    x.mode = SessionMode::Structured;
                    x.status = SessionStatus::Idle;
                })?;
                if let Err(e) = self.ensure_driver(id, false).await {
                    self.set_error(id, &e.to_string());
                    return Err(e);
                }
            }
        }
        self.get_session(id)
    }

    // ------------------------------------------------------------------- pty

    pub fn pty_input(&self, id: &str, data: &[u8]) -> Result<()> {
        let pty = self.pty(id).ok_or_else(|| anyhow!("session has no terminal"))?;
        pty.write(data)
    }

    pub fn pty_resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(p) = self.pty(id) {
            p.resize(cols, rows)?;
        }
        Ok(())
    }

    /// Current screen history: live buffer if running, else the saved copy.
    pub fn pty_scrollback(&self, id: &str) -> Result<Vec<u8>> {
        if let Some(p) = self.pty(id) {
            return Ok(p.scrollback());
        }
        Ok(self.inner.store.load_scrollback(id)?.unwrap_or_default())
    }

    async fn spawn_pty(&self, id: &str) -> Result<()> {
        let s = self.get_session(id)?;
        let argv = s.command.clone().unwrap_or_else(aura_pty::default_shell);
        let mut spec = PtySpec::new(argv, s.cwd.clone());
        spec.env.push(("AURA_SESSION_ID".into(), id.to_string()));
        let handle = PtyHandle::spawn(spec)?;
        if let Some(saved) = self.inner.store.load_scrollback(id)? {
            handle.seed_scrollback(&saved);
        }
        self.inner.runtimes.lock().entry(id.to_string()).or_default().pty = Some(handle.clone());
        self.update_session(id, |x| {
            x.status = SessionStatus::Running;
            x.exit_code = None;
            x.last_error = None;
        })?;
        let me = self.clone();
        let sid = id.to_string();
        tokio::spawn(async move {
            let mut rx = handle.subscribe();
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
            let mut dirty = false;
            loop {
                tokio::select! {
                    chunk = rx.recv() => match chunk {
                        Ok(data) => {
                            dirty = true;
                            let _ = me.inner.pty_out.send(PtyChunk { session_id: sid.clone(), data });
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    _ = tick.tick() => {
                        if dirty {
                            dirty = false;
                            let _ = me.inner.store.save_scrollback(&sid, &handle.scrollback());
                        }
                    }
                    code = handle.wait() => {
                        // drain remaining output briefly
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        while let Ok(data) = rx.try_recv() {
                            let _ = me.inner.pty_out.send(PtyChunk { session_id: sid.clone(), data });
                        }
                        let _ = me.inner.store.save_scrollback(&sid, &handle.scrollback());
                        let still_ours = me.inner.runtimes.lock().get(&sid)
                            .and_then(|r| r.pty.as_ref().map(|p| p.same(&handle)))
                            .unwrap_or(false);
                        if still_ours {
                            if let Some(rt) = me.inner.runtimes.lock().get_mut(&sid) { rt.pty = None; }
                            me.publish(Event::ProcessExited { session_id: sid.clone(), exit_code: code, message: None });
                        }
                        break;
                    }
                }
            }
        });
        Ok(())
    }

    // ---------------------------------------------------------------- drivers

    fn driver(&self, id: &str) -> Option<Arc<dyn Driver>> {
        self.inner.runtimes.lock().get(id).and_then(|r| r.driver.clone())
    }

    fn pty(&self, id: &str) -> Option<PtyHandle> {
        self.inner.runtimes.lock().get(id).and_then(|r| r.pty.clone())
    }

    async fn ensure_driver(&self, id: &str, fork: bool) -> Result<Arc<dyn Driver>> {
        if let Some(d) = self.driver(id) {
            return Ok(d);
        }
        let s = self.get_session(id)?;
        if s.mode != SessionMode::Structured {
            bail!("session is in terminal mode");
        }
        let provider = self.provider(s.provider)?;
        if !provider.capabilities().structured {
            bail!("provider {:?} has no structured mode", s.provider);
        }
        let resuming = s.native_id.is_some() && !fork && !self.inner.store.events(id, 0, 1)?.is_empty();
        {
            let mut rts = self.inner.runtimes.lock();
            let rt = rts.entry(id.to_string()).or_default();
            rt.replaying = resuming;
        }
        let driver: Arc<dyn Driver> = Arc::from(provider.start(&s, fork, self.inner.sink.clone()).await?);
        self.inner.runtimes.lock().entry(id.to_string()).or_default().driver = Some(driver.clone());
        let _ = self.update_session(id, |x| {
            if x.status == SessionStatus::Exited || x.status == SessionStatus::Error {
                x.status = SessionStatus::Idle;
            }
            x.last_error = None;
        });
        Ok(driver)
    }

    // ------------------------------------------------------------- internals

    fn broadcast(&self, event: Event) {
        let _ = self.inner.events.send(event);
    }

    /// Route an event through the same path drivers use (persist + state + broadcast).
    fn publish(&self, event: Event) {
        let _ = self.inner.sink.send(event);
    }

    fn set_error(&self, id: &str, msg: &str) {
        let _ = self.update_session(id, |s| {
            s.status = SessionStatus::Error;
            s.last_error = Some(msg.to_string());
        });
    }

    fn update_session(&self, id: &str, f: impl FnOnce(&mut Session)) -> Result<Session> {
        let updated = {
            let mut sessions = self.inner.sessions.lock();
            let s = sessions.get_mut(id).ok_or_else(|| anyhow!("unknown session {id}"))?;
            f(s);
            s.last_activity = crate::now();
            s.clone()
        };
        self.inner.store.upsert_session(&updated)?;
        self.broadcast(Event::SessionUpdated { session: updated.clone() });
        Ok(updated)
    }

    fn spawn_event_loop(&self, mut rx: mpsc::UnboundedReceiver<Event>) {
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                me.handle_event(ev);
            }
        });
    }

    fn handle_event(&self, ev: Event) {
        let sid = ev.session_id().to_string();
        let replaying = {
            let mut rts = self.inner.runtimes.lock();
            let rt = rts.entry(sid.clone()).or_default();
            if matches!(ev, Event::TurnStarted { .. } | Event::ProcessExited { .. }) {
                rt.replaying = false;
                false
            } else {
                rt.replaying
            }
        };
        let skip_persist = replaying && matches!(ev, Event::ItemStarted { .. } | Event::ItemCompleted { .. } | Event::TurnCompleted { .. });
        if ev.is_persistent() && !skip_persist {
            if let Err(e) = self.inner.store.append_event(&sid, &ev) {
                tracing::warn!("persist event failed: {e}");
            }
        }
        // Update in-memory runtime state.
        {
            let mut rts = self.inner.runtimes.lock();
            let rt = rts.entry(sid.clone()).or_default();
            match &ev {
                Event::TurnStarted { turn, .. } => rt.current_turn = Some(turn.clone()),
                Event::TurnCompleted { .. } => {
                    rt.current_turn = None;
                    rt.live_items.clear();
                }
                Event::ItemStarted { item, .. } => {
                    rt.live_items.insert(item.id.clone(), item.clone());
                }
                Event::ItemDelta { item_id, delta, .. } => {
                    if let Some(item) = rt.live_items.get_mut(item_id) {
                        apply_delta(item, delta);
                    }
                }
                Event::ItemCompleted { item, .. } => {
                    rt.live_items.remove(&item.id);
                }
                Event::ApprovalRequested { approval, .. } => {
                    rt.pending_approvals.insert(approval.id.clone(), approval.clone());
                }
                Event::ApprovalResolved { approval_id, .. } => {
                    rt.pending_approvals.remove(approval_id);
                }
                Event::UserInputRequested { request, .. } => {
                    rt.pending_inputs.insert(request.id.clone(), request.clone());
                }
                Event::UserInputResolved { request_id, .. } => {
                    rt.pending_inputs.remove(request_id);
                }
                Event::ProcessExited { .. } => {
                    rt.driver = None;
                    rt.pending_approvals.clear();
                    rt.pending_inputs.clear();
                    rt.current_turn = None;
                    rt.live_items.clear();
                }
                _ => {}
            }
        }
        let pending = self
            .inner
            .runtimes
            .lock()
            .get(&sid)
            .map(|r| (r.pending_approvals.len() + r.pending_inputs.len()) as u32)
            .unwrap_or(0);
        let running = self.inner.runtimes.lock().get(&sid).map(|r| r.current_turn.is_some()).unwrap_or(false);

        // Update the session row.
        let _ = self.update_session(&sid, |s| {
            s.pending_count = pending;
            match &ev {
                Event::TurnStarted { .. } => s.status = SessionStatus::Running,
                Event::TurnCompleted { turn, .. } => {
                    s.status = if pending > 0 {
                        SessionStatus::WaitingApproval
                    } else {
                        SessionStatus::Idle
                    };
                    if let Some(u) = &turn.usage {
                        s.usage = u.clone();
                    }
                    if turn.status == TurnStatus::Failed {
                        s.last_error = turn.error.clone();
                    }
                }
                Event::ApprovalRequested { .. } => s.status = SessionStatus::WaitingApproval,
                Event::UserInputRequested { .. } => s.status = SessionStatus::WaitingInput,
                Event::ApprovalResolved { .. } | Event::UserInputResolved { .. } => {
                    if pending > 0 {
                        // keep waiting state for the remaining ones
                    } else if running {
                        s.status = SessionStatus::Running;
                    } else {
                        s.status = SessionStatus::Idle;
                    }
                }
                Event::NativeId { native_id, .. } => s.native_id = Some(native_id.clone()),
                Event::Usage { usage, .. } => s.usage = usage.clone(),
                Event::SettingChanged { setting, .. } => match setting {
                    Setting::Model(m) => s.model = Some(m.clone()),
                    Setting::Effort(e) => s.effort = Some(e.clone()),
                    Setting::PermissionMode(p) => s.permission_mode = Some(p.clone()),
                    Setting::SandboxMode(p) => s.sandbox_mode = Some(p.clone()),
                },
                Event::ProcessExited { exit_code, message, .. } => {
                    s.exit_code = *exit_code;
                    match s.mode {
                        SessionMode::Terminal => s.status = SessionStatus::Exited,
                        SessionMode::Structured => {
                            if let Some(m) = message {
                                s.status = SessionStatus::Error;
                                s.last_error = Some(m.clone());
                            } else {
                                s.status = SessionStatus::Idle;
                            }
                        }
                    }
                }
                Event::Notice { level: NoticeLevel::Error, message, .. } => {
                    s.last_error = Some(message.clone());
                }
                _ => {}
            }
        });
        self.broadcast(ev);
    }
}

pub fn apply_delta(item: &mut Item, delta: &ItemDelta) {
    match delta {
        ItemDelta::Text { text } => item.text.push_str(text),
        ItemDelta::Output { text } => {
            let out = item.data.get("output").and_then(|v| v.as_str()).unwrap_or("").to_string() + text;
            if let Some(obj) = item.data.as_object_mut() {
                obj.insert("output".into(), serde_json::Value::String(out));
            } else {
                item.data = serde_json::json!({ "output": out });
            }
        }
        ItemDelta::Data { data } => {
            if let (Some(dst), Some(src)) = (item.data.as_object_mut(), data.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            } else {
                item.data = data.clone();
            }
        }
    }
}

