import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

// Follow Swarmie's shared TypeScript policy without its framework-specific rules.
export default defineConfig({
  extends: [core],
  jsPlugins: antiSlop.jsPlugins,
  ignorePatterns: core.ignorePatterns,
  options: { typeAware: true },
  rules: {
    "func-style": "off",
    "no-use-before-define": ["error", { functions: false, variables: false }],
    "sort-keys": "off",
    "unicorn/no-useless-undefined": "off",
    "no-unused-vars": [
      "error",
      { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "require-await": "off",
    "typescript/require-await": "error",
    "promise/prefer-await-to-then": "off",
    "typescript/parameter-properties": [
      "error",
      { allow: ["readonly", "private readonly", "protected readonly", "public readonly"] },
    ],
    "typescript/consistent-type-definitions": ["error", "type"],
    "typescript/no-floating-promises": ["error", { ignoreVoid: false }],
    "typescript/ban-ts-comment": [
      "error",
      { "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": "allow-with-description" },
    ],
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // Native adapters bridge callbacks, Unix flags, and ordered browser mutations.
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "no-await-in-loop": "off",
    "no-bitwise": "off",
    // Effect generators keep their service receiver and anonymous generator syntax.
    "func-names": "off",
    "typescript/no-this-alias": "off",
    "unicorn/no-this-assignment": "off",
    // Domain errors and their services belong together in the same module.
    "max-classes-per-file": "off",
    // Prefer explicit domain invariants over syntax-only restrictions.
    "no-plusplus": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/catch-error-name": ["error", { name: "cause" }],
    "typescript/return-await": ["error", "in-try-catch"],
    "typescript/strict-void-return": "off",
    // Runtime guards also accept callers without TypeScript and native union values.
    "typescript/strict-boolean-expressions": "off",
    // Public service methods retain the same instance API when implementations are stateless.
    "class-methods-use-this": "off",
    // These casts are checked at native/JSON boundaries and require SAFETY evidence.
    "typescript/no-unsafe-type-assertion": "off",
    // Empty strings and zero deliberately trigger UI and environment fallbacks.
    "typescript/prefer-nullish-coalescing": "off",
    // Control acquisition deliberately throws synchronously before returning its waiter.
    "typescript/promise-function-async": "off",
    // Dashboard IDs are a fixed contract, so use the direct ID lookup.
    "unicorn/prefer-query-selector": "off",
    // Keep ordered protocol/state cases and their local helpers together.
    complexity: "off",
    "unicorn/consistent-function-scoping": "off",
    "no-nested-ternary": "off",
    // Callback validation and settlement may contain several mutually exclusive exits.
    "promise/no-multiple-resolved": "off",
    // Positional protocol fields and the first response in a fixture stay explicit.
    "prefer-destructuring": ["error", { array: false, object: true }],
    // Effect's named self receiver is part of its generator API, not Array iteration.
    "unicorn/no-array-method-this-argument": "off",
  },
  overrides: [
    ...core.overrides,
    {
      files: ["**/*.{test,spec}.{ts,tsx,js,mjs}"],
      // Async fixture adapters preserve rejection semantics without fake awaits.
      // node:test owns test registration promises and controls teardown scheduling.
      rules: { "typescript/require-await": "off", "typescript/no-floating-promises": "off" },
    },
    {
      // Synthetic fixtures intentionally model partial native and transport objects.
      // Their runtime assertions validate behavior; production code retains typed checks.
      files: ["test/**/*.ts", "scripts/integration.ts"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-confusing-void-expression": "off",
      },
    },
    {
      files: ["scripts/integration.ts"],
      // Rendered UI assertions must exclude labels hidden by responsive styles.
      rules: { "unicorn/prefer-dom-node-text-content": "off" },
    },
    {
      files: ["ui/{app,contracts}.ts"],
      // The gateway serves pinned noVNC modules from this absolute browser URL.
      rules: { "import/no-absolute-path": "off" },
    },
    {
      files: ["scripts/runtime.ts"],
      // Effect generators return failed effects early and complete successfully with void.
      rules: { "typescript/consistent-return": "off" },
    },
    {
      files: ["test/**/*.ts"],
      // Fixtures mimic Node EventEmitter APIs and deliberately exercise hostile inputs.
      rules: { "unicorn/prefer-event-target": "off", "no-script-url": "off" },
    },
    {
      files: ["test/playwright-code-mode.test.ts"],
      rules: { "typescript/only-throw-error": "off", "no-throw-literal": "off" },
    },
  ],
});
