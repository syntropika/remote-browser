import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  printWidth: 100,
  trailingComma: "all",
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    "**/*.md",
    "**/*.toml",
    "**/target/**",
    "src/host/ui/app.js",
    "src/host/ui/app.css",
  ],
});
