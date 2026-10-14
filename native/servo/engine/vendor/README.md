# Servo network response observer

`servo-net` is the MPL-2.0 source from the published Servo 0.7.0 crate
(https://github.com/servo/servo/tree/v0.7.0/components/net), with the upstream
license headers retained. The narrow local extension adds `response_observer.rs`,
exports it from `lib.rs`, and wraps the top-level fetch target in `fetch/methods.rs`.

The optional observer sees the original response headers and body chunks after
Servo has sent the real request and applied its normal cookie, redirect, TLS and
fetch processing. It does not repeat GET or POST requests or export credentials.
Attachment document responses are presented to the document loader as no-content
while the observer saves the response. Other loads preserve normal delivery.
Without an installed observer the wrapper forwards unchanged behavior.

Upstream test fixtures and generated registry metadata are omitted. Keep this
extension explicit when upgrading Servo; do not silently apply it to another
version. Browser download behavior is verified by the native integration suite.
