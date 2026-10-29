//! The specialists feature owners hire (see [`crate::specialists`]): Aura's
//! built-ins overlaid with what the user saved, globally and per project.
use super::Manager;
use crate::specialists::{self, Specialist, SpecialistInput, SpecialistScope};
use anyhow::{anyhow, bail, Context, Result};
use std::collections::BTreeMap;

impl Manager {
    /// The project a folder belongs to: its repository's root (the main
    /// working tree, also from a linked worktree), or the folder itself when
    /// it is not in one. Asks git, so call it off the async runtime when you can.
    pub fn project_root(&self, cwd: &str) -> String {
        let cwd = cwd.trim().trim_end_matches('/');
        let cwd = if cwd.is_empty() { "/" } else { cwd };
        self.repo_root(cwd).unwrap_or_else(|| cwd.to_string())
    }

    fn stored_specialists(&self, namespace: &str) -> Result<Vec<Specialist>> {
        Ok(self
            .inner
            .store
            .feature_records(namespace)?
            .into_iter()
            .filter_map(|(id, json)| match serde_json::from_str(&json) {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!("skipping unreadable specialist {id} in {namespace}: {e}");
                    None
                }
            })
            .collect())
    }

    /// The global specialists: the built-ins the user did not delete, as the
    /// user edited them, then the user's own, by name.
    fn global_specialists(&self) -> Result<Vec<Specialist>> {
        let hidden: Vec<String> = self
            .inner
            .store
            .feature_records(specialists::HIDDEN)?
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        let mut saved: BTreeMap<String, Specialist> = self
            .stored_specialists(specialists::GLOBAL)?
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();
        let mut out = vec![];
        for b in specialists::built_ins() {
            if hidden.contains(&b.id) {
                saved.remove(&b.id);
                continue;
            }
            out.push(match saved.remove(&b.id) {
                Some(mut s) => {
                    s.built_in = true;
                    s.customized = true;
                    s
                }
                None => b,
            });
        }
        let mut own: Vec<Specialist> = saved.into_values().collect();
        own.sort_by_key(|s| s.name.to_lowercase());
        out.extend(own);
        Ok(out)
    }

    /// The specialists that apply in `project` (a project root, see
    /// [`Self::project_root`]): its own, then the global ones it does not
    /// override. Without a project, the global ones.
    pub fn specialists(&self, project: Option<&str>) -> Result<Vec<Specialist>> {
        let global = self.global_specialists()?;
        let Some(project) = project.map(str::trim).filter(|p| !p.is_empty()) else {
            return Ok(global);
        };
        let mut own = self.stored_specialists(&specialists::project_namespace(project))?;
        own.sort_by_key(|s| s.name.to_lowercase());
        let mut out: Vec<Specialist> = vec![];
        // A project's specialist takes the place of the global one it overrides.
        for g in global {
            match own.iter().position(|o| o.id == g.id) {
                Some(i) => out.push(own.remove(i)),
                None => out.push(g),
            }
        }
        out.extend(own);
        Ok(out)
    }

    /// The specialists for a worker in `cwd`.
    pub fn specialists_for_dir(&self, cwd: &str) -> Result<Vec<Specialist>> {
        let project = self.project_root(cwd);
        self.specialists(Some(&project))
    }

    /// The specialist with this id that applies in `project`.
    pub fn specialist(&self, id: &str, project: Option<&str>) -> Result<Specialist> {
        let all = self.specialists(project)?;
        all.iter()
            .find(|s| s.id == id.trim())
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "no specialist `{}`; the ones there are: {}",
                    id.trim(),
                    all.iter()
                        .map(|s| format!("`{}`", s.id))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
    }

    /// Create or change a specialist. Saving a built-in keeps it a built-in
    /// that can be reset; saving a deleted one brings it back.
    pub fn save_specialist(&self, input: SpecialistInput) -> Result<Specialist> {
        let mut input = specialists::validate(input)?;
        if input.scope == SpecialistScope::Project {
            let root = self.project_root(input.project.as_deref().unwrap_or_default());
            input.project = Some(root);
        }
        let namespace = match input.scope {
            SpecialistScope::Global => specialists::GLOBAL.to_string(),
            SpecialistScope::Project => {
                specialists::project_namespace(input.project.as_deref().unwrap_or_default())
            }
        };
        let _guard = self.inner.specialists.lock();
        let now = crate::now();
        let existing = self
            .stored_specialists(&namespace)?
            .into_iter()
            .find(|s| s.id == input.id);
        let built_in =
            input.scope == SpecialistScope::Global && specialists::built_in(&input.id).is_some();
        let s = Specialist {
            id: input.id,
            name: input.name,
            role: input.role,
            description: input.description,
            instructions: input.instructions,
            agent: input.agent,
            model: input.model,
            effort: input.effort,
            scope: input.scope,
            project: input.project,
            built_in,
            customized: built_in,
            created_at: existing.map(|e| e.created_at).unwrap_or(now),
            updated_at: now,
        };
        self.inner
            .store
            .save_feature_record(&namespace, &s.id, &serde_json::to_string(&s)?)?;
        if built_in {
            self.inner
                .store
                .delete_feature_record(specialists::HIDDEN, &s.id)?;
        }
        Ok(s)
    }

    /// Delete a specialist. A built-in is hidden, so resetting it brings it back.
    pub fn delete_specialist(
        &self,
        id: &str,
        scope: SpecialistScope,
        project: Option<&str>,
    ) -> Result<()> {
        let _guard = self.inner.specialists.lock();
        match scope {
            SpecialistScope::Global => {
                let known = self.global_specialists()?.iter().any(|s| s.id == id);
                if !known {
                    bail!("no global specialist `{id}`");
                }
                self.inner
                    .store
                    .delete_feature_record(specialists::GLOBAL, id)?;
                if specialists::built_in(id).is_some() {
                    self.inner
                        .store
                        .save_feature_record(specialists::HIDDEN, id, "{}")?;
                }
            }
            SpecialistScope::Project => {
                let root = self.project_root(
                    project
                        .filter(|p| !p.trim().is_empty())
                        .context("a project specialist needs the project's path")?,
                );
                let namespace = specialists::project_namespace(&root);
                if !self
                    .stored_specialists(&namespace)?
                    .iter()
                    .any(|s| s.id == id)
                {
                    bail!("{root} has no specialist `{id}` of its own");
                }
                self.inner.store.delete_feature_record(&namespace, id)?;
            }
        }
        Ok(())
    }

    /// Bring a built-in back as Aura ships it, edited or deleted.
    pub fn reset_specialist(&self, id: &str) -> Result<Specialist> {
        let b = specialists::built_in(id)
            .ok_or_else(|| anyhow!("`{id}` is not a built-in specialist"))?;
        let _guard = self.inner.specialists.lock();
        self.inner
            .store
            .delete_feature_record(specialists::GLOBAL, id)?;
        self.inner
            .store
            .delete_feature_record(specialists::HIDDEN, id)?;
        Ok(b)
    }

    /// The built-ins the user deleted, which resetting brings back.
    pub fn hidden_specialists(&self) -> Result<Vec<Specialist>> {
        let hidden: Vec<String> = self
            .inner
            .store
            .feature_records(specialists::HIDDEN)?
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        Ok(specialists::built_ins()
            .into_iter()
            .filter(|b| hidden.contains(&b.id))
            .collect())
    }
}
