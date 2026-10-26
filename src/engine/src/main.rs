//! Embedded Chromium with windowless tab surfaces, speaking the host's stdio protocol.
//!
//! CEF requires the browser process to own the main thread, so standard input is read on
//! its own thread and the operations it carries are served between turns of the message
//! loop. Only plain data crosses that boundary; browser objects never leave this thread.
//! Standard output carries protocol replies only; diagnostics go to stderr.

use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;
use cef::args::Args;
mod agent_actions;
mod browser_lifecycle;
mod cdp;
mod extension_installs;
mod extensions;
mod operations;
mod pointer;
mod session_health;
use operations::Navigation;

use cef::*;
use image::ImageEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use remote_browser_native::files::{DOWNLOAD_LIMIT, Files};
use remote_browser_native::reservations::{ReservationInfo, Reservations};
use serde::Deserialize;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The surface a tab renders at until the dashboard measures the display it has.
const VIEWPORT: (i32, i32) = (1024, 768);
/// An operation that has not finished by this deadline leaves completion unknown.
const OPERATION_LIMIT: Duration = Duration::from_secs(12);
/// How long to wait for a frame once the work that should produce it has finished.
const PAINT_LIMIT: Duration = Duration::from_millis(1500);
/// A short turn of the loop, enough for queued work to come through without holding a reply.
const SETTLE: Duration = Duration::from_millis(80);
/// The longest a frame request waits for the page to paint before reporting no change.
const FRAME_LIMIT: Duration = Duration::from_millis(400);

/// Reads the page the way a reader would: the text it shows and the things it offers to
/// interact with. The elements stay in this object, which CEF holds by handle, so acting
/// on one later needs no mark on the page itself.
const INSPECT: &str = r#"(() => {
  const limit = LIMIT;
  const elements = [];
  let visited = 0;
  let truncated = false;
  const clean = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const name = (element) => {
    const labelled = element.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (text.trim()) return clean(text, 160);
    }
    const label = element.getAttribute("aria-label");
    if (label) return clean(label, 160);
    if (element.labels?.length) return clean(Array.from(element.labels).map((label) => label.textContent).join(" "), 160);
    // Values, including passwords and text inputs, are deliberately excluded.
    return clean(element.getAttribute("alt") || element.getAttribute("placeholder") || element.innerText || element.getAttribute("title"), 160);
  };
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  let element = walker.currentNode;
  while (element) {
    if (++visited > 3000) { truncated = true; break; }
    const tag = element.localName;
    const role = element.getAttribute("role") || ({a:"link",button:"button",textarea:"textbox",select:"combobox",input:({checkbox:"checkbox",radio:"radio",button:"button",submit:"button",range:"slider",file:"file"}[element.type] || "textbox")}[tag]);
    const interactive = role || element.isContentEditable || element.tabIndex >= 0;
    if (interactive && tag !== "iframe" && visible(element)) {
      if (elements.length >= limit) { truncated = true; break; }
      elements.push({ element, role: role || "element", name: name(element), tag, type: element.getAttribute("type"), disabled: !!element.disabled });
    }
    element = walker.nextNode();
  }
  const text = document.body?.innerText || "";
  return { url: location.href, title: document.title, text: text.slice(0, 12000), truncated: truncated || text.length > 12000, elements };
})()"#;

/// The part of a snapshot that travels: the elements without their nodes.
const DESCRIBE: &str = r#"function() {
  return {
    url: this.url,
    title: this.title,
    text: this.text,
    truncated: this.truncated,
    elements: this.elements.map((entry) => ({
      role: entry.role,
      name: entry.name,
      tag: entry.tag,
      type: entry.type,
      disabled: entry.disabled,
    })),
  };
}"#;

/// The modifier bits CEF reads off an input event, from cef_event_flags_t.
const SHIFT_DOWN: u32 = 1 << 1;
const CONTROL_DOWN: u32 = 1 << 2;
const ALT_DOWN: u32 = 1 << 3;
const COMMAND_DOWN: u32 = 1 << 7;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Call {
    id: u64,
    op: String,
    tab_id: Option<String>,
    /// The reservation this caller holds, when it holds one.
    #[serde(default)]
    lease_id: Option<String>,
    /// Which client is calling. Agents may share a key and still hold separate tabs.
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    human: bool,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    trace_id: Option<String>,
    #[serde(default)]
    profile_key: Option<String>,
}

#[derive(Default)]
struct Painted {
    width: i32,
    height: i32,
    bgra: Vec<u8>,
    /// What moved in each of the last frames, so a display holding the frame before this
    /// one is sent the part of the surface that changed rather than all of it.
    changes: VecDeque<(u64, Patch)>,
}

/// A rectangle of the surface, in the pixels the page is painted at.
#[derive(Clone, Copy)]
struct Patch {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Patch {
    fn cover(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Self {
            x,
            y,
            width: (self.x + self.width).max(other.x + other.width) - x,
            height: (self.y + self.height).max(other.y + other.height) - y,
        }
    }

    /// The part of this rectangle that lies on a surface of the given size.
    fn within(self, width: i32, height: i32) -> Self {
        let x = self.x.clamp(0, width);
        let y = self.y.clamp(0, height);
        Self {
            x,
            y,
            width: (self.x + self.width).clamp(x, width) - x,
            height: (self.y + self.height).clamp(y, height) - y,
        }
    }

    fn area(self) -> i64 {
        self.width as i64 * self.height as i64
    }
}

/// How many frames of change to remember. A display that has fallen further behind than
/// this is sent the whole surface instead.
const REMEMBERED_CHANGES: usize = 48;

/// What the handlers CEF owns hand back to the loop that serves operations.
#[derive(Default)]
struct Shared {
    painted: Mutex<Painted>,
    /// The surface the dashboard asked for, which the render handler reports to CEF.
    size: Mutex<(i32, i32)>,
    /// Counts frames, so an operation can wait for the page it asked for to be drawn.
    paints: AtomicU64,
    url: Mutex<String>,
    title: Mutex<String>,
    /// Counts the pages this tab has been on, so a snapshot of an earlier one is known to
    /// be stale even when the page navigated by itself.
    pages: AtomicU64,
}

wrap_render_handler! {
    struct Surface {
        shared: Arc<Shared>,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                let (width, height) = *self.shared.size.lock().unwrap();
                rect.x = 0;
                rect.y = 0;
                rect.width = width;
                rect.height = height;
            }
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            buffer: *const u8,
            width: ::std::os::raw::c_int,
            height: ::std::os::raw::c_int,
        ) {
            if type_.get_raw() != PaintElementType::VIEW.get_raw() || buffer.is_null() {
                return;
            }
            let length = width as usize * height as usize * 4;
            // CEF owns these pixels only for the duration of the call.
            let pixels = unsafe { std::slice::from_raw_parts(buffer, length) };
            let mut painted = self.shared.painted.lock().unwrap();
            let resized = painted.width != width || painted.height != height;
            painted.width = width;
            painted.height = height;
            painted.bgra.clear();
            painted.bgra.extend_from_slice(pixels);
            // Counted while the frame is held, so a reader that takes this lock sees the
            // count and the pixels it belongs to.
            let seq = self.shared.paints.fetch_add(1, Ordering::Release) + 1;
            let whole = Patch { x: 0, y: 0, width, height };
            let moved = match _dirty_rects {
                Some(rects) if !rects.is_empty() && !resized => rects
                    .iter()
                    .map(|rect| Patch {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    })
                    .reduce(Patch::cover)
                    .map(|moved| moved.within(width, height))
                    .unwrap_or(whole),
                _ => whole,
            };
            painted.changes.push_back((seq, moved));
            while painted.changes.len() > REMEMBERED_CHANGES {
                painted.changes.pop_front();
            }
        }
    }
}

wrap_display_handler! {
    struct Caption {
        shared: Arc<Shared>,
    }

    impl DisplayHandler {
        fn on_address_change(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            url: Option<&CefString>,
        ) {
            if let Some(url) = url {
                *self.shared.url.lock().unwrap() = url.to_string();
                self.shared.pages.fetch_add(1, Ordering::Release);
            }
        }

        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Some(title) = title {
                *self.shared.title.lock().unwrap() = title.to_string();
            }
        }
    }
}

