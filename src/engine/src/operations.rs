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
            let outcome = match self.tabs.iter().find(|tab| tab.id == pending.tab) {
                None => Some(Err("uncertain".into())),
                Some(_) if now.duration_since(pending.started) >= OPERATION_LIMIT => {
                    Some(Err("uncertain".into()))
                }
                Some(tab) if tab.browser.is_loading() == 0 => {
                    let paints = tab.shared.paints.load(Ordering::Acquire);
                    let (finished, drawn) = pending.paint.get_or_insert((now, paints));
                    (paints != *drawn || now.duration_since(*finished) >= PAINT_LIMIT)
                        .then_some(Ok(Value::Null))
                }
                Some(_) => {
                    pending.paint = None;
                    None
                }
            };
            if let Some(outcome) = outcome {
                let pending = self.navigations.remove(index);
                if let Some(operation) = pending.operation {
                    finish_call(pending.id, operation, outcome);
                }
            } else {
                index += 1;
            }
        }
    }
}

impl Navigation {
    pub(super) fn new(id: u64, tab: String) -> Self {
        Self {
            id,
            tab,
            started: Instant::now(),
            paint: None,
            operation: None,
        }
    }
}
