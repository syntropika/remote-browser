//! Exclusive tab reservations for the lifetime of an engine session.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservationInfo {
    pub task: String,
    pub agent_name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub tab_id: String,
    pub lease_id: String,
    pub task: String,
    pub agent_name: String,
}
struct Entry {
    token: String,
    client: String,
    info: ReservationInfo,
}
#[derive(Default)]
pub struct Reservations {
    entries: HashMap<String, Entry>,
}
impl Reservations {
    pub fn info(&self, tab: &str) -> Option<ReservationInfo> {
        self.entries.get(tab).map(|entry| entry.info.clone())
    }
    pub fn check_for(&self, tab: &str, token: Option<&str>, client: &str) -> Result<()> {
        match (self.entries.get(tab), token) {
            (Some(entry), Some(token)) if entry.token == token && entry.client == client => Ok(()),
            (Some(_), _) => Err(Error::Invalid(
                "This tab is reserved; supply its matching leaseId".into(),
            )),
            (None, Some(_)) => Err(Error::Invalid(
                "Lease was released or revoked; reserve the tab again".into(),
            )),
            (None, None) => Ok(()),
        }
    }
    pub fn reserve_named_for(
        &mut self,
        tab: &str,
        task: &str,
        agent_name: &str,
        client: &str,
    ) -> Result<Lease> {
        self.check_for(tab, None, client)?;
        for (name, value) in [("agentName", agent_name), ("task", task)] {
            if value.trim().is_empty()
                || value.chars().count() > 120
                || value.chars().any(char::is_control)
            {
                return Err(Error::Invalid(format!(
                    "{name} must contain 1 to 120 characters without controls"
                )));
            }
        }
        let info = ReservationInfo {
            task: task.trim().into(),
            agent_name: agent_name.trim().into(),
        };
        let token = Uuid::new_v4().to_string();
        self.entries.insert(
            tab.into(),
            Entry {
                token: token.clone(),
                client: client.into(),
                info: info.clone(),
            },
        );
        Ok(Lease {
            tab_id: tab.into(),
            lease_id: token,
            task: info.task,
            agent_name: info.agent_name,
        })
    }
    pub fn release_for(&mut self, tab: &str, token: &str, client: &str) -> Result<()> {
        self.check_for(tab, Some(token), client)?;
        self.remove(tab);
        Ok(())
    }
    pub fn remove(&mut self, tab: &str) {
        self.entries.remove(tab);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_requires_both_client_and_token_and_names_are_not_credentials() {
        let mut registry = Reservations::default();
        let a = registry
            .reserve_named_for("a", "work", "Agent", "key-a")
            .unwrap();
        let b = registry
            .reserve_named_for("b", "work", "Agent", "key-a")
            .unwrap();
        assert!(registry.check_for("a", None, "key-a").is_err());
        assert!(registry.check_for("a", Some(&b.lease_id), "key-a").is_err());
        assert!(registry.check_for("a", Some(&a.lease_id), "key-b").is_err());
        assert!(registry.release_for("a", &a.lease_id, "key-b").is_err());
        assert!(
            registry
                .reserve_named_for("a", "other", "Agent", "key-a")
                .is_err()
        );
        assert!(registry.check_for("a", Some(&a.lease_id), "key-a").is_ok());
        let listed = serde_json::to_string(&registry.info("a")).unwrap();
        assert!(!listed.contains(&a.lease_id));
        assert!(!listed.contains("expiresAt"));
    }
    #[test]
    fn release_and_takeover_permanently_invalidate_old_tokens() {
        let mut registry = Reservations::default();
        let a = registry
            .reserve_named_for("a", "work", "Agent", "key-a")
            .unwrap();
        registry.release_for("a", &a.lease_id, "key-a").unwrap();
        assert!(registry.check_for("a", Some(&a.lease_id), "key-a").is_err());
        let b = registry
            .reserve_named_for("a", "work", "Agent", "key-a")
            .unwrap();
        assert_ne!(a.lease_id, b.lease_id);
        registry.remove("a");
        assert!(registry.check_for("a", Some(&b.lease_id), "key-a").is_err());
    }
}
