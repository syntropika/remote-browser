/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
//! Optional embedder observer for the original response stream, including POST.
use net_traits::{
    FetchTaskTarget,
    http_status::HttpStatus,
    request::{Destination, Request},
    response::Response,
};
use std::sync::{Arc, OnceLock};
pub trait Capture: Send {
    fn chunk(&mut self, bytes: &[u8]);
    fn finish(&mut self, success: bool);
}
pub trait Observer: Send + Sync {
    fn response(&self, request: &Request, response: &Response) -> Option<Box<dyn Capture>>;
}
static OBSERVER: OnceLock<Arc<dyn Observer>> = OnceLock::new();
pub fn install(observer: Arc<dyn Observer>) -> bool {
    OBSERVER.set(observer).is_ok()
}
pub struct ObservedTarget<'a> {
    target: crate::fetch::methods::Target<'a>,
    capture: Option<Box<dyn Capture>>,
    discard: bool,
}
impl<'a> ObservedTarget<'a> {
    pub fn new(target: crate::fetch::methods::Target<'a>) -> Self {
        Self {
            target,
            capture: None,
            discard: false,
        }
    }
}
fn empty(response: &Response) -> Response {
    let mut response = response.actual_response().clone();
    response.internal_response = None;
    response.return_internal = false;
    response.status = HttpStatus::new(http::StatusCode::NO_CONTENT, b"No Content".to_vec());
    response.headers.remove(http::header::CONTENT_DISPOSITION);
    response.headers.remove(http::header::CONTENT_LENGTH);
    response
}

impl FetchTaskTarget for ObservedTarget<'_> {
    fn process_request_body(&mut self, request: &Request) {
        self.target.process_request_body(request);
    }
    fn process_response(&mut self, request: &Request, response: &Response) {
        self.capture = OBSERVER
            .get()
            .and_then(|observer| observer.response(request, response));
        self.discard = self.capture.is_some() && request.destination == Destination::Document;
        if !self.discard {
            self.target.process_response(request, response);
        }
    }
    fn process_response_chunk(&mut self, request: &Request, chunk: bytes::Bytes) {
        if let Some(capture) = self.capture.as_mut() {
            capture.chunk(&chunk);
        }
        if !self.discard {
            self.target.process_response_chunk(request, chunk);
        }
    }
    fn process_response_eof(&mut self, request: &Request, response: &Response) {
        if let Some(mut capture) = self.capture.take() {
            capture.finish(
                !response.is_network_error()
                    && !response.aborted.load(std::sync::atomic::Ordering::Relaxed),
            );
        }
        if self.discard {
            let response = empty(response);
            self.target.process_response(request, &response);
            self.target.process_response_eof(request, &response);
        } else {
            self.target.process_response_eof(request, response);
        }
    }
    fn process_csp_violations(
        &mut self,
        request: &Request,
        violations: Vec<content_security_policy::Violation>,
    ) {
        self.target.process_csp_violations(request, violations);
    }
    fn process_response_length_hint(&mut self, request: &Request, length: usize) {
        if !self.discard {
            self.target.process_response_length_hint(request, length);
        }
    }
}