wrap_app! {
    struct Offscreen;

    impl App {
        fn on_before_command_line_processing(
            &self,
            _process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            if let Some(command_line) = command_line {
                if command_line.has_switch(Some(&CefString::from("type"))) != 1 {
                    command_line.append_switch_with_value(Some(&CefString::from("remote-debugging-port")), Some(&CefString::from("0")));
                    command_line.append_switch_with_value(Some(&CefString::from("remote-debugging-address")), Some(&CefString::from("127.0.0.1")));
                }
                // Off-screen surfaces do not require a desktop window system.
                if command_line.has_switch(Some(&CefString::from("ozone-platform"))) != 1 {
                    command_line.append_switch_with_value(Some(&CefString::from("ozone-platform")), Some(&CefString::from("headless")));
                }
            }
        }
    }
}

wrap_dialog_handler! {
    struct Picker {
        pending: Rc<RefCell<Option<FileDialogCallback>>>,
    }

    impl DialogHandler {
        fn on_file_dialog(
            &self,
            _browser: Option<&mut Browser>,
            _mode: FileDialogMode,
            _title: Option<&CefString>,
            _default_file_path: Option<&CefString>,
            _accept_filters: Option<&mut CefStringList>,
            _accept_extensions: Option<&mut CefStringList>,
            _accept_descriptions: Option<&mut CefStringList>,
            callback: Option<&mut FileDialogCallback>,
        ) -> ::std::os::raw::c_int {
            // There is no window to put a file dialog in. The request is held instead, and
            // the person or the agent answers it with files from the profile's workspace.
            if let Some(callback) = callback {
                *self.pending.borrow_mut() = Some(callback.clone());
            }
            1
        }
    }
}

wrap_download_handler! {
    struct Downloads {
        folder: Option<std::path::PathBuf>,
    }

    impl DownloadHandler {
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> ::std::os::raw::c_int {
            i32::from(self.folder.is_some())
        }

        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> ::std::os::raw::c_int {
            // A download a page starts goes to this profile's downloads folder under the
            // name the server suggested, with no dialog: there is no window to show one in.
            let (Some(folder), Some(callback)) = (self.folder.as_ref(), callback) else {
                return 0;
            };
            let suggested = suggested_name.map(ToString::to_string).unwrap_or_default();
            let name = match remote_browser_native::files::validate_name(&suggested) {
                Ok(()) => suggested,
                Err(_) => format!("download-{}", uuid::Uuid::new_v4()),
            };
            let path = folder.join(name);
            callback.cont(Some(&CefString::from(path.to_string_lossy().as_ref())), 0);
            1
        }
    }
}

wrap_client! {
    struct Surfaced {
        shared: Arc<Shared>,
        picker: Rc<RefCell<Option<FileDialogCallback>>>,
        dialog: Rc<RefCell<Option<agent_actions::PendingDialog>>>,
        downloads: Option<std::path::PathBuf>,
        browsers: browser_lifecycle::Browsers,
    }

    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(Surface::new(self.shared.clone()))
        }

        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(Caption::new(self.shared.clone()))
        }

        fn dialog_handler(&self) -> Option<DialogHandler> {
            Some(Picker::new(self.picker.clone()))
        }

        fn jsdialog_handler(&self) -> Option<JsdialogHandler> { Some(agent_actions::Dialogs::new(self.dialog.clone())) }

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(Downloads::new(self.downloads.clone()))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(self.browsers.handler())
        }
    }
}

/// Turns the message loop for a while, to let queued work such as painting come through.
fn pump_for(span: Duration) {
    let deadline = Instant::now() + span;
    while Instant::now() < deadline {
        do_message_loop_work();
        std::thread::sleep(Duration::from_millis(4));
    }
}

/// Turns the message loop until the condition holds, so a reply never blocks painting.
fn pump_until(ready: impl FnMut() -> bool) -> bool {
    pump_within(OPERATION_LIMIT, ready)
}

/// The same, giving up after a while. A frame that has not arrived by then is not worth
/// holding the loop for.
fn pump_within(span: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + span;
    while Instant::now() < deadline {
        do_message_loop_work();
        if ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(4));
    }
    false
}

/// The elements of one snapshot, which CEF holds for us by handle.
struct Held {
    object: String,
    generation: u64,
    /// The page the snapshot was taken on.
    page: u64,
}

struct Surfacing {
    id: String,
    browser: Browser,
    shared: Arc<Shared>,
    /// The last snapshot's elements; a reference names one of them.
    held: Option<Held>,
    /// Set while the page is waiting for files, which it asked for with a file dialog.
    picker: Rc<RefCell<Option<FileDialogCallback>>>,
    dialog: Rc<RefCell<Option<agent_actions::PendingDialog>>>,
    /// A tab a person took; agent operations on it are refused until they hand it back.
    human: bool,
    pointer: (i32, i32),
    clicks: pointer::Clicks,
    /// Text the dashboard put on this profile's clipboard, waiting to be pasted.
    pasteboard: String,
    target: String,
}

impl Surfacing {
    fn open(
        id: String,
        size: (i32, i32),
        downloads: Option<std::path::PathBuf>,
        browsers: browser_lifecycle::Browsers,
    ) -> Option<Self> {
        let shared = Arc::new(Shared::default());
        *shared.size.lock().unwrap() = size;
        let picker = Rc::new(RefCell::new(None));
        let dialog = Rc::new(RefCell::new(None));
        let window_info = WindowInfo::default().set_as_windowless(0);
        let mut client = Surfaced::new(
            shared.clone(),
            picker.clone(),
            dialog.clone(),
            downloads,
            browsers,
        );
        let browser = browser_host_create_browser_sync(
            Some(&window_info),
            Some(&mut client),
            Some(&CefString::from("about:blank")),
            Some(&BrowserSettings {
                // A windowless surface has no window behind it, so a page that paints no
                // background of its own would be handed over as transparent, which reads
                // as black once the alpha is dropped. A browser shows white there.
                background_color: 0xFFFF_FFFF,
                ..Default::default()
            }),
            None,
            None,
        )?;
        if let Some(host) = browser.host() {
            // Windowless rendering only produces frames for a view that is visible and has
            // been measured, and the dashboard's view is both from the moment it exists.
            host.was_hidden(0);
            host.was_resized();
            host.set_focus(1);
        }
        let target = cdp::identify(&browser).ok()?;
        Some(Self {
            id,
            browser,
            shared,
            held: None,
            picker,
            dialog,
            human: false,
            pointer: (size.0 / 2, size.1 / 2),
            clicks: pointer::Clicks::default(),
            pasteboard: String::new(),
            target,
        })
    }

    fn describe(&self, active: bool, reservation: Option<ReservationInfo>, busy: bool) -> Value {
        // A page writes its own title and address, and may write a great deal of them.
        let brief = |value: &str| -> String { value.chars().take(1024).collect() };
        json!({
            "id": self.id,
            "active": active,
            // Every tab here was opened by this engine, so the dashboard may close it.
            "owned": true,
            "canGoBack": self.browser.can_go_back() == 1,
            "canGoForward": self.browser.can_go_forward() == 1,
            "filePicker": self.picker.borrow().is_some(),
            "owner": if self.human { "human" } else { "agent" },
            "url": brief(&self.shared.url.lock().unwrap()),
            "title": brief(&self.shared.title.lock().unwrap()),
            "reservation": reservation,
            "busy": busy,
        })
    }
}

struct Engine {
    cdp: cdp::Adapter,
    installs: Option<extension_installs::InstallBridge>,
    extensions: Option<extensions::Manager>,
    browsers: browser_lifecycle::Browsers,
    tabs: Vec<Surfacing>,
    active: usize,
    next_tab: u32,
    /// The profile's file workspace: what a page may upload and what it downloaded.
    files: Option<Files>,
    /// Which client exclusively holds each reserved tab.
    reservations: Reservations,
    /// Counts snapshots, so a reference from an earlier one is recognised as stale.
    next_snapshot: u64,
    /// The display the dashboard last measured. Every tab renders at this size, so a tab
    /// opened later is the same shape as the one it was opened from.
    surface: (i32, i32),
    /// The calls waiting to be served, so work that can yield sees one coming.
    inbox: Arc<Inbox>,
    navigations: Vec<Navigation>,
}

