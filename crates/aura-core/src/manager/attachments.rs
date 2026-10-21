//! Images sent with a message. Each is copied to
//! `<data_dir>/attachments/<session>/` so the transcript can enlarge it later,
//! and the user message it was sent with records them in `data.attachments`:
//! `{ id, name, media_type, width, height, original_width, original_height,
//! thumbnail }`. The kept file is what the agent got, after any shrinking.
//!
//! Providers emit the user message themselves (Codex only once the server
//! echoes it), so what a send attached is staged per session and added to the
//! first top-level user message with the same text. Other data a message
//! carries is staged the same way: a message from an orchestrator to its
//! worker records `data.from_orchestrator`, the orchestrator's id.

use super::Manager;
use crate::event::Event;
use crate::types::{Input, ItemKind};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

/// Sends whose user message has not shown up yet; older ones are dropped.
const MAX_STAGED: usize = 16;

#[derive(Default)]
pub(super) struct Staged {
    /// Text of each send and the data its user message gets.
    sends: VecDeque<(String, Map<String, Value>)>,
    /// Data of user messages that started but have not completed.
    by_item: std::collections::HashMap<String, Map<String, Value>>,
}

impl Manager {
    /// Keep sent images under `dir`. Without it the transcript still shows
    /// their previews, but cannot enlarge them.
    pub fn enable_attachments(&self, dir: PathBuf) {
        *self.inner.attachments_dir.lock() = Some(dir);
    }

    pub(super) fn stage_attachments(&self, id: &str, input: &Input) {
        if input.images.is_empty() {
            return;
        }
        let dir = self.inner.attachments_dir.lock().clone();
        let refs = input
            .images
            .iter()
            .map(|img| {
                let media_type = img
                    .media_type
                    .clone()
                    .or_else(|| img.path.as_deref().map(|p| media_type_of(p).to_string()));
                let stored = dir.as_deref().and_then(|dir| {
                    save(
                        dir,
                        id,
                        img.data.as_deref(),
                        img.path.as_deref(),
                        media_type.as_deref(),
                    )
                    .map_err(|e| tracing::warn!("keep attachment: {e:#}"))
                    .ok()
                });
                let name = img.name.clone().or_else(|| {
                    img.path
                        .as_deref()
                        .and_then(|p| Path::new(p).file_name())
                        .map(|n| n.to_string_lossy().into_owned())
                });
                json!({
                    "id": stored,
                    "name": name,
                    "media_type": media_type,
                    "width": img.width,
                    "height": img.height,
                    "original_width": img.original_width,
                    "original_height": img.original_height,
                    "thumbnail": img.thumbnail,
                })
            })
            .collect();
        self.stage_data(id, &input.text, "attachments", Value::Array(refs));
    }

    /// Give the user message the next send of `text` makes `data.<key> = value`.
    pub(super) fn stage_data(&self, id: &str, text: &str, key: &str, value: Value) {
        let mut rts = self.inner.runtimes.lock();
        let staged = &mut rts.entry(id.to_string()).or_default().staged;
        staged.sends.push_back((
            text.trim().to_string(),
            Map::from_iter([(key.to_string(), value)]),
        ));
        while staged.sends.len() > MAX_STAGED {
            staged.sends.pop_front();
        }
    }

    /// The send failed, so no user message will carry what it staged.
    pub(super) fn unstage(&self, id: &str, text: &str) {
        if let Some(rt) = self.inner.runtimes.lock().get_mut(id) {
            let text = text.trim();
            if let Some(pos) = rt.staged.sends.iter().rposition(|(t, _)| t == text) {
                rt.staged.sends.remove(pos);
            }
        }
    }

    /// Adds staged data to the user message it was sent with.
    pub(super) fn attach_staged(&self, ev: &mut Event) {
        let completed = matches!(ev, Event::ItemCompleted { .. });
        let (Event::ItemStarted { session_id, item } | Event::ItemCompleted { session_id, item }) =
            ev
        else {
            return;
        };
        if item.kind != ItemKind::UserMessage || item.parent_id.is_some() {
            return;
        }
        let mut rts = self.inner.runtimes.lock();
        let Some(staged) = rts.get_mut(session_id.as_str()).map(|rt| &mut rt.staged) else {
            return;
        };
        let extra = match staged.by_item.get(&item.id) {
            Some(extra) => extra.clone(),
            None => {
                let text = item.text.trim();
                let Some(pos) = staged.sends.iter().position(|(t, _)| t == text) else {
                    return;
                };
                let (_, extra) = staged.sends.remove(pos).unwrap_or_default();
                staged.by_item.insert(item.id.clone(), extra.clone());
                extra
            }
        };
        if completed {
            staged.by_item.remove(&item.id);
        }
        match &mut item.data {
            Value::Object(map) => map.extend(extra),
            data @ Value::Null => *data = Value::Object(extra),
            _ => {}
        }
    }

    /// A kept image as `(base64 data, media type)`.
    pub fn attachment(&self, session_id: &str, id: &str) -> Result<(String, String)> {
        let dir = self
            .inner
            .attachments_dir
            .lock()
            .clone()
            .ok_or_else(|| anyhow!("attachments are not kept"))?;
        if !safe_segment(session_id) || !safe_segment(id) {
            bail!("invalid attachment id");
        }
        let path = dir.join(session_id).join(id);
        let bytes = std::fs::read(&path).with_context(|| format!("attachment {id}"))?;
        Ok((
            base64::engine::general_purpose::STANDARD.encode(bytes),
            media_type_of(id).to_string(),
        ))
    }

    pub(super) fn delete_attachments(&self, session_id: &str) {
        let Some(dir) = self.inner.attachments_dir.lock().clone() else {
            return;
        };
        if !safe_segment(session_id) {
            return;
        }
        let dir = dir.join(session_id);
        if dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                tracing::warn!("remove attachments of {session_id}: {e}");
            }
        }
    }
}

/// Copies the image into the session's attachment directory; returns its id.
fn save(
    dir: &Path,
    session_id: &str,
    data: Option<&str>,
    path: Option<&str>,
    media_type: Option<&str>,
) -> Result<String> {
    if !safe_segment(session_id) {
        bail!("invalid session id");
    }
    let bytes = match (data, path) {
        (Some(d), _) => base64::engine::general_purpose::STANDARD
            .decode(d.trim())
            .context("decode image")?,
        (None, Some(p)) => std::fs::read(p).with_context(|| format!("read image {p}"))?,
        (None, None) => bail!("image has neither data nor path"),
    };
    let ext = match media_type.unwrap_or("image/png") {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    let dir = dir.join(session_id);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let id = format!("{}.{ext}", crate::new_id());
    std::fs::write(dir.join(&id), bytes).with_context(|| format!("write attachment {id}"))?;
    Ok(id)
}

/// One path component made of ids, never `..` or a separator.
fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('.')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn media_type_of(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}
