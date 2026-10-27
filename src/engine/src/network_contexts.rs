//! Independent test sessions retain their own cookies, workers and proxy preferences.
use cef::*;
use std::{cell::Cell, collections::HashMap, rc::Rc, time::Duration};

wrap_request_context_handler! {
    struct Ready { initialized: Rc<Cell<bool>> }
    impl RequestContextHandler {
        fn on_request_context_initialized(&self, _context: Option<&mut RequestContext>) {
            self.initialized.set(true);
        }
    }
}

#[derive(Default)]
pub(super) struct Contexts(HashMap<String, (String, String, RequestContext)>);

impl Contexts {
    pub(super) fn get(
        &mut self,
        id: &str,
        owner: &str,
        proxy: &str,
    ) -> Result<RequestContext, String> {
        if uuid::Uuid::parse_str(id).is_err()
            || !proxy.parse::<std::net::SocketAddr>().is_ok_and(|address| {
                address.ip() == std::net::Ipv4Addr::LOCALHOST && address.port() != 0
            })
        {
            return Err("Invalid network session configuration".into());
        }
        if let Some((client, endpoint, context)) = self.0.get(id) {
            if client != owner || endpoint != proxy {
                return Err("Network session belongs to another connection".into());
            }
            return Ok(context.clone());
        }
        if self.0.len() >= 32 {
            return Err("Close unused test pages before opening another network session".into());
        }
        let initialized = Rc::new(Cell::new(false));
        let mut handler = Ready::new(initialized.clone());
        let context = request_context_create_context(
            Some(&RequestContextSettings::default()),
            Some(&mut handler),
        )
        .ok_or("Could not create the test request context")?;
        if !super::pump_within(Duration::from_secs(5), || initialized.get()) {
            return Err("The test request context did not initialize".into());
        }
        let mut preference = parse_json(
            Some(&CefString::from(
                serde_json::json!({"mode":"fixed_servers","server":format!("socks5://{proxy}"),"bypass_list":"<-loopback>"}).to_string().as_str(),
            )),
            JsonParserOptions::default(),
        )
        .ok_or("Could not configure the test proxy")?;
        // CEF requires an allocated output string; the default wrapper is a null pointer.
        let mut error = CefString::from("");
        if context.set_preference(
            Some(&CefString::from("proxy")),
            Some(&mut preference),
            Some(&mut error),
        ) != 1
        {
            return Err("CEF could not apply the test proxy preference".into());
        }
        self.0
            .insert(id.into(), (owner.into(), proxy.into(), context.clone()));
        Ok(context)
    }

    pub(super) fn owns(&self, id: &str, owner: &str) -> bool {
        self.0.get(id).is_some_and(|(client, _, _)| client == owner)
    }

    pub(super) fn retire(
        &mut self,
        browsers: &super::browser_lifecycle::Browsers,
        retired: &[String],
    ) -> Vec<String> {
        self.0
            .retain(|id, (_, _, context)| !retired.contains(id) || browsers.uses_context(context));
        self.0.keys().cloned().collect()
    }
}
