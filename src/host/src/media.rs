//! Bounded MP4 capture from the native display; no browser or container dependency.
use crate::{
    Error, Result,
    files::{Files, UPLOAD_LIMIT, validate_name},
    native::NativeClient,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{Mutex, Notify},
    task::JoinHandle,
};
struct Job {
    id: String,
    tab: String,
    client: String,
    lease: Option<String>,
    stop: Arc<Notify>,
    task: JoinHandle<Result<Value>>,
}
#[derive(Default)]
pub struct Media {
    job: Mutex<Option<Job>>,
    last: Mutex<Option<Value>>,
}
impl Media {
    pub async fn action(
        &self,
        browser: NativeClient,
        op: &str,
        tab: &str,
        args: Value,
        human: bool,
    ) -> Result<Value> {
        if !human {
            browser
                .engine_request("validate_lease", Some(tab), Value::Null, false)
                .await?;
        }
        let mut job = self.job.lock().await;
        if !human
            && let Some(active) = job.as_ref()
            && !active.task.is_finished()
            && (active.client != crate::identity::current().id
                || active.tab != tab
                || active.lease.as_deref() != browser.lease_id())
        {
            return Err(Error::Invalid(
                "This recording belongs to another reservation".into(),
            ));
        }
        if op == "record_start" {
            if job.as_ref().is_some_and(|job| !job.task.is_finished()) {
                return Err(Error::Busy);
            }
            if let Some(old) = job.take() {
                *self.last.lock().await = Some(
                    old.task
                        .await
                        .map_err(|_| Error::Invalid("Recording worker stopped".into()))??,
                );
            }
            let seconds = args["maxSeconds"].as_u64().unwrap_or(60);
            if !(1..=300).contains(&seconds) {
                return Err(Error::Invalid(
                    "Recording duration must be 1 to 300 seconds".into(),
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let name = args["name"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Browser recording-{id}.mp4"));
            validate_name(&name)?;
            if !name.ends_with(".mp4") {
                return Err(Error::Invalid("Use a .mp4 filename".into()));
            }
            let listing = browser
                .engine_request("files", None, Value::Null, true)
                .await?;
            let root = PathBuf::from(
                listing["root"]
                    .as_str()
                    .ok_or_else(|| Error::Protocol("File workspace unavailable".into()))?,
            );
            let files = Files::new(&root)?;
            if files
                .list()?
                .iter()
                .any(|file| file.id == format!("recordings/{name}"))
            {
                return Err(Error::Invalid("Recording already exists".into()));
            }
            Box::pin(browser.request("record_check", Some(tab), Value::Null, human)).await?;
            let temporary = root.join("recordings").join(format!(".recording-{id}.mp4"));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&temporary)?;
            let binary =
                std::env::var_os("REMOTE_BROWSER_FFMPEG_BINARY").unwrap_or_else(|| "ffmpeg".into());
            let spawned = Command::new(binary)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "image2pipe",
                    "-framerate",
                    "4",
                    "-i",
                    "pipe:0",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                ])
                .arg(&temporary)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn();
            let mut child = match spawned {
                Ok(child) => child,
                Err(_) => {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(Error::Invalid(
                        "MP4 encoder unavailable. Install FFmpeg or configure REMOTE_BROWSER_FFMPEG_BINARY"
                            .into(),
                    ));
                }
            };
            let mut input = child.stdin.take().unwrap();
            let stop = Arc::new(Notify::new());
            let signal = stop.clone();
            let client = crate::identity::current();
            let actor = client.id.clone();
            let tab = tab.to_owned();
            let selected = tab.clone();
            let lease = browser.lease_id().map(str::to_owned);
            let task = tokio::spawn(crate::identity::scope(client, async move {
                let started = tokio::time::Instant::now();
                let mut frames = 0;
                let mut tick = tokio::time::interval(Duration::from_millis(250));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {_=signal.notified()=>break,_=tokio::time::sleep_until(started+Duration::from_secs(seconds))=>break,_=tick.tick()=>{}}
                    let target = if !human {
                        selected.clone()
                    } else {
                        match browser
                            .engine_request("tabs", None, Value::Null, true)
                            .await
                        {
                            Ok(tabs) => tabs
                                .as_array()
                                .and_then(|tabs| tabs.iter().find(|tab| tab["active"] == true))
                                .and_then(|tab| tab["id"].as_str())
                                .unwrap_or(&selected)
                                .to_owned(),
                            Err(_) => break,
                        }
                    };
                    let encoded = match browser
                        .engine_request("screenshot", Some(&target), Value::Null, human)
                        .await
                    {
                        Ok(Value::String(encoded)) => encoded,
                        Err(Error::Busy | Error::HumanControl) => continue,
                        _ => break,
                    };
                    let Ok(bytes) = STANDARD.decode(encoded) else {
                        break;
                    };
                    if !matches!(
                        tokio::time::timeout(Duration::from_secs(2), input.write_all(&bytes)).await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                    frames += 1;
                    if std::fs::metadata(&temporary).is_ok_and(|meta| meta.len() > UPLOAD_LIMIT) {
                        break;
                    }
                }
                drop(input);
                let result = async {
                    let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
                        .await
                        .map_err(|_| Error::Invalid("Recording encoder timed out".into()))??;
                    if !status.success() || frames == 0 {
                        return Err(Error::Invalid(
                            "Recording encoder produced no usable video".into(),
                        ));
                    }
                    let file = files.publish("recordings", &name, &temporary)?;
                    Ok(json!({"active":false,"frames":frames,"file":file}))
                }
                .await;
                let _ = std::fs::remove_file(temporary);
                result
            }));
            *job = Some(Job {
                id: id.clone(),
                tab: tab.clone(),
                client: actor,
                lease,
                stop,
                task,
            });
            *self.last.lock().await = None;
            return Ok(json!({"active":true,"id":id,"tabId":tab,"maxSeconds":seconds}));
        }
        if op == "record_stop"
            && let Some(active) = job.as_ref()
        {
            if !human && active.client != crate::identity::current().id {
                return Err(Error::Invalid(
                    "This recording belongs to another client".into(),
                ));
            }
            active.stop.notify_one();
        }
        if job
            .as_ref()
            .is_some_and(|job| op == "record_stop" || job.task.is_finished())
        {
            let old = job.take().unwrap();
            let result = old
                .task
                .await
                .map_err(|_| Error::Invalid("Recording worker stopped".into()))??;
            *self.last.lock().await = Some(result.clone());
            return Ok(result);
        }
        if let Some(active) = job.as_ref() {
            Ok(json!({"active":true,"id":active.id,"tabId":active.tab}))
        } else {
            Ok(self
                .last
                .lock()
                .await
                .clone()
                .unwrap_or(json!({"active":false})))
        }
    }
    pub async fn stop(&self) {
        if let Some(job) = self.job.lock().await.take() {
            job.stop.notify_one();
            let _ = job.task.await;
        }
    }
}
