import { asyncHandler } from "../src/async-boundary.js";
import { isRecord, required } from "../src/invariants.js";
import { uiFailure } from "./api.js";

type Options = {
  action: (
    op: string,
    args: Record<string, unknown>,
    tab: string | null,
    profile: string,
  ) => Promise<unknown>;
  profile: () => string;
  tab: () => string;
  profiles: () => string[];
  token: () => string;
  connected: () => boolean;
  notice: (message: string) => void;
  history: (op: string) => Promise<void>;
  openFiles: (profile?: string) => Promise<void>;
};
function element(id: string) {
  return required(document.getElementById(id));
}
function dialog(id: string) {
  const node = element(id);
  if (!(node instanceof HTMLDialogElement)) {
    throw new Error("Missing dialog");
  }
  return node;
}
function textInput(id: string) {
  const node = element(id);
  if (!(node instanceof HTMLTextAreaElement)) {
    throw new Error("Missing text input");
  }
  return node;
}
function value(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("Invalid browser response");
  }
  return input;
}
function video() {
  const node = element("media-video");
  if (!(node instanceof HTMLVideoElement)) {
    throw new Error("Missing video");
  }
  return node;
}
function image() {
  const node = element("media-image");
  if (!(node instanceof HTMLImageElement)) {
    throw new Error("Missing image");
  }
  return node;
}
function errorMessage(cause: unknown) {
  return uiFailure(cause).message;
}
function string(input: unknown) {
  return typeof input === "string" ? input : "";
}
export function createServoFeatures(ctx: Options) {
  let handoff: { id: string; tab: string; profile: string } | null = null;
  let polling = false;
  let recording = false;
  let mediaUrl: string | null = null;
  let mediaEpoch = 0;
  let thumbnailEpoch = 0;
  const thumbnailUrls = new Set<string>();
  let recordedProfile = "";
  function clearThumbnails() {
    thumbnailEpoch++;
    for (const url of thumbnailUrls) {
      URL.revokeObjectURL(url);
    }
    thumbnailUrls.clear();
  }
  const thumbnail = asyncHandler(
    async (
      target: HTMLImageElement | HTMLVideoElement,
      profile: string,
      file: string,
      mime: string,
    ) => {
      const epoch = thumbnailEpoch;
      const url = new URL("/api/files/content", location.href);
      url.search = new URLSearchParams({
        profileId: profile,
        fileId: file,
        preview: "true",
      }).toString();
      const headers: Record<string, string> = ctx.token()
        ? { Authorization: `Bearer ${ctx.token()}` }
        : {};
      if (mime.startsWith("video/")) {
        headers.Range = "bytes=0-524287";
      }
      const response = await fetch(url, { headers, cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const blob = await response.blob();
      if (epoch !== thumbnailEpoch || !target.isConnected) {
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      thumbnailUrls.add(objectUrl);
      target.src = objectUrl;
    },
  );
  const request = async (
    op: string,
    args: Record<string, unknown> = {},
    tab = ctx.tab(),
    profile = ctx.profile(),
  ) => value(await ctx.action(op, args, tab, profile));
  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (cause) {
      ctx.notice(errorMessage(cause));
    }
  };
  for (const op of ["back", "forward", "reload"]) {
    element(op).addEventListener(
      "click",
      asyncHandler(() => run(() => ctx.history(op))),
    );
  }
  function closeMedia() {
    mediaEpoch++;
    video().pause();
    video().removeAttribute("src");
    image().removeAttribute("src");
    if (mediaUrl) {
      URL.revokeObjectURL(mediaUrl);
      mediaUrl = null;
    }
    dialog("media-preview").close();
  }
  async function preview(profile: string, file: string, mime: string) {
    closeMedia();
    const epoch = mediaEpoch;
    const url = new URL("/api/files/content", location.href);
    url.search = new URLSearchParams({
      profileId: profile,
      fileId: file,
      preview: "true",
    }).toString();
    const response = await fetch(url, {
      headers: ctx.token() ? { Authorization: `Bearer ${ctx.token()}` } : {},
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error("File preview unavailable. Sign in or refresh the file list.");
    }
    const blob = await response.blob();
    if (epoch !== mediaEpoch) {
      return;
    }
    mediaUrl = URL.createObjectURL(blob);
    element("media-title").textContent = file.split("/").pop() || "Saved media";
    video().hidden = !mime.startsWith("video/");
    image().hidden = !mime.startsWith("image/");
    if (mime.startsWith("video/")) {
      video().src = mediaUrl;
    } else {
      image().src = mediaUrl;
    }
    dialog("media-preview").showModal();
  }
  element("media-close").addEventListener("click", closeMedia);
  dialog("media-preview").addEventListener("cancel", closeMedia);
  element("clipboard-open").addEventListener(
    "click",
    asyncHandler(() =>
      run(async () => {
        element("more-menu").removeAttribute("open");
        element("clipboard-dialog").hidden = false;
        textInput("clipboard-text").focus({ preventScroll: true });
        textInput("clipboard-text").value = string((await request("clipboard_read")).text);
      }),
    ),
  );
  function closeClipboard(restoreFocus = true) {
    const opened = !element("clipboard-dialog").hidden;
    element("clipboard-dialog").hidden = true;
    if (opened && restoreFocus) {
      const trigger = element("more-menu").querySelector("summary");
      if (trigger instanceof HTMLElement) {
        trigger.focus({ preventScroll: true });
      }
    }
  }
  element("clipboard-close").addEventListener("click", () => {
    closeClipboard();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !element("clipboard-dialog").hidden) {
      event.preventDefault();
      closeClipboard();
    }
  });
  element("clipboard-read").addEventListener(
    "click",
    asyncHandler(() =>
      run(async () => {
        await request("clipboard_copy");
        textInput("clipboard-text").value = string((await request("clipboard_read")).text);
      }),
    ),
  );
  element("clipboard-send").addEventListener(
    "click",
    asyncHandler(() =>
      run(async () => {
        await request("clipboard_write", { text: textInput("clipboard-text").value });
        await request("clipboard_paste");
        element("clipboard-status").textContent = "Pasted into the browser.";
      }),
    ),
  );
  function copyToDevice() {
    const source = textInput("clipboard-text");
    const input = element("clipboard-dialog").hidden ? document.createElement("textarea") : source;
    const previous = document.activeElement;
    if (input !== source) {
      input.value = source.value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      input.style.pointerEvents = "none";
      input.setAttribute("aria-hidden", "true");
      document.body.append(input);
    }
    input.focus();
    input.select();
    let copied = false;
    try {
      // oxlint-disable-next-line typescript/no-deprecated -- LAN HTTP needs the synchronous clipboard fallback.
      copied = document.execCommand("copy");
    } catch {
      /* Keep text selected for native manual copy. */
    }
    if (input !== source) {
      input.remove();
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    }
    element("clipboard-status").textContent = copied
      ? "Copied to your device."
      : "Text selected. Use your device's Copy action.";
  }
  element("clipboard-device-copy").addEventListener("click", copyToDevice);
  element("capture-save").addEventListener(
    "click",
    asyncHandler(() =>
      run(async () => {
        const result = await request("save_screenshot", {
          name: `Page capture-${Date.now()}.png`,
        });
        ctx.notice(`Screenshot saved in Files: ${string(result.id)}`);
      }),
    ),
  );
  async function recordingStatus() {
    let any = "";
    for (const profile of new Set([ctx.profile(), ...ctx.profiles()])) {
      let status: Record<string, unknown>;
      try {
        status = await request("record_status", {}, "", profile);
      } catch {
        continue;
      }
      if (status.active === true && !any) {
        any = profile;
      }
      if (profile === ctx.profile()) {
        recording = status.active === true;
        element("files-recording-stop").hidden = !recording;
        element("recording-label").textContent = recording ? "Stop recording" : "Record browser";
        element("recording-status").textContent = recording
          ? "Recording the visible tab in this profile"
          : "";
        element("recording-status").hidden = !recording;
      }
    }
    recordedProfile = any;
    element("recording-indicator").hidden = !any;
  }
  element("recording-indicator").addEventListener(
    "click",
    asyncHandler(() => ctx.openFiles(recordedProfile)),
  );
  element("recording-toggle").addEventListener(
    "click",
    asyncHandler(() =>
      run(async () => {
        if (recording) {
          await request("record_stop");
          ctx.notice("Recording saved in Files.");
        } else {
          await request("record_start", {
            name: `Browser recording-${Date.now()}.mp4`,
            maxSeconds: 300,
          });
        }
        await recordingStatus();
      }),
    ),
  );
  element("files-recording-stop").addEventListener(
    "click",
    asyncHandler(() =>
      run(async () => {
        await request("record_stop");
        await recordingStatus();
        ctx.notice("Recording saved. Refresh Files to preview it.");
      }),
    ),
  );
  async function cancelHandoff() {
    const current = handoff;
    if (!current) {
      return;
    }
    try {
      await request("handoff_cancel", { id: current.id }, current.tab, current.profile);
      dialog("agent-handoff").close();
      handoff = null;
    } catch (cause) {
      element("agent-handoff-error").textContent = errorMessage(cause);
      element("agent-handoff-error").hidden = false;
    }
  }
  element("agent-handoff-cancel").addEventListener("click", asyncHandler(cancelHandoff));
  dialog("agent-handoff").addEventListener("cancel", (event) => {
    event.preventDefault();
    asyncHandler(cancelHandoff)();
  });
  async function poll() {
    if (polling || !ctx.connected()) {
      return;
    }
    polling = true;
    try {
      let found = false;
      const handoffId = handoff?.id;
      for (const profile of new Set([ctx.profile(), ...ctx.profiles()])) {
        const state = await request("handoff_status", {}, "", profile);
        if (!Array.isArray(state.requests)) {
          continue;
        }
        const item: unknown = state.requests.find(
          (candidate: unknown) =>
            isRecord(candidate) &&
            typeof candidate.id === "string" &&
            typeof candidate.tabId === "string" &&
            (!handoffId || handoffId === candidate.id),
        );
        if (isRecord(item) && typeof item.id === "string" && typeof item.tabId === "string") {
          if (handoff && handoff.id !== item.id) {
            continue;
          }
          handoff = { id: item.id, tab: item.tabId, profile };
          found = true;
          await request("handoff_ack", { id: item.id }, item.tabId, profile);
          if (!dialog("agent-handoff").open) {
            element("agent-handoff-error").hidden = true;
            dialog("agent-handoff").showModal();
          }
          const seconds =
            typeof item.deadline === "number"
              ? Math.max(0, Math.ceil((item.deadline - Date.now()) / 1000))
              : 5;
          element("agent-handoff-countdown").textContent =
            `Returning control in ${seconds} seconds`;
          break;
        }
        if (found) {
          break;
        }
      }
      if (!found && handoff) {
        handoff = null;
        dialog("agent-handoff").close();
      }
    } catch (cause) {
      if (handoff) {
        element("agent-handoff-error").textContent = errorMessage(cause);
        element("agent-handoff-error").hidden = false;
      }
    } finally {
      polling = false;
    }
  }
  setInterval(asyncHandler(poll), 500);
  setInterval(
    asyncHandler(async () => {
      if (ctx.connected()) {
        try {
          await recordingStatus();
        } catch {
          /* Preserve interactive controls during transient refresh errors. */
        }
      }
    }),
    2000,
  );
  return {
    preview,
    thumbnail,
    clearThumbnails,
    closeClipboard: () => {
      closeClipboard(false);
    },
    reset: () => {
      clearThumbnails();
      element("recording-indicator").hidden = true;
      handoff = null;
      dialog("agent-handoff").close();
      closeClipboard(false);
      textInput("clipboard-text").value = "";
      closeMedia();
    },
    shortcut: (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ["c", "x"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        asyncHandler(() =>
          run(async () => {
            await request(event.key.toLowerCase() === "x" ? "clipboard_cut" : "clipboard_copy");
            textInput("clipboard-text").value = string((await request("clipboard_read")).text);
            copyToDevice();
          }),
        )();
        return true;
      }
      return false;
    },
  };
}
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    createServoFeatures: typeof createServoFeatures;
  }
}
window.createServoFeatures = createServoFeatures;
