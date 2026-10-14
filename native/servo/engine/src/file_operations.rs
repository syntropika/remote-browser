use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use remote_browser_servo::files::{DOWNLOAD_LIMIT, validate_name};

impl Engine {
    pub(super) fn file_request(&self, request: &Request) -> Result<bool, String> {
        let value = match request.op.as_str() {
            "files" => {
                let pickers: Vec<_> = self
                    .tabs
                    .borrow()
                    .iter()
                    .filter_map(|(id, tab)| {
                        tab.file_picker.as_ref().map(
                            |picker| json!({"tabId":id,"multiple":picker.allow_select_multiple()}),
                        )
                    })
                    .collect();
                json!({"root":self.files.root(),"files":self.files.list().map_err(|e| e.to_string())?,"pickers":pickers,"downloadLimitBytes":DOWNLOAD_LIMIT})
            }
            "stage_file" => serde_json::to_value(
                self.files
                    .stage(
                        request.args["name"].as_str().ok_or("name is required")?,
                        request.args["offset"]
                            .as_u64()
                            .ok_or("offset is required")?,
                        request.args["data"]
                            .as_str()
                            .ok_or("base64 data is required")?,
                    )
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?,
            "read_file" => {
                let (data, next) = self
                    .files
                    .read_chunk(
                        request.args["fileId"]
                            .as_str()
                            .ok_or("fileId is required")?,
                        request.args["offset"]
                            .as_u64()
                            .ok_or("offset is required")?,
                    )
                    .map_err(|e| e.to_string())?;
                json!({"data":data,"nextOffset":next})
            }
            "delete_file" => {
                self.files
                    .delete(
                        request.args["fileId"]
                            .as_str()
                            .ok_or("fileId is required")?,
                    )
                    .map_err(|e| e.to_string())?;
                json!({"ok":true})
            }
            _ => return Ok(false),
        };
        self.reply(request.id, Ok(value));
        Ok(true)
    }
    fn selected_files(&self, request: &Request) -> Result<Vec<PathBuf>, String> {
        let ids = request.args["fileIds"]
            .as_array()
            .ok_or("fileIds are required")?;
        if ids.is_empty() || ids.len() > 16 {
            return Err("Select between 1 and 16 files".into());
        }
        ids.iter()
            .map(|id| {
                self.files
                    .existing(id.as_str().ok_or("Invalid fileId")?)
                    .map_err(|e| e.to_string())
            })
            .collect()
    }
    pub(super) fn choose_files(self: &Rc<Self>, request: &Request) -> Result<(), String> {
        let files = if request.args["cancel"].as_bool() == Some(true) {
            Vec::new()
        } else {
            self.selected_files(request)?
        };
        let picker = {
            let mut tabs = self.tabs.borrow_mut();
            let tab = tabs.get_mut(request.tab_id.as_deref().unwrap()).unwrap();
            let picker = tab
                .file_picker
                .as_ref()
                .ok_or("No file chooser is open in this tab")?;
            if !picker.allow_select_multiple() && files.len() > 1 {
                return Err("This chooser accepts one file".into());
            }
            tab.file_picker.take().unwrap()
        };
        if files.is_empty() {
            picker.dismiss();
        } else {
            let mut picker = picker;
            picker.select(&files);
            picker.submit();
        }
        self.invalidate(request.id);
        self.complete(request.id, Ok(json!({"ok":true})));
        Ok(())
    }
    pub(super) fn upload(self: &Rc<Self>, request: &Request) -> Result<(), String> {
        let id = request.id;
        let files = self.selected_files(request)?;
        let native = self.reference(request)?;
        let text = files
            .iter()
            .map(|path| path.to_str().ok_or("File path is not UTF-8"))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        let target = native.clone();
        // Check the element type first so a file path can never be typed into a text field.
        self.command(
            id,
            move |sender| {
                WebDriverScriptCommand::GetElementAttribute(target, "type".into(), sender)
            },
            move |engine, kind| {
                if !kind
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case("file"))
                {
                    engine.complete(
                        id,
                        Err("Select an input of type file from a fresh snapshot".into()),
                    );
                    return;
                }
                engine.command(
                    id,
                    move |sender| WebDriverScriptCommand::WillSendKeys(native, text, false, sender),
                    move |engine, _| engine.complete(id, Ok(json!({"ok":true}))),
                );
            },
        );
        Ok(())
    }
    pub(super) fn download(self: &Rc<Self>, request: &Request) -> Result<(), String> {
        let name = request.args["name"]
            .as_str()
            .ok_or("name is required")?
            .to_owned();
        validate_name(&name).map_err(|e| e.to_string())?;
        let text = request.args["url"].as_str().ok_or("url is required")?;
        if text.len() > 8192 {
            return Err("Download URL exceeds 8 KiB".into());
        }
        let view = self.view(request.id).unwrap();
        let url = view
            .url()
            .ok_or("Page URL unavailable")?
            .join(text)
            .map_err(|_| "Invalid download URL")?;
        if !matches!(url.scheme(), "http" | "https" | "blob")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Download an HTTP(S) or page blob URL without embedded credentials".into());
        }
        let script = format!(
            "({DOWNLOAD_SCRIPT})({}, {DOWNLOAD_LIMIT})",
            serde_json::to_string(url.as_str()).unwrap()
        );
        let (sender, receiver) =
            generic_channel::channel().ok_or("Download channel unavailable")?;
        self.servo
            .execute_webdriver_command(WebDriverCommandMsg::ScriptCommand(
                BrowsingContextId::from(view.id()),
                WebDriverScriptCommand::ExecuteScriptWithCallback(script, sender),
            ));
        let id = request.id;
        self.pollers.borrow_mut().push(Box::new(move |engine| {
            if !engine.pending.borrow().contains_key(&id) { return true; }
            match receiver.try_recv() {
                Ok(Ok(value)) => {
                    let value = to_json(value);
                    let result = (|| {
                        if value["ok"] != true { return Err("Download failed, timed out, exceeded 8 MiB, or was blocked by page CORS".to_string()); }
                        let encoded = value["data"].as_str().ok_or("Invalid download result")?;
                        if encoded.len() > DOWNLOAD_LIMIT.div_ceil(3)*4 { return Err("Download exceeds 8 MiB".into()); }
                        let bytes = STANDARD.decode(encoded).map_err(|_| "Invalid download data")?;
                        serde_json::to_value(engine.files.save_download(&name,&bytes).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
                    })();
                    engine.complete(id,result); true
                }
                Ok(Err(_)) => { engine.complete(id,Err("Page does not support this download operation".into())); true }
                Err(TryReceiveError::Empty) => false,
                Err(_) => { engine.poison(id,"script_channel_closed"); true }
            }
        }));
        Ok(())
    }
}
const DOWNLOAD_SCRIPT: &str = r#"async function(url, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {credentials: 'include', signal: controller.signal});
    if (!response.ok || Number(response.headers.get('content-length')) > limit) return {ok:false};
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const {value,done} = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); return {ok:false}; }
      chunks.push(value);
    }
    let binary = '';
    for (const chunk of chunks) for (let i=0; i<chunk.length; i+=8192)
      binary += String.fromCharCode(...chunk.subarray(i,i+8192));
    return {ok:true,data:btoa(binary)};
  } catch (_) { return {ok:false}; }
  finally { clearTimeout(timer); controller.abort(); }
}"#;
