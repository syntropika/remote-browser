/** Narrow untrusted JSON objects before reading their fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJson(source: string): unknown {
  return JSON.parse(source);
}

export function jsonObject(source: string): Record<string, unknown> {
  const value = parseJson(source);
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value;
}

/** Native APIs cannot express every presence invariant established by their callers. */
export function required<A>(value: A | null | undefined): A {
  if (value === null || value === undefined) {
    throw new Error("A required native value is unavailable.");
  }
  return value;
}
