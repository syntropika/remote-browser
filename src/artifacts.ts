import { nativeError } from "./effects.js";
import { Data, Effect } from "effect";
import { attempt, SerialOperations, withFile } from "./effects.js";
import type { ChildProcess } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
export interface ArtifactMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  kind?: string;
}
export interface RecordingStatus {
  id: string;
  name: string;
  startedAt: string;
  maxSeconds: number;
  state: string;
}
interface RecordingJob {
  id: string;
  name: string;
  startedAt: string;
  maxSeconds: number;
  file: FileHandle | null;
  dataPath: string;
  child: ChildProcess | null;
  frames: boolean;
  stopping: boolean;
  failure: Error | null;
  settled: boolean;
  timers: NodeJS.Timeout[];
  progress: string;
  startupTimer?: NodeJS.Timeout;
  ready?: Promise<RecordingStatus>;
  done?: Promise<ArtifactMetadata & { url: string }>;
  started?: (value: RecordingStatus) => void;
  startFailed?: (error: Error) => void;
  finished?: (value: ArtifactMetadata & { url: string }) => void;
  finishFailed?: (error: Error) => void;
}
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const MiB = 1024 * 1024;
const screenshotLimit = 8 * MiB;
export const fileLimit = 20 * MiB;
const bodyLimit = 29 * MiB;
const validId = (id: unknown) =>
  typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const formats: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "video/mp4": "mp4",
  "application/octet-stream": "",
};

export class ArtifactError extends Data.TaggedError("ArtifactError")<{
  status: number;
  message: string;
}> {
  size?: number;
  constructor(status: number, message: string) {
    super({ status, message });
  }
}

function artifactName(value: unknown, extension: string) {
  if (value === undefined || value === "")
    return extension
      ? `${extension === "mp4" ? "Recording" : "Screenshot"}.${extension}`
      : "download.bin";
  if (
    typeof value !== "string" ||
    value.length > 120 ||
    /[\p{Cc}\p{Cf}\\/]/u.test(value)
  ) {
    throw new ArtifactError(
      400,
      "Use a file name of at most 120 characters without slashes or control characters.",
    );
  }
  const name = value.trim().normalize("NFC");
  if (!name || name === "." || name === "..")
    throw new ArtifactError(400, "Enter a file name.");
  const filename =
    !extension || name.toLowerCase().endsWith(`.${extension}`)
      ? name
      : `${name}.${extension}`;
  if (filename.length > 120)
    throw new ArtifactError(
      400,
      "Use a file name of at most 120 characters including its extension.",
    );
  return filename;
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Check all components, including parents: no configured storage path may traverse a symlink.
  let current = path.resolve(directory);
  while (true) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ArtifactError(503, "Artifact storage is unavailable.");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  await chmod(directory, 0o700);
}

async function safeOpen(filename: string, maximum: number) {
  let file;
  try {
    file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum || stat.mode & 0o077)
      throw new Error("Invalid artifact file.");
    return { file, stat };
  } catch (errorCause) {
    const error = nativeError(errorCause);
    await file?.close();
    throw error;
  }
}

function byteRange(value: unknown, size: number) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  const reject = () => {
    const error = new ArtifactError(
      416,
      "The requested byte range is not available.",
    );
    error.size = size;
    throw error;
  };
  const match =
    typeof value === "string" && /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return reject();
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return reject();
  if (first === null) {
    if (!last) return reject();
    return { start: Math.max(0, size - last), end: size - 1, partial: true };
  }
  if (first >= size || (last !== null && last < first)) return reject();
  return {
    start: first,
    end: last === null ? size - 1 : Math.min(last, size - 1),
    partial: true,
  };
}

export class ArtifactService {
  directory: string;
  socketPath: string;
  publicOrigin: string;
  display: string;
  width: number;
  height: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxVideoBytes: number;
  spawnProcess: typeof spawn;
  now: () => number;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
  initialization: Promise<void> | null;
  private readonly operations = new SerialOperations();
  get queue() {
    return this.operations.drain();
  }
  recording: RecordingJob | null;
  server: http.Server | null;
  closed: boolean;
  closing: Promise<void> | null;

