//! Cooperative task reservations scoped to one automation session.
use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservationInfo {
    pub task: String,
    #[serde(default)]
    pub agent_name: String,
    pub expires_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub tab_id: String,
    pub lease_id: String,
    pub task: String,
    #[serde(default)]
    pub agent_name: String,
    pub ttl_ms: u64,
    pub expires_at: u64,
}

struct Entry {
    token: String,
    client: String,
    info: ReservationInfo,
    deadline: Instant,
}

#[derive(Default)]
pub struct Reservations {
    entries: HashMap<String, Entry>,
}

impl Reservations {
    fn prune(&mut self, now: Instant) {
        self.entries.retain(|_, entry| entry.deadline > now);
    }

    pub fn info(&mut self, tab: &str, now: Instant) -> Option<ReservationInfo> {
        self.prune(now);
        self.entries.get(tab).map(|entry| entry.info.clone())
    }

    pub fn check(&mut self, tab: &str, token: Option<&str>, now: Instant) -> Result<()> {
        self.check_for(tab, token, "stdio", now)
    }
    pub fn check_for(
        &mut self,
        tab: &str,
        token: Option<&str>,
        client: &str,
        now: Instant,
    ) -> Result<()> {
        self.prune(now);
        match (self.entries.get(tab), token) {
            (Some(entry), Some(token)) if entry.token == token && entry.client == client => Ok(()),
            (Some(_), _) => Err(Error::Invalid(
                "This tab is reserved; supply its matching leaseId".into(),
            )),
            (None, Some(_)) => Err(Error::Invalid(
                "Lease expired or was released; reserve the tab again".into(),
            )),
            (None, None) => Ok(()),
        }
    }

    pub fn reserve(&mut self, tab: &str, task: &str, ttl_ms: u64, now: Instant) -> Result<Lease> {
        self.reserve_for(tab, task, ttl_ms, "stdio", now)
    }
    pub fn reserve_for(
        &mut self,
        tab: &str,
        task: &str,
        ttl_ms: u64,
        client: &str,
        now: Instant,
    ) -> Result<Lease> {
        self.reserve_named_for(tab, task, task, ttl_ms, client, now)
    }
    pub fn reserve_named_for(
        &mut self,
        tab: &str,
        task: &str,
        agent_name: &str,
        ttl_ms: u64,
        client: &str,
        now: Instant,
    ) -> Result<Lease> {
        self.check_for(tab, None, client, now)?;
        if agent_name.trim().is_empty()
            || agent_name.chars().count() > 120
            || agent_name.chars().any(char::is_control)
        {
            return Err(Error::Invalid(
                "agentName must contain 1 to 120 characters without controls".into(),
            ));
        }
        if task.trim().is_empty() || task.chars().count() > 120 {
            return Err(Error::Invalid(
                "Task must contain 1 to 120 characters".into(),
            ));
        }
        let lease = lease(tab, task, agent_name, Uuid::new_v4().to_string(), ttl_ms)?;
        self.entries.insert(
            tab.into(),
            Entry {
                token: lease.lease_id.clone(),
                client: client.into(),
                info: ReservationInfo {
                    task: lease.task.clone(),
                    agent_name: lease.agent_name.clone(),
                    expires_at: lease.expires_at,
                },
                deadline: now + Duration::from_millis(ttl_ms),
            },
        );
        Ok(lease)
    }

    pub fn renew(&mut self, tab: &str, token: &str, ttl_ms: u64, now: Instant) -> Result<Lease> {
        self.renew_for(tab, token, ttl_ms, "stdio", now)
    }
    pub fn renew_for(
        &mut self,
        tab: &str,
        token: &str,
        ttl_ms: u64,
        client: &str,
        now: Instant,
    ) -> Result<Lease> {
        self.check_for(tab, Some(token), client, now)?;
        let entry = self
            .entries
            .get_mut(tab)
            .ok_or_else(|| Error::Invalid("Missing reservation".into()))?;
        let lease = lease(
            tab,
            &entry.info.task,
            &entry.info.agent_name,
            entry.token.clone(),
            ttl_ms,
        )?;
        entry.deadline = now + Duration::from_millis(ttl_ms);
        entry.info.expires_at = lease.expires_at;
        Ok(lease)
    }

