/** A disposable Chrome pipe client and ordinary dashboard pointer interactions. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import filePath from "node:path";
import { Readable, Writable } from "node:stream";

import { assert, deadline, wait, sleep } from "../tests/harness.js";
import type { Wire } from "../tests/harness.js";

const { join } = filePath;

export type Point = readonly [number, number];
export type DisplayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  surfaceWidth: number;
  surfaceHeight: number;
};

export class Browser {
  session: string | undefined;
  private sequence = 0;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: Wire) => void; reject: (cause: Error) => void }
  >();
  private constructor(
    readonly process: ReturnType<typeof spawn>,
    readonly profile: string,
    readonly commands: Writable,
    replies: Readable,
  ) {
    replies.setEncoding("utf-8");
    replies.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\0")) >= 0) {
        const raw = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        try {
          const reply = JSON.parse(raw);
          const pending = this.pending.get(reply.id);
          this.pending.delete(reply.id);
          if (reply.error) {
            pending?.reject(new Error(JSON.stringify(reply.error)));
          } else {
            pending?.resolve(reply.result);
          }
        } catch (cause) {
          for (const p of this.pending.values()) {
            p.reject(new Error(String(cause)));
          }
          this.pending.clear();
        }
      }
    });
    const fail = (cause: Error) => {
      for (const p of this.pending.values()) {
        p.reject(cause);
      }
      this.pending.clear();
    };
    process.on("error", fail);
    process.on("exit", () => fail(new Error("Chrome pipe closed")));
  }
  static async launch(executable: string, width = 1280, height = 900, headless = true) {
    const profile = await mkdtemp(join(tmpdir(), "dashboard-browser-"));
    const child = spawn(
      executable,
      [
        ...(headless ? ["--headless=new"] : []),
        "--remote-debugging-pipe",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        `--window-size=${width},${height}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    const commands = child.stdio[3];
    const replies = child.stdio[4];
    assert(commands instanceof Writable && replies instanceof Readable);
    return new Browser(child, profile, commands, replies);
  }
  call(method: string, params: Wire = {}, ms = 30_000): Promise<Wire> {
    const id = ++this.sequence;
    const promise = new Promise<Wire>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.commands.write(
      `${JSON.stringify({
        id,
        method,
        params,
        ...(this.session ? { sessionId: this.session } : {}),
      })}\0`,
    );
    return deadline(promise, ms).finally(() => this.pending.delete(id));
  }
  async open(url: string) {
    const target = await this.call("Target.createTarget", { url: "about:blank" });
    this.session = (
      await this.call("Target.attachToTarget", { targetId: target.targetId, flatten: true })
    ).sessionId;
    await this.call("Page.navigate", { url });
  }
  async evaluate(expression: string): Promise<Wire> {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }
  async mouse(kind: string, x: number, y: number, buttons = 0) {
    await this.call("Input.dispatchMouseEvent", {
      type: kind,
      x,
      y,
      buttons,
      button: kind === "mouseMoved" ? "none" : "left",
      ...(kind === "mouseMoved" ? {} : { clickCount: 1 }),
    });
  }
  async close() {
    this.session = undefined;
    try {
      await this.call("Browser.close", {}, 5000);
    } catch {
      /* The pipe may close before its reply. */
    }
    if (this.process.exitCode === null && this.process.signalCode === null) {
      try {
        await deadline(once(this.process, "exit"), 10_000);
      } catch {
        this.process.kill("SIGKILL");
        await deadline(once(this.process, "exit"), 5000);
      }
    }
    await rm(this.profile, { recursive: true, force: true });
  }
}

export async function waitForDisplay(browser: Browser): Promise<DisplayRect> {
  return wait<DisplayRect>(
    () =>
      browser.evaluate(`(() => {
      const display = document.querySelector('section[aria-label="Browser display"]');
      const canvas = display?.querySelector('canvas[aria-label="Browser page"]');
      if (!canvas || display.getAttribute('aria-busy') !== 'false' || document.querySelector('[aria-label="Page address"]')?.disabled) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const available = display.getBoundingClientRect();
      const width = Math.max(320, Math.min(3840, Math.round(available.width)));
      const height = Math.max(240, Math.min(2160, Math.round(available.height)));
      if (Math.abs(rect.width - width) > 2 || Math.abs(rect.height - height) > 2) return null;
      return {left:rect.left, top:rect.top, width:rect.width, height:rect.height,
        surfaceWidth:width, surfaceHeight:height};
    })()`),
    Boolean,
    40_000,
  );
}

export function mapper(rect: DisplayRect) {
  return (x: number, y: number): Point => [
    rect.left + (x * rect.width) / rect.surfaceWidth,
    rect.top + (y * rect.height) / rect.surfaceHeight,
  ];
}

export async function travel(
  browser: Browser,
  toScreen: (x: number, y: number) => Point,
  start: Point,
  end: Point,
  seconds = 0.8,
  jitter = 1.4,
  rng = Math.random,
) {
  const steps = Math.max(8, Math.trunc(seconds / 0.018));
  const points: Point[] = [];
  for (let step = 1; step <= steps; step++) {
    const progress = step / steps;
    const eased = 3 * progress ** 2 - 2 * progress ** 3;
    const wobble = Math.sin(progress * Math.PI) * jitter;
    const x = start[0] + (end[0] - start[0]) * eased + (rng() * 2 - 1) * wobble;
    const y = start[1] + (end[1] - start[1]) * eased + (rng() * 2 - 1) * wobble;
    points.push([x, y]);
    await browser.mouse("mouseMoved", ...toScreen(x, y));
    await sleep(12 + rng() * 14);
  }
  return points;
}

export async function press(
  browser: Browser,
  toScreen: (x: number, y: number) => Point,
  point: Point,
  hold = 0.07 + Math.random() * 0.06,
  rng = Math.random,
) {
  await browser.mouse("mousePressed", ...toScreen(...point), 1);
  await sleep(hold * 1000);
  const release: Point = [point[0] + rng() * 1.6 - 0.8, point[1] + rng() * 1.6 - 0.8];
  await browser.mouse("mouseReleased", ...toScreen(...release));
  return { holdSeconds: hold, point, release };
}

export async function interact(
  browser: Browser,
  rect: DisplayRect,
  target: Point,
  seed = 1,
  approach: Point = [380, 210],
) {
  let state = seed >>> 0;
  const rng = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const random = (a: number, b: number) => a + rng() * (b - a);
  const toScreen = mapper(rect);
  await browser.mouse("mouseMoved", ...toScreen(...approach));
  await sleep(250);
  const mid: Point = [
    (approach[0] + target[0]) / 2 + random(-40, 40),
    (approach[1] + target[1]) / 2 + random(-30, 30),
  ];
  await travel(browser, toScreen, approach, mid, 0.45, 2.2, rng);
  await travel(
    browser,
    toScreen,
    mid,
    [target[0] + random(-2, 2), target[1] + random(-2, 2)],
    0.55,
    1.1,
    rng,
  );
  const hover = random(0.35, 0.7);
  await sleep(hover * 1000);
  await travel(browser, toScreen, [target[0] + 2, target[1] + 2], target, 0.2, 0.4, rng);
  await sleep(random(80, 200));
  const record = await press(browser, toScreen, target, random(0.07, 0.13), rng);
  await sleep(random(300, 600));
  await travel(
    browser,
    toScreen,
    target,
    [target[0] + random(60, 160), target[1] + random(40, 120)],
    0.5,
    1.5,
    rng,
  );
  return { approach, target, hoverSeconds: hover, press: record };
}
