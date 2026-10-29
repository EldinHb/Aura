//! Specialists suggested from repeated ad-hoc work (see
//! [`crate::suggestions`]): the briefs kept, the pass that looks for
//! recurring roles in them, and the suggestions it makes, which the user
//! accepts, edits or dismisses in a feature owner's chat or in the settings.
use super::Manager;
use crate::event::*;
use crate::features::*;
use crate::specialists::{Specialist, SpecialistInput, SpecialistScope};
use crate::suggestions::{self as found, AdHocBrief, SuggestionModel, SuggestionSettings};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use ts_rs::TS;

/// What a suggestion pass came to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SuggestionRun {
    /// The suggestions it made.
    pub suggestions: Vec<SpecialistSuggestion>,
    /// What happened, for the one who asked: why it made none, or which.
    pub note: String,
}

impl SuggestionRun {
    fn none(note: impl Into<String>) -> Self {
        SuggestionRun {
            suggestions: vec![],
            note: note.into(),
        }
    }
}

impl Manager {
    /// The cheap model suggestion passes run on. Without one, a pass that
    /// gets as far as needing it says so.
    pub fn set_suggestion_model(&self, model: Arc<dyn SuggestionModel>) {
        *self.inner.suggestion_model.lock() = Some(model);
    }

    pub fn suggestion_settings(&self) -> SuggestionSettings {
        match self.inner.store.get_setting(found::SETTING_KEY) {
            Ok(Some(raw)) => found::parse_stored(&raw),
            Ok(None) => SuggestionSettings::default(),
            Err(e) => {
                tracing::warn!("suggestion settings: {e:#}");
                SuggestionSettings::default()
            }
        }
    }

    pub fn set_suggestion_settings(&self, s: SuggestionSettings) -> Result<SuggestionSettings> {
        let s = s.tidy();
        self.inner
            .store
            .set_setting(found::SETTING_KEY, &serde_json::to_string(&s)?)?;
        Ok(s)
    }

    /// Keep an ad-hoc worker's brief, past its feature.
    pub(super) fn save_brief(&self, b: &AdHocBrief) {
        let saved = serde_json::to_string(b)
            .map_err(anyhow::Error::from)
            .and_then(|json| {
                self.inner
                    .store
                    .save_feature_record(found::BRIEFS, &b.key(), &json)
            });
        if let Err(e) = saved {
            tracing::warn!("keep the brief of {}: {e:#}", b.worker_id);
        }
    }

    /// Every ad-hoc worker's brief kept, oldest first.
    pub fn adhoc_briefs(&self) -> Result<Vec<AdHocBrief>> {
        let mut out: Vec<AdHocBrief> = self
            .inner
            .store
            .feature_records(found::BRIEFS)?
            .into_iter()
            .filter_map(|(id, json)| match serde_json::from_str(&json) {
                Ok(b) => Some(b),
                Err(e) => {
                    tracing::warn!("skipping unreadable brief {id}: {e}");
                    None
                }
            })
            .collect();
        out.sort_by_key(|b: &AdHocBrief| b.at);
        Ok(out)
    }

