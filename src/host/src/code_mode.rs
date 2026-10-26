//! Bounded JavaScript orchestration embedded in Rust; no OS or module bindings.
use crate::{
    Error, Result,
    agent::{Action, Page},
};
use rquickjs::{Context, Function, Promise, Runtime};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

static WORKERS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));
struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct Worker {
    page: Page,
    client: crate::identity::Client,
    context: crate::logging::Context,
    handle: tokio::runtime::Handle,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    count: AtomicUsize,
}
impl Worker {
    fn invoke(&self, name: &str, arguments: &str) -> Result<Value> {
        if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(Error::Invalid(
                "Code execution was cancelled or timed out".into(),
            ));
        }
        if self.count.fetch_add(1, Ordering::Relaxed) >= 100 {
            return Err(Error::Invalid(
                "Code mode allows at most 100 page operations per call".into(),
            ));
        }
        let action = Action::parse(name, serde_json::from_str(arguments)?)?;
        self.handle.block_on(crate::identity::scope(
            self.client.clone(),
            self.context.clone().scope(async {
                // Cancelling a pending native mutation uses its usual completion guard;
                // an unknown outcome cannot silently be retried by later operations.
                tokio::select! {
                    result = tokio::time::timeout_at(tokio::time::Instant::from_std(self.deadline), self.page.execute(action)) => {
                        result.map_err(|_| Error::Invalid("Code execution timed out; preceding actions may have completed".into()))?
                    }
                    _ = async {
                        while !self.cancelled.load(Ordering::Acquire) {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                    } => Err(Error::Invalid("Code execution was cancelled; preceding actions may have completed".into())),
                }
            }),
        ))
    }
    fn execute(self, code: &str) -> Result<Value> {
        let runtime = Runtime::new().map_err(js_error)?;
        runtime.set_memory_limit(64 * 1024 * 1024);
        runtime.set_max_stack_size(1024 * 1024);
        let cancelled = self.cancelled.clone();
        let deadline = self.deadline;
        runtime.set_interrupt_handler(Some(Box::new(move || {
            cancelled.load(Ordering::Acquire) || Instant::now() >= deadline
        })));
        let context = Context::full(&runtime).map_err(js_error)?;
        context.with(|ctx| {
            let bridge = Function::new(ctx.clone(), move |name: String, arguments: String| -> String {
                match self.invoke(&name, &arguments) {
                    Ok(value) => json!({"value": value}).to_string(),
                    Err(error) => json!({"error": error.to_string()}).to_string(),
                }
            }).map_err(js_error)?;
            ctx.globals().set("__call", bridge).map_err(js_error)?;
            let result = (|| -> rquickjs::Result<String> {
                ctx.eval::<(), _>(include_str!("../code/page.js"))?;
                let promise: Promise = ctx.eval(format!("(async () => {{\n{code}\n}})().then(value => JSON.stringify(value === undefined ? null : value))"))?;
                promise.finish::<String>()
            })();
            let encoded = result.map_err(|error| {
                let message = rquickjs::CaughtError::from_error(&ctx, error).to_string();
                Error::Invalid(format!("Code execution failed: {}", message.chars().take(2048).collect::<String>()))
            })?;
            if encoded.len() > 32768 { return Err(Error::Invalid("Code result exceeds 32 KiB".into())); }
            Ok(json!({"value": serde_json::from_str::<Value>(&encoded)?}))
        })
    }
}
pub(crate) async fn run(page: Page, code: String, timeout_ms: u64) -> Result<Value> {
    if code.is_empty() || code.len() > 65536 || !(1..=60000).contains(&timeout_ms) {
        return Err(Error::Invalid(
            "Supply 1 to 65536 bytes of code and timeoutMs from 1 to 60000".into(),
        ));
    }
    let permit = WORKERS
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Busy)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _guard = Cancel(cancelled.clone());
    let worker = Worker {
        page,
        client: crate::identity::current(),
        context: crate::logging::Context::current(),
        handle: tokio::runtime::Handle::current(),
        cancelled,
        deadline: Instant::now() + Duration::from_millis(timeout_ms),
        count: AtomicUsize::new(0),
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        worker.execute(&code)
    })
    .await
    .map_err(|_| Error::Invalid("Code worker stopped".into()))?
}
fn js_error(error: rquickjs::Error) -> Error {
    Error::Invalid(format!("JavaScript runtime: {error}"))
}
