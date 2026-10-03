import { Context, Effect, Layer } from "effect";
import type { AccountStore } from "./account.js";
import type { ApiKeyStore } from "./api-keys.js";
import type { ArtifactService } from "./artifacts.js";
import type { BrowserService } from "./browser.js";
import type { ClipboardService } from "./clipboard.js";
import { attempt, run } from "./effects.js";

/** Dependencies are supplied once by the gateway, never looked up globally. */
export class Accounts extends Context.Service<Accounts, AccountStore>()(
  "remote-browser/Accounts",
) {}
export class Keys extends Context.Service<Keys, ApiKeyStore>()(
  "remote-browser/Keys",
) {}
export class Artifacts extends Context.Service<Artifacts, ArtifactService>()(
  "remote-browser/Artifacts",
) {}
export class Browser extends Context.Service<Browser, BrowserService>()(
  "remote-browser/Browser",
) {}
export class Clipboard extends Context.Service<Clipboard, ClipboardService>()(
  "remote-browser/Clipboard",
) {}
export type Services = Accounts | Keys | Artifacts | Browser | Clipboard;

export function serviceRuntime(dependencies: {
  accountStore: AccountStore;
  apiKeys: ApiKeyStore;
  artifactService: ArtifactService;
  browserService: BrowserService;
  clipboardService: ClipboardService;
}) {
  const layer = Layer.mergeAll(
    Layer.succeed(Accounts, dependencies.accountStore),
    Layer.succeed(Keys, dependencies.apiKeys),
    Layer.succeed(Artifacts, dependencies.artifactService),
    Layer.succeed(Browser, dependencies.browserService),
    Layer.succeed(Clipboard, dependencies.clipboardService),
  );
  return <A, E>(program: Effect.Effect<A, E, Services>) =>
    run(program.pipe(Effect.provide(layer)));
}

/** Adapt a native service method while retaining its concrete result type. */
export function useService<S, I, A>(
  service: Context.Service<S, I>,
  operation: (implementation: I) => PromiseLike<A> | A,
) {
  return Effect.flatMap(service, (implementation) =>
    attempt(() => operation(implementation)),
  );
}
