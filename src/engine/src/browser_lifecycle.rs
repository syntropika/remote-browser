//! Keeps CEF browsers alive until their native close callback completes.
use cef::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Clone, Default)]
pub(crate) struct Browsers {
    active: Rc<RefCell<HashMap<i32, Browser>>>,
}

impl Browsers {
    pub(crate) fn handler(&self) -> LifeSpanHandler {
        Lifetime::new(self.clone())
    }

    /// Includes browsers whose tabs were discarded and popups sharing this client.
    pub(crate) fn all_closed(&self) -> bool {
        self.active.borrow().is_empty()
    }

    pub(crate) fn uses_context(&self, context: &RequestContext) -> bool {
        self.active.borrow().values().any(|browser| {
            browser
                .host()
                .and_then(|host| host.request_context())
                .is_some_and(|mut other| context.is_sharing_with(Some(&mut other)) == 1)
        })
    }

    pub(crate) fn close_all(&self) {
        // Closing may call back into the registry, so do not borrow it across CEF calls.
        let browsers: Vec<_> = self.active.borrow().values().cloned().collect();
        for browser in browsers {
            if browser.is_valid() == 1
                && let Some(host) = browser.host()
            {
                host.close_browser(1);
            }
        }
    }
}

wrap_life_span_handler! {
    struct Lifetime {
        browsers: Browsers,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                self.browsers.active.borrow_mut().insert(browser.identifier(), browser.clone());
            }
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                self.browsers.active.borrow_mut().remove(&browser.identifier());
            }
        }
    }
}
