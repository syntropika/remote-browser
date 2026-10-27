use super::*;
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};

async fn socket(proxy: std::net::SocketAddr, target: u16) -> TcpStream {
    let mut socket = TcpStream::connect(proxy).await.unwrap();
    // Fragment the greeting to exercise the actual SOCKS framing seam.
    socket.write_all(&[5]).await.unwrap();
    socket.write_all(&[1, 0]).await.unwrap();
    let mut reply = [0; 2];
    socket.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply, [5, 0]);
    let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
    request.extend_from_slice(&target.to_be_bytes());
    socket.write_all(&request).await.unwrap();
    let mut reply = [0; 10];
    socket.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply[..2], &[5, 0]);
    socket
}
fn wire(
    broker: Arc<Peer>,
    mut from_broker: tokio::sync::mpsc::Receiver<Frame>,
    connector: Arc<Peer>,
    mut from_connector: tokio::sync::mpsc::Receiver<Frame>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _=broker.cancelled.cancelled()=>break,
                _=connector.cancelled.cancelled()=>break,
                frame=from_broker.recv()=>match frame{Some(frame)=>if connector.receive(frame).await.is_err(){break;},None=>break},
                frame=from_connector.recv()=>match frame{Some(frame)=>if broker.receive(frame).await.is_err(){break;},None=>break},
            }
        }
        broker.close();
        connector.close();
    });
}
#[tokio::test]
async fn multiple_streams_preserve_bytes_half_close_and_disconnect() {
    timeout(std::time::Duration::from_secs(10), async {
        let backend = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = backend.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = backend.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let (mut r, mut w) = stream.into_split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        let rules = Rules::parse(&format!("127.0.0.1:{target}")).unwrap();
        let (broker, bframes) = Peer::new(Side::Broker, rules.clone());
        let (connector, cframes) = Peer::new(Side::Connector, rules.clone());
        wire(broker.clone(), bframes, connector.clone(), cframes);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = listener.local_addr().unwrap();
        tokio::spawn(serve(
            listener,
            broker.clone(),
            rules,
            broker.cancelled.child_token(),
        ));
        let mut tasks = tokio::task::JoinSet::new();
        for seed in 0..4u8 {
            tasks.spawn(async move {
                let stream = socket(proxy, target).await;
                let (mut read, mut write) = stream.into_split();
                let payload = vec![seed; CHUNK * 10 + 137];
                let expected = payload.clone();
                let sending = tokio::spawn(async move {
                    write.write_all(&payload).await.unwrap();
                    write.shutdown().await.unwrap();
                });
                let mut got = Vec::new();
                read.read_to_end(&mut got).await.unwrap();
                sending.await.unwrap();
                assert_eq!(got, expected);
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        let mut live = socket(proxy, target).await;
        connector.close();
        let mut byte = [0; 1];
        assert!(matches!(live.read(&mut byte).await, Ok(0) | Err(_)));
        echo.abort();
        broker.close();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn disallowed_connector_destinations_and_oversized_frames_are_rejected() {
    let (peer, _) = Peer::new(Side::Connector, Rules::parse("localhost:3000").unwrap());
    assert!(
        peer.receive(Frame::Text(
            r#"{"type":"open","id":1,"host":"localhost","port":8080}"#.into()
        ))
        .await
        .is_err()
    );
    assert!(
        peer.receive(Frame::Binary(vec![0; MAX_FRAME + 1]))
            .await
            .is_err()
    );
    peer.close();
}

#[tokio::test]
async fn retired_proxy_port_cannot_be_reassigned_until_its_context_is_gone() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (peer, _) = Peer::new(Side::Broker, Rules::parse("<loopback>").unwrap());
    let lifetime = CancellationToken::new();
    let task = tokio::spawn(serve(
        listener,
        peer.clone(),
        Rules::parse("<loopback>").unwrap(),
        lifetime.clone(),
    ));
    peer.close();
    assert!(TcpListener::bind(address).await.is_err());
    let mut old_page = TcpStream::connect(address).await.unwrap();
    let mut byte = [0; 1];
    assert_eq!(
        timeout(CONNECT_TIMEOUT, old_page.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(
        !task.is_finished(),
        "The retired endpoint must still reject old-page connections"
    );
    drop(old_page);
    lifetime.cancel();
    task.await.unwrap();
}
