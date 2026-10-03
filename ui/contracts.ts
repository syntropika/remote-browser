import type RFB from "/vendor/novnc/core/rfb.js";

import type { ArtifactMetadata, RecordingStatus } from "../src/artifacts.js";
import type { BrowserTabs } from "../src/browser.js";
import type { api } from "./api.js";

export { type default as RFB } from "/vendor/novnc/core/rfb.js";

export type Api = typeof api;
export type UiOptions = {
  api: Api;
  onOpen: () => void;
  onUnauthorized: () => void;
};
export type ControlState = {
  mode: string;
  ownsControl: boolean;
  leaseExpiresAt: number | null;
  activeOperations: number;
  ready: boolean;
  serverNow: number;
  revision: number;
  error?: string;
  agentRequest: { id: string; deadline: number; canCancel: boolean } | null;
  recording?: RecordingStatus | null;
};
export type ClipboardOptions = {
  getRfb: () => RFB | null;
  canControl: () => boolean;
} & UiOptions;
export type BrowserControlOptions = {
  canControl: () => boolean;
  isAuthenticated: () => boolean;
  beforeAction: () => void;
  onError: (message: string) => void;
} & UiOptions;
export type ApiKeyMetadata = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  legacy?: boolean;
};
export type SavedFile = ArtifactMetadata & { url: string };

export type GetRoutes = {
  "/api/auth/status": { configured: boolean; authenticated: boolean };
  "/api/status": ControlState;
  "/api/artifacts": { files: SavedFile[]; recording: RecordingStatus | null };
  "/api/clipboard": { text: string };
  "/api/keys": { keys: ApiKeyMetadata[] };
  "/api/browser/tabs": BrowserTabs;
};
export type PostRoutes = {
  "/api/auth/setup": { authenticated: boolean };
  "/api/login": { authenticated: boolean };
  "/api/logout": { authenticated: boolean };
  "/api/control/agent/cancel": ControlState;
  "/api/control/take": ControlState;
  "/api/control/release": ControlState;
  "/api/control/renew": ControlState;
  "/api/browser/action": BrowserTabs;
  "/api/clipboard": { written: boolean };
  "/api/keys": { key: ApiKeyMetadata; secret: string };
  "/api/keys/revoke": { revoked: boolean };
};

export type { RecordingStatus } from "../src/artifacts.js";
export type { BrowserTabs } from "../src/browser.js";
