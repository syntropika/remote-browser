import { nativeError } from "./effects.js";
import {
  Accounts,
  Keys,
  Artifacts,
  Browser,
  Clipboard,
  serviceRuntime,
  useService,
} from "./services.js";
import { run } from "./effects.js";
import type { FinishOperation } from "./control.js";
interface GatewayOptions {
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
}
interface VncClient {
  ws: WebSocket;
  upstreamSocket: net.Socket;
  session: string;
  mode: string;
}
import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Auth } from "./auth.js";
import { AccountError, AccountStore } from "./account.js";
import { ApiKeyError, ApiKeyStore } from "./api-keys.js";
import { Control } from "./control.js";
import { BrowserError, BrowserService } from "./browser.js";
import { ArtifactError, ArtifactService, fileLimit } from "./artifacts.js";
import { ClipboardError, ClipboardService } from "./clipboard.js";
import { forwardMcp, requiresControl, rpcError } from "./mcp-proxy.js";
import { prepareCodeMode } from "./code-mode.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(
  directory,
  directory.endsWith(`${path.sep}dist${path.sep}src`) ? "../.." : "..",
);
const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const json = (res: http.ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};

async function readBody(req: http.IncomingMessage, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tcpReady(port: number | string) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1");
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
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
      const browser = await response.json();
      return (
        Boolean(browser.webSocketDebuggerUrl) &&
        (await tcpReady(new URL(upstream).port || 80))
      );
    } catch {
      return false;
    }
  },
}: GatewayOptions = {}) {
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin)
    throw new Error(
      "PUBLIC_ORIGIN must be an origin without a trailing slash or path.",
    );
  const execute = serviceRuntime({
    accountStore,
    apiKeys,
    artifactService,
    browserService,
    clipboardService,
  });
  const auth = new Auth(token!);
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
        if (response.destroyed || response.writableEnded) continue;
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
    if (apiKeys.fault) return false;
    if (Date.now() - cachedProbe.time > 2000)
      cachedProbe = {
        time: Date.now(),
        promise: Promise.resolve()
          .then(probe)
          .catch(() => false),
      };
    return !control.fault && (await cachedProbe.promise);
  };
  const validOrigin = (req: http.IncomingMessage, required = false) => {
    if (!req.headers.origin) return !required;
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
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization)?.[1];
      return bearer ? apiKeys.authenticate(bearer) : null;
    }
    return auth.identifySession(req);
  };
  const closeSessionSockets = (id: string) => {
    for (const client of sockets)
      if (client.session === id) {
        client.upstreamSocket.destroy();
        client.ws.close(1008, "Session ended.");
      }
    for (const [response, session] of controlStreams)
      if (session === id) response.end();
  };
  const endSession = (id: string | undefined) => {
    if (!id) return;
    if (control.owner === id) control.release(id);
    auth.sessions.delete(id);
    closeSessionSockets(id);
  };
  const startSession = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    endSession(auth.sessionId(req));
    const id = auth.createSession();
    res.setHeader(
      "Set-Cookie",
      auth.cookie(id, publicOrigin.startsWith("https://")),
    );
  };
  const allowAuthAttempt = (req: http.IncomingMessage) => {
    const now = Date.now();
    if (now - globalAttempts.since >= 60_000)
      globalAttempts = { count: 0, since: now };
    for (const [key, attempt] of loginAttempts)
      if (now - attempt.since >= 60_000) loginAttempts.delete(key);
    const key = req.socket.remoteAddress || "unknown";
    if (!loginAttempts.has(key) && loginAttempts.size >= 512) return false;
    const attempt = loginAttempts.get(key) || { count: 0, since: now };
    if (attempt.count >= 10 || globalAttempts.count >= 30) return false;
    attempt.count++;
    globalAttempts.count++;
    loginAttempts.set(key, attempt);
    return true;
  };

  async function serveStatic(res: http.ServerResponse, pathname: string) {
    let base = path.join(root, "public");
    if (pathname.endsWith(".js")) base = path.join(root, "dist/public");
    let relative = pathname === "/" ? "index.html" : pathname.slice(1);
    if (pathname.startsWith("/vendor/novnc/")) {
      base = path.join(root, "node_modules/@novnc/novnc");
      relative = pathname.slice("/vendor/novnc/".length);
    }
    const filename = path.resolve(base, relative);
    if (
      !filename.startsWith(`${base}${path.sep}`) ||
      !contentTypes[path.extname(filename)]
    )
      return json(res, 404, { error: "Not found." });
    try {
      const data = await readFile(filename);
      res.writeHead(200, {
        "Content-Type": `${contentTypes[path.extname(filename)]}; charset=utf-8`,
      });
      res.end(data);
    } catch {
      json(res, 404, { error: "Not found." });
    }
  }

  const server = http.createServer(async (req, res) => {
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
        return json(res, healthy ? 200 : 503, { ready: healthy });
      }
      if (!validOrigin(req))
        return json(res, 403, { error: "Origin is not allowed." });
      if (pathname === "/api/auth/status" && req.method === "GET") {
        return json(res, 200, {
          configured: await accountStore.configured(),
          authenticated: auth.validSession(auth.sessionId(req)),
        });
      }
      if (
        ["/api/auth/setup", "/api/login"].includes(pathname) &&
        req.method === "POST"
      ) {
        if (!validOrigin(req, true))
          return json(res, 403, {
            error: "A same-origin request is required.",
          });
        if (!allowAuthAttempt(req)) {
          res.setHeader("Retry-After", "60");
          return json(res, 429, {
            error: "Too many sign-in requests. Try again in one minute.",
          });
        }
        let input;
        try {
          input = JSON.parse((await readBody(req, 4096)).toString());
        } catch {
          return json(res, 400, { error: "Invalid or oversized JSON body." });
        }
        if (pathname === "/api/auth/setup")
          await execute(
            useService(Accounts, (account) => account.create(input)),
          );
        else if (
          !(await execute(
            useService(Accounts, (account) => account.verify(input)),
          ))
        )
          return json(res, 401, { error: "Invalid username or password." });
        startSession(req, res);
        return json(res, pathname === "/api/auth/setup" ? 201 : 200, {
          authenticated: true,
        });
      }

      if (pathname.startsWith("/api/") || pathname === "/mcp") {
        const identity = await identify(req);
        if (!identity) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="remote-browser"');
          return json(res, 401, { error: "Authentication required." });
        }
        if (pathname === "/mcp") {
          // Agent clients use bearer credentials. UI cookies never authorize MCP.
          if (identity.type !== "bearer")
            return json(res, 403, {
              error: "MCP requires bearer authentication.",
            });
          if (!["POST", "GET", "DELETE"].includes(req.method ?? ""))
            return json(res, 405, { error: "Method not allowed." });
          let body, message;
          if (req.method === "POST") {
            body = await readBody(req);
            try {
              message = JSON.parse(body.toString());
            } catch {
              return json(res, 400, { error: "Invalid JSON body." });
            }
          }
          // Body reads can outlive a revocation. Check again immediately before dispatch.
          if (!apiKeys.active(identity.id))
            return json(res, 401, { error: "API key has been revoked." });
          let finish: FinishOperation | undefined;
          const waiting = new AbortController();
          const disconnected = () => waiting.abort();
          res.once("close", disconnected);
          const untrack = apiKeys.track(identity.id, () => {
            waiting.abort();
            res.destroy();
          });
          if (!untrack) {
            res.off("close", disconnected);
            return json(res, 401, { error: "API key has been revoked." });
          }
          try {
            if (requiresControl(req.method, message)) {
              try {
                if (req.method === "POST" && prepareCodeMode(body).executes) {
                  if (
                    control.owner &&
                    ![...controlStreams.values()].includes(control.owner)
                  )
                    throw new Error(
                      "Human control is active. Open the dashboard to receive the agent control request, or return control.",
                    );
                  finish = await run(
                    control.beginAgentEffect({
                      signal: waiting.signal,
                      beforeStart: () => {
                        if (!apiKeys.active(identity.id))
                          throw new Error("API key has been revoked.");
                        if (res.destroyed || waiting.signal.aborted)
                          throw new Error(
                            "The agent request was disconnected.",
                          );
                      },
                    }),
                  );
                } else finish = control.begin();
              } catch (errorCause) {
                const error = nativeError(errorCause);
                if (!res.destroyed)
                  return json(
                    res,
                    req.method === "POST" ? 200 : 409,
                    rpcError(message, error.message),
                  );
                return;
              }
            }
            if (!apiKeys.active(identity.id) || res.destroyed) {
              finish?.();
              if (!res.destroyed)
                return json(res, 401, { error: "API key has been revoked." });
              return;
            }
            return await forwardMcp(req, res, {
              upstream,
              body,
              finish,
              timeoutMs: upstreamTimeoutMs,
            });
          } finally {
            untrack();
            res.off("close", disconnected);
          }
        }
        if (pathname === "/api/status" && req.method === "GET") {
          const status = {
            ...control.status(identity.id),
            recording: artifactService.status(),
          };
          status.ready = await ready();
          status.recording = artifactService.status();
          return json(res, 200, status);
        }
        const authorized = () =>
          identity.type === "bearer"
            ? apiKeys.active(identity.id)
            : auth.validSession(identity.id);
        if (pathname === "/api/artifacts" && req.method === "GET") {
          const listing = await execute(
            useService(Artifacts, (artifacts) => artifacts.list()),
          );
          if (!authorized())
            return json(res, 401, { error: "Authentication expired." });
          return json(res, 200, listing);
        }
        const artifactFile =
          /^\/api\/artifacts\/([^/]+)\/(download|preview)$/.exec(pathname);
        if (artifactFile && ["GET", "HEAD"].includes(req.method ?? "")) {
          let file;
          try {
            file = await artifactService.openFile(artifactFile[1], {
              range: req.method === "GET" ? req.headers.range : undefined,
            });
          } catch (errorCause) {
            const error = nativeError(errorCause);
            if (!authorized())
              return json(res, 401, { error: "Authentication expired." });
            if (error instanceof ArtifactError && error.status === 416)
              res.setHeader("Content-Range", `bytes */${error.size}`);
            throw error;
          }
          if (!authorized()) {
            file.stream.destroy();
            return json(res, 401, { error: "Authentication expired." });
          }
          const untrack =
            identity.type === "bearer"
              ? apiKeys.track(identity.id, () => res.destroy())
              : null;
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
            "Content-Disposition": `${artifactFile[2] === "preview" && file.mimeType !== "application/octet-stream" ? "inline" : "attachment"}; filename="browser-file"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
          });
          if (req.method === "HEAD") {
            file.stream.destroy();
            res.end();
            return;
          }
          file.stream.pipe(res);
          return;
        }
        if (identity.type !== "session")
          return json(res, 403, {
            error: "Sign in to the dashboard to manage browser access.",
          });
        if (pathname === "/api/control/events" && req.method === "GET") {
          if (
            [...controlStreams.values()].filter((id) => id === identity.id)
              .length >= 16
          )
            return json(res, 409, {
              error: "Too many dashboard connections. Close an unused tab.",
            });
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
          if (!(await ready()))
            return json(res, 503, {
              error: "The browser service is unavailable.",
            });
          const check = () => {
            if (!auth.validSession(identity.id))
              throw new ClipboardError(401, "Session expired. Sign in again.");
            if (!control.canControl(identity.id))
              throw new ClipboardError(
                409,
                "Take control before using the clipboard.",
              );
          };
          check();
          const text = await execute(
            useService(Clipboard, (clipboard) => clipboard.read()),
          );
          check();
          return json(res, 200, { text });
        }
        if (pathname === "/api/keys" && req.method === "GET") {
          const keys = await execute(useService(Keys, (keys) => keys.list()));
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          return json(res, 200, { keys });
        }
        if (pathname === "/api/browser/tabs" && req.method === "GET") {
          if (!(await ready()))
            return json(res, 503, {
              error: "The browser service is unavailable.",
            });
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          const tabs = await execute(
            useService(Browser, (browser) => browser.listTabs()),
          );
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          return json(res, 200, tabs);
        }
        if (req.method !== "POST")
          return json(res, 405, { error: "Method not allowed." });
        if (!validOrigin(req, true))
          return json(res, 403, {
            error: "A same-origin request is required.",
          });
        if (pathname === "/api/artifacts/upload") {
          if (req.headers["content-type"] !== "application/octet-stream")
            throw new ArtifactError(
              400,
              "Send the file as application/octet-stream.",
            );
          let buffer, name;
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
            if (!auth.validSession(identity.id))
              throw new ArtifactError(401, "Session expired. Sign in again.");
          };
          beforeMutation();
          return json(
            res,
            201,
            await artifactService.saveFile(
              { name, buffer, kind: "upload" },
              { beforeMutation },
            ),
          );
        }
        if (pathname === "/api/control/agent/cancel") {
          let input;
          try {
            input = JSON.parse((await readBody(req, 4096)).toString());
          } catch {
            return json(res, 400, { error: "Invalid or oversized JSON body." });
          }
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          try {
            return json(res, 200, control.cancelAgent(identity.id, input?.id));
          } catch (errorCause) {
            const error = nativeError(errorCause);
            return json(res, 409, { error: error.message });
          }
        }
        if (pathname === "/api/clipboard") {
          let input;
          try {
            input = JSON.parse((await readBody(req, 512 * 1024)).toString());
          } catch {
            return json(res, 400, { error: "Invalid or oversized JSON body." });
          }
          if (!(await ready()))
            return json(res, 503, {
              error: "The browser service is unavailable.",
            });
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          let finish: FinishOperation | undefined;
          try {
            finish = control.beginHuman(identity.id);
          } catch (errorCause) {
            const error = nativeError(errorCause);
            return json(res, 409, { error: error.message });
          }
          try {
            await clipboardService.write(input?.text, {
              beforeMutation: () => {
                if (!auth.validSession(identity.id))
                  throw new ClipboardError(
                    401,
                    "Session expired. Sign in again.",
                  );
                if (!control.canControl(identity.id))
                  throw new ClipboardError(
                    409,
                    "Take control before using the clipboard.",
                  );
              },
            });
            return json(res, 200, { written: true });
          } finally {
            finish();
          }
        }
        if (pathname === "/api/artifacts/delete") {
          let input;
          try {
            input = JSON.parse((await readBody(req, 4096)).toString());
          } catch {
            return json(res, 400, { error: "Invalid or oversized JSON body." });
          }
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          return json(
            res,
            200,
            await artifactService.remove(input?.id, {
              beforeMutation: () => {
                if (!auth.validSession(identity.id))
                  throw new ArtifactError(
                    401,
                    "Session expired. Sign in again.",
                  );
              },
            }),
          );
        }
        if (pathname === "/api/recording/stop") {
          await readBody(req, 4096);
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          return json(res, 200, {
            file: await artifactService.stopRecording({
              beforeMutation: () => {
                if (!auth.validSession(identity.id))
                  throw new ArtifactError(
                    401,
                    "Session expired. Sign in again.",
                  );
              },
            }),
          });
        }
        if (pathname === "/api/keys" || pathname === "/api/keys/revoke") {
          let input;
          try {
            input = JSON.parse((await readBody(req, 4096)).toString());
          } catch {
            return json(res, 400, { error: "Invalid or oversized JSON body." });
          }
          const beforeMutation = () => {
            if (!auth.validSession(identity.id))
              throw new ApiKeyError(401, "Session expired. Sign in again.");
          };
          beforeMutation();
          if (pathname === "/api/keys")
            return json(
              res,
              201,
              await apiKeys.create(input?.name, { beforeMutation }),
            );
          return json(
            res,
            200,
            await apiKeys.revoke(input?.id, { beforeMutation }),
          );
        }
        if (pathname === "/api/browser/action") {
          let input;
          try {
            input = JSON.parse((await readBody(req, 8192)).toString());
          } catch {
            return json(res, 400, { error: "Invalid or oversized JSON body." });
          }
          if (!(await ready()))
            return json(res, 503, {
              error: "The browser service is unavailable.",
            });
          if (!auth.validSession(identity.id))
            return json(res, 401, { error: "Session expired. Sign in again." });
          let finish: FinishOperation | undefined;
          try {
            finish = control.beginHuman(identity.id);
          } catch (errorCause) {
            const error = nativeError(errorCause);
            return json(res, 409, { error: error.message });
          }
          try {
            const state = await browserService.action(input, {
              beforeMutation: () => {
                if (!auth.validSession(identity.id))
                  throw new BrowserError(
                    "Session expired. Sign in again.",
                    401,
                  );
                if (!control.canControl(identity.id))
                  throw new BrowserError(
                    "Take control before using the browser controls.",
                    409,
                  );
              },
            });
            finish();
            return json(res, 200, state);
          } catch (errorCause) {
            const error = nativeError(errorCause);
            finish(error.unknownCompletion ? error : null);
            throw error;
          }
        }
        await readBody(req);
        if (!auth.validSession(identity.id))
          return json(res, 401, { error: "Session expired. Sign in again." });
        if (pathname === "/api/logout") {
          endSession(identity.id);
          res.setHeader(
            "Set-Cookie",
            auth.cookie("", publicOrigin.startsWith("https://")),
          );
          return json(res, 200, { authenticated: false });
        }
        try {
          if (pathname === "/api/control/take") {
            if (!(await ready()))
              return json(res, 503, {
                error: "The browser service is unavailable.",
              });
            if (!auth.validSession(identity.id))
              return json(res, 401, {
                error: "Session expired. Sign in again.",
              });
            const status = control.take(identity.id);
            return json(res, status.mode === "pending" ? 202 : 200, status);
          }
          if (pathname === "/api/control/renew")
            return json(res, 200, control.renew(identity.id));
          if (pathname === "/api/control/release")
            return json(res, 200, control.release(identity.id));
        } catch (errorCause) {
          const error = nativeError(errorCause);
          return json(res, 409, { error: error.message });
        }
        return json(res, 404, { error: "Not found." });
      }
      if (req.method === "GET") return await serveStatic(res, pathname);
      return json(res, 404, { error: "Not found." });
    } catch (errorCause) {
      const error = nativeError(errorCause);
      if (!res.headersSent) {
        const expected =
          error instanceof AccountError ||
          error instanceof BrowserError ||
          error instanceof ApiKeyError ||
          error instanceof ArtifactError ||
          error instanceof ClipboardError;
        json(res, expected ? error.status : 400, {
          error: expected ? error.message : "Invalid request.",
        });
      } else res.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  server.on("upgrade", (req, socket, head) => {
    const reject = (status = "403 Forbidden") => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    try {
      const url = new URL(req.url ?? "/", "http://gateway.invalid");
      const identity = req.headers.authorization
        ? null
        : auth.identifySession(req);
      const mode = url.searchParams.get("mode");
      if (
        url.pathname !== "/vnc" ||
        !validOrigin(req, true) ||
        identity?.type !== "session"
      )
        return reject();
      if (!["view", "control"].includes(mode ?? "")) return reject();
      if (mode === "control" && !control.canControl(identity.id))
        return reject();
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        const upstreamSocket = net.connect(
          mode === "control" ? controlPort : viewPort,
          "127.0.0.1",
        );
        const client = {
          ws,
          upstreamSocket,
          session: identity.id,
          mode: mode!,
        };
        sockets.add(client);
        upstreamSocket.on("data", (data) => {
          upstreamSocket.pause();
          if (ws.readyState !== WebSocket.OPEN) return upstreamSocket.destroy();
          ws.send(data, { binary: true }, (error) => {
            if (error) upstreamSocket.destroy();
            else upstreamSocket.resume();
          });
        });
        ws.on("message", (data, binary) => {
          if (
            !binary ||
            !auth.validSession(identity.id) ||
            (mode === "control" && !control.canControl(identity.id))
          )
            return ws.close(1008, "Input is not authorized.");
          if (
            !upstreamSocket.write(
              Array.isArray(data)
                ? Buffer.concat(data)
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : data,
            )
          )
            ws.pause();
        });
        upstreamSocket.on("drain", () => ws.resume());
        upstreamSocket.on("error", () =>
          ws.close(1011, "Remote display is unavailable."),
        );
        upstreamSocket.on("close", () => ws.close());
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
    for (const client of sockets)
      if (!auth.validSession(client.session))
        client.ws.close(1008, "Session expired.");
    for (const [response, session] of controlStreams) {
      if (!auth.validSession(session)) response.end();
      else if (
        !response.destroyed &&
        !response.writableEnded &&
        response.writableLength < 64 * 1024
      )
        response.write(": heartbeat\n\n");
    }
  }, 1000);
  interval.unref();
  server.on("close", () => {
    control.close();
    clearInterval(interval);
    for (const response of controlStreams.keys()) response.end();
    for (const client of sockets) client.ws.terminate();
    wsServer.close();
    browserService.close?.();
    void artifactService.close();
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

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const token = (
    await readFile(
      process.env.BROWSER_TOKEN_FILE || "/data/access-token",
      "utf8",
    )
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
  server.listen(port, "0.0.0.0", () =>
    console.log(`Remote browser gateway listening on port ${port}.`),
  );
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      control.close();
      server.close();
      setTimeout(() => process.exit(0), 10_000).unref();
      await artifactService.close();
      process.exit(0);
    });
}
