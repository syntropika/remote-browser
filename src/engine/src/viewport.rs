//! Display metrics supplied by the dashboard, in CSS pixels except for the pixel ratio.
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Viewport {
    pub width: i32,
    pub height: i32,
    pub screen_width: i32,
    pub screen_height: i32,
    pub scale: f32,
    pub mobile: bool,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            width: 1024,
            height: 768,
            screen_width: 1024,
            screen_height: 768,
            scale: 1.0,
            mobile: false,
        }
    }
}

impl Viewport {
    pub fn resize(self, args: &Value) -> Self {
        let width = args["width"]
            .as_i64()
            .unwrap_or(self.width.into())
            .clamp(320, 3840) as i32;
        let height = args["height"]
            .as_i64()
            .unwrap_or(self.height.into())
            .clamp(240, 2160) as i32;
        // Keep high-density surfaces within the same pixel budget as full-page captures.
        let maximum_scale = (32_000_000.0 / (f64::from(width) * f64::from(height)))
            .sqrt()
            .min(4.0);
        let scale = args["deviceScaleFactor"]
            .as_f64()
            .unwrap_or(f64::from(self.scale))
            .clamp(1.0, maximum_scale) as f32;
        Self {
            width,
            height,
            scale,
            screen_width: args["screenWidth"]
                .as_i64()
                .unwrap_or(width.into())
                .clamp(1, 16384) as i32,
            screen_height: args["screenHeight"]
                .as_i64()
                .unwrap_or(height.into())
                .clamp(1, 16384) as i32,
            mobile: args["mobile"].as_bool().unwrap_or(self.mobile),
        }
    }

    pub fn device_metrics(self) -> Value {
        json!({
            "width":self.width,"height":self.height,"deviceScaleFactor":self.scale,
            "screenWidth":self.screen_width,"screenHeight":self.screen_height,"mobile":self.mobile,
            "screenOrientation": {"type":if self.screen_width > self.screen_height {"landscapePrimary"} else {"portraitPrimary"},"angle":if self.screen_width > self.screen_height {90} else {0}}
        })
    }
}

impl super::Engine {
    /// Mobile emulation includes viewport-meta behavior, touch capability and the browser's
    /// Chromium version in its mobile user agent. Desktop restores CEF's native defaults.
    pub(super) fn apply_viewport(&mut self, at: usize) -> Result<(), String> {
        let view = self.surface;
        if view.mobile {
            self.protocol(
                at,
                "Emulation.setDeviceMetricsOverride",
                view.device_metrics(),
            )?;
            let version = self.protocol(at, "Browser.getVersion", json!({}))?;
            let agent = version["userAgent"]
                .as_str()
                .ok_or("CEF did not report its user agent")?;
            let version = agent
                .split("Chrome/")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .ok_or("CEF did not report its Chromium version")?;
            let major = version.split('.').next().unwrap_or(version);
            self.protocol(at, "Emulation.setUserAgentOverride", json!({
                "userAgent":format!("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Mobile Safari/537.36"),
                "userAgentMetadata":{"brands":[{"brand":"Chromium","version":major}],"fullVersionList":[{"brand":"Chromium","version":version}],"platform":"Android","platformVersion":"10.0.0","architecture":"","model":"K","mobile":true}
            }))?;
        } else {
            self.protocol(at, "Emulation.clearDeviceMetricsOverride", json!({}))?;
            self.protocol(
                at,
                "Emulation.setUserAgentOverride",
                json!({"userAgent":""}),
            )?;
        }
        self.protocol(
            at,
            "Emulation.setTouchEmulationEnabled",
            json!({"enabled":view.mobile}),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_metrics_keep_screen_distinct_from_available_page_space() {
        let view = Viewport::default().resize(&json!({"width":390,"height":720,"screenWidth":390,"screenHeight":844,"deviceScaleFactor":3,"mobile":true}));
        assert_eq!(
            (
                view.width,
                view.height,
                view.screen_width,
                view.screen_height,
                view.scale,
                view.mobile
            ),
            (390, 720, 390, 844, 3.0, true)
        );
        assert_eq!(
            view.device_metrics()["screenOrientation"]["type"],
            "portraitPrimary"
        );
    }

    #[test]
    fn oversized_metrics_bound_native_allocations() {
        let view = Viewport::default()
            .resize(&json!({"width":i64::MAX,"height":i64::MAX,"deviceScaleFactor":1000}));
        assert_eq!((view.width, view.height), (3840, 2160));
        assert!(
            f64::from(view.width) * f64::from(view.height) * f64::from(view.scale).powi(2)
                < 32_000_010.0
        );
        assert_eq!(
            Viewport::default()
                .resize(&json!({"width":390,"height":720}))
                .scale,
            1.0
        );
    }
}
