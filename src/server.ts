import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import { AccountError, AccountStore } from "./account.js";
import { ApiKeyError, ApiKeyStore } from "./api-keys.js";
import { ArtifactError, ArtifactService, fileLimit } from "./artifacts.js";
import { asyncHandler, background } from "./async-boundary.js";
import { Auth } from "./auth.js";
import { BrowserError, BrowserService } from "./browser.js";
import { ClipboardError, ClipboardService, validateClipboardText } from "./clipboard.js";
import type { WireMessage } from "./code-mode.js";
import { prepareCodeMode } from "./code-mode.js";
import type { FinishOperation } from "./control.js";
import { Control } from "./control.js";
import { nativeError, run } from "./effects.js";
import { isRecord, jsonObject, parseJson, required } from "./invariants.js";
import { forwardMcp, requiresControl, rpcError } from "./mcp-proxy.js";
import {
  Accounts,
  Artifacts,
  Browser,
  Clipboard,
  Keys,
  serviceRuntime,
  useService,
} from "./services.js";

type GatewayOptions = {
  token?: string;
  accountFile?: string;
  accountStore?: AccountStore;
  apiKeysFile?: string;
  apiKeys?: ApiKeyStore;
  browserService?: BrowserService;
  clipboardService?: ClipboardService;
  upstream?: string;
  publicOrigin?: string;
  artifactService?: ArtifactService;
  viewPort?: number;
  controlPort?: number;
  leaseMs?: number;
  agentTakeoverMs?: number;
  upstreamTimeoutMs?: number;
  probe?: () => Promise<boolean>;
};
type VncClient = {
  ws: WebSocket;
  upstreamSocket: net.Socket;
  session: string;
  mode: string;
};

const directory = import.meta.dirname;
const root = path.resolve(
  directory,
  directory.endsWith(`${path.sep}dist${path.sep}src`) ? "../.." : "..",
);
const contentTypes = new Map([
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);
const json = (res: http.ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};

async function readBody(req: http.IncomingMessage, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk));
    size += chunk.length;
    if (size > limit) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function tcpReady(port: number | string) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1");
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500, () => {
      done(false);
    });
    socket.once("connect", () => {
      done(true);
    });
    socket.once("error", () => {
      done(false);
    });
  });
}

