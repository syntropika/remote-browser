import { types } from "node:util";

import { Effect } from "effect";
import type { BrowserContext, Page } from "playwright";

import { createArtifactClient } from "./artifacts-client.js";
import { createBrowserAgent } from "./browser-agent.js";
import { attempt, run as runEffect } from "./effects.js";
import { isRecord, parseJson } from "./invariants.js";
import type { TabCredentials } from "./tab-reservations.js";

const artifacts = createArtifactClient();
type BrowserBindings = {
  page: Page;
  context: BrowserContext;
  browser: ReturnType<typeof createBrowserAgent>;
  image: (bytes: Uint8Array, mimeType?: string) => void;
  files: typeof artifacts.files;
  recording: typeof artifacts.recording;
};

const MAX_VALUE_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 2;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function truncate(value: string, bytes: number) {
  const encoded = Buffer.from(value);
  if (encoded.length <= bytes) {
    return value;
  }
  return encoded
    .subarray(0, bytes)
    .toString("utf-8")
    .replace(/\uFFFD$/u, "");
}

function errorDetails(error: unknown) {
  const details = isRecord(error) ? error : null;
  let name = "Error";
  let message = "The browser code failed.";
  try {
    if (typeof details?.name === "string") {
      ({ name } = details);
    }
    message = typeof details?.message === "string" ? details.message : String(error);
  } catch {
    // A thrown object may have accessors that also throw.
  }
  return { name: truncate(name, 128), message: truncate(message, 4096) };
}

function serializeValue(value: unknown) {
  if (value === undefined) {
    return null;
  }
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Return a JSON-serializable value.");
  }
  if (Buffer.byteLength(json) > MAX_VALUE_BYTES) {
    throw new RangeError("The returned value exceeds 32 KiB. Return a smaller result.");
  }
  return parseJson(json);
}

function detectImage(buffer: Buffer) {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  throw new TypeError("image() accepts PNG or JPEG bytes.");
}

async function visiblePage(fallback: Page) {
  const context = fallback.context();
  if (!context.pages || !context.newCDPSession) {
    return fallback;
  }
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
      const visibility: unknown = result.value;
      if (isRecord(visibility) && visibility.visible === true) {
        visible ||= candidate;
        if (visibility.focused === true) {
          return candidate;
        }
      }
    } catch {
      // A tab can close or navigate while its visibility is being read.
    } finally {
      await session?.detach().catch((): void => undefined);
    }
  }
  return visible || fallback;
}

async function run(
  page: Page,
  callback: (bindings: BrowserBindings) => unknown,
  options: TabCredentials & { tabId?: string; manageTabs?: boolean } = {},
) {
  const startedAt = performance.now();
  const images: { mimeType: string; data: string }[] = [];
  let imageBytes = 0;
  let completed = false;

  function image(bytes: Uint8Array, mimeType?: string) {
    if (completed) {
      throw new Error(
        "The browser code has already completed. Await browser operations before returning.",
      );
    }
    if (!types.isUint8Array(bytes)) {
      throw new TypeError("image() requires a Buffer or Uint8Array.");
    }
    if (images.length >= MAX_IMAGES) {
      throw new RangeError("A browser call can return at most 2 images.");
    }
    if (imageBytes + bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new RangeError("Images in one browser call cannot exceed 6 MiB in total.");
    }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const detectedType = detectImage(buffer);
    if (mimeType !== undefined && mimeType !== detectedType) {
      throw new TypeError("The image MIME type must match its PNG or JPEG bytes.");
    }
    images.push({ mimeType: detectedType, data: buffer.toString("base64") });
    imageBytes += buffer.length;
  }

  const outcome = await runEffect(
    Effect.gen(function* outcome() {
      if (typeof callback !== "function") {
        return yield* Effect.fail(new TypeError("Browser code must be a function."));
      }
      const fallback =
        options.tabId || options.manageTabs ? page : yield* attempt(async () => visiblePage(page));
      const target = options.manageTabs
        ? fallback
        : yield* attempt(async () =>
            createBrowserAgent(fallback, fallback.context(), options).tabs.get(options.tabId, {
              requireLease: Boolean(options.leaseId),
            }),
          );
      if (!options.tabId && !options.manageTabs) {
        yield* attempt(async () => target.bringToFront());
      }
      const context = target.context();
      const result = yield* Effect.tryPromise({
        catch: (error: unknown) => error,
        try: async () =>
          await callback({
            page: target,
            context,
            image,
            browser: createBrowserAgent(target, context, options),
            files: artifacts.files,
            recording: artifacts.recording,
          }),
      });
      const value = yield* attempt(() => serializeValue(result));
      return {
        value,
      };
    }).pipe(
      Effect.catch((cause) => Effect.succeed({ value: null, error: errorDetails(cause) })),
      Effect.ensuring(
        Effect.sync(() => {
          completed = true;
        }),
      ),
    ),
  );
  const { value } = outcome;
  const error = "error" in outcome ? outcome.error : undefined;

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
// oxlint-disable-next-line typescript/require-await -- The MCP initializer exposes an asynchronous hook contract.
export default async function initializeCodeMode({ page }: { page: Page }) {
  if (Object.getOwnPropertyDescriptor(page, "__remoteBrowserCodeMode")?.value === helper) {
    return;
  }
  Object.defineProperty(page, "__remoteBrowserCodeMode", {
    value: helper,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}
