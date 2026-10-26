/** One visible screen controls a tab; other screens follow its existing surface. */
import { useEffect, useState } from "react";

import { action, failure } from "./api.js";
import { background } from "./async-boundary.js";
import { flag, record } from "./wire.js";

export function useDisplaySession(
  profileId: string,
  tabId: string,
  onNotice: (message: string) => void,
) {
  const [visible, setVisible] = useState(!document.hidden);
  const [control, setControl] = useState({ profileId: "", tabId: "", controller: false });
  useEffect(() => {
    if (!tabId) {
      return undefined;
    }
    let watching = true;
    let pending = false;
    const update = async () => {
      const shown = !document.hidden;
      setVisible(shown);
      if (pending) {
        return;
      }
      pending = true;
      try {
        const reply = record(await action("display", { visible: shown }, tabId, profileId));
        if (watching) {
          setControl({ profileId, tabId, controller: shown && flag(reply.controller) });
        }
      } catch (cause) {
        if (watching && !document.hidden) {
          onNotice(failure(cause).message);
        }
      } finally {
        pending = false;
      }
    };
    const changed = () => {
      background(update());
    };
    const leave = () => {
      background(action("display", { visible: false, leave: true }, tabId, profileId));
    };
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        changed();
      }
    }, 3000);
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("remote-browser-control", changed);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", changed);
    changed();
    return () => {
      watching = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("remote-browser-control", changed);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", changed);
      leave();
    };
  }, [profileId, tabId, onNotice]);
  return {
    visible,
    controls:
      visible && control.profileId === profileId && control.tabId === tabId && control.controller,
  };
}

/** Bound live rendering cost without changing the CSS layout supplied by the device. */
export function displayScale(width: number, height: number, ratio: number): number {
  return Math.max(1, Math.min(ratio || 1, 2, Math.sqrt(2_000_000 / (width * height))));
}
