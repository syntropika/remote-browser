//! Authenticated network sessions are independent from tab leases and the dashboard login.
use crate::{Error, Result, identity, native_extensions::McpExtension, profiles::Profiles};
use axum::{
    Json, Router,
    extract::{
        Extension, Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::{delete, get, post},
};
use futures_util::{SinkExt, StreamExt};
use remote_browser_network::{CONNECT_TIMEOUT, Frame, MAX_FRAME, Peer, Rules, Side};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, mpsc},
    time::{interval, timeout},
};

#[derive(Default)]
pub(crate) struct Sessions {
    pub(crate) entries: Mutex<HashMap<String, Arc<Session>>>,
    pub(crate) cleanup_started: AtomicBool,
    pub(crate) stopped: remote_browser_network::CancellationToken,
}
pub(crate) struct Session {
    id: String,
    owner: String,
    pub(crate) profile: String,
    rules: String,
    proxy: std::net::SocketAddr,
    pub(crate) peer: Arc<Peer>,
    listener_stop: remote_browser_network::CancellationToken,
    frames: AsyncMutex<Option<mpsc::Receiver<Frame>>>,
    connected: AtomicBool,
    pub(crate) pending_reservations: AtomicUsize,
}
impl Session {
    fn description(&self) -> Value {
        json!({"networkSessionId":self.id,"profileId":self.profile,"exposeNetwork":self.rules,"connected":self.connected.load(Ordering::Acquire) && !self.peer.cancelled.is_cancelled()})
    }
    pub(crate) fn configuration(&self) -> Result<Value> {
        if !self.connected.load(Ordering::Acquire) || self.peer.cancelled.is_cancelled() {
            return Err(Error::Invalid(
                "Connect the local network tunnel before reserving a test tab".into(),
            ));
        }
        Ok(json!({"id":self.id,"proxy":self.proxy.to_string()}))
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.peer.close();
        self.listener_stop.cancel();
    }
}
impl Sessions {
    async fn open(self: &Arc<Self>, profile: String, rules: String) -> Result<Arc<Session>> {
        if self.stopped.is_cancelled() {
            return Err(Error::Invalid("The browser is stopping".into()));
        }
        let routes = Rules::parse(&rules).map_err(Error::Invalid)?;
        let owner = identity::current().id;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let proxy = listener.local_addr()?;
        let (peer, frames) = Peer::new(Side::Broker, routes.clone());
        let session = Arc::new(Session {
            id: uuid::Uuid::new_v4().to_string(),
            owner: owner.clone(),
            profile,
            rules,
            proxy,
            peer: peer.clone(),
            listener_stop: remote_browser_network::CancellationToken::new(),
            frames: AsyncMutex::new(Some(frames)),
            connected: AtomicBool::new(false),
            pending_reservations: AtomicUsize::new(0),
        });
        {
            let mut entries = self.entries.lock().unwrap();
            if self.stopped.is_cancelled()
                || entries.len() >= 256
                || entries
                    .values()
                    .filter(|s| !s.peer.cancelled.is_cancelled())
                    .count()
                    >= 32
                || entries
                    .values()
                    .filter(|s| s.owner == owner && !s.peer.cancelled.is_cancelled())
                    .count()
                    >= 4
            {
                return Err(Error::Invalid(
                    "Close an existing network session before opening another".into(),
                ));
            }
            entries.insert(session.id.clone(), session.clone());
        }
        tokio::spawn(remote_browser_network::serve(
            listener,
            peer,
            routes,
            session.listener_stop.clone(),
        ));
        let weak = Arc::downgrade(self);
        let id = session.id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if let Some(sessions) = weak.upgrade() {
                let entries = sessions.entries.lock().unwrap();
                if entries
                    .get(&id)
                    .is_some_and(|s| !s.connected.load(Ordering::Acquire))
                    && let Some(session) = entries.get(&id)
                {
                    session.peer.close();
                }
            }
        });
        Ok(session)
    }
    fn authorize(session: Arc<Session>, profile: Option<&str>) -> Result<Arc<Session>> {
        identity::check()?;

        if session.peer.cancelled.is_cancelled() {
            return Err(Error::Invalid("Network session is closed".into()));
        }
        if session.owner != identity::current().id || profile.is_some_and(|p| p != session.profile)
        {
            return Err(Error::Invalid(
                "Network session belongs to another connection or profile".into(),
            ));
        }
        identity::check_profile(&session.profile)?;
        Ok(session)
    }
    pub(crate) fn get(&self, id: &str, profile: Option<&str>) -> Result<Arc<Session>> {
        let entries = self.entries.lock().unwrap();
        let session = entries
            .get(id)
            .cloned()
            .ok_or_else(|| Error::Invalid("Network session is unavailable".into()))?;
        Self::authorize(session, profile)
    }
    pub(crate) fn reserve(&self, id: &str, profile: Option<&str>) -> Result<ReservationPin> {
        let entries = self.entries.lock().unwrap();
        let session = entries
            .get(id)
            .cloned()
            .ok_or_else(|| Error::Invalid("Network session is unavailable".into()))?;
        let session = Self::authorize(session, profile)?;
        session.pending_reservations.fetch_add(1, Ordering::AcqRel);
        Ok(ReservationPin(session))
    }
    fn close(&self, id: &str) {
        if let Some(session) = self.entries.lock().unwrap().get(id) {
            session.peer.close();
        }
    }
    pub(crate) fn close_all(&self) {
        self.stopped.cancel();
        for (_, session) in self.entries.lock().unwrap().drain() {
            session.peer.close();
            session.listener_stop.cancel();
        }
    }
}
#[derive(Clone)]
struct Host {
    profiles: Profiles,
    extension: Arc<McpExtension>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    profile_id: Option<String>,
    expose_network: String,
}
type HttpResult<T> = std::result::Result<T, (axum::http::StatusCode, &'static str)>;
fn rejected(_: Error) -> (axum::http::StatusCode, &'static str) {
    (
        axum::http::StatusCode::BAD_REQUEST,
        "Network session unavailable or request invalid",
    )
}

async fn open(
    State(host): State<Host>,
    Extension(client): Extension<identity::Client>,
    Json(args): Json<Open>,
) -> HttpResult<Json<Value>> {
    identity::scope(client, async {
        let profile = host.profiles.profile_id(args.profile_id.as_deref());
        identity::check_profile(&profile).map_err(rejected)?;
        host.profiles
            .browser(Some(&profile))
            .await
            .map_err(rejected)?;
        let session = host
            .profiles
            .network
            .open(profile, args.expose_network)
            .await
            .map_err(rejected)?;
        Ok(Json(session.description()))
    })
    .await
}
async fn close(
    State(host): State<Host>,
    Extension(client): Extension<identity::Client>,
    Path(id): Path<String>,
) -> HttpResult<Json<Value>> {
    identity::scope(client, async {
        host.profiles.network.get(&id, None).map_err(rejected)?;
        host.profiles.network.close(&id);
        Ok(Json(json!({"closed":true})))
    })
    .await
}
async fn connect(
    State(host): State<Host>,
    Extension(client): Extension<identity::Client>,
    Path(id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> HttpResult<Response> {
    let session = identity::scope(client.clone(), async {
        host.profiles.network.get(&id, None)
    })
    .await
    .map_err(rejected)?;
    if session.connected.swap(true, Ordering::AcqRel) {
        return Err((
            axum::http::StatusCode::CONFLICT,
            "Network session is already connected",
        ));
    }
    Ok(upgrade
        .max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_failed_upgrade({
            let sessions = host.profiles.network.clone();
            let id = id.clone();
            move |_| sessions.close(&id)
        })
        .on_upgrade(move |socket| async move {
            let _ = socket_loop(socket, &session, &host.extension, client).await;
            host.profiles.network.close(&id);
        }))
}
async fn socket_loop(
    socket: WebSocket,
    session: &Session,
    extension: &McpExtension,
    client: identity::Client,
) -> std::result::Result<(), ()> {
    let Some(mut frames) = session.frames.lock().await.take() else {
        return Err(());
    };
    let (mut send, mut receive) = socket.split();
    let mut heartbeat = interval(Duration::from_secs(5));
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _=session.peer.cancelled.cancelled()=>break,
            _=heartbeat.tick()=>{
                if extension.enabled().is_err() || identity::scope(client.clone(),async{identity::check_profile(&session.profile)}).await.is_err() || last_seen.elapsed()>Duration::from_secs(20){break;}
                if timeout(CONNECT_TIMEOUT,send.send(Message::Ping(Vec::new().into()))).await.map_err(|_|())?.is_err(){break;}
            }
            frame=frames.recv()=>{
                let Some(frame)=frame else{break;};
                let message=match frame{Frame::Text(text)=>Message::Text(text.into()),Frame::Binary(bytes)=>Message::Binary(bytes.into())};
                timeout(CONNECT_TIMEOUT,send.send(message)).await.map_err(|_|())?.map_err(|_|())?;
            }
            message=receive.next()=>{
                let Some(Ok(message))=message else{break;};last_seen=tokio::time::Instant::now();
                let frame=match message{Message::Text(text)=>Frame::Text(text.to_string()),Message::Binary(bytes)=>Frame::Binary(bytes.to_vec()),Message::Close(_)=>break,_=>continue};
                session.peer.receive(frame).await.map_err(|_|())?;
            }
        }
    }
    session.peer.close();
    Ok(())
}
pub(crate) fn router(profiles: Profiles, extension: Arc<McpExtension>) -> Router {
    profiles.network.start_cleanup(profiles.clone());
    Router::new()
        .route("/network/sessions", post(open))
        .route("/network/sessions/{id}", delete(close))
        .route("/network/sessions/{id}/connect", get(connect))
        .with_state(Host {
            profiles,
            extension,
        })
}

/// A pending native reservation keeps its proxy endpoint alive until the engine replies.
pub(crate) struct ReservationPin(Arc<Session>);
impl ReservationPin {
    pub(crate) fn profile(&self) -> &str {
        &self.0.profile
    }
    pub(crate) fn configuration(&self) -> Result<Value> {
        self.0.configuration()
    }
}
impl Drop for ReservationPin {
    fn drop(&mut self) {
        self.0.pending_reservations.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn retired_ports_wait_for_native_reservations_and_live_contexts() {
        let sessions = Arc::new(Sessions::default());
        let session = sessions
            .open("default".into(), "<loopback>".into())
            .await
            .unwrap();
        session.connected.store(true, Ordering::Release);
        let pin = sessions.reserve(&session.id, None).unwrap();
        sessions.close(&session.id);
        assert!(sessions.reserve(&session.id, None).is_err());
        let eligible = std::collections::HashSet::from([session.id.clone()]);
        sessions.reap("default", &Default::default(), &eligible);
        assert!(sessions.entries.lock().unwrap().contains_key(&session.id));
        drop(pin);
        let used = std::collections::HashSet::from([session.id.clone()]);
        sessions.reap("default", &used, &eligible);
        assert!(sessions.entries.lock().unwrap().contains_key(&session.id));
        sessions.reap("default", &Default::default(), &eligible);
        assert!(!sessions.entries.lock().unwrap().contains_key(&session.id));
        let later = sessions
            .open("default".into(), "<loopback>".into())
            .await
            .unwrap();
        sessions.close(&later.id);
        sessions.reap("default", &Default::default(), &eligible);
        assert!(
            sessions.entries.lock().unwrap().contains_key(&later.id),
            "A later retirement cannot use an earlier native snapshot"
        );
        sessions.close_all();
    }
}
