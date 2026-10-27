//! Only loopback listeners are used; authentication belongs to the outer network session.
use crate::{CONNECT_TIMEOUT, Peer, Rules};
use std::{
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::timeout,
};

pub async fn serve(
    listener: TcpListener,
    peer: Arc<Peer>,
    rules: Rules,
    lifetime: crate::CancellationToken,
) {
    let slots = Arc::new(Semaphore::new(crate::MAX_STREAMS));
    loop {
        let accepted = tokio::select! {
            _ = lifetime.cancelled() => break,
            result = listener.accept() => result,
        };
        let Ok((socket, _)) = accepted else {
            break;
        };
        if peer.cancelled.is_cancelled() {
            drop(socket);
            continue;
        }
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(socket);
            continue;
        };
        let peer = peer.clone();
        let rules = rules.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = connection(socket, peer, rules).await;
        });
    }
}
async fn target(socket: &mut TcpStream) -> io::Result<(String, u16)> {
    let (version, methods) = (socket.read_u8().await?, socket.read_u8().await?);
    if version != 5 || methods == 0 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut offered = vec![0; methods.into()];
    socket.read_exact(&mut offered).await?;
    if !offered.contains(&0) {
        socket.write_all(&[5, 255]).await?;
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    socket.write_all(&[5, 0]).await?;
    let mut header = [0; 4];
    socket.read_exact(&mut header).await?;
    if header[..3] != [5, 1, 0] {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let host = match header[3] {
        1 => {
            let mut bytes = [0; 4];
            socket.read_exact(&mut bytes).await?;
            IpAddr::V4(Ipv4Addr::from(bytes)).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            socket.read_exact(&mut bytes).await?;
            IpAddr::V6(Ipv6Addr::from(bytes)).to_string()
        }
        3 => {
            let count = socket.read_u8().await?;
            let mut bytes = vec![0; count.into()];
            socket.read_exact(&mut bytes).await?;
            String::from_utf8(bytes).map_err(|_| io::ErrorKind::InvalidData)?
        }
        _ => return Err(io::ErrorKind::InvalidData.into()),
    };
    let port = socket.read_u16().await?;
    if port == 0 || !crate::valid_host(&host) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok((host, port))
}
async fn connection(mut socket: TcpStream, peer: Arc<Peer>, rules: Rules) -> io::Result<()> {
    let (host, port) = timeout(CONNECT_TIMEOUT, target(&mut socket))
        .await
        .map_err(|_| io::ErrorKind::TimedOut)??;
    if rules.matches(&host, port) {
        return peer.tunnel(socket, &host, port).await;
    }
    // Unmatched traffic keeps the browser server's existing network route.
    let connected = tokio::select! {
        _ = peer.cancelled.cancelled() => return Err(io::ErrorKind::ConnectionAborted.into()),
        result = timeout(CONNECT_TIMEOUT,TcpStream::connect((host.as_str(),port))) => result,
    };
    let mut upstream = match connected {
        Ok(Ok(socket)) => socket,
        _ => {
            socket.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(io::ErrorKind::ConnectionRefused.into());
        }
    };
    socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?;
    tokio::select! {
        _ = peer.cancelled.cancelled() => Ok(()),
        result = tokio::io::copy_bidirectional(&mut socket,&mut upstream) => result.map(|_|()),
    }
}
