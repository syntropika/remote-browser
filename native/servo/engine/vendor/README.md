# Pinned Servo compatibility patches

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

## Worker and message-port origins

`servo-script` is the MPL-2.0 source from the published Servo 0.7.0 crate
(https://github.com/servo/servo/tree/v0.7.0/components/script), with upstream
license headers retained. Registry metadata, the upstream lockfile and documentation
are omitted. The behavioral changes in `dom/workers/dedicatedworkerglobalscope.rs` and
`dom/globalscope/globalscope.rs` make incoming dedicated-worker and MessagePort
messages use the default empty `MessageEvent.origin`.
Window-to-window messaging keeps its actual origin and source checks.

This follows the [HTML Standard's worker `postMessage` algorithms](https://html.spec.whatwg.org/multipage/workers.html#dom-worker-postmessage)
and [message-port event fields](https://html.spec.whatwg.org/multipage/web-messaging.html#message-ports). It restores standards behavior used by embedded widgets;
it does not guarantee that a website will accept a security challenge.
The offline `worker_messages_smoke.py` regression checks both directions, immediate
blob URL revocation, transferred ports, nested workers and window origin isolation.
The complete local delta is recorded in [`servo-script.patch`](servo-script.patch).
Keep the local patch explicit when upgrading Servo.
