//! Optional local destinations are exposed only after an explicit tool call.
use crate::remote::Remote;
use futures_util::{SinkExt, StreamExt};
use remote_browser_network::{CONNECT_TIMEOUT, Frame, MAX_FRAME, Peer, Rules, Side};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{sync::Mutex, time::timeout};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

struct Active {
    description: Value,
    peer: Arc<Peer>,
    connected: Arc<AtomicBool>,
}
pub struct Networks {
    remote: Arc<Remote>,
    entries: Mutex<HashMap<String, Active>>,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Args {
    Open {
        profile_id: Option<String>,
        expose_network: String,
    },
    List {},
    Close {
        network_session_id: String,
    },
}
impl Networks {
    pub fn new(remote: Arc<Remote>) -> Self {
        Self {
            remote,
            entries: Mutex::default(),
        }
    }
    pub async fn call(&self, args: Value) -> Result<Value, String> {
        match serde_json::from_value(args).map_err(|_| "Invalid browser_network arguments")? {
            Args::Open {
                profile_id,
                expose_network,
            } => {
                let rules = Rules::parse(&expose_network)?;
                let description = self
                    .remote
                    .open_network(&json!({"profileId":profile_id,"exposeNetwork":expose_network}))
                    .await?;
                let id = description["networkSessionId"]
                    .as_str()
                    .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                    .ok_or("Invalid network session response")?
                    .to_owned();
                let outcome = self.connect(&id, rules, description).await;
                if outcome.is_err() {
                    let _ = self.remote.close_network(&id).await;
                }
                outcome
            }
            Args::List {} => Ok(
                json!({"sessions":self.entries.lock().await.values().map(|entry|{let mut value=entry.description.clone();value["connected"]=json!(entry.connected.load(Ordering::Acquire));value}).collect::<Vec<_>>()}),
            ),
            Args::Close { network_session_id } => {
                let entry = self
                    .entries
                    .lock()
                    .await
                    .remove(&network_session_id)
                    .ok_or("This local MCP does not own that network session")?;
                entry.peer.close();
                let _ = self.remote.close_network(&network_session_id).await;
                Ok(
                    json!({"closed":true,"networkSessionId":network_session_id,"tabLeasesPreserved":true}),
                )
            }
        }
    }
    async fn connect(
        &self,
        id: &str,
        rules: Rules,
        mut description: Value,
    ) -> Result<Value, String> {
        let mut url = self.remote.url(&format!("network/sessions/{id}/connect"));
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| "Invalid tunnel endpoint")?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| "Invalid tunnel endpoint")?;
        request
            .headers_mut()
            .insert("authorization", self.remote.authorization.clone());
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let (socket, _) = timeout(
            CONNECT_TIMEOUT,
            connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| "Network tunnel connection timed out")?
        .map_err(|_| "Could not authenticate or connect the network tunnel")?;
        let (peer, mut output) = Peer::new(Side::Connector, rules);
        let connected = Arc::new(AtomicBool::new(true));
        description["connected"] = json!(true);
        self.entries.lock().await.insert(
            id.into(),
            Active {
                description: description.clone(),
                peer: peer.clone(),
                connected: connected.clone(),
            },
        );
        tokio::spawn(async move {
            let (mut send, mut receive) = socket.split();
            loop {
                tokio::select! {
                    _=peer.cancelled.cancelled()=>break,
                    frame=output.recv()=>{
                        let Some(frame)=frame else{break;};let message=match frame{Frame::Text(text)=>Message::Text(text.into()),Frame::Binary(bytes)=>Message::Binary(bytes.into())};
                        if !matches!(timeout(CONNECT_TIMEOUT,send.send(message)).await,Ok(Ok(()))){break;}
                    }
                    message=receive.next()=>{
                        let Some(Ok(message))=message else{break;};let frame=match message{Message::Text(text)=>Frame::Text(text.to_string()),Message::Binary(bytes)=>Frame::Binary(bytes.to_vec()),Message::Close(_)=>break,_=>continue};
                        if peer.receive(frame).await.is_err(){break;}
                    }
                }
            }
            peer.close();
            connected.store(false, Ordering::Release);
        });
        Ok(description)
    }
    pub async fn shutdown(&self) {
        for (_, entry) in self.entries.lock().await.drain() {
            entry.peer.close();
        }
    }
}
pub fn tool() -> Value {
    json!({"name":"browser_network","description":"Expose selected host:port destinations from this machine to an isolated remote test session. Open requires exposeNetwork (comma-separated hostname/port rules or <loopback>). Pass returned networkSessionId to browser_tabs reserve without tabId. Pages are created in the background; select explicitly to view. Normal tabs retain their network and cookies. Close disconnects the tunnel but preserves tab reservations. No destinations are exposed until open is called.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"action":{"enum":["open","list","close"]},"profileId":{"type":"string","minLength":1,"maxLength":64},"exposeNetwork":{"type":"string","minLength":1,"maxLength":4096},"networkSessionId":{"type":"string","minLength":1,"maxLength":64}},"required":["action"],"oneOf":[{"properties":{"action":{"const":"open"}},"required":["exposeNetwork"],"not":{"required":["networkSessionId"]}},{"properties":{"action":{"const":"list"}},"not":{"anyOf":[{"required":["profileId"]},{"required":["exposeNetwork"]},{"required":["networkSessionId"]}]}},{"properties":{"action":{"const":"close"}},"required":["networkSessionId"],"not":{"anyOf":[{"required":["profileId"]},{"required":["exposeNetwork"]}]}}]},"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}})
}
