//! Embedded Servo with one profile per process and independent tab surfaces.
use fs2::FileExt;
use remote_browser_servo::reservations::Reservations;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use servo::{
    InputEvent, InputEventId, InputEventResult, JSValue, LoadStatus, Opts, RenderingContext, Servo,
    ServoBuilder, SoftwareRenderingContext, WebDriverCommandMsg, WebDriverScriptCommand, WebView,
    WebViewBuilder, WebViewDelegate,
};
use servo_base::{
    generic_channel::{self, GenericReceiver, GenericSender, TryReceiveError},
    id::BrowsingContextId,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    io::{BufRead, Write},
    path::PathBuf,
    rc::{Rc, Weak},
    sync::mpsc,
    time::{Duration, Instant},
};
use url::Url;
use webdriver::error::ErrorStatus;
mod operations;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: u64,
    op: String,
    tab_id: Option<String>,
    lease_id: Option<String>,
    #[serde(default)]
    human: bool,
    #[serde(default)]
    args: Value,
}
struct Tab {
    view: WebView,
    refs: HashMap<String, String>,
    owned: bool,
    busy: bool,
    uncertain: bool,
    human: bool,
    takeover: Option<u64>,
    load_request: Option<u64>,
    initialized: bool,
    queued_navigation: Option<Url>,
    load_started: bool,
}
struct Pending {
    tab: String,
    deadline: Instant,
    exclusive: bool,
}
type Poller = Box<dyn FnMut(&Rc<Engine>) -> bool>;
struct Engine {
    servo: Servo,
    tabs: RefCell<HashMap<String, Tab>>,
    reservations: RefCell<Reservations>,
    visible: RefCell<String>,
    pending: RefCell<HashMap<u64, Pending>>,
    pollers: RefCell<Vec<Poller>>,
    inputs: RefCell<HashMap<InputEventId, u64>>,
    output: mpsc::Sender<Value>,
    quitting: Cell<bool>,
}
struct Delegate(Weak<Engine>);
impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, view: WebView) {
        view.paint();
    }
    fn notify_load_status_changed(&self, view: WebView, status: LoadStatus) {
        let Some(engine) = self.0.upgrade() else {
            return;
        };
        let (complete, queued) = {
            let mut tabs = engine.tabs.borrow_mut();
            let Some(tab) = tabs.values_mut().find(|tab| tab.view.id() == view.id()) else {
                return;
            };
            if status == LoadStatus::Started && tab.initialized {
                tab.load_started = true;
            }
            if status != LoadStatus::Complete {
                return;
            }
            if !tab.initialized {
                tab.initialized = true;
                (None, tab.queued_navigation.take())
            } else if tab.load_started {
                tab.load_started = false;
                (tab.load_request.take(), None)
            } else {
                (None, None)
            }
        };
        // Initial about:blank must finish before a requested navigation begins.
        if let Some(url) = queued {
            view.load(url);
        }
        if let Some(id) = complete {
            engine.complete(id, Ok(json!({"ok":true})));
        }
    }
    fn notify_input_event_handled(&self, _: WebView, event: InputEventId, _: InputEventResult) {
        if let Some(engine) = self.0.upgrade() {
            let id = engine.inputs.borrow_mut().remove(&event);
            if let Some(id) = id {
                engine.complete(id, Ok(json!({"ok":true})));
            }
        }
    }
    fn notify_crashed(&self, view: WebView, _: String, _: Option<String>) {
        if let Some(engine) = self.0.upgrade()
            && let Some(tab) = engine
                .tabs
                .borrow_mut()
                .values_mut()
                .find(|t| t.view.id() == view.id())
        {
            tab.uncertain = true;
        }
    }
}
impl Engine {
    fn add_tab(self: &Rc<Self>, owned: bool) -> String {
        let context = Rc::new(
            SoftwareRenderingContext::new(dpi::PhysicalSize::new(1024, 768))
                .expect("Software renderer unavailable"),
        );
        context
            .make_current()
            .expect("Rendering context unavailable");
        let view = WebViewBuilder::new(&self.servo, context)
            .url(Url::parse("about:blank").unwrap())
            .delegate(Rc::new(Delegate(Rc::downgrade(self))))
            .build();
        let id = view.id().to_string();
        self.tabs.borrow_mut().insert(
            id.clone(),
            Tab {
                view,
                refs: HashMap::new(),
                owned,
                busy: false,
                uncertain: false,
                human: false,
                takeover: None,
                load_request: None,
                initialized: false,
                queued_navigation: None,
                load_started: false,
            },
        );
        id
    }
    fn reply(&self, id: u64, result: Result<Value, String>) {
        let message = match result {
            Ok(value) => json!({"id":id,"value":value}),
            Err(error) => json!({"id":id,"error":error}),
        };
        let _ = self.output.send(message);
    }
    fn complete(&self, id: u64, result: Result<Value, String>) {
        let pending = self.pending.borrow_mut().remove(&id);
        if let Some(p) = pending {
            let takeover = if p.exclusive {
                self.tabs.borrow_mut().get_mut(&p.tab).and_then(|t| {
                    t.busy = false;
                    t.takeover.take()
                })
            } else {
                None
            };
            self.reply(id, result);
            if let Some(takeover) = takeover {
                self.reservations.borrow_mut().remove(&p.tab);
                if let Some(t) = self.tabs.borrow_mut().get_mut(&p.tab) {
                    t.human = true;
                    t.refs.clear();
                }
                self.reply(takeover, Ok(json!({"ok":true})));
            }
        }
    }
    fn begin(&self, request: &Request) -> Result<WebView, String> {
        let id = request.tab_id.as_deref().ok_or("tabId is required")?;
        let mut tabs = self.tabs.borrow_mut();
        let tab = tabs.get_mut(id).ok_or("Unknown tab")?;
        if tab.uncertain {
            return Err("uncertain".into());
        }
        if tab.takeover.is_some() || (!request.human && tab.human) {
            return Err("humanControl".into());
        }
        if request.human {
            if !matches!(request.op.as_str(), "screenshot" | "health")
                && self
                    .reservations
                    .borrow_mut()
                    .info(id, Instant::now())
                    .is_some()
            {
                return Err("This tab is reserved by an agent".into());
            }
        } else {
            self.reservations
                .borrow_mut()
                .check(id, request.lease_id.as_deref(), Instant::now())
                .map_err(|e| e.to_string())?;
        }
        let exclusive = !(request.human && request.op == "screenshot");
        if exclusive && tab.busy {
            return Err("busy".into());
        }
        if exclusive {
            tab.busy = true;
        }
        self.pending.borrow_mut().insert(
            request.id,
            Pending {
                tab: id.into(),
                deadline: Instant::now() + Duration::from_secs(12),
                exclusive,
            },
        );
        Ok(tab.view.clone())
    }
    fn view(&self, id: u64) -> Option<WebView> {
        let pending = self.pending.borrow();
        let tab = &pending.get(&id)?.tab;
        self.tabs.borrow().get(tab).map(|t| t.view.clone())
    }
    fn invalidate(&self, id: u64) {
        if let Some(p) = self.pending.borrow().get(&id)
            && let Some(tab) = self.tabs.borrow_mut().get_mut(&p.tab)
        {
            tab.refs.clear();
        }
    }
    fn reference(&self, request: &Request) -> Result<String, String> {
        let reference = request.args["reference"]
            .as_str()
            .ok_or("reference is required")?;
        self.tabs
            .borrow()
            .get(request.tab_id.as_deref().unwrap_or(""))
            .and_then(|t| t.refs.get(reference))
            .cloned()
            .ok_or("Unknown or expired reference; take a fresh snapshot".into())
    }
    fn evaluate(
        self: &Rc<Self>,
        id: u64,
        body: &str,
        args: Value,
        callback: impl FnOnce(&Rc<Self>, Value) + 'static,
    ) {
        let Some(view) = self.view(id) else { return };
        let weak = Rc::downgrade(self);
        view.evaluate_javascript(
            format!("(function(){{{body}}}).apply(null,{args})"),
            move |result| {
                let Some(engine) = weak.upgrade() else { return };
                if !engine.pending.borrow().contains_key(&id) {
                    return;
                }
                match result {
                    Ok(value) => callback(&engine, to_json(value)),
                    Err(_) => engine.complete(
                        id,
                        Err(
                            "Page JavaScript failed or the document is not ready; observe again"
                                .into(),
                        ),
                    ),
                }
            },
        );
    }
    fn command<T>(
        self: &Rc<Self>,
        id: u64,
        build: impl FnOnce(GenericSender<Result<T, ErrorStatus>>) -> WebDriverScriptCommand,
        callback: impl FnOnce(&Rc<Self>, T) + 'static,
    ) where
        T: Serialize + for<'a> Deserialize<'a> + 'static,
    {
        let Some(view) = self.view(id) else { return };
        let (sender, receiver) = generic_channel::channel().expect("Internal channel unavailable");
        self.servo
            .execute_webdriver_command(WebDriverCommandMsg::ScriptCommand(
                BrowsingContextId::from(view.id()),
                build(sender),
            ));
        self.poll_receiver(id, receiver, callback);
    }
    fn poll_receiver<T>(
        self: &Rc<Self>,
        id: u64,
        receiver: GenericReceiver<Result<T, ErrorStatus>>,
        callback: impl FnOnce(&Rc<Self>, T) + 'static,
    ) where
        T: Serialize + for<'a> Deserialize<'a> + 'static,
    {
        let mut callback = Some(callback);
        self.pollers.borrow_mut().push(Box::new(move |engine| {
            if !engine.pending.borrow().contains_key(&id) {
                return true;
            }
            match receiver.try_recv() {
                Ok(Ok(value)) => {
                    callback.take().unwrap()(engine, value);
                    true
                }
                Ok(Err(error)) => {
                    engine.complete(
                        id,
                        Err(format!("Element operation failed: {}", error.error_code())),
                    );
                    true
                }
                Err(TryReceiveError::Empty) => false,
                Err(_) => {
                    engine.poison(id);
                    true
                }
            }
        }));
    }
    fn input(self: &Rc<Self>, id: u64, events: Vec<InputEvent>) {
        let Some(view) = self.view(id) else { return };
        let mut last = None;
        for event in events {
            last = Some(view.notify_input_event(event));
        }
        if let Some(last) = last {
            self.inputs.borrow_mut().insert(last, id);
        } else {
            self.complete(id, Ok(json!({"ok":true})));
        }
    }
    fn poison(&self, id: u64) {
        let takeover = self.pending.borrow().get(&id).and_then(|p| {
            self.tabs.borrow_mut().get_mut(&p.tab).and_then(|t| {
                t.uncertain = true;
                t.takeover.take()
            })
        });
        if let Some(t) = takeover {
            self.reply(t, Err("uncertain".into()));
        }
        self.complete(id, Err("uncertain".into()));
    }
    fn tick(self: &Rc<Self>) {
        self.servo.spin_event_loop();
        let tasks = std::mem::take(&mut *self.pollers.borrow_mut());
        for mut task in tasks {
            if !task(self) {
                self.pollers.borrow_mut().push(task);
            }
        }
        let expired: Vec<_> = self
            .pending
            .borrow()
            .iter()
            .filter(|(_, p)| p.deadline <= Instant::now())
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            self.poison(id);
        }
    }
    fn dispatch(self: &Rc<Self>, request: Request) {
        if let Err(error) = self.execute(&request) {
            if self.pending.borrow().contains_key(&request.id) {
                self.complete(request.id, Err(error));
            } else {
                self.reply(request.id, Err(error));
            }
        }
    }
}
fn to_json(value: JSValue) -> Value {
    match value {
        JSValue::Undefined | JSValue::Null => Value::Null,
        JSValue::Boolean(v) => json!(v),
        JSValue::Number(v) => json!(v),
        JSValue::String(v) => json!(v),
        JSValue::Element(v) => json!({remote_browser_servo::webdriver::ELEMENT_KEY:v}),
        JSValue::Array(v) => Value::Array(v.into_iter().map(to_json).collect()),
        JSValue::Object(v) => Value::Object(v.into_iter().map(|(k, v)| (k, to_json(v))).collect()),
        _ => Value::Null,
    }
}
fn run_engine(directory: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join(".engine-lock"))?;
    lock.try_lock_exclusive()?;
    let (input_tx, input_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.len() > 65536 {
                continue;
            }
            match serde_json::from_str::<Request>(&line) {
                Ok(r) => {
                    if input_tx.send(Some(r)).is_err() {
                        return;
                    }
                }
                Err(_) => eprintln!("Invalid engine request"),
            }
        }
        let _ = input_tx.send(None);
    });
    let (output_tx, output_rx) = mpsc::channel::<Value>();
    let writer = std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        for value in output_rx {
            if writeln!(stdout, "{value}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let opts = Opts {
        config_dir: Some(directory),
        temporary_storage: false,
        ..Opts::default()
    };
    let engine = Rc::new(Engine {
        servo: ServoBuilder::default().opts(opts).build(),
        tabs: RefCell::new(HashMap::new()),
        reservations: RefCell::new(Reservations::default()),
        visible: RefCell::new(String::new()),
        pending: RefCell::new(HashMap::new()),
        pollers: RefCell::new(Vec::new()),
        inputs: RefCell::new(HashMap::new()),
        output: output_tx,
        quitting: Cell::new(false),
    });
    *engine.visible.borrow_mut() = engine.add_tab(false);
    while !engine.quitting.get() {
        while let Ok(request) = input_rx.try_recv() {
            match request {
                Some(r) => engine.dispatch(r),
                None => engine.quitting.set(true),
            }
        }
        engine.tick();
        std::thread::sleep(Duration::from_millis(2));
    }
    engine.tabs.borrow_mut().clear();
    engine.pollers.borrow_mut().clear();
    drop(engine);
    drop(lock);
    let _ = writer.join();
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--engine-profile") {
        run_engine(PathBuf::from(
            std::env::args()
                .nth(2)
                .ok_or("Pass the persistent profile directory")?,
        ))
    } else {
        remote_browser_servo::cli::main(Some(std::env::current_exe()?));
        Ok(())
    }
}
