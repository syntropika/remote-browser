import { Data, Effect } from "effect";
import { attempt, run } from "./effects.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const runCommand = promisify(execFile);
export const MAX_CLIPBOARD_BYTES = 64 * 1024;

export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  status: number;
  message: string;
}> {
  constructor(status: number, message: string) {
    super({ status, message });
  }
}

export function validateClipboardText(text: unknown) {
  if (typeof text !== "string" || text.includes("\0"))
    throw new ClipboardError(
      400,
      "Clipboard text must be text without null characters.",
    );
  if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES)
    throw new ClipboardError(413, "Clipboard text is limited to 64 KiB.");
  return text;
}

// Use the desktop clipboard directly: legacy VNC clipboard packets lose Unicode.
export class ClipboardService {
  readEffect(): Effect.Effect<string, ClipboardError> {
    return attempt(() =>
      runCommand(
        "xclip",
        ["-selection", "clipboard", "-out", "-target", "UTF8_STRING"],
        {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: MAX_CLIPBOARD_BYTES,
        },
      ),
    ).pipe(
      Effect.flatMap(({ stdout }) =>
        Effect.try({
          try: () => validateClipboardText(stdout),
          catch: (error) => error as ClipboardError,
        }),
      ),
      Effect.catch((error) => {
        if (error instanceof ClipboardError) return Effect.fail(error);
        const failure = error as Error & {
          code?: string | number;
          stderr?: string;
        };
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return Effect.fail(
            new ClipboardError(413, "Clipboard text is limited to 64 KiB."),
          );
        if (failure.code === 1 && /not available/.test(failure.stderr || ""))
          return Effect.succeed("");
        return Effect.fail(
          new ClipboardError(
            503,
            "Could not read the browser clipboard. Copy text in the browser and try again.",
          ),
        );
      }),
    );
  }
  read() {
    return run(this.readEffect());
  }

  writeEffect(text: string, options: { beforeMutation?: () => void } = {}) {
    return attempt(() => this.writeNative(text, options));
  }
  write(text: string, options: { beforeMutation?: () => void } = {}) {
    return run(Effect.uninterruptible(this.writeEffect(text, options)));
  }
  private async writeNative(text: string, { beforeMutation = () => {} } = {}) {
    validateClipboardText(text);
    beforeMutation();
    await new Promise<void>((resolve, reject) => {
      // xclip forks a selection owner. Do not leave captured pipes open in it.
      const child = spawn("xclip", ["-selection", "clipboard", "-in"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      let settled = false;
      const done = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(
          new ClipboardError(
            503,
            "Could not set the browser clipboard. Check the connection and try again.",
          ),
        );
      }, 2000);
      child.once("error", () =>
        done(new ClipboardError(503, "The browser clipboard is unavailable.")),
      );
      child.stdin.on("error", () =>
        done(new ClipboardError(503, "Could not set the browser clipboard.")),
      );
      child.once("exit", (code) =>
        done(
          code === 0
            ? null
            : new ClipboardError(503, "Could not set the browser clipboard."),
        ),
      );
      child.stdin.end(text, "utf8");
    });
  }
}
