//! Cancellable, acknowledged five-second handoffs; rejected operations have not executed.
use crate::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;
struct Entry {
    id: String,
    operation: String,
    deadline: Option<Instant>,
    expires_at: Option<u64>,
    cancelled: bool,
    last_seen: Option<Instant>,
    notify: Arc<Notify>,
}
#[derive(Default)]
pub struct Handoffs {
    entries: Mutex<HashMap<String, Entry>>,
    suppressed: Mutex<HashMap<String, Instant>>,
    seen: Mutex<Option<Instant>>,
}
struct Guard {
    state: Arc<Handoffs>,
    tab: String,
    id: String,
}
impl Drop for Guard {
    fn drop(&mut self) {
        let mut entries = self.state.entries.lock().unwrap();
        if entries
            .get(&self.tab)
            .is_some_and(|entry| entry.id == self.id)
        {
            entries.remove(&self.tab);
        }
    }
}
impl Handoffs {
    pub fn available(&self) -> bool {
        self.seen
            .lock()
            .unwrap()
            .is_some_and(|seen| seen.elapsed() < Duration::from_secs(2))
    }
    pub fn control(&self, op: &str, tab: &str, args: Value) -> Result<Value> {
        let mut entries = self.entries.lock().unwrap();
        if op == "handoff_status" {
            *self.seen.lock().unwrap() = Some(Instant::now());
            return Ok(
                json!({"requests":entries.iter().map(|(tab,entry)|json!({"tabId":tab,"id":entry.id,"operation":entry.operation,"deadline":entry.expires_at})).collect::<Vec<_>>()}),
            );
        }
        let entry = entries
            .get_mut(tab)
            .ok_or_else(|| Error::Invalid("No agent handoff is pending".into()))?;
        if args["id"].as_str() != Some(&entry.id) {
            return Err(Error::Invalid("Agent handoff expired".into()));
        }
        if op == "handoff_ack" {
            entry.last_seen = Some(Instant::now());
        }
        if op == "handoff_ack" && entry.deadline.is_none() {
            entry.deadline = Some(Instant::now() + Duration::from_secs(5));
            entry.expires_at = Some(
                (SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64)
                    + 5000,
            );
        }
        if op == "handoff_cancel" {
            entry.cancelled = true;
            self.suppressed
                .lock()
                .unwrap()
                .insert(tab.into(), Instant::now() + Duration::from_secs(30));
        }
        entry.notify.notify_one();
        Ok(json!({"ok":true}))
    }
    pub fn clear(&self, tab: &str) {
        self.suppressed.lock().unwrap().remove(tab);
        if let Some(entry) = self.entries.lock().unwrap().get_mut(tab) {
            entry.cancelled = true;
            entry.notify.notify_one();
        }
    }
    pub async fn wait(self: &Arc<Self>, tab: &str, operation: &str) -> Result<()> {
        if self
            .suppressed
            .lock()
            .unwrap()
            .get(tab)
            .is_some_and(|expiry| *expiry > Instant::now())
        {
            return Err(Error::HumanControl);
        }
        let notify = Arc::new(Notify::new());
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut entries = self.entries.lock().unwrap();
            if entries.contains_key(tab) {
                return Err(Error::Busy);
            }
            entries.insert(
                tab.into(),
                Entry {
                    id: id.clone(),
                    operation: operation.into(),
                    deadline: None,
                    expires_at: None,
                    cancelled: false,
                    last_seen: None,
                    notify: notify.clone(),
                },
            );
        }
        let _guard = Guard {
            state: self.clone(),
            tab: tab.into(),
            id,
        };
        let disconnected = Instant::now() + Duration::from_secs(15);
        loop {
            crate::identity::check()?;
            if !self.available() {
                return Err(Error::HumanControl);
            }
            let deadline = {
                let entries = self.entries.lock().unwrap();
                let entry = entries.get(tab).ok_or(Error::HumanControl)?;
                if entry.cancelled
                    || entry
                        .last_seen
                        .is_some_and(|seen| seen.elapsed() > Duration::from_secs(2))
                {
                    return Err(Error::HumanControl);
                }
                entry.deadline
            };
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Ok(());
            }
            if deadline.is_none() && Instant::now() >= disconnected {
                return Err(Error::Invalid(
                    "The human dashboard is not connected to receive a handoff".into(),
                ));
            }
            tokio::select! {_=notify.notified()=>{},_=tokio::time::sleep(Duration::from_millis(100))=>{}}
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_keeps_control_and_suppresses_reprompt() {
        let state = Arc::new(Handoffs::default());
        state.control("handoff_status", "", Value::Null).unwrap();
        let copy = state.clone();
        let pending = tokio::spawn(async move { copy.wait("tab", "navigate").await });
        tokio::task::yield_now().await;
        let data = state.control("handoff_status", "", Value::Null).unwrap();
        let id = data["requests"][0]["id"].clone();
        state
            .control("handoff_ack", "tab", json!({"id":id}))
            .unwrap();
        state
            .control("handoff_cancel", "tab", json!({"id":id}))
            .unwrap();
        assert!(matches!(pending.await.unwrap(), Err(Error::HumanControl)));
        assert!(matches!(
            state.wait("tab", "navigate").await,
            Err(Error::HumanControl)
        ));
        assert!(
            state.control("handoff_status", "", Value::Null).unwrap()["requests"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
