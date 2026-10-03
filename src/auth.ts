import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { required } from "./invariants.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export class Auth {
  tokenHash: Buffer<ArrayBuffer>;
  sessions: Map<string, number>;
  sessionMs: number;
  now: () => number;

  constructor(token: string, { sessionMs = 8 * 60 * 60 * 1000, now = Date.now } = {}) {
    if (token.length < 32) {
      throw new Error("The access token must contain at least 32 characters.");
    }
    this.tokenHash = digest(token);
    this.sessions = new Map();
    this.sessionMs = sessionMs;
    this.now = now;
  }

  validToken(value: unknown) {
    return (
      typeof value === "string" &&
      value.length <= 4096 &&
      timingSafeEqual(this.tokenHash, digest(value))
    );
  }

  sessionId(req: IncomingMessage) {
    return /(?:^|;\s*)remote_browser_session=(?<capture1>[a-f0-9]{64})(?:;|$)/u.exec(
      req.headers.cookie || "",
    )?.[1];
  }

  validSession(id: string | undefined) {
    return Boolean(id && (this.sessions.get(id) ?? 0) > this.now());
  }

  identify(req: IncomingMessage) {
    const bearer = /^Bearer (?<capture1>.+)$/iu.exec(req.headers.authorization || "")?.[1];
    if (bearer && this.validToken(bearer)) {
      return { type: "bearer" };
    }
    return this.identifySession(req);
  }

  identifySession(req: IncomingMessage): { type: "session"; id: string } | null {
    const id = this.sessionId(req);
    return this.validSession(id) ? { type: "session", id: required(id) } : null;
  }

  createSession() {
    this.cleanup();
    if (this.sessions.size >= 32) {
      throw new Error(
        "Too many active sessions. Log out of another session or restart the container.",
      );
    }
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, this.now() + this.sessionMs);
    return id;
  }

  cleanup() {
    for (const id of this.sessions.keys()) {
      if (!this.validSession(id)) {
        this.sessions.delete(id);
      }
    }
  }

  cookie(id: string, secure = false) {
    return `remote_browser_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${id ? this.sessionMs / 1000 : 0}${secure ? "; Secure" : ""}`;
  }
}
