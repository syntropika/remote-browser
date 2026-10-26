//! Dispatch correlated operations without blocking independent tabs on navigation.
use super::{Call, Engine, OPERATION_LIMIT, PAINT_LIMIT, Value, reply};
use cef::ImplBrowser;
use std::sync::atomic::Ordering;
use std::time::Instant;

/// Navigation remains pending while the main loop serves independent tabs.
pub(super) struct Navigation {
    id: u64,
    pub(super) tab: String,
    started: Instant,
    paint: Option<(Instant, u64)>,
    operation: Option<remote_browser_native::logging::Operation>,
}

struct View {
    loading: bool,
    paints: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Completion {
    Loaded,
    Unknown,
}

fn finish_call(
    id: u64,
    mut operation: remote_browser_native::logging::Operation,
    outcome: Result<Value, String>,
) {
    if outcome
        .as_ref()
        .err()
        .is_some_and(|error| error == "uncertain")
    {
        operation.fault("operation_timeout");
    }
    operation.finish(remote_browser_native::logging::engine_outcome(
        outcome.as_ref().err().map(String::as_str),
    ));
    reply(id, outcome);
}

impl Engine {
    pub(super) fn dispatch(&mut self, call: &Call) {
        let operation = remote_browser_native::logging::Operation::begin(
            remote_browser_native::logging::Context::incoming(
                call.trace_id.as_deref(),
                call.profile_key.as_deref(),
            ),
            "engine",
            &call.op,
            Some(call.id),
            call.tab_id.as_deref(),
        );
        let outcome = self.serve(call);
        if let Some(pending) = self
            .navigations
            .iter_mut()
            .find(|pending| pending.id == call.id)
        {
            pending.operation = Some(operation);
        } else {
            finish_call(call.id, operation, outcome);
        }
    }

    pub(super) fn poll_navigations(&mut self) {
        let now = Instant::now();
        let mut index = 0;
        while index < self.navigations.len() {
            let pending = &mut self.navigations[index];
            let view = self
                .tabs
                .iter()
                .find(|tab| tab.id == pending.tab)
                .map(|tab| View {
                    loading: tab.browser.is_loading() != 0,
                    paints: tab.shared.paints.load(Ordering::Acquire),
                });
            if let Some(completion) = pending.poll(now, view) {
                let pending = self.navigations.remove(index);
                if let Some(operation) = pending.operation {
                    finish_call(
                        pending.id,
                        operation,
                        match completion {
                            Completion::Loaded => Ok(Value::Null),
                            Completion::Unknown => Err("uncertain".into()),
                        },
                    );
                }
            } else {
                index += 1;
            }
        }
    }
}

impl Navigation {
    pub(super) fn new(id: u64, tab: String, started: Instant) -> Self {
        Self {
            id,
            tab,
            started,
            paint: None,
            operation: None,
        }
    }

    fn poll(&mut self, now: Instant, view: Option<View>) -> Option<Completion> {
        let Some(view) = view else {
            return Some(Completion::Unknown);
        };
        if now.duration_since(self.started) >= OPERATION_LIMIT {
            return Some(Completion::Unknown);
        }
        if view.loading {
            self.paint = None;
            return None;
        }
        let (finished, drawn) = self.paint.get_or_insert((now, view.paints));
        (view.paints != *drawn || now.duration_since(*finished) >= PAINT_LIMIT)
            .then_some(Completion::Loaded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn view(loading: bool, paints: u64) -> Option<View> {
        Some(View { loading, paints })
    }

    #[test]
    fn loading_waits_for_a_new_paint_after_document_completion() {
        let now = Instant::now();
        let mut navigation = Navigation::new(1, "tab-a".into(), now);
        assert_eq!(navigation.poll(now, view(true, 3)), None);
        assert_eq!(navigation.poll(now, view(false, 3)), None);
        assert_eq!(
            navigation.poll(now, view(false, 4)),
            Some(Completion::Loaded)
        );
    }

    #[test]
    fn paint_wait_is_bounded_but_does_not_finish_early() {
        let now = Instant::now();
        let mut navigation = Navigation::new(1, "tab-a".into(), now);
        assert_eq!(navigation.poll(now, view(false, 3)), None);
        assert_eq!(
            navigation.poll(now + PAINT_LIMIT - Duration::from_millis(1), view(false, 3)),
            None
        );
        assert_eq!(
            navigation.poll(now + PAINT_LIMIT, view(false, 3)),
            Some(Completion::Loaded)
        );
    }

    #[test]
    fn resumed_loading_discards_a_previous_paint_wait() {
        let now = Instant::now();
        let mut navigation = Navigation::new(1, "tab-a".into(), now);
        assert_eq!(navigation.poll(now, view(false, 1)), None);
        assert_eq!(navigation.poll(now + PAINT_LIMIT, view(true, 2)), None);
        assert_eq!(navigation.poll(now + PAINT_LIMIT, view(false, 2)), None);
        assert_eq!(
            navigation.poll(now + PAINT_LIMIT, view(false, 3)),
            Some(Completion::Loaded)
        );
    }

    #[test]
    fn deadline_or_missing_tab_reports_unknown_even_if_a_frame_exists() {
        let now = Instant::now();
        let mut timed = Navigation::new(1, "tab-a".into(), now);
        assert_eq!(
            timed.poll(
                now + OPERATION_LIMIT - Duration::from_millis(1),
                view(true, 1)
            ),
            None
        );
        assert_eq!(
            timed.poll(now + OPERATION_LIMIT, view(false, 2)),
            Some(Completion::Unknown)
        );
        let mut missing = Navigation::new(2, "tab-b".into(), now);
        assert_eq!(missing.poll(now, None), Some(Completion::Unknown));
    }

    #[test]
    fn a_loading_tab_does_not_hold_an_independent_completion() {
        let now = Instant::now();
        let mut slow = Navigation::new(1, "tab-a".into(), now);
        let mut fast = Navigation::new(2, "tab-b".into(), now);
        assert_eq!(slow.poll(now, view(true, 1)), None);
        assert_eq!(fast.poll(now, view(false, 1)), None);
        assert_eq!(fast.poll(now, view(false, 2)), Some(Completion::Loaded));
        assert_eq!(slow.poll(now, view(true, 1)), None);
    }
}
