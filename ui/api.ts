/** The dashboard's HTTP client. The dashboard asks for no credential: it is served from the
 *  browser's own address and its requests are same-origin. */
import { isRecord, parseJson } from "./invariants.js";

export type Failure = { statusCode?: number } & Error;

export function failure(cause: unknown): Failure {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** A page instance is a viewer, independently of API clients and agent leases. */
export const displayId = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
  part.toString(16).padStart(8, "0"),
).join("");

let onUnauthorized: () => void = () => undefined;

export function whenUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

async function send(path: string, body?: unknown, keepalive = false): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    keepalive,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = parseJson(await response.text());
  if (!response.ok) {
    if (response.status === 401) {
      onUnauthorized();
    }
    const error: Failure = new Error(
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : `Request failed (${response.status}).`,
    );
    error.statusCode = response.status;
    throw error;
  }
  return value;
}

/** One dashboard request. A caller validates what comes back; see model.ts. */
export function api(url: string, body?: unknown): Promise<unknown> {
  return send(url, body);
}

/** One operation on one tab of one profile. */
export async function action(
  op: string,
  args: Record<string, unknown> = {},
  tabId: string | null = null,
  profileId = "",
): Promise<unknown> {
  const reply = await send(
    "/api/action",
    {
      profileId,
      op,
      tabId: tabId || null,
      args: { ...args, displayId },
    },
    op === "display" && args.leave === true,
  );
  if (op === "take" || op === "return") {
    window.dispatchEvent(new Event("remote-browser-control"));
  }
  return reply;
}