  constructor({
    directory = "/data/artifacts",
    socketPath = process.env.ARTIFACT_SOCKET_PATH ||
      "/tmp/remote-browser/artifacts.sock",
    publicOrigin = "",
    display = process.env.DISPLAY || ":99",
    width = Number(process.env.SCREEN_WIDTH || 1280),
    height = Number(process.env.SCREEN_HEIGHT || 800),
    maxTotalBytes = 1024 * MiB,
    maxFiles = 500,
    maxVideoBytes = 256 * MiB,
    spawnProcess = spawn,
    now = Date.now,
    startupTimeoutMs = 15_000,
    stopTimeoutMs = 8000,
  } = {}) {
    this.directory = path.resolve(directory);
    this.socketPath = path.resolve(socketPath);
    this.publicOrigin = publicOrigin.replace(/\/$/, "");
    this.display = display;
    this.width = width;
    this.height = height;
    this.maxTotalBytes = maxTotalBytes;
    this.maxFiles = maxFiles;
    this.maxVideoBytes = maxVideoBytes;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.startupTimeoutMs = startupTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.initialization = null;
    this.recording = null;
    this.server = null;
    this.closed = false;
    this.closing = null;
  }

  initialize() {
    if (!this.initialization)
      this.initialization = (async () => {
        await privateDirectory(this.directory);
        const names = new Set(await readdir(this.directory));
        // A crash can leave unregistered video data or a partial metadata write.
        for (const name of names) {
          if (
            (/^[a-f0-9]{32}\.bin$/.test(name) &&
              !names.has(`${name.slice(0, 32)}.json`)) ||
            /^[a-f0-9]{32}\.[a-f0-9]{16}\.tmp$/.test(name)
          )
            await unlink(path.join(this.directory, name));
        }
      })();
    return this.initialization;
  }

  serialize<A>(
    operation: (() => PromiseLike<A> | A) | Effect.Effect<A, Error>,
  ): Promise<A> {
    const self = this;
    return this.operations.execute(
      Effect.gen(function* () {
        yield* attempt(() => self.initialize());
        return yield* Effect.isEffect(operation)
          ? operation
          : attempt(operation);
      }),
    );
  }

  metadata(value: ArtifactMetadata) {
    return {
      ...value,
      url: `${this.publicOrigin}/api/artifacts/${value.id}/download`,
    };
  }

  async readMetadata(id: string) {
    if (!validId(id)) throw new ArtifactError(404, "File not found.");
    let file;
    try {
      ({ file } = await safeOpen(
        path.join(this.directory, `${id}.json`),
        2048,
      ));
      const value = JSON.parse(await file.readFile("utf8"));
      if (
        value.id !== id ||
        !Object.hasOwn(formats, value.mimeType) ||
        typeof value.name !== "string" ||
        value.name !== artifactName(value.name, formats[value.mimeType]) ||
        !Number.isSafeInteger(value.size) ||
        value.size <= 0 ||
        value.size >
          (value.mimeType === "video/mp4"
            ? this.maxVideoBytes
            : value.mimeType === "application/octet-stream"
              ? fileLimit
              : screenshotLimit) ||
        (value.mimeType === "application/octet-stream" &&
          !["upload", "download"].includes(value.kind)) ||
        typeof value.createdAt !== "string" ||
        new Date(value.createdAt).toISOString() !== value.createdAt
      )
        throw new Error("Invalid metadata.");
      return {
        id,
        name: value.name,
        mimeType: value.mimeType,
        size: value.size,
        createdAt: value.createdAt,
        ...(value.kind ? { kind: value.kind } : {}),
      };
    } catch (errorCause) {
      const error = nativeError(errorCause);
      throw new ArtifactError(
        error.code === "ENOENT" ? 404 : 503,
        error.code === "ENOENT"
          ? "File not found."
          : "Artifact storage is unavailable.",
      );
    } finally {
      await file?.close();
    }
  }

