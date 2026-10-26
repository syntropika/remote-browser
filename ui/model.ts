/** The shapes the dashboard reads out of the browser's replies. */
import { count, flag, list, optionalCount, optionalText, record, text } from "./wire.js";

export type Profile = {
  id: string;
  name: string;
  isDefault: boolean;
  connected: boolean;
  backgroundTabs: boolean;
};

export type Reservation = { agentName: string; task: string };
export type JsDialog = {
  id: string;
  type: "alert" | "confirm" | "prompt";
  origin: string;
  message: string;
  defaultPromptText: string;
};

export type Tab = {
  id: string;
  active: boolean;
  owned: boolean;
  filePicker: boolean;
  jsDialog: JsDialog | null;
  canGoBack: boolean;
  canGoForward: boolean;
  reservation: Reservation | null;
  title: string;
  url: string;
  owner: "human" | "agent";
  busy: boolean;
  uncertain: boolean;
};

export type Policy = {
  origin: string;
  cookieNames: string[];
  authenticatedSelector: string | null;
  loginSelector: string | null;
  warningSeconds: number;
};

export type Health = {
  state: "active" | "expiring" | "reauthRequired" | "unknown";
  checkedAt: number;
  secondsRemaining: number | null;
  evidence: string;
};

export type Frame = {
  seq: number;
  x: number;
  y: number;
  width: number;
  height: number;
  image: string;
};

export type ManagedFile = {
  id: string;
  bytes: number;
  mimeType: string;
  /** When the workspace wrote it, as the engine reports it: an RFC 3339 timestamp. */
  createdAt: string;
};

export function readProfile(value: unknown): Profile {
  const profile = record(value);
  return {
    id: text(profile.id),
    name: text(profile.name, text(profile.id)),
    isDefault: flag(profile.isDefault),
    connected: flag(profile.connected),
    backgroundTabs: flag(profile.backgroundTabs),
  };
}

export function readTab(value: unknown): Tab {
  const tab = record(value);
  const reservation = record(tab.reservation);
  const task = optionalText(reservation.task);
  const dialog = record(tab.jsDialog);
  const dialogType = dialog.type;
  return {
    id: text(tab.id),
    active: flag(tab.active),
    owned: flag(tab.owned),
    filePicker: flag(tab.filePicker),
    jsDialog:
      text(dialog.id) &&
      (dialogType === "alert" || dialogType === "confirm" || dialogType === "prompt")
        ? {
            id: text(dialog.id),
            type: dialogType,
            origin: text(dialog.origin),
            message: text(dialog.message),
            defaultPromptText: text(dialog.defaultPromptText),
          }
        : null,
    canGoBack: flag(tab.canGoBack),
    canGoForward: flag(tab.canGoForward),
    reservation: task === null ? null : { agentName: text(reservation.agentName, "Agent"), task },
    title: text(tab.title),
    url: text(tab.url),
    owner: tab.owner === "human" ? "human" : "agent",
    busy: flag(tab.busy),
    uncertain: flag(tab.uncertain),
  };
}

export function readPolicy(value: unknown): Policy {
  const policy = record(value);
  return {
    origin: text(policy.origin),
    cookieNames: list(policy.cookieNames).map((name) => text(name)),
    authenticatedSelector: optionalText(policy.authenticatedSelector),
    loginSelector: optionalText(policy.loginSelector),
    warningSeconds: count(policy.warningSeconds, 86_400),
  };
}

export function readHealth(value: unknown): Health {
  const health = record(value);
  const state = text(health.state);
  return {
    state:
      state === "active" || state === "expiring" || state === "reauthRequired" ? state : "unknown",
    checkedAt: count(health.checkedAt),
    secondsRemaining: optionalCount(health.secondsRemaining),
    evidence: text(health.evidence),
  };
}

/** A frame, or null when nothing has moved since the one the display holds. */
export function readFrame(value: unknown): Frame | null {
  if (!value) {
    return null;
  }
  const frame = record(value);
  const image = optionalText(frame.image);
  if (image === null) {
    return null;
  }
  return {
    seq: count(frame.seq),
    x: count(frame.x),
    y: count(frame.y),
    width: count(frame.width),
    height: count(frame.height),
    image,
  };
}

export function readFiles(value: unknown): ManagedFile[] {
  return list(record(value).files).map((entry) => {
    const file = record(entry);
    return {
      id: text(file.id),
      bytes: count(file.bytes),
      mimeType: text(file.mimeType),
      createdAt: text(file.createdAt),
    };
  });
}

/** Whether a person may act on this tab: an agent's reservation holds it until handed over. */
export function editable(tab: Tab | undefined): boolean {
  return !!tab && (!tab.reservation || tab.owner === "human") && !tab.uncertain;
}

export function origin(url: string): string | null {
  try {
    // A page with no origin of its own, such as about:blank, serialises as "null".
    const value = new URL(url).origin;
    return value === "null" ? null : value;
  } catch {
    return null;
  }
}