    /// The specialists Aura suggested from repeated work, oldest first.
    pub fn role_suggestions(&self) -> Result<Vec<SpecialistSuggestion>> {
        let mut out: Vec<SpecialistSuggestion> = self
            .inner
            .store
            .feature_records(found::NAMESPACE)?
            .into_iter()
            .filter_map(|(id, json)| match serde_json::from_str(&json) {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!("skipping unreadable suggestion {id}: {e}");
                    None
                }
            })
            .collect();
        out.sort_by(|a: &SpecialistSuggestion, b| {
            a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id))
        });
        Ok(out)
    }

    fn save_role_suggestion(&self, s: &SpecialistSuggestion) -> Result<()> {
        self.inner
            .store
            .save_feature_record(found::NAMESPACE, &s.id, &serde_json::to_string(s)?)
    }

    fn announce_role_suggestions(&self) {
        match self.role_suggestions() {
            Ok(suggestions) => self.broadcast(Event::SpecialistSuggestionsUpdated { suggestions }),
            Err(e) => tracing::warn!("suggestions: {e:#}"),
        }
    }

    /// Look for roles that keep coming back in ad-hoc workers' briefs and
    /// suggest them as specialists; for `owner`, the suggestions also show
    /// in its chat. Runs the model only when the pre-filter finds two briefs
    /// alike that no suggestion was made from yet, and one pass at a time.
    pub async fn suggest_specialists(&self, owner: Option<&str>) -> Result<SuggestionRun> {
        if let Some(o) = owner {
            self.feature_owner_session(o)?;
        }
        let settings = self.suggestion_settings();
        if !settings.enabled {
            return Ok(SuggestionRun::none(
                "Suggestions of specialists are off in the settings.",
            ));
        }
        let Ok(_running) = self.inner.suggesting.try_lock() else {
            return Ok(SuggestionRun::none(
                "Aura is already looking for specialists to suggest.",
            ));
        };
        let briefs = self.adhoc_briefs()?;
        let earlier = self.role_suggestions()?;
        let candidates = found::prefilter(&briefs, &earlier);
        if candidates.len() < 2 {
            return Ok(SuggestionRun::none(
                "No two ad-hoc workers' briefs look alike yet that no suggestion was made from, so there is no repeated role to suggest.",
            ));
        }
        let Some(model) = self.inner.suggestion_model.lock().clone() else {
            return Ok(SuggestionRun::none(
                "Aura has no model to look for specialists with.",
            ));
        };
        // The specialists that apply where the briefs come from.
        let projects: BTreeSet<String> = candidates
            .iter()
            .map(|b| b.project.clone())
            .filter(|p| !p.is_empty())
            .collect();
        let global = self.specialists(None)?;
        let mut by_project: HashMap<String, Vec<Specialist>> = HashMap::new();
        let mut all: Vec<Specialist> = global.clone();
        for p in projects {
            let list = self.specialists(Some(&p))?;
            for s in &list {
                if !all.iter().any(|x| x.id == s.id && x.scope == s.scope) {
                    all.push(s.clone());
                }
            }
            by_project.insert(p, list);
        }
        let prompt = found::model_prompt(&candidates, &all);
        let raw = model
            .complete(&settings, &prompt, &found::schema())
            .await
            .map_err(|e| anyhow!("the model could not look for specialists: {e:#}"))?;
        let roles = found::parse_answer(&raw, &candidates)?;
        let mut made: Vec<SpecialistSuggestion> = vec![];
        let mut skipped: Vec<String> = vec![];
        {
            let _guard = self.inner.suggestions.lock();
            let mut known = self.role_suggestions()?;
            for r in roles {
                let applies = match (&r.specialist.scope, &r.specialist.project) {
                    (SpecialistScope::Project, Some(p)) => by_project.get(p).unwrap_or(&global),
                    _ => &global,
                };
                if let Some(id) = found::covered(&r.specialist, applies) {
                    skipped.push(format!(
                        "{} (specialist `{id}` covers it)",
                        r.specialist.name
                    ));
                    continue;
                }
                if found::made_before(&r, &known) {
                    skipped.push(format!("{} (suggested before)", r.specialist.name));
                    continue;
                }
                let features: BTreeSet<&str> =
                    r.evidence.iter().map(|e| e.owner_id.as_str()).collect();
                let s = SpecialistSuggestion {
                    id: next_suggestion_id(&known),
                    reason: format!(
                        "Feature owners started {} ad-hoc workers for this role in {}.",
                        r.evidence.len(),
                        match features.len() {
                            1 => "one feature".to_string(),
                            n => format!("{n} features"),
                        }
                    ),
                    specialist: r.specialist,
                    status: SuggestionStatus::Pending,
                    accepted_id: None,
                    created_at: crate::now(),
                    resolved_at: None,
                    delivered: true,
                    evidence: r.evidence,
                    owner_id: owner.map(str::to_string),
                };
                self.save_role_suggestion(&s)?;
                known.push(s.clone());
                made.push(s);
            }
        }
        if !made.is_empty() {
            self.announce_role_suggestions();
        }
        if let Some(o) = owner.filter(|o| self.feature_owner_session(o).is_ok()) {
            for s in &made {
                self.post_card(
                    o,
                    FeatureCardKind::RoleSuggestion,
                    &s.id,
                    &s.specialist.name,
                );
            }
        }
        let note = match (made.len(), skipped.is_empty()) {
            (0, true) => {
                "The model found no role that comes back in the ad-hoc briefs.".to_string()
            }
            (0, false) => format!("Nothing new to suggest: {}.", skipped.join(", ")),
            (_, _) => format!(
                "Suggested {}; the user accepts, edits or dismisses {}.",
                made.iter()
                    .map(|s| format!("\"{}\"", s.specialist.name))
                    .collect::<Vec<_>>()
                    .join(", "),
                if made.len() == 1 { "it" } else { "them" }
            ),
        };
        Ok(SuggestionRun {
            suggestions: made,
            note,
        })
    }

    /// Run a suggestion pass in the background, as a feature is delivered.
    pub(super) fn suggest_in_background(&self, owner: &str) {
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let (me, owner) = (self.clone(), owner.to_string());
        rt.spawn(async move {
            match me.suggest_specialists(Some(&owner)).await {
                Ok(run) => tracing::debug!("suggestions for {owner}: {}", run.note),
                Err(e) => tracing::warn!("suggest specialists for {owner}: {e:#}"),
            }
        });
    }

    /// The user accepts a suggestion Aura found, as found or as they edited
    /// it (`specialist`, which also says the scope), or dismisses it. Claimed
    /// and saved in one locked step: of two resolutions at once only one
    /// succeeds, and an existing specialist is never overwritten.
    pub fn resolve_role_suggestion(
        &self,
        id: &str,
        accept: bool,
        specialist: Option<SpecialistInput>,
    ) -> Result<SpecialistSuggestion> {
        let s = {
            let _guard = self.inner.suggestions.lock();
            let mut s = self
                .role_suggestions()?
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| anyhow!("no suggestion `{id}`"))?;
            match s.status {
                SuggestionStatus::Pending => {}
                SuggestionStatus::Accepted => bail!("this suggestion was accepted already"),
                SuggestionStatus::Dismissed => bail!("this suggestion was dismissed already"),
            }
            let mut created: Option<Specialist> = None;
            if accept {
                let saved =
                    self.save_new_specialist(specialist.unwrap_or_else(|| s.specialist.clone()))?;
                s.accepted_id = Some(saved.id.clone());
                created = Some(saved);
            }
            s.status = if accept {
                SuggestionStatus::Accepted
            } else {
                SuggestionStatus::Dismissed
            };
            s.resolved_at = Some(crate::now());
            if let Err(e) = self.save_role_suggestion(&s) {
                // Saved, but the suggestion could not be marked: take it back.
                if let Some(c) = created {
                    let _ = self.delete_specialist(&c.id, c.scope, c.project.as_deref());
                }
                return Err(e);
            }
            s
        };
        self.announce_role_suggestions();
        Ok(s)
    }
}

/// `r1`, `r2`, …: one higher than any suggestion has had.
fn next_suggestion_id(known: &[SpecialistSuggestion]) -> String {
    let n = known
        .iter()
        .filter_map(|s| s.id.strip_prefix('r')?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("r{}", n + 1)
}
