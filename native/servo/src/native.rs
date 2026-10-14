//! Private stdio transport to the embedded engine; requests retain their tab identity.
use crate::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, oneshot},
};
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Diagnostic fields deliberately omit page data, request arguments, and lease tokens.
pub fn diagnostic(event: &str, request_id: Option<u64>, op: Option<&str>, tab: Option<&str>) {
    let short = |value: &str| value.chars().take(128).collect::<String>();
    eprintln!(
        "Servo diagnostic: {}",
        json!({
            "event": event,
            "processId": std::process::id(),
            "requestId": request_id,
            "operation": op.map(short),
            "tabId": tab.map(short),
        })
    );
}

async fn response_line(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(available.len());
        let length = line.len() + end;
        let trailing_cr = available[..end].last().or_else(|| line.last()) == Some(&b'\r');
        if length > MAX_RESPONSE_BYTES + usize::from(trailing_cr) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Engine response exceeds 8 MiB",
            ));
        }
        if length > line.capacity() {
            let capacity = length
                .max(line.capacity().saturating_mul(2))
                .min(MAX_RESPONSE_BYTES + 1);
            line.reserve_exact(capacity - line.len());
        }
        line.extend_from_slice(&available[..end]);
        reader.consume(end + usize::from(newline.is_some()));
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}
struct State {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: SyncMutex<HashMap<u64, oneshot::Sender<Value>>>,
    unknown: SyncMutex<HashSet<String>>,
    failed: AtomicBool,
    closing: AtomicBool,
    next: AtomicU64,
    timeout: Duration,
}
#[derive(Clone)]
pub struct NativeClient {
    state: Arc<State>,
    lease_id: Option<String>,
}
struct CompletionGuard {
    state: Arc<State>,
    tab: Option<String>,
    armed: bool,
    request_id: u64,
    sent: bool,
    operation: String,
    reason: &'static str,
}
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        self.state.pending.lock().unwrap().remove(&self.request_id);
        if self.armed {
            if !self.sent {
                if !self.state.failed.swap(true, Ordering::SeqCst) {
                    diagnostic(
                        self.reason,
                        Some(self.request_id),
                        Some(&self.operation),
                        self.tab.as_deref(),
                    );
                }
            } else if let Some(tab) = &self.tab {
                if self.state.unknown.lock().unwrap().insert(tab.clone()) {
                    diagnostic(
                        self.reason,
                        Some(self.request_id),
                        Some(&self.operation),
                        Some(tab),
                    );
                }
            } else {
                if !self.state.failed.swap(true, Ordering::SeqCst) {
                    diagnostic(
                        self.reason,
                        Some(self.request_id),
                        Some(&self.operation),
                        None,
                    );
                }
            }
        }
    }
}
impl NativeClient {
    pub async fn start(binary: &Path, directory: &Path, timeout: Duration) -> Result<Self> {
        let mut child = Command::new(binary)
            .arg("--engine-profile")
            .arg(directory)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| Error::Protocol("Engine input unavailable".into()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| Error::Protocol("Engine output unavailable".into()))?;
        let state = Arc::new(State {
            child: Mutex::new(child),
            input: Mutex::new(input),
            pending: SyncMutex::new(HashMap::new()),
            unknown: SyncMutex::new(HashSet::new()),
            failed: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            next: AtomicU64::new(1),
            timeout,
        });
        let weak = Arc::downgrade(&state);
        tokio::spawn(async move {
            let mut reader = BufReader::new(output);
            let reason = loop {
                let line = match response_line(&mut reader).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break "engine_eof",
                    Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                        break "response_limit";
                    }
                    Err(_) => break "response_read_failed",
                };
                let Some(state) = weak.upgrade() else { return };
                let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                    break "invalid_response_json";
                };
                if let Some(id) = value["id"].as_u64() {
                    let sender = state.pending.lock().unwrap().remove(&id);
                    if let Some(sender) = sender {
                        let _ = sender.send(value);
                    }
                } else {
                    break "invalid_response_id";
                }
            };
            if let Some(state) = weak.upgrade() {
                if !state.failed.swap(true, Ordering::SeqCst)
                    && !(reason == "engine_eof" && state.closing.load(Ordering::SeqCst))
                {
                    diagnostic(reason, None, None, None);
                }
                state.pending.lock().unwrap().clear();
            }
        });
        let client = Self {
            state,
            lease_id: None,
        };
        client.request("status", None, Value::Null, false).await?;
        Ok(client)
    }
    pub fn with_lease(&self, lease: Option<&str>) -> Self {
        Self {
            state: self.state.clone(),
            lease_id: lease.map(str::to_owned),
        }
    }
    pub async fn request(
        &self,
        op: &str,
        tab: Option<&str>,
        args: Value,
        human: bool,
    ) -> Result<Value> {
        if op != "shutdown"
            && (self.state.failed.load(Ordering::SeqCst)
                || tab.is_some_and(|tab| self.state.unknown.lock().unwrap().contains(tab)))
        {
            return Err(Error::Uncertain);
        }
        let id = self.state.next.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.state.pending.lock().unwrap().insert(id, sender);
        let mut guard = CompletionGuard {
            state: self.state.clone(),
            tab: tab.map(str::to_owned),
            armed: false,
            request_id: id,
            sent: false,
            operation: op.into(),
            reason: "request_cancelled",
        };
        let bytes = serde_json::to_vec(
            &json!({"id":id,"op":op,"tabId":tab,"leaseId":self.lease_id,"human":human,"args":args}),
        )?;
        if bytes.len() > 65536 {
            self.state.pending.lock().unwrap().remove(&id);
            return Err(Error::Invalid("Engine request exceeds 64 KiB".into()));
        }
        let reply = tokio::time::timeout(self.state.timeout, async {
            let mut input = self.state.input.lock().await;
            guard.armed = true;
            guard.reason = "request_write_failed";
            input.write_all(&bytes).await?;
            input.write_all(b"\n").await?;
            input.flush().await?;
            guard.sent = true;
            guard.reason = "request_cancelled";
            drop(input);
            receiver.await.map_err(|_| {
                guard.reason = "engine_connection_closed";
                Error::Protocol("Engine connection closed; completion is unknown".into())
            })
        })
        .await;
        let result = match reply {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                self.state.pending.lock().unwrap().remove(&id);
                return Err(error);
            }
            Err(_) => {
                guard.reason = "request_timeout";
                self.state.pending.lock().unwrap().remove(&id);
                return Err(Error::Uncertain);
            }
        };
        guard.armed = false;
        if let Some(error) = result["error"].as_str() {
            return Err(match error {
                "busy" => Error::Busy,
                "uncertain" => {
                    if let Some(tab) = tab
                        && self.state.unknown.lock().unwrap().insert(tab.into())
                    {
                        diagnostic("engine_reported_uncertain", Some(id), Some(op), Some(tab));
                    }
                    Error::Uncertain
                }
                "humanControl" => Error::HumanControl,
                other => Error::Invalid(other.into()),
            });
        }
        result.get("value").cloned().ok_or_else(|| {
            guard.armed = true;
            guard.reason = "invalid_response_envelope";
            Error::Protocol("Invalid engine response; completion is unknown".into())
        })
    }
    pub async fn close(&self) -> Result<()> {
        self.state.closing.store(true, Ordering::SeqCst);
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            self.request("shutdown", None, Value::Null, false),
        )
        .await;
        let mut child = self.state.child.lock().await;
        match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            _ => {
                child.kill().await?;
                Ok(())
            }
        }
    }
    pub fn uncertain(&self) -> bool {
        self.state.failed.load(Ordering::SeqCst) || !self.state.unknown.lock().unwrap().is_empty()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    static FIXTURE_START: Mutex<()> = Mutex::const_new(());
    #[tokio::test]
    async fn response_frames_preserve_split_utf8_crlf_and_following_lines() {
        let input = "{\"id\":1,\"value\":\"💡\"}\r\n{\"id\":2,\"value\":42}\nlast";
        let mut reader = BufReader::with_capacity(2, std::io::Cursor::new(input.as_bytes()));
        let first = response_line(&mut reader).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&first).unwrap()["value"],
            "💡"
        );
        let second = response_line(&mut reader).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&second).unwrap()["value"],
            42
        );
        assert_eq!(response_line(&mut reader).await.unwrap().unwrap(), b"last");
        assert!(response_line(&mut reader).await.unwrap().is_none());
    }
    #[tokio::test]
    async fn response_byte_boundary_accepts_split_crlf_and_rejects_extra_data() {
        let mut input = vec![b'x'; MAX_RESPONSE_BYTES];
        input.extend_from_slice(b"\r\n");
        let mut reader =
            BufReader::with_capacity(MAX_RESPONSE_BYTES + 1, std::io::Cursor::new(input));
        let line = response_line(&mut reader).await.unwrap().unwrap();
        assert_eq!(line.len(), MAX_RESPONSE_BYTES);
        assert!(line.capacity() <= MAX_RESPONSE_BYTES + 1);
        let mut reader = BufReader::new(std::io::Cursor::new(vec![b'x'; MAX_RESPONSE_BYTES + 1]));
        assert_eq!(
            response_line(&mut reader).await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
    }
    #[tokio::test]
    async fn oversized_unterminated_response_fails_before_request_timeout() {
        let fixture_lock = FIXTURE_START.lock().await;
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("servo-native-limit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("fixture");
        std::fs::write(
            &binary,
            r#"#!/usr/bin/env python3
import sys,json,os
for line in sys.stdin:
 r=json.loads(line)
 if r['op']=='oversized':
  try:
   sys.stdout.write('x'*(8*1024*1024+1));sys.stdout.flush()
  except BrokenPipeError:os._exit(0)
  continue
 try:print(json.dumps({'id':r['id'],'value':{'ok':True}}),flush=True)
 except BrokenPipeError:os._exit(0)
 if r['op']=='shutdown':break
"#,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = NativeClient::start(&binary, &root, Duration::from_secs(2))
            .await
            .unwrap();
        drop(fixture_lock);
        let result = client
            .request("oversized", Some("tab-a"), Value::Null, false)
            .await;
        client.close().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            matches!(result, Err(Error::Protocol(_))),
            "Oversized response waited for the request timeout: {result:?}"
        );
    }
    #[tokio::test]
    async fn cancellation_blocks_only_its_target_and_removes_pending_request() {
        let fixture_lock = FIXTURE_START.lock().await;
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("servo-native-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("fixture");
        std::fs::write(
            &binary,
            r#"#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 r=json.loads(line)
 if r['op']=='wait':
  open(sys.argv[2]+'/received','w').close()
  continue
 print(json.dumps({'id':r['id'],'value':{'ok':True}}),flush=True)
 if r['op']=='shutdown':break
"#,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = NativeClient::start(&binary, &root, Duration::from_secs(2))
            .await
            .unwrap();
        drop(fixture_lock);
        let clone = client.clone();
        let request = tokio::spawn(async move {
            clone
                .request("wait", Some("tab-a"), Value::Null, false)
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !root.join("received").exists() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        request.abort();
        let _ = request.await;
        assert!(client.state.pending.lock().unwrap().is_empty());
        assert!(matches!(
            client
                .request("observe", Some("tab-a"), Value::Null, false)
                .await,
            Err(Error::Uncertain)
        ));
        assert!(
            client
                .request("observe", Some("tab-b"), Value::Null, false)
                .await
                .is_ok()
        );
        client.close().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
