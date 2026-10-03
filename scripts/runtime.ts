import { Effect, Schema } from "effect";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { attempt, run, withFile } from "../src/effects.js";

const command = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const log = (message: string) => console.log(`[runtime] ${message}`);
const dimensions = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
});
const config = Schema.decodeUnknownSync(dimensions)({
  width: Number(process.env.SCREEN_WIDTH ?? 1280),
  height: Number(process.env.SCREEN_HEIGHT ?? 800),
});
const data = process.env.DATA_DIR ?? "/data";
const display = process.env.DISPLAY ?? ":99";

async function prepareIdentity(): Promise<void> {
  process.umask(0o077);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const info = await lstat(data);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("DATA_DIR must be a directory, not a symlink");
  if (process.geteuid?.() === 0) {
    const sockets = "/tmp/.X11-unix";
    await mkdir(sockets, { recursive: true, mode: 0o1777 });
    if (!(await lstat(sockets)).isDirectory())
      throw new Error("The X11 socket directory must not be a symlink");
    await chown(sockets, 0, 0);
    await chmod(sockets, 0o1777);
    if (![0, 1000].includes(info.uid))
      throw new Error("DATA_DIR must be owned by root or uid 1000");
    if (info.uid === 0) {
      await chmod(data, 0o700);
      await chown(data, 1000, 1000);
    }
    (
      process as NodeJS.Process & {
        initgroups(user: string, group: number): void;
      }
    ).initgroups("node", 1000);
    process.setgid!(1000);
    process.setuid!(1000);
  }
  if (process.geteuid?.() !== 1000)
    throw new Error("The runtime must run as uid 1000");
  Object.assign(process.env, {
    HOME: "/home/node",
    USER: "node",
    LOGNAME: "node",
  });
  await chmod(data, 0o700);
}

function prepareProfile(): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const profile = path.join(data, "profile");
    yield* attempt(() => mkdir(profile, { recursive: true, mode: 0o700 }));
    if ((yield* attempt(() => lstat(profile))).isSymbolicLink())
      return yield* Effect.fail(
        new Error("The browser profile must not be a symlink"),
      );
    for (const name of [
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
    ]) {
      const filename = path.join(profile, name);
      const stat = yield* attempt(() => lstat(filename)).pipe(
        Effect.catch((error) =>
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? Effect.succeed(null)
            : Effect.fail(error),
        ),
      );
      if (stat?.isSymbolicLink()) yield* attempt(() => unlink(filename));
    }
    const tokenPath = process.env.BROWSER_TOKEN_FILE ?? "/data/access-token";
    yield* withFile(
      tokenPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
      (file) =>
        Effect.gen(function* () {
          yield* attempt(() =>
            file.writeFile(`${randomBytes(48).toString("base64url")}\n`),
          );
          yield* attempt(() => file.sync());
          log(
            "Created the access token file; its value is never written to logs",
          );
        }),
    ).pipe(
      Effect.catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          return Effect.fail(error);
        return withFile(
          tokenPath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
          undefined,
          (file) =>
            Effect.gen(function* () {
              const info = yield* attempt(() => file.stat());
              const text = yield* attempt(() => file.readFile("utf8"));
              if (!info.isFile() || info.uid !== 1000 || !text.trim())
                return yield* Effect.fail(
                  new Error(
                    "The access token file must be a nonempty regular file owned by uid 1000",
                  ),
                );
              yield* attempt(() => file.chmod(0o600));
            }),
        );
      }),
    );
    const runtime = "/tmp/remote-browser";
    yield* attempt(() => mkdir(runtime, { recursive: true, mode: 0o700 }));
    yield* attempt(() => chmod(runtime, 0o700));
    const authority = path.join(runtime, "Xauthority");
    yield* withFile(
      authority,
      constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
      () => Effect.void,
    );
    Object.assign(process.env, {
      XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: path.join(data, "config"),
      XDG_CACHE_HOME: path.join(runtime, "cache"),
      XAUTHORITY: authority,
    });
    yield* attempt(() =>
      command("xauth", [
        "-f",
        authority,
        "add",
        display,
        ".",
        randomBytes(16).toString("hex"),
      ]),
    );
  });
}

