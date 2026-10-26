/** Async native IPC/MCP fixtures; every wait and child shutdown has a deadline. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import filePath from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

import { PAGE, WELCOME } from "./fixtures/smoke.js";

export { default as assert } from "node:assert/strict";

const { join, resolve: resolvePath } = filePath;

// Native replies are deliberately heterogeneous; assertions validate each tested contract.
export type Wire = any;

export const sleep = (ms: number) => Bun.sleep(ms);

export const INIT = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "bun-smoke", version: "1" },
};

export async function deadline<T>(value: Promise<T>, ms = 35_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function wait<T>(
  operation: () => T | Promise<T>,
  predicate: (value: T) => boolean = Boolean,
  ms = 30_000,
): Promise<T> {
  const until = performance.now() + ms;
  let last: T | undefined;
  do {
    last = await operation();
    if (predicate(last)) {
      return last;
    }
    await sleep(50);
  } while (performance.now() < until);
  throw new Error(`Timed out waiting for state: ${JSON.stringify(last)}`);
}

export async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "remote-browser-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export class Rpc {
  readonly process: ChildProcessByStdio<Writable, Readable, Readable | null>;
  readonly logs: string[] = [];
  readonly pending = new Map<
    number,
    { resolve: (value: Wire) => void; reject: (cause: Error) => void }
  >();
  sequence = 0;
  constructor(command: string[], env = process.env, drainLogs = true, stderr?: number) {
    // Node's overloads do not narrow the first two pipes when the third entry is a file descriptor.
    const child = spawn(command[0], command.slice(1), {
      env,
      stdio: ["pipe", "pipe", stderr ?? "pipe"],
    });
    assert.ok(child.stdin && child.stdout, "native IPC requires stdin and stdout pipes");
    // SAFETY: spawn requested both IPC pipes and the assertion above verifies their presence.
    this.process = child as ChildProcessByStdio<Writable, Readable, Readable | null>;
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        pending?.resolve(message);
      } catch (cause) {
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`Invalid stdout: ${String(cause)}`));
        }
        this.pending.clear();
      }
    });
    const closed = (cause: Error) => {
      for (const pending of this.pending.values()) {
        pending.reject(cause);
      }
      this.pending.clear();
    };
    this.process.on("error", closed);
    this.process.on("exit", (code, signal) =>
      closed(new Error(`Child exited: ${code ?? signal}; ${this.logs.slice(-8).join("\n")}`)),
    );
    if (drainLogs) {
      this.drain();
    }
  }
  drain() {
    assert.ok(this.process.stderr, "stderr must be piped to capture logs");
    createInterface({ input: this.process.stderr }).on("line", (line) => this.logs.push(line));
  }
  send(value: Wire): Promise<Wire> {
    const id = ++this.sequence;
    const result = new Promise<Wire>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.process.stdin.write(`${JSON.stringify({ ...value, id })}\n`);
    return deadline(result).finally(() => this.pending.delete(id));
  }
  async exit(eof = true) {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      const exited = once(this.process, "exit");
      if (eof) {
        this.process.stdin.end();
      } else {
        this.process.kill("SIGTERM");
      }
      try {
        await deadline(exited, 15_000);
      } catch (cause) {
        this.process.kill("SIGKILL");
        await deadline(exited, 5000);
        throw cause;
      }
    }
    assert.equal(this.process.exitCode, 0, this.logs.slice(-20).join("\n"));
  }
}

export class Engine extends Rpc {
  constructor(binary: string, directory: string, files = `${directory}-files`) {
    // Synthetic fixtures opt into software graphics instead of depending on a desktop GPU.
    const args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
    super([binary, "--engine-profile", directory, "--files-root", files, ...args], {
      ...process.env,
      LIBGL_ALWAYS_SOFTWARE: "1",
      GALLIUM_DRIVER: "llvmpipe",
    });
  }
  async call(
    op: string,
    tab: string | null = null,
    args: Wire = {},
    options: { lease?: string; human?: boolean; error?: boolean } = {},
  ): Promise<Wire> {
    const reply = await this.send({
      op,
      tabId: tab,
      args,
      leaseId: options.lease ?? null,
      human: options.human ?? false,
    });
    assert.equal("error" in reply, options.error ?? false, JSON.stringify(reply));
    return reply.value ?? reply.error ?? null;
  }
  async stop(eof = false) {
    if (this.process.exitCode === null && this.process.signalCode === null && !eof) {
      await this.call("shutdown");
    }
    await this.exit();
  }
}

export class Mcp {
  constructor(readonly rpc: Rpc) {}
  async request(method: string, params: Wire): Promise<Wire> {
    const reply = await this.rpc.send({ jsonrpc: "2.0", method, params });
    assert.ok(!reply.error, JSON.stringify(reply));
    return reply.result;
  }
  async call(name: string, args: Wire, error = false): Promise<Wire> {
    const result = await this.request("tools/call", { name, arguments: args });
    assert.equal(Boolean(result.isError), error, JSON.stringify(result));
    return error ? result : (result.structuredContent ?? result);
  }
}

export class Browser {
  cookie = "";
  constructor(readonly origin: string) {}
  async api(
    path: string,
    body?: Wire,
    expected = 200,
    origin: boolean | string = true,
  ): Promise<Wire> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (origin) {
      headers.set("Origin", origin === true ? this.origin : origin);
    }
    if (this.cookie) {
      headers.set("Cookie", this.cookie);
    }
    const response = await fetch(this.origin + path, {
      headers,
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${path}: ${text.slice(0, 1000)}`);
    const cookie = response.headers.get("set-cookie");
    if (cookie) {
      this.cookie = cookie.split(";")[0];
    }
    return {
      data: text
        ? response.headers.get("content-type")?.includes("application/json")
          ? JSON.parse(text)
          : { message: text }
        : {},
      headers: response.headers,
    };
  }
  async action(
    op: string,
    tab: string | null = null,
    args: Wire = {},
    profile = "default",
    expected = 200,
  ): Promise<Wire> {
    return (await this.api("/api/action", { profileId: profile, op, tabId: tab, args }, expected))
      .data;
  }
  async change(id: string, action: string, expected = 200, extra: Wire = {}): Promise<Wire> {
    return (await this.api("/api/extensions/native", { id, action, ...extra }, expected)).data;
  }
}

export class Http {
  sequence = 0;
  constructor(
    readonly origin: string,
    readonly token: string,
  ) {}
  async request(
    method: string,
    params: Wire,
    expected = 200,
    options: { authorized?: boolean; origin?: string } = {},
  ): Promise<Wire> {
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    });
    if (options.authorized !== false) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    if (options.origin) {
      headers.set("Origin", options.origin);
    }
    const response = await fetch(`${this.origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.sequence, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    assert.equal(response.status, expected, text.slice(0, 1000));
    return expected === 200 ? JSON.parse(text) : null;
  }
  async call(name: string, args: Wire, error = false): Promise<Wire> {
    const { result } = await this.request("tools/call", { name, arguments: args });
    assert.equal(Boolean(result.isError), error, JSON.stringify(result));
    return result.structuredContent ?? result;
  }
}

export class Runtime extends Rpc {
  readonly client = new Mcp(this);
  dashboard!: Browser;
  get url() {
    return this.dashboard.origin;
  }
  async start() {
    const url = await wait(() =>
      this.logs.find((line) => line.startsWith("Remote Browser dashboard: ")),
    );
    assert.ok(url);
    this.dashboard = new Browser(url.slice("Remote Browser dashboard: ".length));
    await this.client.request("initialize", INIT);
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return this;
  }
  static async launch(
    host: string,
    engine: string,
    root: string,
    options: { stdio?: boolean; env?: NodeJS.ProcessEnv; args?: string[]; drain?: boolean } = {},
  ) {
    const runtime = new Runtime(
      [
        host,
        "--profile-root",
        root,
        "--engine-binary",
        engine,
        "--dashboard-port",
        "0",
        ...(options.stdio === false ? [] : ["--mcp-stdio"]),
        ...(options.args ?? []),
      ],
      options.env ?? process.env,
      options.drain ?? true,
    );
    try {
      if (options.stdio === false) {
        const url = await wait(() =>
          runtime.logs.find((line) => line.startsWith("Remote Browser dashboard: ")),
        );
        assert.ok(url);
        runtime.dashboard = new Browser(url.slice("Remote Browser dashboard: ".length));
      } else {
        await runtime.start();
      }
      return runtime;
    } catch (cause) {
      runtime.process.kill("SIGKILL");
      await once(runtime.process, "exit");
      throw cause;
    }
  }
  async stop() {
    await this.exit(false);
  }
}

export function reference(snapshot: Wire, name: string): string {
  const matches = snapshot.elements.filter((element: Wire) => element.name === name);
  assert.equal(matches.length, 1, JSON.stringify(snapshot));
  return matches[0].reference;
}

export function serve(
  handler?: (request: Request, origin: string) => Response | Promise<Response>,
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request): Promise<Response> {
      if (handler) {
        return handler(request, server.url.origin);
      }
      const path = new URL(request.url).pathname;
      if (path === "/slow") {
        await sleep(2000);
      }
      return new Response(path === "/welcome" || path === "/short" ? WELCOME : PAGE, {
        headers: {
          "Content-Type": "text/html",
          ...(path === "/short"
            ? { "Set-Cookie": "auth_marker=synthetic; HttpOnly; Max-Age=60; Path=/" }
            : {}),
        },
      });
    },
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}

export async function closeEngine(engine: Engine): Promise<void> {
  try {
    await engine.stop();
  } catch (cause) {
    engine.process.kill("SIGKILL");
    console.error(engine.logs.slice(-8).join("\n"));
    throw cause;
  }
}
export async function withEngine(
  binary: string,
  run: (engine: Engine, root: string) => Promise<void>,
) {
  await temporary(async (root) => {
    const engine = new Engine(binary, join(root, "profile"));
    try {
      await run(engine, root);
    } finally {
      await closeEngine(engine);
    }
  });
}
export function cli(
  run: (engine: string, host: string, args: Record<string, Wire>) => Promise<void>,
) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "engine-binary": { type: "string" },
      "host-binary": { type: "string" },
      "protocol-only": { type: "boolean" },
      "verify-expiry": { type: "boolean" },
      chrome: { type: "string" },
    },
  });
  const engine = values["engine-binary"] || process.env.REMOTE_BROWSER_ENGINE_BINARY;
  const host = values["host-binary"] || process.env.REMOTE_BROWSER_HOST_BINARY;
  if (!engine) {
    throw new Error("Pass --engine-binary or REMOTE_BROWSER_ENGINE_BINARY");
  }
  return run(resolvePath(engine), host ? resolvePath(host) : "", values);
}

export async function privateFile(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
}

/** Explicit fixture reservation; callers keep and pass the returned lease. */
export async function reservePage(client: Pick<Http, "call">, tabId?: string, profileId?: string) {
  return client.call("browser_tabs", {
    action: "reserve",
    tabId,
    profileId,
    agentName: "Integration agent",
    task: "fixture operations",
  });
}