  async registeredFiles() {
    const names = await readdir(this.directory);
    const files = [];
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const metadata = await this.readMetadata(name.slice(0, 32));
      let data;
      try {
        data = await safeOpen(
          path.join(this.directory, `${metadata.id}.bin`),
          metadata.size,
        );
        if (data.stat.size !== metadata.size)
          throw new Error("Artifact size changed.");
      } catch {
        throw new ArtifactError(503, "Artifact storage is unavailable.");
      } finally {
        await data?.file.close();
      }
      files.push(metadata);
    }
    return files.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async reserve(size: number) {
    const files = await this.registeredFiles();
    const pending = this.recording ? this.maxVideoBytes : 0;
    if (
      files.length + Number(Boolean(this.recording)) >= this.maxFiles ||
      files.reduce((total, file) => total + file.size, 0) + pending + size >
        this.maxTotalBytes
    ) {
      throw new ArtifactError(
        507,
        "File storage is full. Delete saved files before creating more.",
      );
    }
  }

  async commit(metadata: ArtifactMetadata) {
    const temporary = path.join(
      this.directory,
      `${metadata.id}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let file;
    let registered = false;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(metadata)}\n`);
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, path.join(this.directory, `${metadata.id}.json`));
      registered = true;
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (errorCause) {
      const error = nativeError(errorCause);
      if (registered)
        await unlink(path.join(this.directory, `${metadata.id}.json`)).catch(
          () => {},
        );
      throw error;
    } finally {
      await file?.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  status() {
    const job = this.recording;
    return job
      ? {
          id: job.id,
          name: job.name,
          startedAt: job.startedAt,
          maxSeconds: job.maxSeconds,
          state: job.stopping ? "stopping" : "recording",
        }
      : null;
  }

  list() {
    return this.serialize(async () => ({
      files: (await this.registeredFiles()).map((file) => this.metadata(file)),
      recording: this.status(),
    }));
  }

  private persist(
    bytes: Buffer,
    metadata: ArtifactMetadata,
    beforeMutation: () => void,
  ): Effect.Effect<ArtifactMetadata & { url: string }, Error> {
    const self = this;
    const dataPath = path.join(this.directory, `${metadata.id}.bin`);
    let registered = false;
    return Effect.gen(function* () {
      yield* attempt(() => self.reserve(bytes.length));
      yield* attempt(beforeMutation);
      yield* withFile(dataPath, "wx", 0o600, (file) =>
        Effect.gen(function* () {
          yield* attempt(() => file.writeFile(bytes));
          yield* attempt(() => file.sync());
        }),
      );
      yield* attempt(beforeMutation);
      yield* attempt(() => self.commit(metadata));
      registered = true;
      return self.metadata(metadata);
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          registered
            ? Effect.void
            : attempt(() => unlink(dataPath)).pipe(
                Effect.catch(() => Effect.void),
              ),
        ),
      ),
    );
  }

