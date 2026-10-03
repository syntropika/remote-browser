import { asyncHandler, background } from "../src/async-boundary.js";
import { jsonObject, required } from "../src/invariants.js";
import { uiFailure } from "./api.js";
import type { RecordingStatus, SavedFile, UiOptions } from "./contracts.js";
import { element as domElement } from "./dom.js";

export function createBrowserFiles({ api, onOpen, onUnauthorized }: UiOptions) {
  const byId = domElement;
  const panel = byId("files-panel");
  const workspace = byId("workspace");
  const list = byId("files-list");
  const indicator = byId("recording-indicator");
  let generation = 0;
  let busy = false;
  let recording: RecordingStatus | null = null;

  function clearFiles() {
    for (const video of list.querySelectorAll("video")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    list.replaceChildren();
  }

  function inactive(value: boolean) {
    for (const element of workspace.querySelectorAll<HTMLElement>(
      ".toolbar, .browser-shell, .bottom-stack, .tabs-panel, .notice, .session-footer, .recording-indicator",
    )) {
      element.inert = value;
    }
  }
  function errorMessage(message = "") {
    byId("files-error").textContent = message;
    byId("files-error").hidden = !message;
  }
  function setBusy(value: boolean) {
    busy = value;
    panel.setAttribute("aria-busy", String(value));
    for (const localButton of panel.querySelectorAll<HTMLButtonElement>(
      "button:not(#files-close)",
    )) {
      localButton.disabled = value;
    }
    byId("recording-stop").disabled = value || recording?.state === "stopping";
    byId("files-upload-input").disabled = value;
    byId("files-upload-button").textContent =
      value && byId("files-upload-input").files?.length ? "Uploading…" : "Upload file";
  }
  function sync(current: RecordingStatus | null) {
    const changed = recording?.id !== current?.id || recording?.state !== current?.state;
    recording = current || null;
    indicator.hidden = !recording;
    byId("active-recording").hidden = !recording;
    byId("recording-name").textContent = recording?.name || "";
    byId("recording-stop").textContent =
      recording?.state === "stopping" ? "Saving…" : "Stop recording";
    byId("recording-stop").disabled = busy || recording?.state === "stopping";
    if (changed && !panel.hidden && !busy) {
      background(refresh());
    }
  }
  function close(restoreFocus = true) {
    generation += 1;
    panel.hidden = true;
    if (workspace.dataset.settings === "files") {
      delete workspace.dataset.settings;
    }
    inactive(false);
    clearFiles();
    byId("files-upload-input").value = "";
    byId("files-upload-status").hidden = true;
    errorMessage();
    setBusy(false);
    if (restoreFocus) {
      required(byId("more-menu").querySelector("summary")).focus({ preventScroll: true });
    }
  }
  function button(label: string, className: string, action: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `button ${className}`;
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
  }
  function render(files: SavedFile[]) {
    clearFiles();
    byId("files-empty").hidden = files.length !== 0;
    for (const file of files) {
      const row = document.createElement("li");
      row.className = "file-row";
      row.dataset.fileId = file.id;
      const previewUrl = `/api/artifacts/${encodeURIComponent(file.id)}/preview`;
      let preview;
      if (file.mimeType === "video/mp4") {
        preview = document.createElement("video");
        preview.src = previewUrl;
        preview.controls = true;
        preview.playsInline = true;
        preview.preload = "metadata";
        preview.setAttribute("aria-label", file.name);
      } else if (file.mimeType.startsWith("image/")) {
        preview = document.createElement("a");
        preview.href = previewUrl;
        preview.target = "_blank";
        preview.rel = "noopener";
        preview.setAttribute("aria-label", `View ${file.name} at full size`);
        const thumbnail = document.createElement("img");
        thumbnail.src = previewUrl;
        thumbnail.alt = file.name;
        thumbnail.loading = "lazy";
        preview.append(thumbnail);
      } else {
        preview = document.createElement("div");
        preview.className = "file-document";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("icon");
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#icon-files");
        svg.append(use);
        const caption = document.createElement("span");
        caption.textContent = file.kind === "upload" ? "Uploaded file" : "Downloaded file";
        preview.append(svg, caption);
      }
      preview.classList.add("file-preview");
      const info = document.createElement("div");
      info.className = "file-info";
      const name = document.createElement("h3");
      name.textContent = file.name;
      const meta = document.createElement("p");
      meta.className = "file-meta";
      const size =
        file.size < 1024 * 1024
          ? `${Math.max(1, Math.round(file.size / 1024))} KB`
          : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
      const date = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(file.createdAt));
      const kind =
        file.mimeType === "video/mp4"
          ? "Video"
          : file.kind === "upload"
            ? "Upload"
            : file.kind === "download"
              ? "Download"
              : "Screenshot";
      meta.textContent = `${kind} · ${size} · ${date}`;
      info.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "file-actions";
      const download = document.createElement("a");
      download.className = "button button-secondary";
      download.href = `/api/artifacts/${encodeURIComponent(file.id)}/download`;
      download.download = file.name;
      download.textContent = "Download";
      download.setAttribute("aria-label", `Download ${file.name}`);
      const confirmation = document.createElement("div");
      confirmation.className = "key-revoke-confirm";
      confirmation.hidden = true;
      const prompt = document.createElement("p");
      prompt.textContent = `Delete “${file.name}”? This cannot be undone.`;
      const choices = document.createElement("div");
      const remove = button("Delete", "button-quiet button-destructive", () => {
        confirmation.hidden = false;
        cancel.focus();
      });
      remove.setAttribute("aria-label", `Delete ${file.name}`);
      const cancel = button("Cancel", "button-secondary", () => {
        confirmation.hidden = true;
        remove.focus();
      });
      const confirm = button(
        "Delete file",
        "button-secondary button-destructive",
        asyncHandler(() => mutate("/api/artifacts/delete", { id: file.id })),
      );
      choices.append(cancel, confirm);
      confirmation.append(prompt, choices);
      actions.append(download, remove);
      row.append(preview, info, actions, confirmation);
      list.append(row);
    }
  }
  function handleError(cause: unknown) {
    const error = uiFailure(cause);
    if (error.statusCode === 401) {
      onUnauthorized();
    } else {
      errorMessage(error.message || "Could not update files. Try refreshing.");
    }
  }
  async function refresh() {
    if (busy || panel.hidden) {
      return;
    }
    const current = generation;
    setBusy(true);
    errorMessage();
    byId("files-loading").hidden = false;
    try {
      const result = await api("/api/artifacts");
      if (current !== generation) {
        return;
      }
      render(result.files);
      sync(result.recording);
    } catch (cause) {
      const error = uiFailure(cause);
      if (current === generation) {
        handleError(error);
      }
    } finally {
      if (current === generation) {
        byId("files-loading").hidden = true;
        setBusy(false);
      }
    }
  }
  async function mutate(url: string, body = {}) {
    if (busy) {
      return;
    }
    const current = generation;
    setBusy(true);
    errorMessage();
    try {
      await api(url, body);
      if (current !== generation) {
        return;
      }
      setBusy(false);
      await refresh();
      if (current === generation) {
        byId("files-refresh").focus({ preventScroll: true });
      }
    } catch (cause) {
      const error = uiFailure(cause);
      if (current === generation) {
        handleError(error);
      }
    } finally {
      if (current === generation) {
        setBusy(false);
      }
    }
  }
  function open() {
    onOpen();
    generation += 1;
    panel.hidden = false;
    workspace.dataset.settings = "files";
    inactive(true);
    panel.scrollTop = 0;
    byId("files-empty").hidden = true;
    byId("files-title").focus({ preventScroll: true });
    background(refresh());
  }
  async function upload() {
    const input = byId("files-upload-input");
    const file = input.files?.[0];
    if (!file || busy) {
      return;
    }
    errorMessage();
    byId("files-upload-status").hidden = true;
    if (!file.size || file.size > 20 * 1024 * 1024) {
      input.value = "";
      errorMessage("Choose a non-empty file no larger than 20 MB.");
      return;
    }
    const current = generation;
    setBusy(true);
    try {
      const response = await fetch("/api/artifacts/upload", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const result = jsonObject(await response.text());
      if (!response.ok) {
        throw Object.assign(
          new Error(
            typeof result.error === "string"
              ? result.error
              : "Could not upload the file. Try again.",
          ),
          {
            statusCode: response.status,
          },
        );
      }
      if (current !== generation) {
        return;
      }
      input.value = "";
      setBusy(false);
      await refresh();
      if (current !== generation) {
        return;
      }
      byId("files-upload-status").textContent =
        `${typeof result.name === "string" ? result.name : "Your file"} is ready for your agent.`;
      byId("files-upload-status").hidden = false;
      byId("files-upload-button").focus({ preventScroll: true });
    } catch (cause) {
      const error = uiFailure(cause);
      if (current === generation) {
        handleError(error);
      }
    } finally {
      if (current === generation) {
        input.value = "";
        setBusy(false);
      }
    }
  }
  byId("files-upload-button").addEventListener("click", () => {
    byId("files-upload-input").click();
  });
  byId("files-upload-input").addEventListener(
    "change",
    asyncHandler(() => upload()),
  );
  byId("files-button").addEventListener("click", open);
  indicator.addEventListener("click", open);
  byId("files-close").addEventListener("click", () => {
    close();
  });
  byId("files-refresh").addEventListener(
    "click",
    asyncHandler(() => refresh()),
  );
  byId("recording-stop").addEventListener(
    "click",
    asyncHandler(() => mutate("/api/recording/stop")),
  );
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  return {
    sync,
    reset: () => {
      close(false);
      sync(null);
    },
  };
}
