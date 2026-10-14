//! Bounded, nonblocking JSON diagnostics. Payloads never enter the logging interface.
use crate::Error;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::{
    future::Future,
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    sync::{
        LazyLock,
        atomic::{AtomicU8, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime},
};

#[derive(Clone, Copy, clap::ValueEnum)]
#[repr(u8)]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}
impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }
}
static LEVEL: LazyLock<AtomicU8> = LazyLock::new(|| {
    AtomicU8::new(match std::env::var("SERVO_LOG_LEVEL").as_deref() {
        Ok("error") => 1,
        Ok("warn") => 2,
        Ok("debug") => 4,
        _ => 3,
    })
});
pub fn configure(level: Level) {
    LEVEL.store(level as u8, Ordering::Relaxed);
}
pub fn level() -> Level {
    match LEVEL.load(Ordering::Relaxed) {
        1 => Level::Error,
        2 => Level::Warn,
        4 => Level::Debug,
        _ => Level::Info,
    }
}

#[derive(Clone)]
pub struct Context {
    pub trace_id: String,
    pub profile_key: Option<String>,
}
tokio::task_local! { static CONTEXT: Context; }
impl Context {
    pub fn current() -> Self {
        CONTEXT.try_with(Clone::clone).unwrap_or_else(|_| {
            Self::incoming(None, std::env::var("SERVO_LOG_PROFILE_KEY").ok().as_deref())
        })
    }
    pub fn incoming(trace: Option<&str>, profile: Option<&str>) -> Self {
        Self {
            trace_id: trace
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .unwrap_or_else(uuid::Uuid::new_v4)
                .to_string(),
            profile_key: profile
                .filter(|key| {
                    key.len() == 18
                        && key.starts_with("p-")
                        && key[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .map(str::to_owned),
        }
    }
    pub fn for_profile(mut self, id: &str) -> Self {
        self.profile_key = Some(key("p", id));
        self
    }
    pub async fn scope<T>(self, future: impl Future<Output = T>) -> T {
        CONTEXT.scope(self, future).await
    }
}
fn key(prefix: &str, value: &str) -> String {
    let mut hash = DefaultHasher::new();
    value.hash(&mut hash);
    format!("{prefix}-{:016x}", hash.finish())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u8,
    timestamp: String,
    level: &'static str,
    process_id: u32,
    component: &'static str,
    event: &'static str,
    trace_id: String,
    profile_key: Option<String>,
    request_id: Option<u64>,
    tab_key: Option<String>,
    operation: &'static str,
    elapsed_ms: Option<u64>,
    outcome: Option<&'static str>,
    reason: Option<&'static str>,
    engine_process_id: Option<u32>,
    http_status: Option<u16>,
    dropped_events: usize,
}
enum Message {
    Record(Box<Record>),
    Flush(mpsc::Sender<()>),
}
static DROPPED: AtomicUsize = AtomicUsize::new(0);
static SINK: LazyLock<mpsc::SyncSender<Message>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::sync_channel::<Message>(1024);
    std::thread::spawn(move || {
        for message in receiver {
            match message {
                Message::Record(mut record) => {
                    record.dropped_events = DROPPED.swap(0, Ordering::Relaxed);
                    if let Ok(mut bytes) = serde_json::to_vec(&record) {
                        bytes.push(b'\n');
                        let _ = std::io::stderr().lock().write_all(&bytes);
                    }
                }
                Message::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    });
    sender
});
pub fn flush() {
    let (done, reply) = mpsc::channel();
    if SINK.try_send(Message::Flush(done)).is_ok() {
        let _ = reply.recv_timeout(Duration::from_secs(2));
    }
}
fn emit(level: Level, mut record: Record) {
    if level as u8 > LEVEL.load(Ordering::Relaxed) {
        return;
    }
    record.level = level.name();
    if SINK.try_send(Message::Record(Box::new(record))).is_err() {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}
fn record(
    context: &Context,
    component: &'static str,
    event: &'static str,
    op: &str,
    request: Option<u64>,
    tab: Option<&str>,
) -> Record {
    let safe = Context::incoming(Some(&context.trace_id), context.profile_key.as_deref());
    Record {
        schema_version: 1,
        timestamp: DateTime::<Utc>::from(SystemTime::now())
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        level: "info",
        process_id: std::process::id(),
        component,
        event,
        trace_id: safe.trace_id,
        profile_key: safe.profile_key,
        request_id: request,
        tab_key: tab.map(|tab| key("t", tab)),
        operation: operation(op),
        elapsed_ms: None,
        outcome: None,
        reason: None,
        engine_process_id: None,
        http_status: None,
        dropped_events: 0,
    }
}
pub fn lifecycle(component: &'static str, event: &'static str, engine_pid: Option<u32>) {
    let mut entry = record(&Context::current(), component, event, "", None, None);
    entry.engine_process_id = engine_pid;
    emit(Level::Info, entry);
}
pub fn service_error(error: &Error) {
    let mut entry = record(
        &Context::current(),
        "runtime",
        "service_failed",
        "",
        None,
        None,
    );
    entry.outcome = Some(outcome(Some(error)));
    emit(Level::Error, entry);
}
pub fn fault(
    context: &Context,
    component: &'static str,
    reason: &str,
    request: Option<u64>,
    op: Option<&str>,
    tab: Option<&str>,
) {
    let mut entry = record(
        context,
        component,
        "completion_unknown",
        op.unwrap_or(""),
        request,
        tab,
    );
    entry.reason = Some(match reason {
        "request_cancelled" => "request_cancelled",
        "request_write_failed" => "request_write_failed",
        "request_timeout" => "request_timeout",
        "operation_timeout" => "operation_timeout",
        "script_channel_closed" => "script_channel_closed",
        "tab_crashed" => "tab_crashed",
        "response_limit" => "response_limit",
        "response_read_failed" => "response_read_failed",
        "engine_eof" => "engine_eof",
        "engine_connection_closed" => "engine_connection_closed",
        "invalid_response_json" => "invalid_response_json",
        "invalid_response_id" => "invalid_response_id",
        "invalid_response_envelope" => "invalid_response_envelope",
        "engine_reported_uncertain" => "engine_reported_uncertain",
        _ => "unknown",
    });
    emit(Level::Error, entry);
}
fn operation(value: &str) -> &'static str {
    match value {
        "browser_files" => "browser_files",
        "browser_upload" => "browser_upload",
        "browser_download" => "browser_download",
        "read_file" => "read_file",
        "files" => "files",
        "stage_file" => "stage_file",
        "delete_file" => "delete_file",
        "upload" => "upload",
        "download" => "download",
        "choose_files" => "choose_files",
        "browser_profiles" => "browser_profiles",
        "browser_tabs" => "browser_tabs",
        "browser_status" => "browser_status",
        "browser_navigate" => "browser_navigate",
        "browser_snapshot" => "browser_snapshot",
        "browser_click" => "browser_click",
        "browser_fill" => "browser_fill",
        "browser_press" => "browser_press",
        "browser_scroll" => "browser_scroll",
        "browser_evaluate" => "browser_evaluate",
        "browser_screenshot" => "browser_screenshot",
        "browser_session_health" => "browser_session_health",
        "status" => "status",
        "tabs" => "tabs",
        "open" => "open",
        "close" => "close",
        "select" => "select",
        "view" => "view",
        "take" => "take",
        "return" => "return",
        "navigate" => "navigate",
        "snapshot" => "snapshot",
        "click" => "click",
        "fill" => "fill",
        "press" => "press",
        "scroll" => "scroll",
        "evaluate" => "evaluate",
        "screenshot" => "screenshot",
        "health" => "health",
        "input" => "input",
        "reserve" => "reserve",
        "renew" => "renew",
        "release" => "release",
        "shutdown" => "shutdown",
        "profiles" => "profiles",
        "action" => "action",
        "create_profile" => "create_profile",
        "policies" => "policies",
        _ => "unknown",
    }
}
fn normal_level(op: &str) -> Level {
    if matches!(
        op,
        "navigate"
            | "open"
            | "close"
            | "select"
            | "view"
            | "take"
            | "return"
            | "reserve"
            | "release"
            | "create_profile"
            | "browser_navigate"
            | "browser_click"
            | "browser_fill"
            | "browser_press"
            | "upload"
            | "download"
            | "delete_file"
            | "choose_files"
            | "browser_download"
            | "browser_upload"
    ) {
        Level::Info
    } else {
        Level::Debug
    }
}
pub fn outcome(error: Option<&Error>) -> &'static str {
    match error {
        None => "ok",
        Some(Error::Busy) => "busy",
        Some(Error::HumanControl) => "human_control",
        Some(Error::Uncertain) => "uncertain",
        Some(Error::Invalid(_)) => "invalid",
        Some(Error::Json(_)) => "invalid_request",
        Some(Error::Io(_)) => "io_error",
        Some(Error::Transport(_)) => "transport_error",
        Some(Error::Protocol(_)) => "protocol_error",
        Some(Error::WebDriver { .. }) => "webdriver_error",
    }
}
pub fn engine_outcome(error: Option<&str>) -> &'static str {
    match error {
        None => "ok",
        Some("busy") => "busy",
        Some("humanControl") => "human_control",
        Some("uncertain") => "uncertain",
        Some(_) => "invalid",
    }
}
pub struct Operation {
    pub context: Context,
    component: &'static str,
    operation: &'static str,
    request: Option<u64>,
    tab: Option<String>,
    started: Instant,
    finished: bool,
    http_status: Option<u16>,
}
impl Operation {
    pub fn begin(
        context: Context,
        component: &'static str,
        op: &str,
        request: Option<u64>,
        tab: Option<&str>,
    ) -> Self {
        emit(
            normal_level(op),
            record(&context, component, "operation_started", op, request, tab),
        );
        Self {
            context,
            component,
            operation: operation(op),
            request,
            tab: tab.map(str::to_owned),
            started: Instant::now(),
            finished: false,
            http_status: None,
        }
    }
    pub fn finish(&mut self, outcome: &'static str) {
        let mut entry = record(
            &self.context,
            self.component,
            "operation_finished",
            self.operation,
            self.request,
            self.tab.as_deref(),
        );
        let elapsed = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        entry.elapsed_ms = Some(elapsed);
        entry.outcome = Some(outcome);
        entry.http_status = self.http_status;
        let severity = match outcome {
            "ok" if elapsed >= 1000 => Level::Warn,
            "ok" => normal_level(self.operation),
            "busy" | "human_control" => Level::Debug,
            "invalid" | "invalid_request" | "unauthorized" | "forbidden" | "cancelled" => {
                Level::Warn
            }
            _ => Level::Error,
        };
        emit(severity, entry);
        self.finished = true;
    }
    pub fn fault(&self, reason: &str) {
        fault(
            &self.context,
            self.component,
            reason,
            self.request,
            Some(self.operation),
            self.tab.as_deref(),
        );
    }
    pub fn finish_http(&mut self, status: u16) {
        self.http_status = Some(status);
        self.finish(match status {
            200..=399 => "ok",
            401 => "unauthorized",
            403 => "forbidden",
            400..=499 => "invalid_request",
            _ => "internal_error",
        });
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if !self.finished {
            self.finish("cancelled");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_are_structured_and_untrusted_identifiers_and_names_are_not_payloads() {
        let secret = "secret-token=https://private.test/password";
        let context = Context::incoming(Some(secret), Some(secret)).for_profile(secret);
        let entry = record(
            &context,
            "native",
            "operation_finished",
            secret,
            Some(42),
            Some(secret),
        );
        let text = serde_json::to_string(&entry).unwrap();
        assert!(
            !text.contains(secret) && !text.contains("private.test") && !text.contains("password")
        );
        assert!(uuid::Uuid::parse_str(&entry.trace_id).is_ok());
        assert_eq!(entry.operation, "unknown");
        assert_eq!(entry.profile_key.unwrap().len(), 18);
        assert_eq!(entry.tab_key.unwrap().len(), 18);
        assert!(DateTime::parse_from_rfc3339(&entry.timestamp).is_ok());
        let unsafe_context = Context {
            trace_id: secret.into(),
            profile_key: Some(secret.into()),
        };
        assert!(
            !serde_json::to_string(&record(
                &unsafe_context,
                "mcp",
                "operation_finished",
                secret,
                None,
                None
            ))
            .unwrap()
            .contains(secret)
        );
    }
    #[tokio::test]
    async fn concurrent_scopes_keep_distinct_traces_and_profile_context() {
        let a = Context::current().for_profile("first");
        let b = Context::current().for_profile("second");
        let (observed_a, observed_b) = tokio::join!(
            a.clone().scope(async {
                tokio::task::yield_now().await;
                Context::current()
            }),
            b.clone().scope(async {
                tokio::task::yield_now().await;
                Context::current()
            })
        );
        assert_eq!(observed_a.trace_id, a.trace_id);
        assert_eq!(observed_b.trace_id, b.trace_id);
        assert_ne!(observed_a.profile_key, observed_b.profile_key);
    }
}
