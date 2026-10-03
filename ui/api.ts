import type { GetRoutes, PostRoutes } from "./contracts.js";
import { Cause, Data, Effect, Exit } from "effect";

export class ApiError extends Data.TaggedError("ApiError")<{
  message: string;
  statusCode: number;
}> {
  constructor(message: string, statusCode: number) {
    super({ message, statusCode });
  }
}

/** Network deadlines and failures are managed by Effect; the UI uses a Promise boundary. */
export function requestEffect<A>(
  url: string,
  body?: unknown,
): Effect.Effect<A, Error> {
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: body === undefined ? "GET" : "POST",
              credentials: "same-origin",
              cache: "no-store",
              headers:
                body === undefined
                  ? {}
                  : { "Content-Type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: controller.signal,
            }),
          catch: uiFailure,
        });
        const data = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () =>
            new ApiError(
              "The server returned an invalid response.",
              response.status,
            ),
        });
        if (!response.ok)
          return yield* Effect.fail(
            new ApiError(
              data?.error || `Request failed (${response.status}).`,
              response.status,
            ),
          );
        return data as A;
      }),
    (controller) => Effect.sync(() => controller.abort()),
  ).pipe(Effect.timeout("20 seconds"), Effect.mapError(uiFailure));
}

export interface UiFailure extends Error {
  statusCode?: number;
}
export const uiFailure = (cause: unknown): UiFailure =>
  cause instanceof Error ? cause : new Error(String(cause));

export function api<P extends keyof GetRoutes>(url: P): Promise<GetRoutes[P]>;
export function api<P extends keyof PostRoutes>(
  url: P,
  body: unknown,
): Promise<PostRoutes[P]>;
export function api(url: string, body?: unknown): Promise<unknown>;
export async function api(url: string, body?: unknown): Promise<unknown> {
  const exit = await Effect.runPromiseExit(requestEffect<unknown>(url, body));
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}
