import { nativeError } from "./effects.js";
import { Data, Effect, Schema } from "effect";
import { attempt, SerialOperations } from "./effects.js";
const KeyRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prefix: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  legacy: Schema.optional(Schema.Boolean),
  hash: Schema.String,
});
const Registry = Schema.Struct({
  version: Schema.Literal(1),
  keys: Schema.Array(KeyRecord),
});
type KeyRecord = typeof KeyRecord.Type;
type Registry = typeof Registry.Type;
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const maxKeys = 100;
const metadata = ({
  id,
  name,
  prefix,
  createdAt,
  lastUsedAt,
  legacy,
}: KeyRecord) => ({
  id,
  name,
  prefix,
  createdAt,
  lastUsedAt,
  ...(legacy ? { legacy: true } : {}),
});
const validDate = (value: unknown) =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function keyName(value: unknown) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const name = value.trim().normalize("NFC");
  return name.length && name.length <= 64 ? name : null;
}

export class ApiKeyError extends Data.TaggedError("ApiKeyError")<{
  status: number;
  message: string;
}> {
  constructor(status: number, message: string) {
    super({ status, message });
  }
}

function validateRecord(input: unknown): Registry {
  const record = Schema.decodeUnknownSync(Registry)(input);
  if (
    !record ||
    record.version !== 1 ||
    !Array.isArray(record.keys) ||
    record.keys.length > maxKeys
  )
    throw new Error("Invalid API key record.");
  const ids = new Set();
  const hashes = new Set();
  for (const key of record.keys) {
    if (
      !key ||
      !/^[a-f0-9]{32}$/.test(key.id) ||
      key.name !== keyName(key.name) ||
      !key.name ||
      !/^[a-f0-9]{64}$/.test(key.hash) ||
      !validDate(key.createdAt) ||
      !(key.lastUsedAt === null || validDate(key.lastUsedAt)) ||
      !(key.legacy === undefined || key.legacy === true) ||
      (key.legacy
        ? key.prefix !== "legacy"
        : !/^rb_[A-Za-z0-9_-]{8}$/.test(key.prefix)) ||
      ids.has(key.id) ||
      hashes.has(key.hash)
    )
      throw new Error("Invalid API key record.");
    ids.add(key.id);
    hashes.add(key.hash);
  }
  return record;
}

export class ApiKeyStore {
  filename: string;
  legacyToken: string | undefined;
  now: () => number;
  record: Registry | null;
  fault: ApiKeyError | null;
  initialization: Promise<void> | null;
  private readonly operations = new SerialOperations();
  streams: Map<string, Set<() => void>>;

  constructor(
    filename: string,
    {
      legacyToken,
      now = Date.now,
    }: { legacyToken?: string; now?: () => number } = {},
  ) {
    this.filename = path.resolve(filename);
    this.legacyToken = legacyToken;
    this.now = now;
    this.record = null;
    this.fault = null;
    this.initialization = null;
    this.streams = new Map();
  }

  unavailable() {
    return new ApiKeyError(
      503,
      "API keys are unavailable. Contact the administrator.",
    );
  }