impl Engine {
    /// Reserves, renews or releases a tab for the client behind this call.
    /// Closes one tab and forgets what it held. A caller has checked that it may go: the
    /// engine always keeps one.
    fn discard(&mut self, at: usize) {
        self.cdp.forget(&self.tabs[at].id);
        if let Some(installs) = &self.installs {
            installs.cancel(self.tabs[at].browser.identifier());
        }
        if let Some(host) = self.tabs[at].browser.host() {
            host.close_browser(1);
        }
        let closed = self.tabs[at].id.clone();
        self.reservations.remove(&closed);
        self.tabs.remove(at);
        self.active = self.active.min(self.tabs.len() - 1);
    }

    fn reserve(&mut self, call: &Call, tab: &str) -> Result<Value, String> {
        let client = call.client_id.as_deref().unwrap_or("stdio");
        match call.op.as_str() {
            "reserve" => {
                let task = call.args["task"].as_str().unwrap_or_default();
                let agent = call.args["agentName"].as_str().unwrap_or(task);
                let lease = self
                    .reservations
                    .reserve_named_for(tab, task, agent, client)
                    .map_err(|error| error.to_string())?;
                serde_json::to_value(lease).map_err(|error| error.to_string())
            }
            _ => {
                let token = call
                    .lease_id
                    .as_deref()
                    .ok_or("release needs the tab's leaseId")?;
                self.reservations
                    .release_for(tab, token, client)
                    .map_err(|error| error.to_string())?;
                Ok(Value::Null)
            }
        }
    }

    /// Where the named workspace files are, for the browser to read them.
    fn staged(&self, ids: &Value) -> Result<Vec<String>, String> {
        let ids = ids.as_array().ok_or("name the files to use")?;
        if ids.is_empty() {
            return Err("name at least one file".into());
        }
        let files = self.files()?;
        let mut paths = Vec::new();
        for id in ids {
            let id = id.as_str().ok_or("a file name is not text")?;
            let path = files.existing(id).map_err(|error| error.to_string())?;
            paths.push(path.to_string_lossy().into_owned());
        }
        Ok(paths)
    }

    /// The file workspace, which a profile only has when the host gave it one.
    fn files(&self) -> Result<&Files, String> {
        self.files
            .as_ref()
            .ok_or_else(|| "this profile has no file workspace".to_string())
    }

    fn index(&self, tab: Option<&str>) -> Result<usize, String> {
        match tab {
            None => Ok(self.active),
            Some(id) => self
                .tabs
                .iter()
                .position(|tab| tab.id == id)
                .ok_or_else(|| format!("no tab {id}")),
        }
    }

    fn open(&mut self) -> Result<Value, String> {
        self.next_tab += 1;
        let id = format!("tab-{}", self.next_tab);
        let downloads = self
            .files
            .as_ref()
            .map(|files| files.root().join("downloads"));
        let tab = Surfacing::open(id.clone(), self.surface, downloads, self.browsers.clone())
            .ok_or("the tab could not be created")?;
        if let Err(error) = self.cdp.bind(&id, &tab.target) {
            if let Some(host) = tab.browser.host() {
                host.close_browser(1);
            }
            return Err(error);
        }
        let painted = tab.shared.clone();
        self.tabs.push(tab);
        // A browser paints its first frame a moment after it exists, and until it does its
        // surface holds nothing. Waiting for that frame here is what makes a new tab show
        // the page rather than an empty rectangle.
        pump_within(PAINT_LIMIT, || painted.paints.load(Ordering::Acquire) > 0);
        Ok(Value::String(id))
    }

    /// Use the stable Chromiumoxide session for this engine-owned tab.
    fn protocol(&mut self, at: usize, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.execute(&self.tabs[at].id, method, params)
    }

    fn navigate(&mut self, at: usize, url: &str, id: u64) -> Result<Value, String> {
        let parsed = url::Url::parse(url).map_err(|_| "the URL is not valid".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https" | "about") {
            return Err("only HTTP(S) and about: can be opened".into());
        }
        self.release(at);
        self.tabs[at].clicks.reset();
        let frame = self.tabs[at]
            .browser
            .main_frame()
            .ok_or("the tab has no frame")?;
        frame.load_url(Some(&CefString::from(url)));
        self.navigations.push(Navigation::new(
            id,
            self.tabs[at].id.clone(),
            Instant::now(),
        ));
        Ok(Value::Null)
    }

    /// Waits for the page a history move or a reload asked for, as navigating does.
    fn settle(&mut self, at: usize) -> Result<Value, String> {
        let browser = self.tabs[at].browser.clone();
        // The load may not have started yet, so a turn of the loop comes first.
        pump_for(SETTLE);
        if !pump_until(|| browser.is_loading() == 0) {
            return Err("uncertain".into());
        }
        let shared = self.tabs[at].shared.clone();
        let drawn = shared.paints.load(Ordering::Acquire);
        pump_within(PAINT_LIMIT, || {
            shared.paints.load(Ordering::Acquire) != drawn
        });
        Ok(Value::Null)
    }

    fn evaluate(&mut self, at: usize, script: &str, awaited: bool) -> Result<Value, String> {
        let result = self.protocol(
            at,
            "Runtime.evaluate",
            json!({"expression": script, "returnByValue": true, "awaitPromise": awaited}),
        )?;
        if let Some(details) = result.get("exceptionDetails") {
            return Err(details["text"]
                .as_str()
                .unwrap_or("the script threw")
                .into());
        }
        Ok(result["result"]["value"].clone())
    }

    /// Encodes the surface as PNG, with the frame count it was taken at. A display that
    /// names the frame it holds is given only the rectangle that moved since.
    fn capture(&self, at: usize, since: Option<u64>) -> Result<(u64, Patch, Vec<u8>), String> {
        if self.tabs[at].shared.painted.lock().unwrap().bgra.is_empty() {
            // A tab that has just been created has nothing yet. Asking CEF to repaint one
            // that has never painted hands back an empty surface, so this waits for the
            // frame the browser is already going to produce.
            let painted = self.tabs[at].shared.clone();
            pump_within(PAINT_LIMIT, || painted.paints.load(Ordering::Acquire) > 0);
        }
        let painted = self.tabs[at].shared.painted.lock().unwrap();
        if painted.bgra.is_empty() {
            return Err("nothing has been painted yet".into());
        }
        // The painter holds this lock while it counts the frame, so the count read here
        // belongs to the pixels read here.
        let seq = self.tabs[at].shared.paints.load(Ordering::Acquire);
        let whole = Patch {
            x: 0,
            y: 0,
            width: painted.width,
            height: painted.height,
        };
        // Everything that moved since the frame the display holds. Falling too far behind,
        // or moving over most of the surface, is answered with the whole of it: the saving
        // is in a small rectangle, and the bookkeeping for a large one is not worth it.
        let moved = since
            .filter(|since| {
                painted
                    .changes
                    .front()
                    .is_some_and(|(first, _)| *first <= since + 1)
            })
            .and_then(|since| {
                painted
                    .changes
                    .iter()
                    .filter(|(frame, _)| *frame > since)
                    .map(|(_, moved)| *moved)
                    .reduce(Patch::cover)
            })
            .filter(|moved| moved.area() * 5 < whole.area() * 3 && moved.area() > 0)
            .unwrap_or(whole);
        // CEF paints BGRA. PNG wants RGB, and a page surface is opaque, so the alpha is a
        // quarter of the bytes to compress for nothing. Fast compression keeps a loopback
        // display at a frame rate a person reads as movement rather than as steps.
        let stride = painted.width as usize * 4;
        let mut rgb = vec![0u8; moved.width as usize * moved.height as usize * 3];
        for (row, out) in rgb
            .chunks_mut(moved.width as usize * 3)
            .enumerate()
            .take(moved.height as usize)
        {
            let start = (moved.y as usize + row) * stride + moved.x as usize * 4;
            let line = &painted.bgra[start..start + moved.width as usize * 4];
            for (out, pixel) in out
                .as_chunks_mut::<3>()
                .0
                .iter_mut()
                .zip(line.as_chunks::<4>().0)
            {
                out[0] = pixel[2];
                out[1] = pixel[1];
                out[2] = pixel[0];
            }
        }
        let mut png = Vec::new();
        PngEncoder::new_with_quality(&mut png, CompressionType::Default, FilterType::NoFilter)
            .write_image(
                &rgb,
                moved.width as u32,
                moved.height as u32,
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|error| error.to_string())?;
        Ok((seq, moved, png))
    }

