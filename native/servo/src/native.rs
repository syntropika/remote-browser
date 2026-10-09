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
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, oneshot},
};
struct State {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: SyncMutex<HashMap<u64, oneshot::Sender<Value>>>,
    unknown: SyncMutex<HashSet<String>>,
    failed: AtomicBool,
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
}
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        self.state.pending.lock().unwrap().remove(&self.request_id);
        if self.armed {
            if !self.sent {
                self.state.failed.store(true, Ordering::SeqCst);
            } else if let Some(tab) = &self.tab {
                self.state.unknown.lock().unwrap().insert(tab.clone());
            } else {
                self.state.failed.store(true, Ordering::SeqCst);
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
            next: AtomicU64::new(1),
            timeout,
        });
        let weak = Arc::downgrade(&state);
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(state) = weak.upgrade() else { return };
                if line.len() > 8 * 1024 * 1024 {
                    state.failed.store(true, Ordering::SeqCst);
                    break;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    state.failed.store(true, Ordering::SeqCst);
                    break;
                };
                if let Some(id) = value["id"].as_u64() {
                    let sender = state.pending.lock().unwrap().remove(&id);
                    if let Some(sender) = sender {
                        let _ = sender.send(value);
                    }
                } else {
                    state.failed.store(true, Ordering::SeqCst);
                    break;
                }
            }
            if let Some(state) = weak.upgrade() {
                state.failed.store(true, Ordering::SeqCst);
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
            input.write_all(&bytes).await?;
            input.write_all(b"\n").await?;
            input.flush().await?;
            guard.sent = true;
            drop(input);
            receiver.await.map_err(|_| {
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
                self.state.pending.lock().unwrap().remove(&id);
                return Err(Error::Uncertain);
            }
        };
        guard.armed = false;
        if let Some(error) = result["error"].as_str() {
            return Err(match error {
                "busy" => Error::Busy,
                "uncertain" => {
                    if let Some(tab) = tab {
                        self.state.unknown.lock().unwrap().insert(tab.into());
                    }
                    Error::Uncertain
                }
                "humanControl" => Error::HumanControl,
                other => Error::Invalid(other.into()),
            });
        }
        result.get("value").cloned().ok_or_else(|| {
            guard.armed = true;
            Error::Protocol("Invalid engine response; completion is unknown".into())
        })
    }
    pub async fn close(&self) -> Result<()> {
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
    #[tokio::test]
    async fn cancellation_blocks_only_its_target_and_removes_pending_request() {
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
