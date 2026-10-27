use crate::{CHUNK, CONNECT_TIMEOUT, MAX_FRAME, MAX_STREAMS, Rules, valid_host};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Broker,
    Connector,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Open { id: u32, host: String, port: u16 },
    Connected { id: u32 },
    End { id: u32 },
    Close { id: u32 },
}
#[derive(Debug)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}
#[derive(Debug)]
enum Event {
    Connected,
    Data(Vec<u8>),
    End,
    Close,
}

pub struct Peer {
    side: Side,
    rules: Rules,
    next: AtomicU32,
    streams: Mutex<HashMap<u32, mpsc::Sender<Event>>>,
    output: mpsc::Sender<Frame>,
    slots: Arc<Semaphore>,
    pub cancelled: CancellationToken,
}
impl Peer {
    pub fn new(side: Side, rules: Rules) -> (Arc<Self>, mpsc::Receiver<Frame>) {
        let (output, frames) = mpsc::channel(128);
        (
            Arc::new(Self {
                side,
                rules,
                next: AtomicU32::new(1),
                streams: Mutex::default(),
                output,
                slots: Arc::new(Semaphore::new(MAX_STREAMS)),
                cancelled: CancellationToken::new(),
            }),
            frames,
        )
    }
    pub fn close(&self) {
        self.cancelled.cancel();
        self.streams.lock().unwrap().clear();
    }
    async fn send(&self, frame: Frame) -> io::Result<()> {
        tokio::select! {
            _ = self.cancelled.cancelled() => Err(io::ErrorKind::ConnectionAborted.into()),
            result = timeout(CONNECT_TIMEOUT, self.output.send(frame)) => result.map_err(|_| io::ErrorKind::TimedOut)?.map_err(|_| io::ErrorKind::BrokenPipe.into()),
        }
    }
    async fn control(&self, value: Control) -> io::Result<()> {
        self.send(Frame::Text(serde_json::to_string(&value)?)).await
    }
    fn dispatch(&self, id: u32, event: Event) {
        let sender = self.streams.lock().unwrap().get(&id).cloned();
        if let Some(sender) = sender
            && sender.try_send(event).is_err()
        {
            self.streams.lock().unwrap().remove(&id);
            if self
                .output
                .try_send(Frame::Text(
                    serde_json::to_string(&Control::Close { id }).unwrap(),
                ))
                .is_err()
            {
                self.close();
            }
        }
    }
    pub async fn receive(self: &Arc<Self>, frame: Frame) -> io::Result<()> {
        match frame {
            Frame::Binary(bytes) => {
                if bytes.len() < 5 || bytes.len() > CHUNK + 4 {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                let id = u32::from_be_bytes(bytes[..4].try_into().unwrap());
                self.dispatch(id, Event::Data(bytes[4..].to_vec()));
            }
            Frame::Text(text) => {
                if text.len() > MAX_FRAME {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                match serde_json::from_str::<Control>(&text)? {
                    Control::Open { id, host, port } => {
                        if self.side != Side::Connector
                            || id == 0
                            || port == 0
                            || !valid_host(&host)
                            || !self.rules.matches(&host, port)
                        {
                            return Err(io::ErrorKind::PermissionDenied.into());
                        }
                        let permit = self
                            .slots
                            .clone()
                            .try_acquire_owned()
                            .map_err(|_| io::ErrorKind::OutOfMemory)?;
                        let (sender, receiver) = mpsc::channel(32);
                        if self.streams.lock().unwrap().insert(id, sender).is_some() {
                            return Err(io::ErrorKind::InvalidData.into());
                        }
                        let peer = self.clone();
                        tokio::spawn(async move {
                            let _permit = permit;
                            let connection = tokio::select! {
                                _ = peer.cancelled.cancelled() => None,
                                result = timeout(CONNECT_TIMEOUT, TcpStream::connect((if host == "localhost" || host.ends_with(".localhost") { "localhost" } else { host.as_str() }, port))) => result.ok().and_then(Result::ok),
                            };
                            if let Some(socket) = connection
                                && peer.control(Control::Connected { id }).await.is_ok()
                            {
                                let _ = peer.relay(id, socket, receiver).await;
                            }
                            peer.streams.lock().unwrap().remove(&id);
                            let _ = peer.control(Control::Close { id }).await;
                        });
                    }
                    Control::Connected { id } => {
                        if self.side != Side::Broker {
                            return Err(io::ErrorKind::InvalidData.into());
                        }
                        self.dispatch(id, Event::Connected);
                    }
                    Control::End { id } => self.dispatch(id, Event::End),
                    Control::Close { id } => self.dispatch(id, Event::Close),
                }
            }
        }
        Ok(())
    }
    pub async fn tunnel(
        self: &Arc<Self>,
        mut socket: TcpStream,
        host: &str,
        port: u16,
    ) -> io::Result<()> {
        let _permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| io::ErrorKind::OutOfMemory)?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            self.close();
            return Err(io::ErrorKind::ConnectionAborted.into());
        }
        let (sender, mut receiver) = mpsc::channel(32);
        self.streams.lock().unwrap().insert(id, sender);
        let outcome = async {
            self.control(Control::Open {
                id,
                host: host.into(),
                port,
            })
            .await?;
            let ready = tokio::select! {
                _ = self.cancelled.cancelled() => None,
                result = timeout(CONNECT_TIMEOUT, receiver.recv()) => result.ok().flatten(),
            };
            if !matches!(ready, Some(Event::Connected)) {
                let _ = socket.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return Err(io::ErrorKind::ConnectionRefused.into());
            }
            socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?;
            self.relay(id, socket, receiver).await
        }
        .await;
        self.streams.lock().unwrap().remove(&id);
        let _ = self.control(Control::Close { id }).await;
        outcome
    }
    async fn relay(
        &self,
        id: u32,
        socket: TcpStream,
        mut receiver: mpsc::Receiver<Event>,
    ) -> io::Result<()> {
        socket.set_nodelay(true)?;
        let (mut reader, mut writer) = socket.into_split();
        let (mut reading, mut writing) = (true, true);
        let mut buffer = vec![0; CHUNK];
        while reading || writing {
            tokio::select! {
                _ = self.cancelled.cancelled() => break,
                result = reader.read(&mut buffer), if reading => {
                    let size = result?;
                    if size == 0 { reading = false; self.control(Control::End{id}).await?; }
                    else { let mut bytes = Vec::with_capacity(size+4); bytes.extend_from_slice(&id.to_be_bytes()); bytes.extend_from_slice(&buffer[..size]); self.send(Frame::Binary(bytes)).await?; }
                }
                event = receiver.recv() => match event {
                    Some(Event::Data(bytes)) => { timeout(CONNECT_TIMEOUT, writer.write_all(&bytes)).await.map_err(|_| io::ErrorKind::TimedOut)??; }
                    Some(Event::End) => { writer.shutdown().await?; writing = false; }
                    _ => break,
                }
            }
        }
        Ok(())
    }
}
