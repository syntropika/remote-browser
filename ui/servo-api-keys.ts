import { required } from "../src/invariants.js";
import { createApiKeys } from "./api-keys.js";
import type { UiOptions } from "./contracts.js";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    createServoApiKeys: (options: UiOptions) => ReturnType<typeof createApiKeys>;
  }
}

window.createServoApiKeys = (options) =>
  createApiKeys({
    ...options,
    workspace: required(document.getElementById("app")),
    backgroundSelector: ":scope > :not(.settings-panel)",
  });