    pub fn release(&mut self, tab: &str, token: &str, now: Instant) -> Result<()> {
        self.release_for(tab, token, "stdio", now)
    }
    pub fn release_for(
        &mut self,
        tab: &str,
        token: &str,
        client: &str,
        now: Instant,
    ) -> Result<()> {
        self.check_for(tab, Some(token), client, now)?;
        self.entries.remove(tab);
        Ok(())
    }

    pub fn remove(&mut self, tab: &str) {
        self.entries.remove(tab);
    }
}

fn lease(tab: &str, task: &str, agent_name: &str, token: String, ttl_ms: u64) -> Result<Lease> {
    if !(1000..=300_000).contains(&ttl_ms) {
        return Err(Error::Invalid(
            "ttlMs must be between 1000 and 300000".into(),
        ));
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Protocol("System clock is before the Unix epoch".into()))?
        .as_millis() as u64;
    Ok(Lease {
        tab_id: tab.into(),
        lease_id: token,
        task: task.trim().into(),
        agent_name: agent_name.trim().into(),
        ttl_ms,
        expires_at: now_ms + ttl_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copied_tokens_do_not_authorize_another_client() {
        let mut registry = Reservations::default();
        let now = Instant::now();
        let lease = registry
            .reserve_for("tab", "work", 1000, "key-a", now)
            .unwrap();
        assert!(
            registry
                .check_for("tab", Some(&lease.lease_id), "key-a", now)
                .is_ok()
        );
        assert!(
            registry
                .check_for("tab", Some(&lease.lease_id), "key-b", now)
                .is_err()
        );
        assert!(
            registry
                .renew_for("tab", &lease.lease_id, 1000, "key-b", now)
                .is_err()
        );
        assert!(
            registry
                .release_for("tab", &lease.lease_id, "key-b", now)
                .is_err()
        );
    }
    #[test]
    fn tasks_need_matching_tokens_and_listing_does_not_expose_them() {
        let mut registry = Reservations::default();
        let now = Instant::now();
        let a = registry.reserve("a", "task a", 1000, now).unwrap();
        let b = registry.reserve("b", "task b", 1000, now).unwrap();
        assert!(registry.check("a", None, now).is_err());
        assert!(registry.check("a", Some(&b.lease_id), now).is_err());
        assert!(registry.reserve("a", "task a", 1000, now).is_err());
        assert!(registry.check("a", Some(&a.lease_id), now).is_ok());
        let info = serde_json::to_string(&registry.info("a", now)).unwrap();
        assert!(!info.contains(&a.lease_id));
        assert!(!info.contains("leaseId"));
    }

    #[test]
    fn renewal_release_and_expiration_reject_old_tokens() {
        let mut registry = Reservations::default();
        let now = Instant::now();
        let a = registry.reserve("a", "task", 1000, now).unwrap();
        let renewed = registry.renew("a", &a.lease_id, 2000, now).unwrap();
        assert_eq!(renewed.lease_id, a.lease_id);
        assert!(
            registry
                .check("a", Some(&a.lease_id), now + Duration::from_millis(1500))
                .is_ok()
        );
        assert!(
            registry
                .check("a", Some(&a.lease_id), now + Duration::from_millis(2000))
                .is_err()
        );
        let b = registry
            .reserve("a", "next", 1000, now + Duration::from_millis(2000))
            .unwrap();
        assert_ne!(a.lease_id, b.lease_id);
        assert!(
            registry
                .release("a", &a.lease_id, now + Duration::from_millis(2000))
                .is_err()
        );
        registry
            .release("a", &b.lease_id, now + Duration::from_millis(2000))
            .unwrap();
        assert!(
            registry
                .check("a", Some(&b.lease_id), now + Duration::from_millis(2000))
                .is_err()
        );
    }

    #[test]
    fn invalid_renewal_does_not_change_ownership_or_deadline() {
        let mut registry = Reservations::default();
        let now = Instant::now();
        let lease = registry.reserve("a", "task", 1000, now).unwrap();
        assert!(registry.renew("a", &lease.lease_id, 300001, now).is_err());
        assert!(registry.renew("a", "wrong", 1000, now).is_err());
        assert!(registry.check("a", Some(&lease.lease_id), now).is_ok());
        assert!(
            registry
                .check(
                    "a",
                    Some(&lease.lease_id),
                    now + Duration::from_millis(1000)
                )
                .is_err()
        );
    }
}
