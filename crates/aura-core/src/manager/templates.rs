//! Session templates (see [`crate::templates`]), a feature-record
//! namespace keyed by id. Every change is announced with
//! [`Event::TemplatesChanged`].

use super::*;
use crate::templates::{validate, SessionTemplate, TemplateInput};

const TEMPLATES: &str = "session_templates";

impl Manager {
    /// Every template, by name.
    pub fn list_templates(&self) -> Result<Vec<SessionTemplate>> {
        let mut all: Vec<SessionTemplate> = self
            .inner
            .store
            .feature_records(TEMPLATES)?
            .into_iter()
            .filter_map(|(id, json)| match serde_json::from_str(&json) {
                Ok(t) => Some(t),
                Err(e) => {
                    tracing::warn!("skipping unreadable session template {id}: {e}");
                    None
                }
            })
            .collect();
        all.sort_by(|a, b| {
            a.input
                .name
                .to_lowercase()
                .cmp(&b.input.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(all)
    }

    pub fn create_template(&self, input: TemplateInput) -> Result<SessionTemplate> {
        let template = {
            let _guard = self.inner.templates.lock();
            let all = self.list_templates()?;
            let names: Vec<&str> = all.iter().map(|t| t.input.name.as_str()).collect();
            let now = crate::now();
            let template = SessionTemplate {
                id: crate::new_id(),
                created_at: now,
                updated_at: now,
                input: validate(input, &names)?,
            };
            self.save_template(&template)?;
            template
        };
        self.templates_changed();
        Ok(template)
    }

    /// Replace a template's options (its name included).
    pub fn update_template(&self, id: &str, input: TemplateInput) -> Result<SessionTemplate> {
        let template = {
            let _guard = self.inner.templates.lock();
            let all = self.list_templates()?;
            let Some(old) = all.iter().find(|t| t.id == id) else {
                bail!("unknown template {id}");
            };
            let names: Vec<&str> = all
                .iter()
                .filter(|t| t.id != id)
                .map(|t| t.input.name.as_str())
                .collect();
            let template = SessionTemplate {
                id: old.id.clone(),
                created_at: old.created_at,
                updated_at: crate::now(),
                input: validate(input, &names)?,
            };
            self.save_template(&template)?;
            template
        };
        self.templates_changed();
        Ok(template)
    }

    pub fn delete_template(&self, id: &str) -> Result<()> {
        {
            let _guard = self.inner.templates.lock();
            if !self.list_templates()?.iter().any(|t| t.id == id) {
                bail!("unknown template {id}");
            }
            self.inner.store.delete_feature_record(TEMPLATES, id)?;
        }
        self.templates_changed();
        Ok(())
    }

    fn save_template(&self, t: &SessionTemplate) -> Result<()> {
        self.inner
            .store
            .save_feature_record(TEMPLATES, &t.id, &serde_json::to_string(t)?)
    }

    fn templates_changed(&self) {
        match self.list_templates() {
            Ok(templates) => self.broadcast(Event::TemplatesChanged { templates }),
            Err(e) => tracing::warn!("listing session templates failed: {e}"),
        }
    }
}
