//! Private Chromiumoxide transport with one stable CDP session per engine-owned tab.
use cef::*;
use chromiumoxide::{Connection, Method, cdp::browser_protocol::target, types};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::mpsc,
    thread::JoinHandle,
    time::Duration,
};
use tokio::sync::mpsc as queue;

type Result<T> = std::result::Result<T, String>;
const LIMIT: Duration = Duration::from_secs(10);
const HISTORY: usize = 128;

#[derive(Debug, Deserialize)]
struct Event {
    method: String,
    #[serde(rename = "sessionId")]
    session: Option<String>,
    params: Value,
}
impl Method for Event {
    fn identifier(&self) -> types::MethodId {
        self.method.clone().into()
    }
}
impl types::EventMessage for Event {
    fn session_id(&self) -> Option<&str> {
        self.session.as_deref()
    }
}

enum Request {
    Bind {
        tab: String,
        target: String,
    },
    Execute {
        tab: String,
        method: String,
        params: Value,
    },
    Events {
        tab: String,
        kind: String,
        after: u64,
        limit: usize,
    },
    Forget(String),
    Stop,
}
struct Call {
    request: Request,
    reply: mpsc::Sender<Result<Value>>,
}

/// Owns the connection worker. It never creates, closes or takes ownership of browser tabs.
pub(super) struct Adapter {
    input: queue::UnboundedSender<Call>,
    worker: Option<JoinHandle<()>>,
}
impl Adapter {
    pub(super) fn start(profile: &Path) -> Result<Self> {
        let file = profile.join("DevToolsActivePort");
        let mut endpoint = None;
        super::pump_within(LIMIT, || {
            endpoint = std::fs::read_to_string(&file)
                .ok()
                .and_then(|text| endpoint_url(&text));
            endpoint.is_some()
        });
        let endpoint = endpoint.ok_or("CEF did not publish its private CDP endpoint")?;
        let (input, receiver) = queue::unbounded_channel();
        let (ready, started) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("browser-cdp".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match runtime {
                    Ok(runtime) => runtime.block_on(async move {
                        match tokio::time::timeout(LIMIT, Connection::<Event>::connect(endpoint))
                            .await
                        {
                            Ok(Ok(connection)) => {
                                let _ = ready.send(Ok(Value::Null));
                                Worker::new(connection).run(receiver).await;
                            }
                            _ => {
                                let _ = ready.send(Err("Could not connect to CEF DevTools".into()));
                            }
                        }
                    }),
                    Err(_) => {
                        let _ = ready.send(Err("Could not start the CDP runtime".into()));
                    }
                }
            })
            .map_err(|_| "Could not start the CDP worker")?;
        let adapter = Self {
            input,
            worker: Some(worker),
        };
        wait(started)?;
        Ok(adapter)
    }
    fn call(&self, request: Request) -> Result<Value> {
        let (reply, result) = mpsc::channel();
        self.input
            .send(Call { request, reply })
            .map_err(|_| "uncertain")?;
        wait(result)
    }
    pub(super) fn bind(&self, tab: &str, target: &str) -> Result<()> {
        self.call(Request::Bind {
            tab: tab.into(),
            target: target.into(),
        })
        .map(|_| ())
    }
    pub(super) fn execute(&self, tab: &str, method: &str, params: Value) -> Result<Value> {
        self.call(Request::Execute {
            tab: tab.into(),
            method: method.into(),
            params,
        })
    }
    pub(super) fn events(&self, tab: &str, kind: &str, after: u64, limit: usize) -> Result<Value> {
        self.call(Request::Events {
            tab: tab.into(),
            kind: kind.into(),
            after,
            limit,
        })
    }
    pub(super) fn forget(&self, tab: &str) {
        let _ = self.call(Request::Forget(tab.into()));
    }
}
impl Drop for Adapter {
    fn drop(&mut self) {
        let _ = self.call(Request::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn wait(receiver: mpsc::Receiver<Result<Value>>) -> Result<Value> {
    let mut result = None;
    super::pump_within(LIMIT + Duration::from_secs(1), || {
        match receiver.try_recv() {
            Ok(value) => result = Some(value),
            Err(mpsc::TryRecvError::Disconnected) => result = Some(Err("uncertain".into())),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        result.is_some()
    });
    result.unwrap_or_else(|| Err("uncertain".into()))
}

fn endpoint_url(text: &str) -> Option<String> {
    if text.len() > 4096 {
        return None;
    }
    let mut lines = text.lines();
    let port: u16 = lines.next()?.parse().ok()?;
    let path = lines.next()?;
    if port < 1024
        || !path.starts_with("/devtools/browser/")
        || !path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/-".contains(&byte))
    {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

struct Session {
    target: String,
    id: String,
    events: History,
}
struct Worker {
    connection: Connection<Event>,
    sessions: HashMap<String, Session>,
    failed: bool,
}
impl Worker {
    fn new(connection: Connection<Event>) -> Self {
        Self {
            connection,
            sessions: HashMap::new(),
            failed: false,
        }
    }
    async fn run(mut self, mut requests: queue::UnboundedReceiver<Call>) {
        loop {
            tokio::select! {
                call = requests.recv() => {
                    let Some(call) = call else { break };
                    let stop = matches!(call.request, Request::Stop);
                    let result = if stop { Ok(Value::Null) } else { self.serve(call.request).await };
                    let _ = call.reply.send(result);
                    if stop { break; }
                }
                message = self.connection.next(), if !self.failed => {
                    match message {
                        Some(Ok(types::Message::Event(event))) => self.event(event),
                        Some(Ok(types::Message::Response(_))) => {},
                        _ => self.failed = true,
                    }
                }
            }
        }
    }
    async fn command(
        &mut self,
        method: &str,
        session: Option<&str>,
        params: Value,
    ) -> Result<Value> {
        if self.failed {
            return Err("uncertain".into());
        }
        let id = self
            .connection
            .submit_command(
                method.to_owned().into(),
                session.map(|id| id.to_owned().into()),
                params,
            )
            .map_err(|error| error.to_string())?;
        let result = tokio::time::timeout(LIMIT, async {
            loop {
                match self.connection.next().await {
                    Some(Ok(types::Message::Response(response))) if response.id == id => {
                        return match response.error {
                            Some(error) => Err(error.to_string()),
                            None => Ok(response.result.unwrap_or(Value::Null)),
                        };
                    }
                    Some(Ok(types::Message::Event(event))) => self.event(event),
                    Some(Ok(_)) => {}
                    _ => {
                        self.failed = true;
                        return Err("uncertain".into());
                    }
                }
            }
        })
        .await;
        match result {
            Ok(result) => result,
            // A timed-out action has an unknown outcome in its tab. Keep draining the
            // connection so a late reply cannot block independent tabs.
            Err(_) => Err("uncertain".into()),
        }
    }
    async fn serve(&mut self, request: Request) -> Result<Value> {
        match request {
            Request::Bind {
                tab,
                target: target_id,
            } => {
                if let Some(session) = self.sessions.get(&tab) {
                    return if session.target == target_id {
                        Ok(Value::Null)
                    } else {
                        Err("Tab target changed unexpectedly".into())
                    };
                }
                let attach = target::AttachToTargetParams::builder()
                    .target_id(target_id.clone())
                    .flatten(true)
                    .build()
                    .map_err(|error| error.to_string())?;
                let value = self
                    .command(
                        "Target.attachToTarget",
                        None,
                        serde_json::to_value(attach).map_err(|error| error.to_string())?,
                    )
                    .await?;
                let id = value["sessionId"]
                    .as_str()
                    .ok_or("DevTools did not return a session")?
                    .to_owned();
                self.sessions.insert(
                    tab,
                    Session {
                        target: target_id,
                        id: id.clone(),
                        events: History::default(),
                    },
                );
                for method in ["Page.enable", "Runtime.enable", "Network.enable"] {
                    self.command(method, Some(&id), json!({})).await?;
                }
                Ok(Value::Null)
            }
            Request::Execute {
                tab,
                method,
                params,
            } => {
                let id = self.sessions.get(&tab).ok_or("Unknown CDP tab")?.id.clone();
                self.command(&method, Some(&id), params).await
            }
            Request::Events {
                tab,
                kind,
                after,
                limit,
            } => {
                if !matches!(kind.as_str(), "console" | "network") {
                    return Err("Unknown diagnostics kind".into());
                }
                let session = self.sessions.get(&tab).ok_or("Unknown CDP tab")?;
                Ok(session.events.read(&kind, after, limit))
            }
            Request::Forget(tab) => {
                if let Some(session) = self.sessions.remove(&tab) {
                    let _ = self
                        .command(
                            "Target.detachFromTarget",
                            None,
                            json!({"sessionId": session.id}),
                        )
                        .await;
                }
                Ok(Value::Null)
            }
            Request::Stop => Ok(Value::Null),
        }
    }
    fn event(&mut self, event: Event) {
        if let Some(session) = self
            .sessions
            .values_mut()
            .find(|session| Some(session.id.as_str()) == event.session.as_deref())
        {
            session.events.push(&event.method, &event.params);
        }
    }
}

#[derive(Default)]
struct History {
    sequence: u64,
    entries: VecDeque<Value>,
}
fn text(value: Option<&str>, limit: usize) -> String {
    value.unwrap_or_default().chars().take(limit).collect()
}
impl History {
    fn push(&mut self, method: &str, params: &Value) {
        let mut entry = match method {
            "Runtime.consoleAPICalled" => {
                let args = params["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(8)
                    .map(|arg| {
                        let value = arg
                            .get("value")
                            .filter(|value| !value.is_string())
                            .map(Value::to_string);
                        text(
                            arg["value"]
                                .as_str()
                                .or_else(|| arg["description"].as_str())
                                .or(value.as_deref()),
                            512,
                        )
                    })
                    .collect::<Vec<_>>();
                json!({"kind": "console", "level": text(params["type"].as_str(), 32), "text": args.join(" ")})
            }
            "Network.responseReceived" => {
                json!({"kind": "network", "requestId": text(params["requestId"].as_str(), 128), "url": text(params["response"]["url"].as_str(), 2048), "status": params["response"]["status"], "mimeType": text(params["response"]["mimeType"].as_str(), 128)})
            }
            "Network.loadingFailed" => {
                json!({"kind": "network", "requestId": text(params["requestId"].as_str(), 128), "error": text(params["errorText"].as_str(), 512)})
            }
            _ => return,
        };
        self.sequence += 1;
        entry["sequence"] = json!(self.sequence);
        if self.entries.len() == HISTORY {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }
    fn read(&self, kind: &str, after: u64, limit: usize) -> Value {
        let entries: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| {
                entry["kind"] == kind && entry["sequence"].as_u64().unwrap_or(0) > after
            })
            .take(limit.clamp(1, 100))
            .cloned()
            .collect();
        let next = entries
            .last()
            .and_then(|entry| entry["sequence"].as_u64())
            .unwrap_or(after);
        json!({"entries": entries, "next": next, "latest": self.sequence, "truncated": self.entries.front().is_some_and(|entry| entry["sequence"].as_u64().unwrap_or(0) > after.saturating_add(1))})
    }
}

wrap_dev_tools_message_observer! {
    struct Identify { reply: mpsc::Sender<(bool, Vec<u8>)> }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, id: i32, success: i32, result: Option<&[u8]>) {
            if id == 1 { let _ = self.reply.send((success == 1, result.unwrap_or_default().to_vec())); }
        }
    }
}
/// Discover the actual target without injecting markers into the page or matching URLs.
pub(super) fn identify(browser: &Browser) -> Result<String> {
    let host = browser.host().ok_or("The tab has no host")?;
    let (reply, receiver) = mpsc::channel();
    let mut observer = Identify::new(reply);
    let _registration = host.add_dev_tools_message_observer(Some(&mut observer));
    let bytes = br#"{"id":1,"method":"Target.getTargetInfo","params":{}}"#;
    if host.send_dev_tools_message(Some(bytes)) != 1 {
        return Err("The tab refused target discovery".into());
    }
    let mut result = None;
    super::pump_within(LIMIT, || {
        result = receiver.try_recv().ok();
        result.is_some()
    });
    let (success, bytes) = result.ok_or("Target discovery timed out")?;
    if !success {
        return Err("CEF target discovery failed".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid CEF target identity")?;
    value["targetInfo"]["targetId"]
        .as_str()
        .map(str::to_owned)
        .ok_or("Missing CEF target identity".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_is_always_loopback_and_validated() {
        assert_eq!(
            endpoint_url("9222\n/devtools/browser/abc-123\n").unwrap(),
            "ws://127.0.0.1:9222/devtools/browser/abc-123"
        );
        assert!(endpoint_url("0\n/devtools/browser/abc").is_none());
        assert!(endpoint_url("9222\n//other-host/browser/abc").is_none());
    }
    #[test]
    fn event_session_uses_the_wire_field() {
        let event: Event = serde_json::from_value(
            json!({"method":"Runtime.consoleAPICalled","sessionId":"session-a","params":{}}),
        )
        .unwrap();
        assert_eq!(event.session.as_deref(), Some("session-a"));
    }
    #[test]
    fn diagnostics_are_bounded_paginated_and_omit_network_credentials() {
        let mut history = History::default();
        for _ in 0..140 {
            history.push("Network.responseReceived", &json!({"requestId":"r", "response":{"url":"x".repeat(5000),"status":200,"headers":{"Cookie":"secret"}}}));
        }
        let page = history.read("network", 0, 2);
        assert_eq!(page["entries"].as_array().unwrap().len(), 2);
        assert_eq!(page["next"], 14);
        assert_eq!(page["truncated"], true);
        assert_eq!(page["entries"][0]["url"].as_str().unwrap().len(), 2048);
        assert!(!page.to_string().contains("secret"));
        assert_eq!(history.read("console", 0, 100)["entries"], json!([]));
    }
}