    /// The frame a display asks for. A caller that already holds the current one can wait
    /// for the next, which is how a page's own movement reaches a display promptly. The
    /// wait ends the moment another call arrives, so watching never delays acting.
    fn frame(&mut self, at: usize, args: &Value) -> Result<Value, String> {
        let Some(since) = args["since"].as_u64() else {
            return Ok(Value::String(
                BASE64_STANDARD.encode(self.capture(at, None)?.2),
            ));
        };
        let wait =
            Duration::from_millis(args["wait"].as_u64().unwrap_or_default()).min(FRAME_LIMIT);
        let shared = self.tabs[at].shared.clone();
        let deadline = Instant::now() + wait;
        while shared.paints.load(Ordering::Acquire) <= since {
            if Instant::now() >= deadline || self.inbox.waiting() {
                return Ok(Value::Null);
            }
            do_message_loop_work();
            std::thread::sleep(Duration::from_millis(4));
        }
        let (seq, moved, png) = self.capture(at, Some(since))?;
        Ok(json!({
            "seq": seq,
            "x": moved.x,
            "y": moved.y,
            "width": moved.width,
            "height": moved.height,
            "image": BASE64_STANDARD.encode(png),
        }))
    }

    /// Reads the page: the text it shows and the things it offers to interact with. The
    /// elements stay with CEF, and each one is named by a reference the caller can use.
    fn snapshot(&mut self, at: usize, limit: usize) -> Result<Value, String> {
        self.release(at);
        let script = INSPECT.replace("LIMIT", &limit.clamp(1, 500).to_string());
        let read = self.protocol(
            at,
            "Runtime.evaluate",
            json!({"expression": script, "returnByValue": false, "awaitPromise": false}),
        )?;
        if let Some(details) = read.get("exceptionDetails") {
            return Err(details["text"]
                .as_str()
                .unwrap_or("the page could not be read")
                .into());
        }
        let object = read["result"]["objectId"]
            .as_str()
            .ok_or("the page could not be read")?
            .to_owned();
        let described = self.protocol(
            at,
            "Runtime.callFunctionOn",
            json!({"objectId": object, "functionDeclaration": DESCRIBE, "returnByValue": true}),
        )?;
        self.next_snapshot += 1;
        let generation = self.next_snapshot;
        let page = self.tabs[at].shared.pages.load(Ordering::Acquire);
        self.tabs[at].held = Some(Held {
            object,
            generation,
            page,
        });
        let mut value = described["result"]["value"].clone();
        let count = value["elements"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_default();
        value["tabId"] = Value::String(self.tabs[at].id.clone());
        for index in 0..count {
            value["elements"][index]["reference"] = Value::String(format!("{generation}:{index}"));
        }
        Ok(value)
    }

    /// Lets go of the elements a snapshot held, so the page can be collected.
    fn release(&mut self, at: usize) {
        if let Some(held) = self.tabs[at].held.take() {
            let _ = self.protocol(
                at,
                "Runtime.releaseObject",
                json!({"objectId": held.object}),
            );
        }
    }

    /// The element a reference names: the handle holding it, and its place in it.
    fn element(&self, at: usize, reference: &str) -> Result<(String, usize), String> {
        let held = self.tabs[at]
            .held
            .as_ref()
            .ok_or("take a snapshot of this tab before acting on its elements")?;
        let (generation, index) = reference
            .split_once(':')
            .ok_or("the element reference is not one this engine issued")?;
        if generation.parse::<u64>() != Ok(held.generation) {
            return Err(
                "the element reference belongs to an earlier snapshot; take a new one".into(),
            );
        }
        if self.tabs[at].shared.pages.load(Ordering::Acquire) != held.page {
            return Err("the page has changed since the snapshot; take a new one".into());
        }
        Ok((
            held.object.clone(),
            index
                .parse::<usize>()
                .map_err(|_| "the element reference is not one this engine issued".to_string())?,
        ))
    }

    /// Runs a function on one element of the snapshot.
    fn with_element(&mut self, at: usize, reference: &str, body: &str) -> Result<Value, String> {
        let (object, index) = self.element(at, reference)?;
        let result = self
            .protocol(
                at,
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object,
                    "functionDeclaration": body,
                    "arguments": [{"value": index}],
                    "returnByValue": true,
                }),
            )
            .map_err(Self::stale)?;
        if let Some(details) = result.get("exceptionDetails") {
            return Err(details["text"]
                .as_str()
                .unwrap_or("the element could not be used")
                .into());
        }
        Ok(result["result"]["value"].clone())
    }

    /// A page that was replaced takes its elements with it; CEF reports that as a context
    /// it cannot find, which is not what the caller asked about.
    fn stale(error: String) -> String {
        if error.contains("Cannot find context") || error.contains("Could not find object") {
            return "the page has changed since the snapshot; take a new one".into();
        }
        error
    }

    /// Clicks an element where it sits on the surface, so the page sees a real pointer.
    fn click(&mut self, at: usize, reference: &str) -> Result<Value, String> {
        let bounds = self.with_element(
            at,
            reference,
            "function(index) { const element = this.elements[index].element; element.scrollIntoView({ block: 'center', inline: 'center' }); const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, width: bounds.width, height: bounds.height }; }",
        )?;
        let width = bounds["width"].as_f64().unwrap_or_default();
        let height = bounds["height"].as_f64().unwrap_or_default();
        if width <= 0.0 || height <= 0.0 {
            // Nothing to aim at, so the page is asked to dispatch the click itself.
            self.with_element(
                at,
                reference,
                "function(index) { this.elements[index].element.click(); return true; }",
            )?;
            return Ok(Value::Null);
        }
        let point = MouseEvent {
            x: bounds["x"].as_f64().unwrap_or_default() as i32,
            y: bounds["y"].as_f64().unwrap_or_default() as i32,
            modifiers: 0,
        };
        let host = self.tabs[at].browser.host().ok_or("the tab has no host")?;
        host.send_mouse_move_event(Some(&point), 0);
        host.send_mouse_click_event(Some(&point), MouseButtonType::LEFT, 0, 1);
        host.send_mouse_click_event(Some(&point), MouseButtonType::LEFT, 1, 1);
        self.tabs[at].pointer = (point.x, point.y);
        Ok(Value::Null)
    }

    /// Replaces what a field holds, through the page's own editing path.
    fn fill(&mut self, at: usize, reference: &str, text: &str) -> Result<Value, String> {
        self.with_element(
            at,
            reference,
            "function(index) { const element = this.elements[index].element; element.focus(); if (typeof element.select === 'function') { element.select(); } else if (element.isContentEditable) { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); } return true; }",
        )?;
        if text.is_empty() {
            // Nothing to insert: what was selected is deleted instead.
            return self.input(at, &json!({"kind": "key", "key": "Delete"}));
        }
        self.protocol(at, "Input.insertText", json!({"text": text}))?;
        Ok(Value::Null)
    }

    /// Presses a key with an element focused, which is how a form is submitted.
    fn press(&mut self, at: usize, reference: &str, key: &str) -> Result<Value, String> {
        self.with_element(
            at,
            reference,
            "function(index) { this.elements[index].element.focus(); return true; }",
        )?;
        self.input(at, &json!({"kind": "key", "key": key}))
    }

    /// Hands a file input the files it asked for, as choosing them in a dialog would.
    fn upload(&mut self, at: usize, reference: &str, paths: Vec<String>) -> Result<Value, String> {
        let (object, index) = self.element(at, reference)?;
        self.protocol(at, "DOM.enable", json!({}))?;
        let resolved = self.protocol(
            at,
            "Runtime.callFunctionOn",
            json!({
                "objectId": object,
                "functionDeclaration": "function(index) { return this.elements[index].element; }",
                "arguments": [{"value": index}],
                "returnByValue": false,
            }),
        )?;
        let element = resolved["result"]["objectId"]
            .as_str()
            .ok_or("the element could not be resolved")?
            .to_owned();
        let outcome = self.protocol(
            at,
            "DOM.setFileInputFiles",
            json!({"files": paths, "objectId": element}),
        );
        let _ = self.protocol(at, "Runtime.releaseObject", json!({"objectId": element}));
        outcome?;
        Ok(Value::Null)
    }

    /// Input as a person produced it: movement, hover, a press and a release, in order.
    fn input(&mut self, at: usize, args: &Value) -> Result<Value, String> {
        let modifiers = held(args);
        // A pointer can only be where the surface is. A point outside it would otherwise be
        // clamped onto an edge and read as a gesture the person never made.
        if let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) {
            let (width, height) = *self.tabs[at].shared.size.lock().unwrap();
            if x < 0.0 || y < 0.0 || x >= f64::from(width) || y >= f64::from(height) {
                return Err("the point is outside the surface".into());
            }
        }
        // An event without a point happens where the pointer already is: a release still ends
        // the press it belongs to, even when the sender no longer knows the surface's size.
        let last = self.tabs[at].pointer;
        let host = self.tabs[at].browser.host().ok_or("the tab has no host")?;
        let point = |args: &Value| MouseEvent {
            x: args["x"].as_f64().map_or(last.0, |value| value as i32),
            y: args["y"].as_f64().map_or(last.1, |value| value as i32),
            modifiers,
        };
        if let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) {
            self.tabs[at].pointer = (x as i32, y as i32);
        }
        let kind = args["kind"].as_str().unwrap_or_default();
        if matches!(kind, "down" | "click") {
            host.set_focus(1);
            let position = self.tabs[at].pointer;
            self.tabs[at].clicks.press(position, Instant::now());
        }
        let count = self.tabs[at].clicks.count();
        match kind {
            "move" => host.send_mouse_move_event(Some(&point(args)), 0),
            "leave" => host.send_mouse_move_event(Some(&point(args)), 1),
            "down" => {
                host.send_mouse_click_event(Some(&point(args)), MouseButtonType::LEFT, 0, count)
            }
            "up" => {
                host.send_mouse_click_event(Some(&point(args)), MouseButtonType::LEFT, 1, count)
            }
            "click" => {
                let event = point(args);
                host.send_mouse_move_event(Some(&event), 0);
                host.send_mouse_click_event(Some(&event), MouseButtonType::LEFT, 0, count);
                host.send_mouse_click_event(Some(&event), MouseButtonType::LEFT, 1, count);
            }
            // Capture loss alone does not provide full mouse cancellation.
            "cancel" => host.send_capture_lost_event(),
            // A key press is the three events a keyboard produces: the press, the text it
            // writes, and the release. Which key was pressed and which text it writes are
            // different things, and sending the text in place of the key is what makes a
            // period arrive as the Delete key.
            "key" => {
                let key = args["key"].as_str().unwrap_or_default();
                let mut modifiers = modifiers;
                let (code, text) = match named_key(key) {
                    Some(key) => key,
                    None => {
                        let mut characters = key.chars();
                        let (Some(character), None) = (characters.next(), characters.next()) else {
                            return Err(format!("unsupported key {key}"));
                        };
                        let (code, shifted) = character_key(character)
                            .ok_or_else(|| format!("unsupported key {key}"))?;
                        if shifted {
                            modifiers |= SHIFT_DOWN;
                        }
                        (code, Some(character))
                    }
                };
                // Ctrl+A selects a page; it does not write an A.
                let text =
                    text.filter(|_| modifiers & (CONTROL_DOWN | ALT_DOWN | COMMAND_DOWN) == 0);
                let mut event = KeyEvent {
                    type_: KeyEventType::RAWKEYDOWN,
                    modifiers,
                    windows_key_code: code,
                    native_key_code: 0,
                    character: text.map(|text| text as u16).unwrap_or_default(),
                    unmodified_character: text.map(|text| text as u16).unwrap_or_default(),
                    ..Default::default()
                };
                host.send_key_event(Some(&event));
                if let Some(text) = text {
                    event.type_ = KeyEventType::CHAR;
                    event.windows_key_code = text as i32;
                    host.send_key_event(Some(&event));
                    event.windows_key_code = code;
                }
                event.type_ = KeyEventType::KEYUP;
                host.send_key_event(Some(&event));
            }
            "text" => {
                for character in args["text"].as_str().unwrap_or_default().encode_utf16() {
                    host.send_key_event(Some(&KeyEvent {
                        type_: KeyEventType::CHAR,
                        modifiers,
                        windows_key_code: character as i32,
                        character,
                        unmodified_character: character,
                        ..Default::default()
                    }));
                }
            }
            other => return Err(format!("unsupported input kind {other}")),
        }
        Ok(Value::Null)
    }

    fn serve(&mut self, call: &Call) -> Result<Value, String> {
        // Observation is always allowed; acting on a tab a person holds is not.
        let at = self.index(call.tab_id.as_deref())?;
        let acts = matches!(
            call.op.as_str(),
            "navigate"
                | "agent_click"
                | "agent_type"
                | "agent_hover"
                | "agent_drag"
                | "agent_select"
                | "agent_press"
                | "agent_evaluate"
                | "agent_dialog"
                | "js_dialog"
                | "agent_upload"
                | "cdp"
                | "evaluate"
                | "input"
                | "reload"
                | "back"
                | "forward"
                | "close"
                | "scroll"
                | "clipboard_paste"
                | "click"
                | "fill"
                | "press"
                | "upload"
                | "download"
                | "choose_files"
        );
        if (acts || call.op == "release")
            && !matches!(call.op.as_str(), "agent_dialog" | "js_dialog")
            && self
                .navigations
                .iter()
                .any(|pending| pending.tab == self.tabs[at].id)
        {
            return Err("busy".into());
        }
        if acts || call.lease_id.is_some() {
            let tab = self.tabs[at].id.clone();
            let taken = self.tabs[at].human;
            if call.human {
                // A tab an agent reserved stays the agent's until the person takes it,
                // which is what the dashboard's control button is for.
                if !taken && self.reservations.info(&tab).is_some() {
                    return Err("This tab is reserved; take control of it first".into());
                }
            } else {
                self.reservations
                    .check_for(
                        &tab,
                        call.lease_id.as_deref(),
                        call.client_id.as_deref().unwrap_or("stdio"),
                    )
                    .map_err(|error| error.to_string())?;
                if taken {
                    return Err("humanControl".into());
                }
            }
        }

        if let Some(result) = self.agent_action(at, call) {
            return result;
        }
        match call.op.as_str() {
            "diagnostics" => {
                let kind = call.args["kind"]
                    .as_str()
                    .ok_or("diagnostics needs a kind")?;
                let after = call.args["after"].as_u64().unwrap_or(0);
                let limit = call.args["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
                self.cdp.events(&self.tabs[at].id, kind, after, limit)
            }
            "extensions" => match &self.extensions {
                Some(manager) => {
                    manager.request(self.tabs[at].browser.identifier(), json!({"op": "list"}))
                }
                None => Ok(json!({"available": false, "extensions": []})),
            },
            "extension_set_enabled" | "extension_remove" | "extension_options" => {
                if !call.human {
                    return Err("Extension management requires the dashboard".into());
                }
                let id = call.args["id"]
                    .as_str()
                    .ok_or("An extension ID is required")?;
                let request = match call.op.as_str() {
                    "extension_set_enabled" => json!({
                        "op": "set_enabled", "id": id,
                        "enabled": call.args["enabled"].as_bool()
                            .ok_or("An explicit enabled state is required")?,
                    }),
                    "extension_remove" => {
                        if call.args["confirmed"].as_bool() != Some(true) {
                            return Err("Confirm removal of this extension first".into());
                        }
                        json!({"op": "remove", "id": id, "confirmed": true})
                    }
                    _ => json!({"op": "options", "id": id}),
                };
                let result = self
                    .extensions
                    .as_ref()
                    .ok_or("This CEF build does not support extension management")?
                    .request(self.tabs[at].browser.identifier(), request)?;
                if call.op == "extension_options" {
                    let url = result["url"]
                        .as_str()
                        .ok_or("This extension has no options page")?;
                    let parsed =
                        url::Url::parse(url).map_err(|_| "Invalid extension options URL")?;
                    if parsed.scheme() != "chrome-extension" || parsed.host_str() != Some(id) {
                        return Err("Invalid extension options URL".into());
                    }
                    let opened = self.open()?;
                    let index = self.index(opened.as_str())?;
                    let frame = self.tabs[index]
                        .browser
                        .main_frame()
                        .ok_or("The options tab has no frame")?;
                    frame.load_url(Some(&CefString::from(url)));
                    self.settle(index)?;
                    return Ok(opened);
                }
                Ok(result)
            }
            "extension_installs" => {
                let Some(installs) = &self.installs else {
                    return Ok(json!({"available": false, "requests": []}));
                };
                let mut requests = Vec::new();
                for pending in installs.pending().map_err(|error| error.to_string())? {
                    let Some(tab) = self
                        .tabs
                        .iter()
                        .find(|tab| tab.browser.identifier() == pending.browser_id)
                    else {
                        installs.cancel(pending.browser_id);
                        continue;
                    };
                    requests.push(json!({
                        "id": pending.id, "tabId": tab.id,
                        "extensionId": pending.extension_id, "name": pending.name,
                        "version": pending.version, "origin": pending.origin,
                        "permissions": pending.permissions,
                        "secondsRemaining": pending.seconds_remaining,
                    }));
                }
                Ok(json!({"available": true, "requests": requests}))
            }
            "extension_install_decide" => {
                if !call.human {
                    return Err("Extension installation decisions require the dashboard".into());
                }
                let id = call.args["id"]
                    .as_str()
                    .ok_or("An installation request id is required")?;
                let allow = call.args["allow"]
                    .as_bool()
                    .ok_or("An explicit installation decision is required")?;
                let installs = self
                    .installs
                    .as_ref()
                    .ok_or("This CEF build does not support extension installation decisions")?;
                installs
                    .decide(id, self.tabs[at].browser.identifier(), allow)
                    .map_err(|error| error.to_string())?;
                Ok(json!({"decision": if allow { "accepted" } else { "cancelled" }}))
            }
            "status" => Ok(json!({"owner": "agent", "uncertain": false})),
            "tabs" => {
                let ids: Vec<String> = self.tabs.iter().map(|tab| tab.id.clone()).collect();
                let mut held: Vec<Option<ReservationInfo>> = Vec::new();
                for id in &ids {
                    held.push(self.reservations.info(id));
                }
                let active = self.active;
                Ok(Value::Array(
                    self.tabs
                        .iter()
                        .enumerate()
                        .zip(held)
                        .map(|((index, tab), reservation)| {
                            let mut description = tab.describe(
                                index == active,
                                reservation,
                                self.navigations.iter().any(|pending| pending.tab == tab.id),
                            );
                            if call.human {
                                description["jsDialog"] = tab
                                    .dialog
                                    .borrow()
                                    .as_ref()
                                    .map(agent_actions::PendingDialog::describe)
                                    .unwrap_or(Value::Null);
                            }
                            description
                        })
                        .collect(),
                ))
            }
            "open" => self.open(),
            "reserve" => {
                if self.tabs[at].human && call.tab_id.is_some() {
                    return Err("humanControl".into());
                }
                let tab = if call.tab_id.is_none() {
                    self.open()?
                        .as_str()
                        .ok_or("the tab could not be created")?
                        .to_owned()
                } else {
                    self.tabs[at].id.clone()
                };
                match self.reserve(call, &tab) {
                    Ok(lease) => Ok(lease),
                    Err(error) => {
                        if call.tab_id.is_none() {
                            let index = self.index(Some(&tab))?;
                            self.discard(index);
                        }
                        Err(error)
                    }
                }
            }
            "release" => {
                let tab = self.tabs[at].id.clone();
                self.reserve(call, &tab)?;
                Ok(Value::Null)
            }
            // The dashboard calls this "view" and the automation layer calls it "select";
            // both mean the same thing to the engine.
            "select" | "view" => {
                self.active = at;
                Ok(Value::Null)
            }
            "close" => {
                if self.tabs.len() == 1 {
                    return Err("the last tab cannot be closed".into());
                }
                self.discard(at);
                Ok(Value::Null)
            }
            "take" => {
                self.reservations.remove(&self.tabs[at].id);
                self.release(at);
                self.tabs[at].human = true;
                Ok(Value::Null)
            }
            "return" => {
                self.tabs[at].human = false;
                Ok(Value::Null)
            }
            "navigate" => {
                let url = call.args["url"].as_str().ok_or("navigate needs a url")?;
                self.navigate(at, url, call.id)
            }
            "reload" => {
                self.release(at);
                self.tabs[at].browser.reload();
                self.settle(at)
            }
            "back" => {
                self.release(at);
                self.tabs[at].browser.go_back();
                self.settle(at)
            }
            "forward" => {
                self.release(at);
                self.tabs[at].browser.go_forward();
                self.settle(at)
            }
            // Tools accept a JavaScript function body with an explicit JSON return.
            "evaluate" => {
                let script = call.args["script"]
                    .as_str()
                    .ok_or("evaluate needs a script")?;
                self.evaluate(at, &format!("(function(){{\n{script}\n}})()"), false)
            }
            "input" => {
                let args = call.args.clone();
                self.input(at, &args)
            }
            "snapshot" => {
                let limit = call.args["maxElements"].as_u64().unwrap_or(80) as usize;
                self.snapshot(at, limit)
            }
            "click" => {
                let reference = call.args["reference"]
                    .as_str()
                    .ok_or("click needs a reference")?
                    .to_owned();
                self.click(at, &reference)
            }
            "fill" => {
                let reference = call.args["reference"]
                    .as_str()
                    .ok_or("fill needs a reference")?
                    .to_owned();
                let text = call.args["text"].as_str().unwrap_or_default().to_owned();
                self.fill(at, &reference, &text)
            }
            "press" => {
                let reference = call.args["reference"]
                    .as_str()
                    .ok_or("press needs a reference")?
                    .to_owned();
                let key = call.args["key"]
                    .as_str()
                    .ok_or("press needs a key")?
                    .to_owned();
                self.press(at, &reference, &key)
            }
            // The files a page may read are the ones in this profile's workspace, named by
            // the workspace rather than by a path the page or the agent chose.
            "upload" => {
                let reference = call.args["reference"]
                    .as_str()
                    .ok_or("upload needs a reference")?
                    .to_owned();
                let paths = self.staged(&call.args["fileIds"])?;
                self.upload(at, &reference, paths)
            }
            "choose_files" => {
                let cancel = call.args["cancel"].as_bool().unwrap_or_default();
                // The paths are resolved before the request is taken, so a bad name leaves
                // the page waiting for an answer rather than waiting forever.
                let paths = if cancel {
                    Vec::new()
                } else {
                    self.staged(&call.args["fileIds"])?
                };
                let pending = self.tabs[at]
                    .picker
                    .borrow_mut()
                    .take()
                    .ok_or("this tab is not asking for files")?;
                if cancel {
                    pending.cancel();
                } else {
                    let mut chosen = CefStringList::new();
                    for path in &paths {
                        chosen.append(path);
                    }
                    pending.cont(Some(&mut chosen));
                }
                pump_for(SETTLE);
                Ok(Value::Null)
            }
            "download" => {
                let url = call.args["url"]
                    .as_str()
                    .ok_or("download needs a url")?
                    .to_owned();
                let name = call.args["name"]
                    .as_str()
                    .ok_or("download needs a name")?
                    .to_owned();
                // Fetched by the page itself, so the site answers the session it already
                // has rather than an anonymous request from the engine.
                let script = format!(
                    "(async () => {{ const response = await fetch({url}, {{ credentials: 'include' }}); if (!response.ok) throw new Error('The server answered ' + response.status); const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > {DOWNLOAD_LIMIT}) throw new Error('The download exceeds the workspace limit'); let encoded = ''; for (let at = 0; at < bytes.length; at += 8192) {{ encoded += String.fromCharCode.apply(null, bytes.subarray(at, at + 8192)); }} return btoa(encoded); }})()",
                    url = serde_json::to_string(&url).map_err(|error| error.to_string())?,
                );
                let encoded = self.evaluate(at, &script, true)?;
                let bytes = BASE64_STANDARD
                    .decode(encoded.as_str().unwrap_or_default())
                    .map_err(|error| error.to_string())?;
                Ok(json!(
                    self.files()?
                        .save_download(&name, &bytes)
                        .map_err(|error| error.to_string())?
                ))
            }
            // The host asks this before it starts a recording: can frames be taken from
            // this tab right now?
            "record_check" => {
                if self.tabs[at].shared.painted.lock().unwrap().bgra.is_empty() {
                    let painted = self.tabs[at].shared.clone();
                    pump_within(PAINT_LIMIT, || painted.paints.load(Ordering::Acquire) > 0);
                }
                if self.tabs[at].shared.painted.lock().unwrap().bgra.is_empty() {
                    return Err("this tab has not painted a frame yet".into());
                }
                Ok(Value::Null)
            }
            "screenshot" => {
                let args = call.args.clone();
                self.frame(at, &args)
            }
            // The dashboard sends wheel deltas in CSS pixels, counted downwards; CEF counts
            // a wheel turn the other way.
            "scroll" => {
                let host = self.tabs[at].browser.host().ok_or("the tab has no host")?;
                let (x, y) = self.tabs[at].pointer;
                let event = MouseEvent { x, y, modifiers: 0 };
                let delta = |name: &str| -call.args[name].as_f64().unwrap_or_default() as i32;
                host.send_mouse_wheel_event(Some(&event), delta("x"), delta("y"));
                Ok(Value::Null)
            }
            // The text a person put on this profile's clipboard, and then pastes into the
            // page. It is inserted through the page's own editing path rather than through
            // the machine's clipboard, which a windowless browser does not share.
            "clipboard_write" => {
                self.tabs[at].pasteboard =
                    call.args["text"].as_str().unwrap_or_default().to_owned();
                Ok(Value::Null)
            }
            "clipboard_paste" => {
                let text = self.tabs[at].pasteboard.clone();
                if text.is_empty() {
                    return Ok(Value::Null);
                }
                self.protocol(at, "Input.insertText", json!({"text": text}))?;
                Ok(Value::Null)
            }
            "clipboard_read" => Ok(json!({"text": self.tabs[at].pasteboard.clone()})),
            // The page's own copy or cut, and what it took kept on this profile's
            // clipboard, so the dashboard and an agent can read it back.
            "clipboard_copy" | "clipboard_cut" => {
                let taken = self.evaluate(
                    at,
                    "(function(){ const active = document.activeElement; if (active && typeof active.selectionStart === 'number' && active.selectionStart !== active.selectionEnd) { return String(active.value).slice(active.selectionStart, active.selectionEnd); } return String(getSelection() || ''); })()",
                    false,
                )?;
                let frame = self.tabs[at].browser.main_frame().ok_or("no frame")?;
                if call.op == "clipboard_cut" {
                    frame.cut()
                } else {
                    frame.copy()
                }
                if let Some(text) = taken.as_str() {
                    self.tabs[at].pasteboard = text.chars().take(8192).collect();
                }
                Ok(Value::Null)
            }
            // The surface follows the dashboard's display, so a wide window is rendered
            // wide rather than stretched from a fixed one.
            "resize" => {
                let width = call.args["width"].as_i64().unwrap_or(self.surface.0 as i64);
                let height = call.args["height"]
                    .as_i64()
                    .unwrap_or(self.surface.1 as i64);
                let width = width.clamp(320, 3840) as i32;
                let height = height.clamp(240, 2160) as i32;
                // A window is one shape for every tab in it, including the ones opened
                // after it was measured.
                self.surface = (width, height);
                for tab in &self.tabs {
                    *tab.shared.size.lock().unwrap() = (width, height);
                    if let Some(host) = tab.browser.host() {
                        host.was_resized();
                    }
                }
                pump_for(SETTLE);
                Ok(json!({"width": width, "height": height}))
            }
            "health" => self.session_health(at, &call.args),
            // A capture belongs in the profile's workspace, where the dashboard and the
            // agent both find it. A plain path is still accepted for running by hand.
            "save_screenshot" => {
                let png = self.capture(at, None)?.2;
                if let Some(path) = call.args["path"].as_str() {
                    std::fs::write(path, &png).map_err(|error| error.to_string())?;
                    return Ok(json!({"path": path, "bytes": png.len()}));
                }
                let name = call.args["name"]
                    .as_str()
                    .unwrap_or("Page capture.png")
                    .to_owned();
                Ok(json!(
                    self.files()?
                        .save("captures", &name, &png)
                        .map_err(|error| error.to_string())?
                ))
            }
            // The dashboard serves file content itself, from the workspace this names, and
            // the pickers say which tabs are waiting for files right now.
            "files" => {
                let pickers: Vec<String> = self
                    .tabs
                    .iter()
                    .filter(|tab| tab.picker.borrow().is_some())
                    .map(|tab| tab.id.clone())
                    .collect();
                let files = self.files()?;
                Ok(json!({
                    "root": files.root(),
                    "files": files.list().map_err(|error| error.to_string())?,
                    "pickers": pickers,
                }))
            }
            "read_file" => {
                let id = call.args["fileId"]
                    .as_str()
                    .ok_or("read_file needs a fileId")?;
                let offset = call.args["offset"].as_u64().unwrap_or_default();
                let (data, next) = self
                    .files()?
                    .read_chunk(id, offset)
                    .map_err(|error| error.to_string())?;
                Ok(json!({"data": data, "nextOffset": next}))
            }
            "stage_file" => {
                let name = call.args["name"]
                    .as_str()
                    .ok_or("stage_file needs a name")?;
                let offset = call.args["offset"].as_u64().unwrap_or_default();
                let data = call.args["data"].as_str().unwrap_or_default();
                Ok(json!(
                    self.files()?
                        .stage(name, offset, data)
                        .map_err(|error| error.to_string())?
                ))
            }
            "delete_file" => {
                let id = call.args["fileId"]
                    .as_str()
                    .ok_or("delete_file needs a fileId")?;
                self.files()?
                    .delete(id)
                    .map_err(|error| error.to_string())?;
                Ok(Value::Null)
            }
            // A development window onto the protocol underneath. It is not for the host to
            // call: the ops above are the bounded surface, this one is all of CDP.
            "cdp" => {
                let method = call.args["method"]
                    .as_str()
                    .ok_or("cdp needs a method")?
                    .to_owned();
                let params = call.args["params"].clone();
                self.protocol(at, &method, params)
            }
            other => Err(format!("the engine does not implement {other}")),
        }
    }
}

