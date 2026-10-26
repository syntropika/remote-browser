//! Human display presence is independent of persistent agent reservations.
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

const ABSENT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct Displays {
    viewers: BTreeMap<String, Instant>,
    controller: Option<String>,
    hidden_controller: bool,
}

impl Displays {
    pub fn controller(&self) -> Option<&str> {
        self.controller.as_deref().filter(|id| {
            self.hidden_controller
                || self
                    .viewers
                    .get(*id)
                    .is_some_and(|seen| seen.elapsed() < ABSENT)
        })
    }

    pub fn allows(&self, id: Option<&str>) -> bool {
        self.controller()
            .is_none_or(|controller| Some(controller) == id)
    }

    pub fn observe(&mut self, id: &str, visible: bool, available: bool) {
        self.viewers.retain(|_, seen| seen.elapsed() < ABSENT);
        if visible {
            self.viewers.insert(id.into(), Instant::now());
        } else {
            self.viewers.remove(id);
        }
        if self.controller.as_deref() == Some(id) {
            self.hidden_controller = !visible;
        }
        if self.controller().is_none() {
            self.controller = None;
            self.hidden_controller = false;
            if visible && available {
                self.controller = Some(id.into());
            }
        }
    }

    pub fn take(&mut self, id: Option<&str>) {
        self.controller = id.map(str::to_owned);
        self.hidden_controller = false;
        if let Some(id) = id {
            self.viewers.insert(id.into(), Instant::now());
        }
    }

    pub fn leave(&mut self, id: &str) {
        self.viewers.remove(id);
        if self.controller.as_deref() == Some(id) {
            self.controller = None;
            self.hidden_controller = false;
        }
    }

    pub fn count(&self) -> usize {
        self.viewers
            .values()
            .filter(|seen| seen.elapsed() < ABSENT)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewers_follow_until_control_is_explicitly_transferred() {
        let mut displays = Displays::default();
        displays.observe("desktop", true, true);
        displays.observe("phone", true, true);
        assert_eq!(displays.count(), 2);
        assert!(displays.allows(Some("desktop")));
        assert!(!displays.allows(Some("phone")));
        assert!(!displays.allows(None));
        displays.take(Some("phone"));
        assert!(!displays.allows(Some("desktop")));
        displays.observe("desktop", false, true);
        assert_eq!(displays.controller(), Some("phone"));
        displays.observe("phone", false, true);
        assert_eq!(displays.controller(), Some("phone"));
        displays.leave("phone");
        assert_eq!(displays.controller(), None);
    }

    #[test]
    fn absent_viewers_expire_without_changing_agent_ownership() {
        let mut displays = Displays::default();
        displays.observe("phone", true, false);
        assert_eq!(displays.controller(), None);
        displays.take(Some("phone"));
        displays
            .viewers
            .insert("phone".into(), Instant::now() - ABSENT);
        assert_eq!(displays.controller(), None);
        displays.observe("desktop", true, true);
        assert_eq!(displays.controller(), Some("desktop"));
    }
}