const exitOf = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
};
async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exitOf(child).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function httpReady(url: string, allowed = [200]): Promise<boolean> {
  const response = await fetch(url, {
    headers: { Accept: "application/json, text/event-stream" },
    signal: AbortSignal.timeout(1000),
  });
  await response.body?.cancel();
  return allowed.includes(response.status);
}
async function tcpReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

class Supervisor {
  private readonly children = new Map<string, ChildProcess>();
  private stopping = false;
  private failure: Error | null = null;
  private readonly onStop = () => {
    this.stopping = true;
  };

  start(name: string, args: string[]): void {
    log(`Starting ${name}`);
    const child = spawn(args[0]!, args.slice(1), {
      detached: true,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      this.failure = error;
      log(`${name} could not start: ${error.message}`);
      this.stopping = true;
    });
    this.children.set(name, child);
  }

  check(): void {
    if (this.failure) throw this.failure;
    for (const [name, child] of this.children)
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `${name} exited with status ${child.exitCode ?? child.signalCode}`,
        );
  }

  ready(
    name: string,
    probe: () => Promise<boolean>,
    timeoutMs = 30_000,
  ): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      const deadline = performance.now() + timeoutMs;
      while (!self.stopping && performance.now() < deadline) {
        yield* attempt(() => self.check());
        if (
          yield* attempt(probe).pipe(Effect.catch(() => Effect.succeed(false)))
        ) {
          log(`${name} is ready`);
          return;
        }
        yield* Effect.sleep("200 millis");
      }
      if (!self.stopping)
        return yield* Effect.fail(
          new Error(
            `${name} did not become ready within ${timeoutMs / 1000} seconds`,
          ),
        );
      return yield* Effect.fail(
        self.failure ?? new Error("Shutdown requested"),
      );
    });
  }

  program(): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      process.on("SIGTERM", self.onStop);
      process.on("SIGINT", self.onStop);
      yield* prepareProfile();
      const { width, height } = config;
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 640 ||
        width > 3840 ||
        height < 480 ||
        height > 2160
      )
        return yield* Effect.fail(
          new Error("Screen dimensions must be between 640x480 and 3840x2160"),
        );
      const authority = process.env.XAUTHORITY!;
      self.start("Xvfb", [
        "Xvfb",
        display,
        "-screen",
        "0",
        `${width}x${height}x24`,
        "-nolisten",
        "tcp",
        "-auth",
        authority,
      ]);
      yield* self.ready("X display", async () => {
        await command("xdpyinfo", ["-display", display], { timeout: 2000 });
        return true;
      });
      self.start("window manager", [
        "openbox",
        "--sm-disable",
        "--config-file",
        "/app/docker/openbox.xml",
      ]);
      self.start("Chromium", [
        "chromium",
        `--user-data-dir=${path.join(data, "profile")}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--no-first-run",
        "--no-default-browser-check",
        `--window-size=${width},${height}`,
        "--window-position=0,0",
        "--start-maximized",
        "--restore-last-session",
        "about:blank",
      ]);
      yield* self.ready("Chromium CDP", () =>
        httpReady("http://127.0.0.1:9222/json/version"),
      );
      for (const [name, port, extra] of [
        [
          "view-only VNC",
          Number(process.env.VNC_VIEW_PORT ?? 5900),
          [
            "-viewonly",
            "-noprimary",
            "-nosetprimary",
            "-noclipboard",
            "-nosetclipboard",
          ],
        ],
        ["interactive VNC", Number(process.env.VNC_CONTROL_PORT ?? 5901), []],
      ] as const) {
        self.start(name, [
          "x11vnc",
          "-display",
          display,
          "-auth",
          authority,
          "-listen",
          "127.0.0.1",
          "-noipv6",
          "-rfbportv6",
          "-1",
          "-rfbport",
          String(port),
          "-forever",
          "-shared",
          "-nopw",
          "-noxdamage",
          "-xkb",
          "-repeat",
          "-quiet",
          ...extra,
        ]);
        yield* self.ready(name, () => tcpReady(port));
      }
      self.start("Playwright MCP", [
        "node",
        "/app/node_modules/@playwright/mcp/cli.js",
        "--host",
        "127.0.0.1",
        "--port",
        "8931",
        "--allowed-hosts",
        "127.0.0.1:8931,localhost:8931",
        "--cdp-endpoint",
        "http://127.0.0.1:9222",
        "--shared-browser-context",
        "--init-page",
        "/app/dist/src/playwright-code-mode.js",
      ]);
      yield* self.ready("Playwright MCP", () =>
        httpReady("http://127.0.0.1:8931/mcp", [200, 400, 405, 406]),
      );
      self.start("gateway", ["node", "/app/dist/src/server.js"]);
      yield* self.ready("gateway", () =>
        httpReady("http://127.0.0.1:8080/healthz"),
      );
      log(
        "Ready; browser, VNC, and MCP upstream ports remain inside the container",
      );
      while (!self.stopping) {
        yield* attempt(() => self.check());
        yield* Effect.sleep("250 millis");
      }
    }).pipe(
      Effect.catch((error) =>
        self.stopping && !self.failure && error.message === "Shutdown requested"
          ? Effect.void
          : Effect.fail(error),
      ),
      Effect.ensuring(attempt(() => self.shutdown()).pipe(Effect.orDie)),
    );
  }

  async shutdown(): Promise<void> {
    const gateway = this.children.get("gateway");
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      log("Finalizing active recordings");
      gateway.kill("SIGTERM");
      if (!(await waitForExit(gateway, 11_000)))
        signalGroup(gateway, "SIGKILL");
    }
    const chrome = this.children.get("Chromium");
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      log("Closing Chromium and flushing its persistent profile");
      try {
        const info = (await (
          await fetch("http://127.0.0.1:9222/json/version", {
            signal: AbortSignal.timeout(1500),
          })
        ).json()) as { webSocketDebuggerUrl: string };
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(info.webSocketDebuggerUrl);
          const timer = setTimeout(() => {
            socket.close();
            resolve();
          }, 2000);
          socket.addEventListener("open", () =>
            socket.send(JSON.stringify({ id: 1, method: "Browser.close" })),
          );
          socket.addEventListener("close", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("Chromium close failed"));
          });
        });
        if (!(await waitForExit(chrome, 8000))) signalGroup(chrome, "SIGTERM");
      } catch {
        signalGroup(chrome, "SIGTERM");
      }
    }
    for (const child of [...this.children.values()].reverse())
      signalGroup(child, "SIGTERM");
    const deadline = performance.now() + 5000;
    for (const child of this.children.values())
      if (
        !(await waitForExit(child, Math.max(1, deadline - performance.now())))
      )
        signalGroup(child, "SIGKILL");
    await Promise.all(
      [...this.children.values()].map((child) => waitForExit(child, 1000)),
    );
    process.off("SIGTERM", this.onStop);
    process.off("SIGINT", this.onStop);
  }
}

async function main(): Promise<void> {
  await prepareIdentity();
  if (process.argv.includes("--locked")) {
    await run(new Supervisor().program());
    return;
  }
  // flock keeps the kernel lock across exec and releases it even after a crash.
  await run(
    withFile(
      path.join(data, ".runtime.lock"),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
      (file) =>
        attempt(
          () =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(
                "flock",
                [
                  "--no-fork",
                  "--nonblock",
                  "-E",
                  "73",
                  "/proc/self/fd/3",
                  "node",
                  path.join(root, "dist/scripts/runtime.js"),
                  "--locked",
                ],
                { stdio: ["inherit", "inherit", "inherit", file.fd] },
              );
              const forward = (signal: NodeJS.Signals) => {
                child.kill(signal);
              };
              process.on("SIGTERM", forward);
              process.on("SIGINT", forward);
              child.once("error", reject);
              child.once("exit", (code) => {
                process.off("SIGTERM", forward);
                process.off("SIGINT", forward);
                if (code === 0) resolve();
                else
                  reject(
                    new Error(
                      code === 73
                        ? "The profile is already owned by another runtime"
                        : `Supervisor exited with status ${code}`,
                    ),
                  );
              });
            }),
        ),
    ),
  );
}
main().catch((error) => {
  log(
    `Startup or service failure: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