/// The modifiers a dashboard reports as held, as the bits CEF reads.
fn held(args: &Value) -> u32 {
    let mut modifiers = 0;
    for (name, bit) in [
        ("shift", SHIFT_DOWN),
        ("ctrl", CONTROL_DOWN),
        ("alt", ALT_DOWN),
        ("meta", COMMAND_DOWN),
    ] {
        if args[name].as_bool().unwrap_or_default() {
            modifiers |= bit;
        }
    }
    modifiers
}

/// The keys a browser names rather than writes, as Windows virtual key codes, with the
/// text each one writes. Most write nothing: a page reads them from the press itself.
fn named_key(key: &str) -> Option<(i32, Option<char>)> {
    Some(match key {
        "Enter" => (0x0D, Some('\r')),
        "Tab" => (0x09, Some('\t')),
        "Backspace" => (0x08, None),
        "Escape" => (0x1B, None),
        "Delete" => (0x2E, None),
        "Insert" => (0x2D, None),
        "ArrowLeft" => (0x25, None),
        "ArrowUp" => (0x26, None),
        "ArrowRight" => (0x27, None),
        "ArrowDown" => (0x28, None),
        "Home" => (0x24, None),
        "End" => (0x23, None),
        "PageUp" => (0x21, None),
        "PageDown" => (0x22, None),
        "F1" => (0x70, None),
        "F2" => (0x71, None),
        "F3" => (0x72, None),
        "F4" => (0x73, None),
        "F5" => (0x74, None),
        "F6" => (0x75, None),
        "F7" => (0x76, None),
        "F8" => (0x77, None),
        "F9" => (0x78, None),
        "F10" => (0x79, None),
        "F11" => (0x7A, None),
        "F12" => (0x7B, None),
        _ => return None,
    })
}

