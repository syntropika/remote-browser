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

## Native pointer boundaries and click interfaces

The `servo-script` delta also changes `dom/document/document_event_handler.rs`
and `dom/event/mouseevent.rs`. With no previous hover target, boundary dispatch
must include the target's ancestor chain. Treating that target itself as a common
ancestor suppressed its initial `pointerenter` and `mouseenter` events.

Native primary-button clicks now use `PointerEvent`, retaining the native event's
trust, mouse fields and activation behavior. Pointer identity/type follow the
causing pointer; activation-specific pointer attributes retain their defaults.
Double clicks keep their `MouseEvent` interface. This follows
[Pointer Events Level 3](https://www.w3.org/TR/pointerevents3/#the-click-auxclick-and-contextmenu-events).
The offline `pointer_events_smoke.py` regression covers initial and sibling
boundaries, click properties, double clicks, checkbox activation and cancelation.
These corrections establish browser API behavior; website acceptance remains
independent of the regression result.

Native mouse and pointer screen coordinates use the input position in the WebView
and its screen origin, independent of the hit-tested frame's local viewport.
The `pointer_screen_smoke.py` regression checks nested, transformed and scrolled
frames while retaining frame-local client coordinates and synthetic event fields.

When `pointerup` is captured, compatibility `mouseup` and the following `click`
retain that capture target, including when the handler releases capture or the
control moves. Captured release bypasses the ordinary click-distance cutoff.
The `pointer_capture_smoke.py` regression checks implicit release, explicit release
inside `pointerup`, and the uncaptured control case. This follows the
[Pointer Events click target algorithm](https://www.w3.org/TR/pointerevents3/#event-dispatch).

## Cross-origin frame visibility and user activation

Servo runs documents of different sites in different script threads, so a frame
cannot read its embedder's layout or windows directly. This delta additionally
vendors the published Servo 0.7.0 `servo-constellation`, `servo-constellation-traits`
and `servo-script-traits` crates, excluding registry metadata and lockfiles. MPL-2.0
headers are retained and the license file is included. The narrow deltas are
recorded in [`servo-constellation.patch`](servo-constellation.patch),
[`servo-constellation-traits.patch`](servo-constellation-traits.patch),
[`servo-script-traits.patch`](servo-script-traits.patch) and
[`servo-script.patch`](servo-script.patch).

Asynchronous messages through the constellation carry three kinds of information:

- **Visible frame area.** After each rendering update, a document computes the visible
  part of each `<iframe>` content box. That part is clipped by the document's
  overflow clips and viewports, and then by its ancestors: directly when they are in
  the same thread, or through their own report when they are not. It is sent as
  fractions of the nested viewport. The constellation accepts a value only from the
  frame's parent pipeline, including for a frame whose first document is still loading.
  It forwards the value to every pipeline of that browsing context and replays it to
  documents created later by navigation. The value is dropped when the browsing context
  closes, so a replaced `<iframe>` never inherits the old geometry. Nothing is sent
  while an ancestor's area is unknown, and observations that depend on it wait instead
  of reporting a guess.
- **User activation.** A trusted activation-triggering input event still updates the
  windows reachable in its thread, and only same-origin descendants are activated.
  It then notifies the constellation with the event time. The constellation forwards
  that time to every ancestor, and to descendants that have the sender's origin. It
  ignores inactive senders and clamps the time to the present.
- **Activation consumption.** Consumption is forwarded to every fully active document
  of the top-level traversable with its time. A late activation notice cannot restore
  a consumed activation, and a consumption cannot remove a newer activation.

The IntersectionObserver changes follow the
[specification](https://w3c.github.io/IntersectionObserver/):

- `rootBounds` is `null` and `rootMargin` and `scrollMargin` are ignored for targets that are not
  same-origin-domain with the implicit root, including cross-origin frames in the same
  thread.
- Frame offsets use the container's content box, and scaled containers map rectangles
  into frame coordinates.
- A `delay` skips only the affected target.
- A frame whose container is not rendered reports a non-intersecting entry. For a
  same-thread frame, this previously panicked the script thread.

The observer remains disabled unless the engine runs with
`SERVO_EXPERIMENTAL_INTERSECTION_OBSERVER=1`; frame reports are only computed then.
User activation propagation is always enabled.

Known limits:

- Layout reports bounding boxes of transformed containers, so rotation and skew are
  approximated by those boxes.
- `clip-path` and per-axis `overflow: clip` remain upstream TODOs.
- Root margins cannot extend clipping performed in another thread. A same-origin-domain
  target below a cross-origin ancestor, such as A inside B inside A, reports the
  expanded `rootBounds`, but its intersection uses the ancestor's unexpanded report.
- The constellation trusts the script thread's trusted-input decision, as it does for
  other script messages in Servo 0.7.0. It does not cross-check its own input routing.

The `intersection_frames_smoke.py`, `intersection_smoke.py` and
`user_activation_smoke.py` regressions use loopback addresses, `localhost` and
separate ports, so that frames run both in other threads and as cross-origin documents
in the same thread.

## Experimental Private State Tokens

The opt-in native PST integration additionally vendors the unmodified published
Servo 0.7.0 `servo-script-bindings` and `servo-net-traits` crates, excluding registry
metadata, upstream tests, lockfiles and documentation. MPL-2.0 headers and license
files are retained. Narrow changes add WebIDL dictionaries/query methods,
request metadata, generated binding configuration and a document helper trait.
The script patch connects Request/Fetch and Document queries to the browser
service; the net patch processes private headers before response filtering.

The implementation is gated by the engine's `private-state-tokens` feature and
uses the separate safe browser service and native crypto wrapper. See
[`private-state-tokens/README.md`](../../private-state-tokens/README.md) for the
implemented surface, build requirements, privacy controls and deliberate limits.
Iframe/worker operations fail closed pending policy delegation support.