  save({
    name,
    base64,
    mimeType,
  }: { name?: unknown; base64?: unknown; mimeType?: string } = {}) {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        if (this.closed)
          return yield* Effect.fail(
            new ArtifactError(503, "Artifact service is stopping."),
          );
        if (
          !mimeType ||
          !["image/png", "image/jpeg"].includes(mimeType) ||
          typeof base64 !== "string" ||
          base64.length > Math.ceil(screenshotLimit / 3) * 4 ||
          base64.length % 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
        )
          return yield* Effect.fail(
            new ArtifactError(
              400,
              "Supply a PNG or JPEG screenshot no larger than 8 MiB.",
            ),
          );
        const buffer = Buffer.from(base64, "base64");
        const signatureMatches =
          mimeType === "image/png"
            ? buffer.subarray(0, 8).equals(pngSignature)
            : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
        if (
          buffer.toString("base64") !== base64 ||
          !signatureMatches ||
          buffer.length <= 8 ||
          buffer.length > screenshotLimit
        )
          return yield* Effect.fail(
            new ArtifactError(400, "Invalid screenshot data."),
          );
        const filename = yield* attempt(() =>
          artifactName(name, formats[mimeType]),
        );
        return yield* this.persist(
          buffer,
          {
            id: randomBytes(16).toString("hex"),
            name: filename,
            mimeType,
            size: buffer.length,
            createdAt: new Date(this.now()).toISOString(),
          },
          () => {},
        );
      }),
    );
  }

  saveFile(
    {
      name,
      buffer,
      kind = "download",
    }: { name?: unknown; buffer?: Buffer; kind?: string } = {},
    { beforeMutation = () => {} } = {},
  ) {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        if (this.closed)
          return yield* Effect.fail(
            new ArtifactError(503, "Artifact service is stopping."),
          );
        if (
          !Buffer.isBuffer(buffer) ||
          !buffer.length ||
          buffer.length > fileLimit ||
          !["upload", "download"].includes(kind)
        )
          return yield* Effect.fail(
            new ArtifactError(
              400,
              "Supply a non-empty file no larger than 20 MiB.",
            ),
          );
        const filename = yield* attempt(() => artifactName(name, ""));
        return yield* this.persist(
          buffer,
          {
            id: randomBytes(16).toString("hex"),
            name: filename,
            kind,
            mimeType: "application/octet-stream",
            size: buffer.length,
            createdAt: new Date(this.now()).toISOString(),
          },
          beforeMutation,
        );
      }),
    );
  }

  async openFile(id: string, { range }: { range?: string } = {}) {
    await this.initialize();
    const metadata = await this.readMetadata(id);
    const selection = byteRange(range, metadata.size);
    let data;
    try {
      data = await safeOpen(
        path.join(this.directory, `${id}.bin`),
        metadata.size,
      );
      if (data.stat.size !== metadata.size)
        throw new Error("Artifact size changed.");
      return {
        ...this.metadata(metadata),
        ...selection,
        contentLength: selection.end - selection.start + 1,
        stream: data.file.createReadStream({
          start: selection.start,
          end: selection.end,
          autoClose: true,
        }),
      };
    } catch {
      await data?.file.close();
      throw new ArtifactError(404, "File not found.");
    }
  }

  remove(id: string, { beforeMutation = () => {} } = {}) {
    return this.serialize(async () => {
      const metadata = await this.readMetadata(id);
      beforeMutation();
      await unlink(path.join(this.directory, `${metadata.id}.json`));
      await unlink(path.join(this.directory, `${metadata.id}.bin`)).catch(
        (error) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      return { deleted: true };
    });
  }

  async startRecording({
    name,
    maxSeconds = 60,
  }: { name?: unknown; maxSeconds?: number } = {}) {
    const job = await this.serialize(async () => {
      if (this.closed)
        throw new ArtifactError(503, "Artifact service is stopping.");
      if (this.recording)
        throw new ArtifactError(409, "A recording is already running.");
      if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300)
        throw new ArtifactError(
          400,
          "Choose a recording duration between 1 and 300 seconds.",
        );
      if (
        !Number.isInteger(this.width) ||
        !Number.isInteger(this.height) ||
        this.width < 2 ||
        this.height < 2 ||
        this.width > 3840 ||
        this.height > 2160
      ) {
        throw new ArtifactError(503, "The display dimensions are invalid.");
      }
      const filename = artifactName(name, "mp4");
      await this.reserve(this.maxVideoBytes);
      const id = randomBytes(16).toString("hex");
      const dataPath = path.join(this.directory, `${id}.bin`);
      const file = await open(dataPath, "wx", 0o600);
      const value: RecordingJob = {
        id,
        name: filename,
        startedAt: new Date(this.now()).toISOString(),
        maxSeconds,
        file,
        dataPath,
        child: null,
        frames: false,
        stopping: false,
        failure: null,
        settled: false,
        timers: [],
        progress: "",
      };
      value.ready = new Promise((resolve, reject) => {
        value.started = resolve;
        value.startFailed = reject;
      });
      value.done = new Promise((resolve, reject) => {
        value.finished = resolve;
        value.finishFailed = reject;
      });
      value.ready.catch(() => {});
      value.done.catch(() => {});
      this.recording = value;
      try {
        value.child = this.spawnProcess(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "x11grab",
            "-framerate",
            "15",
            "-video_size",
            `${this.width}x${this.height}`,
            "-i",
            this.display,
            "-t",
            String(maxSeconds),
            "-fs",
            String(Math.max(1, this.maxVideoBytes - 64 * 1024)),
            "-an",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:3",
            "-f",
            "mp4",
            "/proc/self/fd/4",
          ],
          {
            stdio: ["ignore", "ignore", "pipe", "pipe", file.fd],
            env: { ...process.env },
          },
        );
        // Drain diagnostics without exposing browser data or filesystem paths to callers.
        value.child.stderr?.resume();
        (value.child.stdio[3] as Readable).on("data", (chunk) => {
          value.progress = (value.progress + chunk.toString("utf8")).slice(
            -8192,
          );
          if (
            !value.frames &&
            /(?:^|\n)frame=\s*[1-9][0-9]*(?:\n|$)/.test(value.progress)
          ) {
            value.frames = true;
            clearTimeout(value.startupTimer);
            value.started!({
              id,
              name: filename,
              startedAt: value.startedAt,
              maxSeconds,
              state: "recording",
            });
          }
        });
        value.child.once("error", () => {
          value.failure = new ArtifactError(502, "Recording could not start.");
          this.finishRecording(value, null);
        });
        value.child.once("close", (code) => this.finishRecording(value, code));
        value.startupTimer = setTimeout(() => {
          value.failure = new ArtifactError(
            504,
            "Recording could not start in time.",
          );
          value.child!.kill("SIGKILL");
        }, this.startupTimeoutMs);
        value.timers.push(value.startupTimer);
        value.timers.push(
          setTimeout(() => this.stopJob(value), (maxSeconds + 10) * 1000),
        );
      } catch {
        value.failure = new ArtifactError(502, "Recording could not start.");
        this.finishRecording(value, null);
      }
      return value;
    });
    return job.ready;
  }

  finishRecording(job: RecordingJob, code: number | null) {
    if (job.settled) return;
    job.settled = true;
    job.timers.forEach(clearTimeout);
    this.serialize(async () => {
      try {
        if (job.failure) throw job.failure;
        if (!job.frames || !(code === 0 || (code === 255 && job.stopping)))
          throw new ArtifactError(502, "Recording failed. No video was saved.");
        await job.file!.sync();
        await job.file!.close();
        job.file = null;
        const data = await safeOpen(job.dataPath, this.maxVideoBytes);
        let size;
        try {
          size = data.stat.size;
          const signature = Buffer.alloc(12);
          await data.file.read(signature, 0, signature.length, 0);
          if (
            size < 12 ||
            signature.subarray(4, 8).toString("ascii") !== "ftyp"
          )
            throw new ArtifactError(
              502,
              "Recording failed. No video was saved.",
            );
        } finally {
          await data.file.close();
        }
        const metadata = {
          id: job.id,
          name: job.name,
          mimeType: "video/mp4",
          size,
          createdAt: job.startedAt,
        };
        await this.commit(metadata);
        if (this.recording === job) this.recording = null;
        job.finished!(this.metadata(metadata));
      } catch (errorCause) {
        const error = nativeError(errorCause);
        await unlink(job.dataPath).catch(() => {});
        const failure =
          error instanceof ArtifactError
            ? error
            : new ArtifactError(502, "Recording failed. No video was saved.");
        job.startFailed!(failure);
        job.finishFailed!(failure);
      } finally {
        await job.file?.close();
        if (this.recording === job) this.recording = null;
      }
    }).catch((error) => {
      job.startFailed!(error);
      job.finishFailed!(error);
      if (this.recording === job) this.recording = null;
    });
  }

  stopJob(job: RecordingJob) {
    if (!job.stopping && !job.settled) {
      job.stopping = true;
      job.child?.kill("SIGINT");
      job.timers.push(
        setTimeout(() => {
          job.failure = new ArtifactError(
            504,
            "Recording did not finish in time. No video was saved.",
          );
          job.child?.kill("SIGKILL");
        }, this.stopTimeoutMs),
      );
    }
    return job.done!;
  }

  async stopRecording({ beforeMutation = () => {} } = {}) {
    await this.queue;
    beforeMutation();
    if (!this.recording)
      throw new ArtifactError(409, "No recording is running.");
    return this.stopJob(this.recording);
  }

  async listen() {
    if (this.closed)
      throw new ArtifactError(503, "Artifact service is stopping.");
    if (this.server) return;
    await this.initialize();
    await privateDirectory(path.dirname(this.socketPath));
    try {
      const stat = await lstat(this.socketPath);
      if (!stat.isSocket())
        throw new Error("The artifact socket path is occupied.");
      await unlink(this.socketPath);
    } catch (errorCause) {
      const error = nativeError(errorCause);
      if (error.code !== "ENOENT") throw error;
    }
    const server = http.createServer(async (req, res) => {
      try {
        let body;
        if (req.method === "POST") {
          let bytes = 0;
          const chunks = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > bodyLimit)
              throw new ArtifactError(413, "Artifact request is too large.");
            chunks.push(chunk);
          }
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw new ArtifactError(400, "Send a JSON object.");
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new ArtifactError(400, "Send a JSON object.");
        }
        let value;
        const uploadMatch = /^\/uploads\/([a-f0-9]{32})$/.exec(req.url ?? "");
        if (req.method === "GET" && uploadMatch) {
          const metadata = await this.readMetadata(uploadMatch[1]);
          if (metadata.kind !== "upload")
            throw new ArtifactError(
              400,
              "Choose a file uploaded by the human.",
            );
          const file = await this.openFile(metadata.id);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": file.size,
            "cache-control": "no-store",
            "x-file-name": encodeURIComponent(file.name),
          });
          res.once("close", () => file.stream.destroy());
          file.stream.on("error", () => res.destroy());
          file.stream.pipe(res);
          return;
        }
        if (req.method === "GET" && req.url === "/files")
          value = await this.list();
        else if (req.method === "GET" && req.url === "/recording")
          value = this.status();
        else if (req.method === "POST" && req.url === "/screenshot")
          value = await this.save(body);
        else if (req.method === "POST" && req.url === "/download") {
          if (
            typeof body.base64 !== "string" ||
            body.base64.length > Math.ceil(fileLimit / 3) * 4 ||
            body.base64.length % 4 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)
          )
            throw new ArtifactError(400, "Invalid file data.");
          const buffer = Buffer.from(body.base64, "base64");
          if (buffer.toString("base64") !== body.base64)
            throw new ArtifactError(400, "Invalid file data.");
          value = await this.saveFile({
            name: body.name,
            buffer,
            kind: "download",
          });
        } else if (req.method === "POST" && req.url === "/recording/start")
          value = await this.startRecording(body);
        else if (req.method === "POST" && req.url === "/recording/stop")
          value = await this.stopRecording();
        else throw new ArtifactError(404, "Not found.");
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(value));
      } catch (errorCause) {
        const error = nativeError(errorCause);
        res.writeHead(error instanceof ArtifactError ? error.status : 500, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            error:
              error instanceof ArtifactError
                ? error.message
                : "Artifact request failed.",
          }),
        );
      }
    });
    server.requestTimeout = 20_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
    this.server = server;
  }

  close() {
    if (!this.closing)
      this.closing = (async () => {
        this.closed = true;
        await this.queue;
        if (this.recording) await this.stopJob(this.recording).catch(() => {});
        if (this.server) {
          this.server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            this.server!.close((error) => (error ? reject(error) : resolve())),
          );
          this.server = null;
          await unlink(this.socketPath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      })();
    return this.closing;
  }
}
