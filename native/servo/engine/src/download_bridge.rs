//! Restore native download-attribute handling absent from the pinned Servo release.
use super::*;
impl Engine {
    pub(super) fn install_download_bridge(self: &Rc<Self>, view: &WebView, complete: Option<u64>) {
        let weak = Rc::downgrade(self);
        view.evaluate_javascript(include_str!("download_bridge.js"), move |_result| {
            if let Some(engine) = weak.upgrade()
                && let Some(id) = complete
            {
                engine.complete(id, Ok(json!({"ok":true})));
            }
        });
    }

    pub(super) fn poll_blob_downloads(self: &Rc<Self>) {
        let targets: Vec<_> = self
            .tabs
            .borrow_mut()
            .values_mut()
            .filter_map(|tab| {
                if !tab.initialized || tab.bridge_polling {
                    return None;
                }
                tab.bridge_polling = true;
                Some(tab.view.clone())
            })
            .collect();
        for view in targets {
            let weak = Rc::downgrade(self);
            let tab_id = view.id().to_string();
            view.evaluate_javascript(
                "window.__remoteBrowserDownloads?.drain() || null",
                move |result| {
                    let Some(engine) = weak.upgrade() else { return };
                    if let Some(tab) = engine.tabs.borrow_mut().get_mut(&tab_id) {
                        tab.bridge_polling = false;
                    }
                    let Ok(value) = result else { return };
                    let value = to_json(value);
                    if value.is_null() {
                        return;
                    }
                    if value["kind"] == "url" {
                        if let (Some(url), Some(name)) =
                            (value["url"].as_str(), value["name"].as_str())
                            && url.len() <= 8192
                            && let Ok(url) = Url::parse(url)
                            && matches!(url.scheme(), "http" | "https")
                            && url.username().is_empty()
                            && url.password().is_none()
                        {
                            engine.download_hints.note(
                                tab_id.clone(),
                                url.as_str().into(),
                                name.into(),
                            );
                            if let Some(tab) = engine.tabs.borrow().get(&tab_id) {
                                tab.view.load(url);
                            }
                        }
                        return;
                    }
                    let Some(name) = value["name"].as_str() else {
                        return;
                    };
                    let Some(data) = value["data"].as_str() else {
                        return;
                    };
                    let Some(offset) = value["offset"]
                        .as_f64()
                        .filter(|offset| {
                            offset.is_finite() && *offset >= 0.0 && offset.fract() == 0.0
                        })
                        .map(|offset| offset as u64)
                    else {
                        return;
                    };
                    if offset > remote_browser_servo::files::DOWNLOAD_LIMIT as u64 {
                        return;
                    }
                    let key = (tab_id.clone(), name.to_owned());
                    let assigned = {
                        let mut names = engine.blob_names.borrow_mut();
                        if offset == 0 {
                            names.insert(
                                key.clone(),
                                format!(
                                    "download-{}-{}",
                                    uuid::Uuid::new_v4(),
                                    if remote_browser_servo::files::validate_name(name).is_ok() {
                                        name.chars().take(100).collect::<String>()
                                    } else {
                                        "download.bin".into()
                                    }
                                ),
                            );
                        }
                        names.get(&key).cloned()
                    };
                    if let Some(name) = assigned
                        && (engine
                            .files
                            .stage_bucket("downloads", &name, offset, data)
                            .is_err()
                            || value["done"] == true)
                    {
                        engine.blob_names.borrow_mut().remove(&key);
                    }
                },
            );
        }
    }
}
