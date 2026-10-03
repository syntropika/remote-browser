import { Data, Effect, Schema, Semaphore } from "effect";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { attempt, run, withFile } from "./effects.js";

const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const canonicalUsername = (value: string) =>
  value.normalize("NFKC").toLowerCase();
const AccountRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  username: Schema.String,
  canonicalUsername: Schema.String,
  algorithm: Schema.Literal("scrypt"),
  N: Schema.Number,
  r: Schema.Number,
  p: Schema.Number,
  salt: Schema.String,
  passwordHash: Schema.String,
});
type AccountRecord = typeof AccountRecord.Type;
export interface Credentials {
  username?: unknown;
  password?: unknown;
}

export class AccountError extends Data.TaggedError("AccountError")<{
  status: number;
  message: string;
}> {
  constructor(status: number, message: string) {
    super({ status, message });
  }
}

function username(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().normalize("NFC");
  return trimmed.length >= 3 &&
    trimmed.length <= 64 &&
    !/[\p{Cc}\p{Cf}]/u.test(trimmed)
    ? trimmed
    : null;
}
const validPassword = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 12 && value.length <= 256;
const filesystemCode = (error: Error) => (error as NodeJS.ErrnoException).code;

function validateRecord(value: unknown): AccountRecord {
  const record = Schema.decodeUnknownSync(AccountRecord)(value);
  if (
    !username(record.username) ||
    record.username !== username(record.username) ||
    record.canonicalUsername !== canonicalUsername(record.username) ||
    !/^[a-f0-9]{32}$/.test(record.id) ||
    !/^[a-f0-9]{32}$/.test(record.salt) ||
    !/^[a-f0-9]{128}$/.test(record.passwordHash) ||
    record.N !== parameters.N ||
    record.r !== parameters.r ||
    record.p !== parameters.p
  )
    throw new Error("Invalid account record.");
  return record;
}

export class AccountStore {
  readonly filename: string;
  private readonly derivations = Semaphore.makeUnsafe(2);
  private readonly dummySalt = randomBytes(16);

  constructor(filename: string) {
    this.filename = path.resolve(filename);
  }

  loadEffect(): Effect.Effect<AccountRecord | null, AccountError> {
    return withFile(
      this.filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
      undefined,
      (file) =>
        Effect.gen(function* () {
          const stat = yield* attempt(() => file.stat());
          if (!stat.isFile() || stat.size > 16 * 1024)
            return yield* Effect.fail(new Error("Invalid account file."));
          const text = yield* attempt(() => file.readFile("utf8"));
          return yield* Effect.try({
            try: () => validateRecord(JSON.parse(text)),
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          });
        }),
    ).pipe(
      Effect.catch((error) =>
        filesystemCode(error) === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(
              new AccountError(
                503,
                "The dashboard account is unavailable. Contact the administrator.",
              ),
            ),
      ),
    );
  }

  load() {
    return run(this.loadEffect());
  }
  configured() {
    return run(this.loadEffect().pipe(Effect.map(Boolean)));
  }

  hashEffect(password: string, salt: Buffer): Effect.Effect<Buffer, Error> {
    const derive = attempt(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          scrypt(password, salt, 64, parameters, (error, key) =>
            error ? reject(error) : resolve(key),
          );
        }),
    );
    return this.derivations
      .withPermitsIfAvailable(1)(Effect.uninterruptible(derive))
      .pipe(
        Effect.flatMap((result) =>
          result._tag === "Some"
            ? Effect.succeed(result.value)
            : Effect.fail(
                new AccountError(
                  429,
                  "Too many sign-in requests. Try again shortly.",
                ),
              ),
        ),
      );
  }

  hash(password: string, salt: Buffer) {
    return run(this.hashEffect(password, salt));
  }

  createEffect(input: Credentials | null): Effect.Effect<string, Error> {
    const self = this;
    return Effect.gen(function* () {
      if (yield* self.loadEffect())
        return yield* Effect.fail(
          new AccountError(409, "The dashboard account is already configured."),
        );
      const name = username(input?.username);
      if (!name)
        return yield* Effect.fail(
          new AccountError(
            400,
            "Use a username with 3 to 64 characters and no control characters.",
          ),
        );
      if (!validPassword(input?.password))
        return yield* Effect.fail(
          new AccountError(400, "Use a password with 12 to 256 characters."),
        );
      const salt = randomBytes(16);
      const passwordHash = yield* self.hashEffect(input.password, salt);
      const record: AccountRecord = {
        version: 1,
        id: randomBytes(16).toString("hex"),
        username: name,
        canonicalUsername: canonicalUsername(name),
        algorithm: "scrypt",
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        salt: salt.toString("hex"),
        passwordHash: passwordHash.toString("hex"),
      };
      const directory = path.dirname(self.filename);
      yield* attempt(() => mkdir(directory, { recursive: true, mode: 0o700 }));
      const temporary = `${self.filename}.${randomBytes(16).toString("hex")}.tmp`;
      const publish = Effect.gen(function* () {
        yield* withFile(temporary, "wx", 0o600, (file) =>
          Effect.gen(function* () {
            yield* attempt(() =>
              file.writeFile(`${JSON.stringify(record)}\n`, "utf8"),
            );
            yield* attempt(() => file.sync());
          }),
        );
        // A hard link publishes the account atomically without replacing another owner.
        yield* attempt(() => link(temporary, self.filename));
        yield* withFile(directory, constants.O_RDONLY, undefined, (file) =>
          attempt(() => file.sync()),
        );
        return name;
      }).pipe(
        Effect.catch((error) =>
          filesystemCode(error) === "EEXIST"
            ? Effect.fail(
                new AccountError(
                  409,
                  "The dashboard account is already configured.",
                ),
              )
            : Effect.fail(error),
        ),
      );
      return yield* publish.pipe(
        Effect.ensuring(
          attempt(() => unlink(temporary)).pipe(
            Effect.catch((error) =>
              filesystemCode(error) === "ENOENT"
                ? Effect.void
                : Effect.die(error),
            ),
          ),
        ),
      );
    });
  }

  create(input: Credentials | null) {
    return run(Effect.uninterruptible(this.createEffect(input)));
  }

  verifyEffect(input: Credentials | null): Effect.Effect<boolean, Error> {
    const self = this;
    return Effect.gen(function* () {
      const record = yield* self.loadEffect();
      const name = username(input?.username);
      const password =
        typeof input?.password === "string" && input.password.length <= 256
          ? input.password
          : "";
      const actual = yield* self.hashEffect(
        password,
        record ? Buffer.from(record.salt, "hex") : self.dummySalt,
      );
      const expected = record
        ? Buffer.from(record.passwordHash, "hex")
        : Buffer.alloc(64);
      const matches = timingSafeEqual(actual, expected);
      return Boolean(
        record &&
        name &&
        validPassword(input?.password) &&
        canonicalUsername(name) === record.canonicalUsername &&
        matches,
      );
    });
  }
  verify(input: Credentials | null) {
    return run(this.verifyEffect(input));
  }
}
