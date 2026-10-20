/** Readers for the browser's replies, which arrive as untrusted JSON. */
import { isRecord } from "./invariants.js";

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function count(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function flag(value: unknown): boolean {
  return value === true;
}