/// The key that writes this character on a US keyboard, and whether shift is held for it.
/// A page that reads key presses reads the key, not the text, so the two have to agree.
fn character_key(character: char) -> Option<(i32, bool)> {
    Some(match character {
        'a'..='z' => (character.to_ascii_uppercase() as i32, false),
        'A'..='Z' => (character as i32, true),
        '0'..='9' => (character as i32, false),
        ' ' => (0x20, false),
        ';' => (0xBA, false),
        ':' => (0xBA, true),
        '=' => (0xBB, false),
        '+' => (0xBB, true),
        ',' => (0xBC, false),
        '<' => (0xBC, true),
        '-' => (0xBD, false),
        '_' => (0xBD, true),
        '.' => (0xBE, false),
        '>' => (0xBE, true),
        '/' => (0xBF, false),
        '?' => (0xBF, true),
        '`' => (0xC0, false),
        '~' => (0xC0, true),
        '[' => (0xDB, false),
        '{' => (0xDB, true),
        '\\' => (0xDC, false),
        '|' => (0xDC, true),
        ']' => (0xDD, false),
        '}' => (0xDD, true),
        '\'' => (0xDE, false),
        '"' => (0xDE, true),
        '!' => (0x31, true),
        '@' => (0x32, true),
        '#' => (0x33, true),
        '$' => (0x34, true),
        '%' => (0x35, true),
        '^' => (0x36, true),
        '&' => (0x37, true),
        '*' => (0x38, true),
        '(' => (0x39, true),
        ')' => (0x30, true),
        // Anything else still writes itself; no key on this layout claims it.
        _ => (0, false),
    })
}

