use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use remote_browser_servo::{
    Error,
    automation::{Automation, Owner},
    webdriver::WebDriver,
};
use reqwest::Method;
use serde_json::{Value, json};

struct Reply {
    method: &'static str,
    path: &'static str,
    status: u16,
    envelope: Value,
    delay: Duration,
    body: Option<Value>,
}

impl Reply {
    fn ok(method: &'static str, path: &'static str, value: Value) -> Self {
        Self {
            method,
            path,
            status: 200,
            envelope: json!({"value":value}),
            delay: Duration::ZERO,
            body: None,
        }
    }

    fn with_body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    fn delayed(mut self) -> Self {
        self.delay = Duration::from_millis(200);
        self
    }
}

struct Fixture {
    endpoint: String,
    seen: Arc<AtomicUsize>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = seen.clone();
        let thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            for reply in replies {
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(stream) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "Expected {} {}",
                                reply.method,
                                reply.path
                            );
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let header_end = loop {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                    if let Some(end) = bytes.windows(4).position(|item| item == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let header = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                assert!(
                    header.starts_with(&format!("{} {} HTTP/1.1\r\n", reply.method, reply.path)),
                    "{header}"
                );
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|number| number.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                }
                if reply.path == "/session" {
                    let request: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                    assert_eq!(
                        request["capabilities"]["alwaysMatch"]["browserName"],
                        "servo"
                    );
                }
                if let Some(expected) = reply.body {
                    let request: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                    assert_eq!(request, expected);
                }
                counter.fetch_add(1, Ordering::SeqCst);
                thread::sleep(reply.delay);
                let body = reply.envelope.to_string();
                // Cancellation can close the client before the delayed reply is written.
                let _ = write!(
                    stream,
                    "HTTP/1.1 {} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.status,
                    body.len(),
                    body
                );
            }
        });
        Self {
            endpoint,
            seen,
            thread: Some(thread),
        }
    }

    async fn wait_for(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.seen.load(Ordering::SeqCst) < count {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    fn finish(mut self) {
        self.thread.take().unwrap().join().unwrap();
    }
}

fn handshake(mut rest: Vec<Reply>) -> Vec<Reply> {
    let mut replies = vec![
        Reply::ok(
            "POST",
            "/session",
            json!({"sessionId":"session","capabilities":{"browserName":"servo"}}),
        ),
        Reply::ok("POST", "/session/session/timeouts", Value::Null),
    ];
    replies.append(&mut rest);
    replies
}

#[tokio::test]
async fn timeout_blocks_further_commands() {
    let fixture = Fixture::start(handshake(vec![
        Reply::ok("GET", "/session/session/window", json!("tab")).delayed(),
    ]));
    let driver = WebDriver::connect(&fixture.endpoint, Duration::from_millis(50))
        .await
        .unwrap();
    assert!(matches!(
        driver.command(Method::GET, &["window"], None).await,
        Err(Error::Transport(_))
    ));
    assert!(driver.is_uncertain());
    assert!(matches!(
        driver.command(Method::GET, &["window"], None).await,
        Err(Error::Uncertain)
    ));
    fixture.finish();
}

#[tokio::test]
async fn cancellation_retains_uncertainty_and_overlap_is_busy() {
    let fixture = Fixture::start(handshake(vec![
        Reply::ok("GET", "/session/session/window", json!("tab")).delayed(),
    ]));
    let browser = Automation::connect(&fixture.endpoint, Duration::from_secs(2))
        .await
        .unwrap();
    let copy = browser.clone();
    let operation = tokio::spawn(async move { copy.tabs().await });
    fixture.wait_for(3).await;
    assert!(matches!(browser.tabs().await, Err(Error::Busy)));
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    assert!(browser.status().await.uncertain);
    assert!(matches!(browser.tabs().await, Err(Error::Uncertain)));
    fixture.finish();
}

#[tokio::test]
async fn definitive_element_error_allows_recovery() {
    let mut stale = Reply::ok("POST", "/session/session/element/node/click", Value::Null);
    stale.status = 404;
    stale.envelope =
        json!({"value":{"error":"stale element reference","message":"Element was removed"}});
    let fixture = Fixture::start(handshake(vec![
        stale,
        Reply::ok("GET", "/session/session/window", json!("tab")),
    ]));
    let driver = WebDriver::connect(&fixture.endpoint, Duration::from_secs(2))
        .await
        .unwrap();
    assert!(matches!(
        driver
            .command(Method::POST, &["element", "node", "click"], Some(json!({})))
            .await,
        Err(Error::WebDriver { .. })
    ));
    assert!(!driver.is_uncertain());
    assert_eq!(
        driver
            .command(Method::GET, &["window"], None)
            .await
            .unwrap(),
        "tab"
    );
    fixture.finish();
}

#[tokio::test]
async fn malformed_response_blocks_further_commands() {
    let mut malformed = Reply::ok("GET", "/session/session/window", Value::Null);
    malformed.envelope = json!({"unexpected":"shape"});
    let fixture = Fixture::start(handshake(vec![malformed]));
    let driver = WebDriver::connect(&fixture.endpoint, Duration::from_secs(2))
        .await
        .unwrap();
    assert!(matches!(
        driver.command(Method::GET, &["window"], None).await,
        Err(Error::Protocol(_))
    ));
    assert!(driver.is_uncertain());
    fixture.finish();
}

#[tokio::test]
async fn human_ownership_blocks_operations_without_touching_servo() {
    let fixture = Fixture::start(handshake(vec![]));
    let browser = Automation::connect(&fixture.endpoint, Duration::from_secs(2))
        .await
        .unwrap();
    browser.set_owner(Owner::Human).await;
    assert_eq!(browser.status().await.owner, Owner::Human);
    assert!(matches!(browser.tabs().await, Err(Error::HumanControl)));
    assert!(matches!(
        browser.evaluate("tab", "return 1").await,
        Err(Error::HumanControl)
    ));
    fixture.finish();
}

#[tokio::test]
async fn refuses_non_servo_sessions_and_deletes_them() {
    let fixture = Fixture::start(vec![
        Reply::ok(
            "POST",
            "/session",
            json!({"sessionId":"session","capabilities":{"browserName":"chrome"}}),
        ),
        Reply::ok("DELETE", "/session/session", Value::Null),
    ]);
    assert!(matches!(
        WebDriver::connect(&fixture.endpoint, Duration::from_secs(2)).await,
        Err(Error::Protocol(_))
    ));
    fixture.finish();
}

#[tokio::test]
async fn reservations_deny_before_io_and_target_selection_is_atomic() {
    let fixture = Fixture::start(handshake(vec![
        Reply::ok("GET", "/session/session/window/handles", json!(["a", "b"])),
        Reply::ok("GET", "/session/session/window/handles", json!(["a", "b"])),
        Reply::ok("GET", "/session/session/window", json!("a")),
        Reply::ok("POST", "/session/session/window", Value::Null)
            .with_body(json!({"handle":"b"}))
            .delayed(),
        Reply::ok("POST", "/session/session/execute/sync", json!("result b")),
        Reply::ok("GET", "/session/session/window", json!("b")),
        Reply::ok("POST", "/session/session/window", Value::Null).with_body(json!({"handle":"a"})),
        Reply::ok("POST", "/session/session/execute/sync", json!("result a")),
    ]));
    let browser = Automation::connect(&fixture.endpoint, Duration::from_secs(2))
        .await
        .unwrap();
    let a = browser.reserve("a", "task a", 300_000).await.unwrap();
    let b = browser.reserve("b", "task b", 300_000).await.unwrap();
    let task_a = browser.with_lease(Some(&a.lease_id));
    let task_b = browser.with_lease(Some(&b.lease_id));
    assert!(matches!(
        browser.evaluate("b", "return 1").await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        task_a.select_tab("b").await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(fixture.seen.load(Ordering::SeqCst), 4);
    let operation = tokio::spawn(async move { task_b.evaluate("b", "return 'result b'").await });
    fixture.wait_for(6).await;
    assert!(matches!(
        task_a.evaluate("a", "return 1").await,
        Err(Error::Busy)
    ));
    assert_eq!(operation.await.unwrap().unwrap(), "result b");
    assert_eq!(
        task_a.evaluate("a", "return 'result a'").await.unwrap(),
        "result a"
    );
    fixture.finish();
}