export function createGateway({
  token,
  accountFile = path.join(process.env.DATA_DIR || "/data", "account.json"),
  accountStore = new AccountStore(accountFile),
  apiKeysFile = path.join(path.dirname(accountFile), "api-keys.json"),
  apiKeys = new ApiKeyStore(apiKeysFile, { legacyToken: token }),
  browserService = new BrowserService(),
  clipboardService = new ClipboardService(),
  upstream = "http://127.0.0.1:8931/mcp",
  publicOrigin = "",
  artifactService = new ArtifactService({
    directory: path.join(path.dirname(accountFile), "artifacts"),
    publicOrigin,
  }),
  viewPort = 5900,
  controlPort = 5901,
  leaseMs = 90_000,
  agentTakeoverMs = 5000,
  upstreamTimeoutMs = 120_000,
  probe = async () => {
    try {
      const response = await fetch("http://127.0.0.1:9222/json/version", {
        signal: AbortSignal.timeout(1500),
      });
      const browser = jsonObject(await response.text());
      return (
        Boolean(browser.webSocketDebuggerUrl) && (await tcpReady(new URL(upstream).port || 80))
      );
    } catch {
      return false;
    }
  },
}: GatewayOptions = {}) {
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) {
    throw new Error("PUBLIC_ORIGIN must be an origin without a trailing slash or path.");
  }
  const execute = serviceRuntime({
    accountStore,
    apiKeys,
    artifactService,
    browserService,
    clipboardService,
  });
  const auth = new Auth(required(token));
  const sockets = new Set<VncClient>();
  const controlStreams = new Map<http.ServerResponse, string>();
  const loginAttempts = new Map<string, { count: number; since: number }>();
  let globalAttempts = { count: 0, since: 0 };
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const control = new Control({
    leaseMs,
    agentTakeoverMs,
    onChange: () => {
      for (const client of sockets) {
        if (client.mode === "control" && !control.canControl(client.session)) {
          client.upstreamSocket.destroy();
          client.ws.close(1008, "Control returned.");
        }
      }
      for (const [response, session] of controlStreams) {
        if (response.destroyed || response.writableEnded) {
          continue;
        }
        if (response.writableLength > 64 * 1024) {
          response.destroy();
          continue;
        }
        response.write(`data: ${JSON.stringify(control.status(session))}\n\n`);
      }
    },
  });
  let cachedProbe = { time: 0, promise: Promise.resolve(false) };
  const ready = async () => {
    try {
      await apiKeys.initialize();
    } catch {
      return false;
    }
    if (apiKeys.fault) {
      return false;
    }
    if (Date.now() - cachedProbe.time > 2000) {
      cachedProbe = {
        time: Date.now(),
        promise: Promise.resolve()
          .then(probe)
          .catch(() => false),
      };
    }
    return !control.fault && (await cachedProbe.promise);
  };
  const validOrigin = (req: http.IncomingMessage, localRequired = false) => {
    if (!req.headers.origin) {
      return !localRequired;
    }
    try {
      const origin = new URL(req.headers.origin);
      return (
        req.headers.origin === origin.origin &&
        origin.origin === (publicOrigin || `http://${req.headers.host}`)
      );
    } catch {
      return false;
    }
  };
  const identify = async (req: http.IncomingMessage) => {
    if (req.headers.authorization) {
      const bearer = /^Bearer (?<capture1>.+)$/iu.exec(req.headers.authorization)?.[1];
      return bearer ? apiKeys.authenticate(bearer) : null;
    }
    return auth.identifySession(req);
  };
  const closeSessionSockets = (id: string) => {
    for (const client of sockets) {
      if (client.session === id) {
        client.upstreamSocket.destroy();
        client.ws.close(1008, "Session ended.");
      }
    }
    for (const [response, session] of controlStreams) {
      if (session === id) {
        response.end();
      }
    }
  };
  const endSession = (id: string | undefined) => {
    if (!id) {
      return;
    }
    if (control.owner === id) {
      control.release(id);
    }
    auth.sessions.delete(id);
    closeSessionSockets(id);
  };
  const startSession = (req: http.IncomingMessage, res: http.ServerResponse) => {
    endSession(auth.sessionId(req));
    const id = auth.createSession();
    res.setHeader("Set-Cookie", auth.cookie(id, publicOrigin.startsWith("https://")));
  };
  const allowAuthAttempt = (req: http.IncomingMessage) => {
    const now = Date.now();
    if (now - globalAttempts.since >= 60_000) {
      globalAttempts = { count: 0, since: now };
    }
    for (const [key, attempt] of loginAttempts) {
      if (now - attempt.since >= 60_000) {
        loginAttempts.delete(key);
      }
    }
    const key = req.socket.remoteAddress || "unknown";
    if (!loginAttempts.has(key) && loginAttempts.size >= 512) {
      return false;
    }
    const attempt = loginAttempts.get(key) || { count: 0, since: now };
    if (attempt.count >= 10 || globalAttempts.count >= 30) {
      return false;
    }
    attempt.count++;
    globalAttempts.count++;
    loginAttempts.set(key, attempt);
    return true;
  };

  async function serveStatic(res: http.ServerResponse, pathname: string) {
    let base = path.join(root, "public");
    if (pathname.endsWith(".js")) {
      base = path.join(root, "dist/public");
    }
    let relative = pathname === "/" ? "index.html" : pathname.slice(1);
    if (pathname.startsWith("/vendor/novnc/")) {
      base = path.join(root, "node_modules/@novnc/novnc");
      relative = pathname.slice("/vendor/novnc/".length);
    }
    const filename = path.resolve(base, relative);
    if (!filename.startsWith(`${base}${path.sep}`) || !contentTypes.has(path.extname(filename))) {
      json(res, 404, { error: "Not found." });
      return;
    }
    try {
      const data = await readFile(filename);
      res.writeHead(200, {
        "Content-Type": `${required(contentTypes.get(path.extname(filename)))}; charset=utf-8`,
      });
      res.end(data);
    } catch {
      json(res, 404, { error: "Not found." });
    }
  }

  const server = http.createServer(
    asyncHandler(async (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      try {
        const url = new URL(req.url ?? "/", "http://gateway.invalid");
        const pathname = decodeURIComponent(url.pathname);
        if (pathname === "/healthz" && req.method === "GET") {
          const healthy = await ready();
          json(res, healthy ? 200 : 503, { ready: healthy });
          return;
        }
        if (!validOrigin(req)) {
          json(res, 403, { error: "Origin is not allowed." });
          return;
        }
        if (pathname === "/api/auth/status" && req.method === "GET") {
          json(res, 200, {
            configured: await accountStore.configured(),
            authenticated: auth.validSession(auth.sessionId(req)),
          });
          return;
        }
        if (["/api/auth/setup", "/api/login"].includes(pathname) && req.method === "POST") {
          if (!validOrigin(req, true)) {
            json(res, 403, {
              error: "A same-origin request is required.",
            });
            return;
          }
          if (!allowAuthAttempt(req)) {
            res.setHeader("Retry-After", "60");
            json(res, 429, {
              error: "Too many sign-in requests. Try again in one minute.",
            });
            return;
          }
          let input: Record<string, unknown>;
          try {
            input = jsonObject((await readBody(req, 4096)).toString());
          } catch {
            json(res, 400, { error: "Invalid or oversized JSON body." });
            return;
          }
          if (pathname === "/api/auth/setup") {
            await execute(useService(Accounts, async (account) => account.create(input)));
          } else if (
            !(await execute(useService(Accounts, async (account) => account.verify(input))))
          ) {
            json(res, 401, { error: "Invalid username or password." });
            return;
          }
          startSession(req, res);
          json(res, pathname === "/api/auth/setup" ? 201 : 200, {
            authenticated: true,
          });
          return;
        }

        if (pathname.startsWith("/api/") || pathname === "/mcp") {
          const identity = await identify(req);
          if (!identity) {
            res.setHeader("WWW-Authenticate", 'Bearer realm="remote-browser"');
            json(res, 401, { error: "Authentication required." });
            return;
          }
          if (pathname === "/mcp") {
            // Agent clients use bearer credentials. UI cookies never authorize MCP.
            if (identity.type !== "bearer") {
              json(res, 403, {
                error: "MCP requires bearer authentication.",
              });
              return;
            }
            if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
              json(res, 405, { error: "Method not allowed." });
              return;
            }
            let body;
            let message: WireMessage | WireMessage[] | undefined;
            if (req.method === "POST") {
              body = await readBody(req);
              try {
                const parsed = parseJson(body.toString());
                message = isRecord(parsed)
                  ? parsed
                  : Array.isArray(parsed)
                    ? parsed.filter(isRecord)
                    : undefined;
              } catch {
                json(res, 400, { error: "Invalid JSON body." });
                return;
              }
            }
            // Body reads can outlive a revocation. Check again immediately before dispatch.
            if (!apiKeys.active(identity.id)) {
              json(res, 401, { error: "API key has been revoked." });
              return;
            }
            let finish: FinishOperation | undefined;
            const waiting = new AbortController();
            const disconnected = () => {
              waiting.abort();
            };
            res.once("close", disconnected);
            const untrack = apiKeys.track(identity.id, () => {
              waiting.abort();
              res.destroy();
            });
            if (!untrack) {
              res.off("close", disconnected);
              json(res, 401, { error: "API key has been revoked." });
              return;
            }
            try {
              if (requiresControl(req.method, message)) {
                try {
                  if (req.method === "POST" && prepareCodeMode(body).executes) {
                    if (control.owner && ![...controlStreams.values()].includes(control.owner)) {
                      throw new Error(
                        "Human control is active. Open the dashboard to receive the agent control request, or return control.",
                      );
                    }
                    finish = await run(
                      control.beginAgentEffect({
                        signal: waiting.signal,
                        beforeStart: () => {
                          if (!apiKeys.active(identity.id)) {
                            throw new Error("API key has been revoked.");
                          }
                          if (res.destroyed || waiting.signal.aborted) {
                            throw new Error("The agent request was disconnected.");
                          }
                        },
                      }),
                    );
                  } else {
                    finish = control.begin();
                  }
                } catch (cause) {
                  const error = nativeError(cause);
                  if (!res.destroyed) {
                    json(res, req.method === "POST" ? 200 : 409, rpcError(message, error.message));
                    return;
                  }
                  return;
                }
              }
              if (!apiKeys.active(identity.id) || res.destroyed) {
                finish?.();
                if (!res.destroyed) {
                  json(res, 401, { error: "API key has been revoked." });
                  return;
                }
                return;
              }
              await forwardMcp(req, res, {
                upstream,
                body,
                finish,
                timeoutMs: upstreamTimeoutMs,
              });
              return;
            } finally {
              untrack();
              res.off("close", disconnected);
            }
          }
          if (pathname === "/api/status" && req.method === "GET") {
            const status = {
              ...control.status(identity.id),
              ready: await ready(),
              recording: artifactService.status(),
            };
            json(res, 200, status);
            return;
          }
          const authorized = () =>
            identity.type === "bearer"
              ? apiKeys.active(identity.id)
              : auth.validSession(identity.id);
          if (pathname === "/api/artifacts" && req.method === "GET") {
            const listing = await execute(
              useService(Artifacts, async (artifacts) => artifacts.list()),
            );
            if (!authorized()) {
              json(res, 401, { error: "Authentication expired." });
              return;
            }
            json(res, 200, listing);
            return;
          }
          const artifactFile =
            /^\/api\/artifacts\/(?<capture1>[^/]+)\/(?<capture2>download|preview)$/u.exec(pathname);
          if (artifactFile && ["GET", "HEAD"].includes(req.method ?? "")) {
            let file;
            try {
              file = await artifactService.openFile(artifactFile[1], {
                range: req.method === "GET" ? req.headers.range : undefined,
              });
            } catch (cause) {
              const error = nativeError(cause);
              if (!authorized()) {
                json(res, 401, { error: "Authentication expired." });
                return;
              }
              if (error instanceof ArtifactError && error.status === 416) {
                res.setHeader("Content-Range", `bytes */${error.size}`);
              }
              throw error;
            }
            if (!authorized()) {
              file.stream.destroy();
              json(res, 401, { error: "Authentication expired." });
              return;
            }
            const untrack =
              identity.type === "bearer" ? apiKeys.track(identity.id, () => res.destroy()) : null;
            res.once("close", () => {
              file.stream.destroy();
              untrack?.();
            });
            file.stream.once("error", () => res.destroy());
            res.writeHead(file.partial ? 206 : 200, {
              "Content-Type": file.mimeType,
              "Content-Length": file.contentLength,
              "Accept-Ranges": "bytes",
              ...(file.partial
                ? {
                    "Content-Range": `bytes ${file.start}-${file.end}/${file.size}`,
                  }
                : {}),
              "Content-Disposition": `${artifactFile[2] === "preview" && file.mimeType !== "application/octet-stream" ? "inline" : "attachment"}; filename="browser-file"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll(/['()*]/gu, (c) => `%${required(c.codePointAt(0)).toString(16)}`)}`,
            });
            if (req.method === "HEAD") {
              file.stream.destroy();
              res.end();
              return;
            }
            file.stream.pipe(res);
            return;
          }
          if (identity.type !== "session") {
            json(res, 403, {
              error: "Sign in to the dashboard to manage browser access.",
            });
            return;
          }
          if (pathname === "/api/control/events" && req.method === "GET") {
            if ([...controlStreams.values()].filter((id) => id === identity.id).length >= 16) {
              json(res, 409, {
                error: "Too many dashboard connections. Close an unused tab.",
              });
              return;
            }
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "X-Accel-Buffering": "no",
            });
            res.flushHeaders();
            controlStreams.set(res, identity.id);
            res.once("close", () => {
              controlStreams.delete(res);
              if (
                control.agentRequest?.owner === identity.id &&
                ![...controlStreams.values()].includes(identity.id)
              ) {
                control.rejectAgentRequest(
                  new Error(
                    "The dashboard connection was lost. Retry after it reconnects or control is returned.",
                  ),
                );
              }
            });
            res.write(`data: ${JSON.stringify(control.status(identity.id))}\n\n`);
            return;
          }
          if (pathname === "/api/clipboard" && req.method === "GET") {
            if (!(await ready())) {
              json(res, 503, {
                error: "The browser service is unavailable.",
              });
              return;
            }
            const check = () => {
              if (!auth.validSession(identity.id)) {
                throw new ClipboardError(401, "Session expired. Sign in again.");
              }
              if (!control.canControl(identity.id)) {
                throw new ClipboardError(409, "Take control before using the clipboard.");
              }
            };
            check();
            const text = await execute(
              useService(Clipboard, async (clipboard) => clipboard.read()),
            );
            check();
            json(res, 200, { text });
            return;
          }
          if (pathname === "/api/keys" && req.method === "GET") {
            const keys = await execute(useService(Keys, async (localKeys) => localKeys.list()));
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            json(res, 200, { keys });
            return;
          }
          if (pathname === "/api/browser/tabs" && req.method === "GET") {
            if (!(await ready())) {
              json(res, 503, {
                error: "The browser service is unavailable.",
              });
              return;
            }
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            const tabs = await execute(useService(Browser, async (browser) => browser.listTabs()));
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            json(res, 200, tabs);
            return;
          }
          if (req.method !== "POST") {
            json(res, 405, { error: "Method not allowed." });
            return;
          }
          if (!validOrigin(req, true)) {
            json(res, 403, {
              error: "A same-origin request is required.",
            });
            return;
          }
          if (pathname === "/api/artifacts/upload") {
            if (req.headers["content-type"] !== "application/octet-stream") {
              throw new ArtifactError(400, "Send the file as application/octet-stream.");
            }
            let buffer;
            let name;
            try {
              name = decodeURIComponent(String(req.headers["x-file-name"] || ""));
              buffer = await readBody(req, fileLimit);
            } catch {
              throw new ArtifactError(
                413,
                "Choose a file no larger than 20 MiB with a valid name.",
              );
            }
            const beforeMutation = () => {
              if (!auth.validSession(identity.id)) {
                throw new ArtifactError(401, "Session expired. Sign in again.");
              }
            };
            beforeMutation();
            json(
              res,
              201,
              await artifactService.saveFile({ name, buffer, kind: "upload" }, { beforeMutation }),
            );
            return;
          }
          if (pathname === "/api/control/agent/cancel") {
            let input: Record<string, unknown>;
            try {
              input = jsonObject((await readBody(req, 4096)).toString());
            } catch {
              json(res, 400, { error: "Invalid or oversized JSON body." });
              return;
            }
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            try {
              json(res, 200, control.cancelAgent(identity.id, input?.id));
              return;
            } catch (cause) {
              const error = nativeError(cause);
              json(res, 409, { error: error.message });
              return;
            }
          }
          if (pathname === "/api/clipboard") {
            let input: Record<string, unknown>;
            try {
              input = jsonObject((await readBody(req, 512 * 1024)).toString());
            } catch {
              json(res, 400, { error: "Invalid or oversized JSON body." });
              return;
            }
            if (!(await ready())) {
              json(res, 503, {
                error: "The browser service is unavailable.",
              });
              return;
            }
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            let finish: FinishOperation | undefined;
            try {
              finish = control.beginHuman(identity.id);
            } catch (cause) {
              const error = nativeError(cause);
              json(res, 409, { error: error.message });
              return;
            }
            try {
              await clipboardService.write(validateClipboardText(input?.text), {
                beforeMutation: () => {
                  if (!auth.validSession(identity.id)) {
                    throw new ClipboardError(401, "Session expired. Sign in again.");
                  }
                  if (!control.canControl(identity.id)) {
                    throw new ClipboardError(409, "Take control before using the clipboard.");
                  }
                },
              });
              json(res, 200, { written: true });
              return;
            } finally {
              finish();
            }
          }
          if (pathname === "/api/artifacts/delete") {
            let input: Record<string, unknown>;
            try {
              input = jsonObject((await readBody(req, 4096)).toString());
            } catch {
              json(res, 400, { error: "Invalid or oversized JSON body." });
              return;
            }
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            json(
              res,
              200,
              await artifactService.remove(input?.id, {
                beforeMutation: () => {
                  if (!auth.validSession(identity.id)) {
                    throw new ArtifactError(401, "Session expired. Sign in again.");
                  }
                },
              }),
            );
            return;
          }
          if (pathname === "/api/recording/stop") {
            await readBody(req, 4096);
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            json(res, 200, {
              file: await artifactService.stopRecording({
                beforeMutation: () => {
                  if (!auth.validSession(identity.id)) {
                    throw new ArtifactError(401, "Session expired. Sign in again.");
                  }
                },
              }),
            });
            return;
          }
          if (pathname === "/api/keys" || pathname === "/api/keys/revoke") {
            let input: Record<string, unknown>;
            try {
              input = jsonObject((await readBody(req, 4096)).toString());
            } catch {
              json(res, 400, { error: "Invalid or oversized JSON body." });
              return;
            }
            const beforeMutation = () => {
              if (!auth.validSession(identity.id)) {
                throw new ApiKeyError(401, "Session expired. Sign in again.");
              }
            };
            beforeMutation();
            if (pathname === "/api/keys") {
              json(res, 201, await apiKeys.create(input?.name, { beforeMutation }));
              return;
            }
            json(res, 200, await apiKeys.revoke(input?.id, { beforeMutation }));
            return;
          }
          if (pathname === "/api/browser/action") {
            let input: Record<string, unknown>;
            try {
              input = jsonObject((await readBody(req, 8192)).toString());
            } catch {
              json(res, 400, { error: "Invalid or oversized JSON body." });
              return;
            }
            if (!(await ready())) {
              json(res, 503, {
                error: "The browser service is unavailable.",
              });
              return;
            }
            if (!auth.validSession(identity.id)) {
              json(res, 401, { error: "Session expired. Sign in again." });
              return;
            }
            let finish: FinishOperation | undefined;
            try {
              finish = control.beginHuman(identity.id);
            } catch (cause) {
              const error = nativeError(cause);
              json(res, 409, { error: error.message });
              return;
            }
            try {
              const state = await browserService.action(input, {
                beforeMutation: () => {
                  if (!auth.validSession(identity.id)) {
                    throw new BrowserError("Session expired. Sign in again.", 401);
                  }
                  if (!control.canControl(identity.id)) {
                    throw new BrowserError("Take control before using the browser controls.", 409);
                  }
                },
              });
              finish();
              json(res, 200, state);
              return;
            } catch (cause) {
              const error = nativeError(cause);
              finish(error.unknownCompletion ? error : null);
              throw error;
            }
          }
          await readBody(req);
          if (!auth.validSession(identity.id)) {
            json(res, 401, { error: "Session expired. Sign in again." });
            return;
          }
          if (pathname === "/api/logout") {
            endSession(identity.id);
            res.setHeader("Set-Cookie", auth.cookie("", publicOrigin.startsWith("https://")));
            json(res, 200, { authenticated: false });
            return;
          }
          try {
            if (pathname === "/api/control/take") {
              if (!(await ready())) {
                json(res, 503, {
                  error: "The browser service is unavailable.",
                });
                return;
              }
              if (!auth.validSession(identity.id)) {
                json(res, 401, {
                  error: "Session expired. Sign in again.",
                });
                return;
              }
              const status = control.take(identity.id);
              json(res, status.mode === "pending" ? 202 : 200, status);
              return;
            }
            if (pathname === "/api/control/renew") {
              json(res, 200, control.renew(identity.id));
              return;
            }
            if (pathname === "/api/control/release") {
              json(res, 200, control.release(identity.id));
              return;
            }
          } catch (cause) {
            const error = nativeError(cause);
            json(res, 409, { error: error.message });
            return;
          }
          json(res, 404, { error: "Not found." });
          return;
        }
        if (req.method === "GET") {
          await serveStatic(res, pathname);
          return;
        }
        json(res, 404, { error: "Not found." });
      } catch (cause) {
        const error = nativeError(cause);
        if (res.headersSent) {
          res.destroy();
        } else {
          const expected =
            error instanceof AccountError ||
            error instanceof BrowserError ||
            error instanceof ApiKeyError ||
            error instanceof ArtifactError ||
            error instanceof ClipboardError;
          json(res, expected ? error.status : 400, {
            error: expected ? error.message : "Invalid request.",
          });
        }
      }
    }),
  );
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  server.on("upgrade", (req, socket, head) => {
    const reject = (status = "403 Forbidden") => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    try {
      const url = new URL(req.url ?? "/", "http://gateway.invalid");
      const identity = req.headers.authorization ? null : auth.identifySession(req);
      const mode = url.searchParams.get("mode");
      if (url.pathname !== "/vnc" || !validOrigin(req, true) || identity?.type !== "session") {
        reject();
        return;
      }
      if (!["view", "control"].includes(mode ?? "")) {
        reject();
        return;
      }
      if (mode === "control" && !control.canControl(identity.id)) {
        reject();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        const upstreamSocket = net.connect(
          mode === "control" ? controlPort : viewPort,
          "127.0.0.1",
        );
        const client = {
          ws,
          upstreamSocket,
          session: identity.id,
          mode: required(mode),
        };
        sockets.add(client);
        upstreamSocket.on("data", (data) => {
          upstreamSocket.pause();
          if (ws.readyState !== WebSocket.OPEN) {
            upstreamSocket.destroy();
            return;
          }
          ws.send(data, { binary: true }, (error) => {
            if (error) {
              upstreamSocket.destroy();
            } else {
              upstreamSocket.resume();
            }
          });
        });
        ws.on("message", (data, binary) => {
          if (
            !binary ||
            !auth.validSession(identity.id) ||
            (mode === "control" && !control.canControl(identity.id))
          ) {
            ws.close(1008, "Input is not authorized.");
            return;
          }
          if (
            !upstreamSocket.write(
              Array.isArray(data)
                ? Buffer.concat(data)
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : data,
            )
          ) {
            ws.pause();
          }
        });
        upstreamSocket.on("drain", () => {
          ws.resume();
        });
        upstreamSocket.on("error", () => {
          ws.close(1011, "Remote display is unavailable.");
        });
        upstreamSocket.on("close", () => {
          ws.close();
        });
        ws.on("error", () => upstreamSocket.destroy());
        ws.on("close", () => {
          sockets.delete(client);
          upstreamSocket.destroy();
        });
      });
    } catch {
      reject("400 Bad Request");
    }
  });
  const interval = setInterval(() => {
    control.tick();
    auth.cleanup();
    for (const client of sockets) {
      if (!auth.validSession(client.session)) {
        client.ws.close(1008, "Session expired.");
      }
    }
    for (const [response, session] of controlStreams) {
      if (!auth.validSession(session)) {
        response.end();
      } else if (
        !response.destroyed &&
        !response.writableEnded &&
        response.writableLength < 64 * 1024
      ) {
        response.write(": heartbeat\n\n");
      }
    }
  }, 1000);
  interval.unref();
  server.on("close", () => {
    control.close();
    clearInterval(interval);
    for (const response of controlStreams.keys()) {
      response.end();
    }
    for (const client of sockets) {
      client.ws.terminate();
    }
    wsServer.close();
    browserService.close?.();
    background(artifactService.close());
  });
  return {
    server,
    control,
    auth,
    accountStore,
    apiKeys,
    browserService,
    artifactService,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const token = (
    await readFile(process.env.BROWSER_TOKEN_FILE || "/data/access-token", "utf-8")
  ).trim();
  const { server, control, artifactService } = createGateway({
    token,
    publicOrigin: process.env.PUBLIC_ORIGIN || "",
    upstream: process.env.MCP_URL || "http://127.0.0.1:8931/mcp",
    viewPort: Number(process.env.VNC_VIEW_PORT || 5900),
    controlPort: Number(process.env.VNC_CONTROL_PORT || 5901),
  });
  await artifactService.listen();
  const port = Number(process.env.PORT || 8080);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Remote browser gateway listening on port ${port}.`);
  });
  let stopping = false;
  const stop = asyncHandler(async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    control.close();
    server.close();
    setTimeout(() => process.exit(0), 10_000).unref();
    await artifactService.close();
    process.exit(0);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, stop);
  }
}
