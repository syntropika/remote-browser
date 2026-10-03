import type RFB from "/vendor/novnc/core/rfb.js";
import type { BrowserTabs } from "../src/browser.js";
import type { RecordingStatus, ArtifactMetadata } from "../src/artifacts.js";

export type Api = typeof import("./api.js").api;
export interface UiOptions {
  api: Api;
  onOpen: () => void;
  onUnauthorized: () => void;
}
export interface ControlState {
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
}
export interface ClipboardOptions extends UiOptions {
  getRfb: () => RFB | null;
  canControl: () => boolean;
}
export interface BrowserControlOptions extends UiOptions {
  canControl: () => boolean;
  isAuthenticated: () => boolean;
  beforeAction: () => void;
  onError: (message: string) => void;
}
export interface ApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  legacy?: boolean;
}
export type SavedFile = ArtifactMetadata & { url: string };
export type { RFB, BrowserTabs, RecordingStatus };
export interface GetRoutes {
  "/api/auth/status": { configured: boolean; authenticated: boolean };
  "/api/status": ControlState;
  "/api/artifacts": { files: SavedFile[]; recording: RecordingStatus | null };
  "/api/clipboard": { text: string };
  "/api/keys": { keys: ApiKeyMetadata[] };
  "/api/browser/tabs": BrowserTabs;
}
export interface PostRoutes {
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
}
