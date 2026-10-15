//! Attachment responses are streamed once to private files, independent of HTTP method.
use net::response_observer::{Capture, Observer};
use net_traits::{
    request::{Destination, Request},
    response::Response,
};
use remote_browser_servo::files::{DOWNLOAD_LIMIT, Files, validate_name};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
#[derive(Default)]
pub struct Hints(std::sync::Mutex<Vec<(String, String, String)>>);
impl Hints {
    pub fn note(&self, view: String, url: String, name: String) {
        let mut hints = self.0.lock().unwrap();
        if hints.len() >= 32 {
            hints.remove(0);
        }
        hints.push((view, url, name));
    }
    fn take(&self, request: &Request) -> Option<String> {
        let view = request.target_webview_id.map(|id| id.to_string());
        let mut hints = self.0.lock().unwrap();
        let index = hints.iter().position(|(id, url, _)| {
            view.as_deref() == Some(id)
                && request.url_list.iter().any(|entry| entry.as_str() == url)
        })?;
        Some(hints.remove(index).2)
    }
}
pub struct Notice {
    pub view: Option<String>,
    pub url: String,
    pub success: bool,
}
struct Downloads {
    notices: std::sync::mpsc::Sender<Notice>,
    hints: Arc<Hints>,
    files: Files,
    active: Arc<AtomicUsize>,
}
struct Stream {
    notices: std::sync::mpsc::Sender<Notice>,
    view: Option<String>,
    url: String,
    files: Files,
    name: String,
    path: PathBuf,
    file: Option<File>,
    size: usize,
    active: Arc<AtomicUsize>,
}
pub fn install(files: Files) -> (std::sync::mpsc::Receiver<Notice>, Arc<Hints>) {
    let (notices, receiver) = std::sync::mpsc::channel();
    let hints = Arc::new(Hints::default());
    net::response_observer::install(Arc::new(Downloads {
        hints: hints.clone(),
        files,
        notices,
        active: Arc::new(AtomicUsize::new(0)),
    }));
    (receiver, hints)
}
fn name(request: &Request, response: &Response, override_name: Option<String>) -> Option<String> {
    let hint = override_name.or_else(|| {
        request
            .current_url()
            .fragment()
            .and_then(|value| value.strip_prefix("remote-browser-download="))
            .map(|value| {
                percent_encoding::percent_decode_str(value)
                    .decode_utf8_lossy()
                    .into_owned()
            })
    });
    let header = response
        .actual_response()
        .headers
        .get(http::header::CONTENT_DISPOSITION)
        .and_then(|header| header.to_str().ok());
    if hint.is_none()
        && !header.is_some_and(|header| {
            header
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("attachment")
        })
    {
        return None;
    }
    if request.destination != Destination::Document {
        return None;
    }
    let from_header = header.and_then(|header| {
        header
            .split(';')
            .skip(1)
            .filter_map(|piece| piece.trim().split_once('='))
            .find_map(|(key, value)| {
                let value = value.trim().trim_matches('"');
                if key.eq_ignore_ascii_case("filename*") {
                    value.split_once("''").map(|(_, encoded)| {
                        percent_encoding::percent_decode_str(encoded)
                            .decode_utf8_lossy()
                            .into_owned()
                    })
                } else if key.eq_ignore_ascii_case("filename") {
                    Some(value.into())
                } else {
                    None
                }
            })
    });
    let candidate = hint
        .or(from_header)
        .unwrap_or_else(|| "download.bin".into());
    Some(if validate_name(&candidate).is_ok() {
        candidate
    } else {
        format!("download-{}.bin", uuid::Uuid::new_v4())
    })
}
impl Observer for Downloads {
    fn response(&self, request: &Request, response: &Response) -> Option<Box<dyn Capture>> {
        if request.destination != Destination::Document {
            return None;
        }
        let mut name = name(request, response, self.hints.take(request))?;
        if response.actual_response().status.raw_code() < 200
            || response.actual_response().status.raw_code() >= 300
        {
            return None;
        }
        if self.active.fetch_add(1, Ordering::SeqCst) >= 8 {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        let listing = match self.files.list() {
            Ok(listing) => listing,
            Err(_) => {
                self.active.fetch_sub(1, Ordering::SeqCst);
                return None;
            }
        };
        if listing
            .iter()
            .any(|file| file.id == format!("downloads/{name}"))
        {
            let suffix = uuid::Uuid::new_v4();
            name = format!(
                "download-{suffix}-{}",
                name.chars().take(100).collect::<String>()
            );
        }
        let path = self
            .files
            .root()
            .join("downloads")
            .join(format!(".download-{}", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = match options.open(&path) {
            Ok(file) => file,
            Err(_) => {
                self.active.fetch_sub(1, Ordering::SeqCst);
                return None;
            }
        };
        Some(Box::new(Stream {
            notices: self.notices.clone(),
            view: request.target_webview_id.map(|id| id.to_string()),
            url: request
                .url_list
                .first()
                .map(|url| url.as_str().to_owned())
                .unwrap_or_default(),
            files: self.files.clone(),
            name,
            path,
            file: Some(file),
            size: 0,
            active: self.active.clone(),
        }))
    }
}
impl Capture for Stream {
    fn chunk(&mut self, bytes: &[u8]) {
        self.size = self.size.saturating_add(bytes.len());
        if self.size > DOWNLOAD_LIMIT
            || self
                .file
                .as_mut()
                .is_some_and(|file| file.write_all(bytes).is_err())
        {
            self.file = None;
        }
    }
    fn finish(&mut self, success: bool) {
        let saved = success
            && self.file.take().is_some_and(|file| file.sync_all().is_ok())
            && self
                .files
                .publish("downloads", &self.name, &self.path)
                .is_ok();
        remote_browser_servo::logging::lifecycle(
            "engine",
            if saved {
                "download_saved"
            } else {
                "download_failed"
            },
            None,
        );
        let _ = self.notices.send(Notice {
            view: self.view.clone(),
            url: self.url.clone(),
            success: saved,
        });
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}
