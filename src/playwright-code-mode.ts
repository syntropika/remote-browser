import { Effect } from "effect";
import { attempt, run as runEffect } from "./effects.js";
import type { Page, BrowserContext } from "playwright";
import { types } from "node:util";
import { createArtifactClient } from "./artifacts-client.js";
import { createBrowserAgent } from "./browser-agent.js";

const artifacts = createArtifactClient();
interface BrowserBindings {
  page: Page;
  context: BrowserContext;
  browser: ReturnType<typeof createBrowserAgent>;
  image: (bytes: Uint8Array, mimeType?: string) => void;
  files: typeof artifacts.files;
  recording: typeof artifacts.recording;
}

const MAX_VALUE_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 2;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function truncate(value: string, bytes: number) {
  const encoded = Buffer.from(value);
  if (encoded.length <= bytes) return value;
  return encoded
    .subarray(0, bytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function errorDetails(error: unknown) {
  const details = error as { name?: unknown; message?: unknown } | null;
  let name = "Error";
  let message = "The browser code failed.";
  try {
    if (typeof details?.name === "string") name = details!.name as string;
    message =
      typeof details?.message === "string"
        ? (details!.message as string)
        : String(error);
  } catch {
    // A thrown object may have accessors that also throw.
  }
  return { name: truncate(name, 128), message: truncate(message, 4096) };
}

function serializeValue(value: unknown) {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new TypeError("Return a JSON-serializable value.");
  if (Buffer.byteLength(json) > MAX_VALUE_BYTES) {
    throw new RangeError(
      "The returned value exceeds 32 KiB. Return a smaller result.",
    );
  }
  return JSON.parse(json);
}

function detectImage(buffer: Buffer) {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    return "image/png";
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  throw new TypeError("image() accepts PNG or JPEG bytes.");
}

async function visiblePage(fallback: Page) {
  const context = fallback.context();
  if (!context.pages || !context.newCDPSession) return fallback;
  let visible;
  // Match the visible tab after a human or a previous code call switched tabs.
  for (const candidate of context.pages()) {
    let session;
    try {
      session = await context.newCDPSession(candidate);
      const { result } = await session.send("Runtime.evaluate", {
        expression:
          '({ visible: document.visibilityState === "visible", focused: document.hasFocus() })',
        returnByValue: true,
        throwOnSideEffect: true,
        timeout: 500,
      });
      if (result?.value?.visible) {
        visible ||= candidate;
        if (result.value.focused) return candidate;
      }
    } catch {
      // A tab can close or navigate while its visibility is being read.
    } finally {
      await session?.detach().catch(() => {});
    }
  }
  return visible || fallback;
}

async function run(
  page: Page,
  callback: (bindings: BrowserBindings) => PromiseLike<unknown> | unknown,
) {
  const startedAt = performance.now();
  const images: { mimeType: string; data: string }[] = [];
  let imageBytes = 0;
  let completed = false;

  function image(bytes: Uint8Array, mimeType?: string) {
    if (completed)
      throw new Error(
        "The browser code has already completed. Await browser operations before returning.",
      );
    if (!types.isUint8Array(bytes))
      throw new TypeError("image() requires a Buffer or Uint8Array.");
    if (images.length >= MAX_IMAGES)
      throw new RangeError("A browser call can return at most 2 images.");
    if (imageBytes + bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new RangeError(
        "Images in one browser call cannot exceed 6 MiB in total.",
      );
    }
    const buffer = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const detectedType = detectImage(buffer);
    if (mimeType !== undefined && mimeType !== detectedType) {
      throw new TypeError(
        "The image MIME type must match its PNG or JPEG bytes.",
      );
    }
    images.push({ mimeType: detectedType, data: buffer.toString("base64") });
    imageBytes += buffer.length;
  }

  const outcome = await runEffect(
    Effect.gen(function* () {
      if (typeof callback !== "function")
        return yield* Effect.fail(
          new TypeError("Browser code must be a function."),
        );
      page = yield* attempt(() => visiblePage(page));
      yield* attempt(() => page.bringToFront());
      const context = page.context();
      const result = yield* Effect.tryPromise({
        catch: (error: unknown) => error,
        try: async () =>
          callback({
            page,
            context,
            image,
            browser: createBrowserAgent(page, context),
            files: artifacts.files,
            recording: artifacts.recording,
          }),
      });
      const value = yield* attempt(() => serializeValue(result));
      return {
        value,
        error: undefined as { name: string; message: string } | undefined,
      };
    }).pipe(
      Effect.catch((caught) =>
        Effect.succeed({ value: null, error: errorDetails(caught) }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          completed = true;
        }),
      ),
    ),
  );
  const { value, error } = outcome;

  return {
    __remoteBrowserCodeMode: 1,
    ok: !error,
    value,
    images,
    durationMs: Math.round(performance.now() - startedAt),
    ...(error ? { error } : {}),
  };
}

const helper = Object.freeze({ run });

// This runs on the Playwright Page object, outside the visited document.
export default async function initializeCodeMode({ page }: { page: Page }) {
  if (
    Object.getOwnPropertyDescriptor(page, "__remoteBrowserCodeMode")?.value ===
    helper
  )
    return;
  Object.defineProperty(page, "__remoteBrowserCodeMode", {
    value: helper,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}
