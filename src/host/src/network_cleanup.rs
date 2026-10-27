//! Retired proxy endpoints remain reserved until CEF has released their request contexts.
use crate::{network::Sessions, profiles::Profiles};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

impl Sessions {
    pub(crate) fn reap(&self, profile: &str, used: &HashSet<String>, eligible: &HashSet<String>) {
        self.entries.lock().unwrap().retain(|id, session| {
            !eligible.contains(id)
                || session.profile != profile
                || !session.peer.cancelled.is_cancelled()
                || session.pending_reservations.load(Ordering::Acquire) != 0
                || used.contains(id)
        });
    }

    fn retired(&self) -> HashMap<String, HashSet<String>> {
        let mut profiles = HashMap::<String, HashSet<String>>::new();
        for (id, session) in self.entries.lock().unwrap().iter() {
            if session.peer.cancelled.is_cancelled()
                && session.pending_reservations.load(Ordering::Acquire) == 0
            {
                profiles
                    .entry(session.profile.clone())
                    .or_default()
                    .insert(id.clone());
            }
        }
        profiles
    }

    pub(crate) fn start_cleanup(self: &Arc<Self>, profiles: Profiles) {
        if self.cleanup_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let sessions = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3));
            loop {
                tokio::select! {
                    _ = sessions.stopped.cancelled() => break,
                    _ = tick.tick() => {
                        // Only reclaim candidates already retired before the native observation.
                        // A concurrent reservation may create a context after that observation.
                        for (profile, eligible) in sessions.retired() {
                            if let Ok(browser) = profiles.browser(Some(&profile)).await
                                && let Ok(used) = browser.network_contexts(&eligible.iter().cloned().collect::<Vec<_>>()).await
                            {
                                sessions.reap(&profile, &used.into_iter().collect(), &eligible);
                            }
                        }
                    }
                }
            }
        });
    }
}