/// The calls read off standard input, waiting for the loop that serves them.
#[derive(Default)]
struct Inbox {
    lines: Mutex<VecDeque<String>>,
    ended: AtomicBool,
}

impl Inbox {
    fn take(&self) -> Option<String> {
        self.lines.lock().unwrap().pop_front()
    }

    /// Whether a call is already waiting, which is how work that can yield knows to.
    fn waiting(&self) -> bool {
        !self.lines.lock().unwrap().is_empty()
    }

    fn ended(&self) -> bool {
        self.ended.load(Ordering::Acquire) && !self.waiting()
    }
}

/// Reads protocol lines on their own thread, because the loop below owns this one.
fn reader() -> Arc<Inbox> {
    let inbox = Arc::new(Inbox::default());
    let reading = inbox.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            reading.lines.lock().unwrap().push_back(line);
        }
        reading.ended.store(true, Ordering::Release);
    });
    inbox
}

/// Takes the profile directory for this engine alone. Chromium marks the directory it is
/// using and an engine that was killed leaves that mark behind, which would make the next
/// engine wait for a browser that is no longer running. Holding this lock is what makes it
/// safe to clear: no other engine has the directory.
fn claim(profile_root: &str) -> std::io::Result<std::fs::File> {
    use fs2::FileExt as _;
    let directory = std::path::Path::new(profile_root);
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(directory.join("engine.lock"))?;
    lock.try_lock_exclusive()?;
    for leftover in [
        "SingletonLock",
        "SingletonCookie",
        "SingletonSocket",
        "DevToolsActivePort",
    ] {
        let path = directory.join(leftover);
        if std::fs::symlink_metadata(&path).is_ok() {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(lock)
}

fn reply(id: u64, outcome: Result<Value, String>) {
    let message = match outcome {
        Ok(value) => json!({"id": id, "value": value}),
        Err(error) => json!({"id": id, "error": error}),
    };
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn main() {
    // CEF's structs are versioned, and a process that does not declare which version it was
    // built against is refused on its first call. Every process this binary becomes, the
    // browser process and each of its children, has to say so before anything else.
    api_hash(sys::CEF_API_VERSION_LAST, 0);

    let args = Args::new();
    // CEF re-executes this binary for its renderer, GPU and utility processes.
    if std::env::args().any(|argument| argument.starts_with("--type=")) {
        let mut app = Offscreen::new();
        std::process::exit(execute_process(
            Some(args.as_main_args()),
            Some(&mut app),
            std::ptr::null_mut(),
        ));
    }

    // The host spawns a worker with --engine-profile, and --files-root when the profile
    // has a file workspace; --profile-root is for running one by hand. Other switches
    // belong to CEF, which reads them from the command line itself.
    let mut profile_root = None;
    let mut files_root = None;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--engine-profile" | "--profile-root" => profile_root = arguments.next(),
            "--files-root" => files_root = arguments.next(),
            _ => {}
        }
    }
    let Some(profile_root) = profile_root else {
        eprintln!("--engine-profile is required");
        std::process::exit(2);
    };
    if let Err(error) = std::fs::create_dir_all(&profile_root) {
        eprintln!("the profile root is not usable: {error}");
        std::process::exit(1);
    }
    let _claim = match claim(&profile_root) {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("another engine is using this profile, or it is not writable: {error}");
            std::process::exit(1);
        }
    };

    let settings = Settings {
        no_sandbox: 1,
        windowless_rendering_enabled: 1,
        persist_session_cookies: 1,
        root_cache_path: CefString::from(profile_root.as_str()),
        ..Default::default()
    };
    let mut app = Offscreen::new();
    if initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) != 1
    {
        eprintln!("the engine could not start");
        std::process::exit(1);
    }

    // The workspace is private to this profile, and the host decides where it lives. It
    // exists before the first tab, which a page's own downloads are routed through.
    let files = match files_root {
        Some(root) => match Files::new(std::path::Path::new(&root)) {
            Ok(files) => Some(files),
            Err(error) => {
                eprintln!("the file workspace is not usable: {error}");
                shutdown();
                std::process::exit(1);
            }
        },
        None => None,
    };
    let downloads = files.as_ref().map(|files| files.root().join("downloads"));
    let cdp = match cdp::Adapter::start(std::path::Path::new(&profile_root)) {
        Ok(cdp) => cdp,
        Err(error) => {
            eprintln!("CDP startup failed: {error}");
            shutdown();
            std::process::exit(1);
        }
    };
    let browsers = browser_lifecycle::Browsers::default();
    let Some(first) = Surfacing::open("tab-1".to_string(), VIEWPORT, downloads, browsers.clone())
    else {
        eprintln!("the first tab could not be created");
        drop(cdp);
        shutdown();
        std::process::exit(1);
    };
    if let Err(error) = cdp.bind(&first.id, &first.target) {
        eprintln!("CDP tab binding failed: {error}");
        drop(cdp);
        browsers.close_all();
        drop(first);
        pump_within(Duration::from_secs(8), || browsers.all_closed());
        shutdown();
        std::process::exit(1);
    }
    let inbox = reader();
    let mut engine = Engine {
        cdp,
        installs: extension_installs::InstallBridge::discover(),
        extensions: extensions::Manager::discover(),
        browsers: browsers.clone(),
        tabs: vec![first],
        active: 0,
        next_tab: 1,
        files,
        reservations: Reservations::default(),
        next_snapshot: 0,
        surface: VIEWPORT,
        inbox: inbox.clone(),
        navigations: Vec::new(),
    };

    eprintln!("engine ready");
    loop {
        do_message_loop_work();
        engine.poll_navigations();
        match inbox.take() {
            Some(line) => match serde_json::from_str::<Call>(&line) {
                Ok(call) if call.op == "shutdown" => {
                    reply(call.id, Ok(Value::Null));
                    break;
                }
                Ok(call) => {
                    engine.dispatch(&call);
                }
                Err(error) => eprintln!("unreadable call: {error}"),
            },
            None if inbox.ended() => break,
            None => std::thread::sleep(Duration::from_millis(2)),
        }
    }
    if let Some(installs) = &engine.installs {
        installs.cancel(0);
    }
    browsers.close_all();
    // Release browser and DevTools references before CEF's OnBeforeClose callbacks.
    drop(engine);
    if !pump_within(Duration::from_secs(8), || browsers.all_closed()) {
        eprintln!("the engine could not close every browser before shutdown");
        std::process::exit(1);
    }
    drop(browsers);
    shutdown();
    remote_browser_native::logging::flush();
}
