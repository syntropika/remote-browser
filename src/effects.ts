import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

import { Cause, Effect, Exit, Semaphore } from "effect";

export type NativeError = {
  code?: string | number;
  stderr?: string;
  stdout?: string;
  status?: number;
  unknownCompletion?: boolean;
} & Error;
export const nativeError = (cause: unknown): NativeError => asError(cause);

export const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** Adapt native I/O without hiding domain errors from the Effect error channel. */
export const attempt = <A>(operation: () => PromiseLike<A> | A): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: async () => operation(), catch: asError });

/** Only transport and process entry points convert Effects back into Promises. */
export async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  }
  return exit.value;
}

export function withFile<A>(
  filename: string,
  flags: string | number,
  mode: number | undefined,
  use: (file: FileHandle) => Effect.Effect<A, Error>,
): Effect.Effect<A, Error> {
  return Effect.acquireUseRelease(
    attempt(async () => open(filename, flags, mode)),
    use,
    (file) => attempt(async () => file.close()).pipe(Effect.orDie),
  );
}

/** Each mutation holds its permit until native I/O has completed, including cleanup. */
export class SerialOperations {
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private tail: Promise<unknown> = Promise.resolve();

  async execute<A>(operation: Effect.Effect<A, Error>): Promise<A> {
    const result = run(this.semaphore.withPermits(1)(Effect.uninterruptible(operation)));
    this.tail = result.catch((): void => undefined);
    return result;
  }

  async drain(): Promise<unknown> {
    return this.tail;
  }
}