  async read() {
    let file;
    try {
      file = await open(
        this.filename,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 128 * 1024 || stat.mode & 0o077)
        throw new Error("Invalid API key file.");
      return validateRecord(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file?.close();
    }
  }

  async commit(
    record: Registry,
    { initial = false, beforeMutation = () => {} } = {},
  ) {
    const directory = path.dirname(this.filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomBytes(16).toString("hex")}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await file.sync();
      await file.close();
      file = null;
      // Validate the destination again before replacing it; never follow a symlink.
      if (!initial) await this.read();
      beforeMutation();
      if (initial) await link(temporary, this.filename);
      else await rename(temporary, this.filename);
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await file?.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  initialize() {
    if (!this.initialization)
      this.initialization = (async () => {
        try {
          try {
            this.record = await this.read();
          } catch (errorCause) {
            const error = nativeError(errorCause);
            if (error.code !== "ENOENT") throw error;
            const keys: KeyRecord[] = [];
            if (this.legacyToken) {
              if (
                typeof this.legacyToken !== "string" ||
                this.legacyToken.length < 32 ||
                this.legacyToken.length > 4096
              )
                throw new Error("Invalid initial key.");
              keys.push({
                id: randomBytes(16).toString("hex"),
                name: "Initial key",
                prefix: "legacy",
                createdAt: new Date(this.now()).toISOString(),
                lastUsedAt: null,
                legacy: true,
                hash: digest(this.legacyToken),
              });
            }
            const record: Registry = { version: 1, keys };
            try {
              await this.commit(record, { initial: true });
              this.record = record;
            } catch (writeErrorCause) {
              const writeError = nativeError(writeErrorCause);
              if (writeError.code !== "EEXIST") throw writeError;
              this.record = await this.read();
            }
          }
        } catch {
          this.fault = this.unavailable();
          throw this.fault;
        } finally {
          this.legacyToken = undefined;
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
        if (self.fault) return yield* Effect.fail(self.fault);
        return yield* (
          Effect.isEffect(operation) ? operation : attempt(operation)
        ).pipe(
          Effect.catch((error) => {
            if (error instanceof ApiKeyError) return Effect.fail(error);
            self.fault = self.unavailable();
            for (const id of self.streams.keys()) self.closeStreams(id);
            return Effect.fail(self.fault);
          }),
        );
      }),
    );
  }

  list() {
    return this.serialize(() => this.record!.keys.map(metadata));
  }

  create(name: unknown, { beforeMutation = () => {} } = {}) {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        const normalized = keyName(name);
        if (!normalized)
          return yield* Effect.fail(
            new ApiKeyError(
              400,
              "Use a key name with 1 to 64 characters and no control characters.",
            ),
          );
        if (this.record!.keys.length >= maxKeys)
          return yield* Effect.fail(
            new ApiKeyError(
              409,
              "Revoke an existing key before creating another.",
            ),
          );
        yield* attempt(beforeMutation);
        const secret = `rb_${randomBytes(32).toString("base64url")}`;
        const key = {
          id: randomBytes(16).toString("hex"),
          name: normalized,
          prefix: secret.slice(0, 11),
          createdAt: new Date(this.now()).toISOString(),
          lastUsedAt: null,
          hash: digest(secret),
        };
        const record: Registry = {
          version: 1,
          keys: [...this.record!.keys, key],
        };
        yield* attempt(() => this.commit(record, { beforeMutation }));
        this.record = record;
        return { key: metadata(key), secret };
      }),
    );
  }

  revoke(id: unknown, { beforeMutation = () => {} } = {}) {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        if (
          typeof id !== "string" ||
          !this.record!.keys.some((key) => key.id === id)
        )
          return yield* Effect.fail(new ApiKeyError(404, "API key not found."));
        yield* attempt(beforeMutation);
        const record: Registry = {
          version: 1,
          keys: this.record!.keys.filter((key) => key.id !== id),
        };
        yield* attempt(() => this.commit(record, { beforeMutation }));
        this.record = record;
        this.closeStreams(id);
        return { revoked: true };
      }),
    );
  }

  authenticate(secret: unknown) {
    return this.serialize(
      Effect.gen({ self: this }, function* () {
        if (
          typeof secret !== "string" ||
          secret.length < 32 ||
          secret.length > 4096
        )
          return null;
        const hash = Buffer.from(digest(secret), "hex");
        const key = this.record!.keys.find((candidate) =>
          timingSafeEqual(Buffer.from(candidate.hash, "hex"), hash),
        );
        if (!key) return null;
        const lastUsedAt = new Date(this.now()).toISOString();
        const record: Registry = {
          version: 1,
          keys: this.record!.keys.map((candidate) =>
            candidate.id === key.id ? { ...candidate, lastUsedAt } : candidate,
          ),
        };
        yield* attempt(() => this.commit(record));
        this.record = record;
        return { type: "bearer", id: key.id };
      }),
    );
  }

  active(id: string) {
    return (
      !this.fault && Boolean(this.record?.keys.some((key) => key.id === id))
    );
  }

  track(id: string, close: () => void) {
    if (!this.active(id)) return null;
    const streams = this.streams.get(id) || new Set();
    streams.add(close);
    this.streams.set(id, streams);
    return () => {
      streams.delete(close);
      if (!streams.size) this.streams.delete(id);
    };
  }

  closeStreams(id: string) {
    const streams = this.streams.get(id);
    this.streams.delete(id);
    if (streams) for (const close of streams) close();
  }
}
