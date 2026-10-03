type GestureDetail = {
  type: string;
  clientX: number;
  clientY: number;
};
type Gesture = {
  target: HTMLCanvasElement;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  cancelled: boolean;
};
// Adapt the gesture events from the pinned noVNC client. Its default one-finger
// drag holds the mouse button; page scrolling normally requires two fingers.
export function createMobileScroll({
  display,
  canScroll,
}: {
  display: HTMLElement;
  canScroll: () => boolean;
}) {
  let gesture: Gesture | null = null;

  function handle(rawEvent: Event) {
    // SAFETY: The pinned noVNC client emits CustomEvent gesture details from its canvas; the drag type and canvas tag are checked before use.
    const event = rawEvent as CustomEvent<GestureDetail> & {
      target: HTMLCanvasElement;
    };
    if (event.detail?.type !== "drag" || event.target.tagName !== "CANVAS") {
      return;
    }
    if (event.type === "gesturestart") {
      gesture = null;
      if (!canScroll()) {
        return;
      }
      const bounds = event.target.getBoundingClientRect();
      if (!bounds.width || !bounds.height) {
        return;
      }
      gesture = {
        target: event.target,
        x: event.detail.clientX,
        y: event.detail.clientY,
        scaleX: event.target.width / bounds.width,
        scaleY: event.target.height / bounds.height,
        cancelled: false,
      };
    }
    if (!gesture || gesture.target !== event.target) {
      return;
    }
    event.stopImmediatePropagation();
    // Once claimed, never hand the tail of this drag back to mouse input.
    if (!canScroll()) {
      gesture.cancelled = true;
    }
    if (!gesture.cancelled) {
      event.target.dispatchEvent(
        new CustomEvent(event.type, {
          detail: {
            type: "twodrag",
            clientX: gesture.x,
            clientY: gesture.y,
            magnitudeX: (event.detail.clientX - gesture.x) * gesture.scaleX,
            magnitudeY: (event.detail.clientY - gesture.y) * gesture.scaleY,
          },
        }),
      );
    }
    if (event.type === "gestureend") {
      gesture = null;
    }
  }

  for (const type of ["gesturestart", "gesturemove", "gestureend"]) {
    display.addEventListener(type, handle, { capture: true });
  }
  return {
    cancel() {
      if (gesture) {
        gesture.cancelled = true;
      }
    },
  };
}
