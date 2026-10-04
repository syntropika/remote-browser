import type { IncomingMessage, ServerResponse } from "node:http";

import type { WireMessage } from "./code-mode.js";
import { MAX_UPSTREAM_BYTES, prepareCodeMode, transformCodeModeResponse } from "./code-mode.js";
import type { FinishOperation } from "./control.js";
import { asError } from "./effects.js";
import { isRecord } from "./invariants.js";

const allowedDuringHandoff = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "notifications/initialized",
  "notifications/cancelled",
]);

export function requiresControl(
  method: string | undefined,
  message: WireMessage | WireMessage[] | undefined,
) {
  if (method === "DELETE") {
    return true;
  }
  if (method !== "POST") {
    return false;
  }
  const messages = Array.isArray(message) ? message : [message];
  return messages.some(
    (item) =>
      item &&
      typeof item.method === "string" &&
      !allowedDuringHandoff.has(item.method) &&
      !(
        item.method === "tools/call" &&
        (isRecord(item.params) ? item.params.name : undefined) === "browser_docs"
      ),
  );
}

export function rpcError(message: WireMessage | WireMessage[] | undefined, error: string) {
  const messages = Array.isArray(message) ? message : [message];
  const replies = messages
    .filter((item): item is WireMessage => item !== undefined && item.id !== undefined)
    .map((item) => ({
      jsonrpc: "2.0",
      id: item.id,
      error: { code: -32_000, message: error },
    }));
  return Array.isArray(message) ? replies : replies[0] || { error };
}

export async function forwardMcp(
  req: IncomingMessage,
  res: ServerResponse,
  {
    upstream,
    body,
    finish,
    timeoutMs = 120_000,
    owner,
  }: {
    upstream: string;
    body?: Buffer;
    finish?: FinishOperation;
    timeoutMs?: number;
    owner?: string;
  },
) {
  const prepared =
    req.method === "POST"
      ? prepareCodeMode(body, owner)
      : { body, plans: new Map(), executes: false };
  const headers: Record<string, string> = {};
  for (const name of [
    "accept",
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
  ]) {
    if (req.headers[name]) {
      headers[name] = String(req.headers[name]);
    }
  }
  const controller = new AbortController();
  // GET is the optional long-lived MCP notification channel, not a tool call.
  const timer =
    req.method === "GET"
      ? null
      : setTimeout(() => {
          controller.abort();
        }, timeoutMs);
  if (req.method === "GET") {
    res.on("close", () => {
      controller.abort();
    });
  }
  let failure: Error | null = null;
  try {
    const response = await fetch(upstream, {
      method: req.method,
      headers,
      ...(prepared.body?.length
        ? {
            body: typeof prepared.body === "string" ? prepared.body : new Uint8Array(prepared.body),
          }
        : {}),
      signal: controller.signal,
      redirect: "error",
    });
    const transformResponse =
      prepared.plans.size > 0 &&
      response.status >= 200 &&
      response.status < 300 &&
      response.status !== 202 &&
      response.status !== 204;
    const writeHeaders = () => {
      if (res.destroyed) {
        return;
      }
      res.statusCode = response.status;
      for (const name of [
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "www-authenticate",
        "allow",
      ]) {
        const value = response.headers.get(name);
        if (value) {
          res.setHeader(name, value);
        }
      }
      res.setHeader("Cache-Control", "no-store");
      res.flushHeaders();
    };
    if (!transformResponse) {
      writeHeaders();
    }
    if (response.status >= 500 && finish) {
      failure = new Error("MCP upstream failed.");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        if (transformResponse) {
          bytes += chunk.byteLength;
          if (bytes > MAX_UPSTREAM_BYTES) {
            throw new Error("The browser automation response is too large.");
          }
          chunks.push(chunk);
          continue;
        }
        // Drain even if the caller disconnected: a disconnect cannot release the lease.
        if (!res.destroyed && !res.write(chunk)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
        }
      }
    }
    if (transformResponse) {
      const output = transformCodeModeResponse(
        Buffer.concat(chunks),
        response.headers.get("content-type"),
        prepared,
      );
      writeHeaders();
      if (!res.destroyed) {
        res.write(output);
      }
    } else if (prepared.executes && response.status >= 200 && response.status < 300) {
      // An execution request needs a known completion before another actor can use the browser.
      failure = new Error("The browser execution response is incomplete.");
    }
    if (!res.destroyed) {
      res.end();
    }
  } catch (cause) {
    failure = asError(cause);
    if (!res.destroyed) {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "The browser automation service is unavailable.",
          }),
        );
      }
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    finish?.(failure);
  }
}
