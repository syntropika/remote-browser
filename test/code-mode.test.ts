import assert from "node:assert/strict";
import test from "node:test";

import { prepareCodeMode, transformCodeModeResponse } from "../src/code-mode.js";
import { requiresControl } from "../src/mcp-proxy.js";

const request = (name, args = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const prepare = (message) => prepareCodeMode(Buffer.from(JSON.stringify(message)));
const envelope = (fields = {}) => ({
  __remoteBrowserCodeMode: 1,
  ok: true,
  value: { title: "Example" },
  images: [],
  durationMs: 12,
  ...fields,
});
const response = (value, id = 1) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [
      {
        type: "text",
        text: `### Result\n${JSON.stringify(value)}\n### Ran Playwright code\nSECRET_SHOULD_NOT_BE_RETURNED\n### Page\nVerbose snapshot`,
      },
    ],
  },
});
const transformed = (message, prepared) =>
  JSON.parse(
    transformCodeModeResponse(Buffer.from(JSON.stringify(message)), "application/json", prepared),
  );

test("the catalog exposes code-mode and tab coordination tools after a successful upstream list", () => {
  const prepared = prepare({
    jsonrpc: "2.0",
    id: "catalog",
    method: "tools/list",
  });
  const output = transformed(
    {
      jsonrpc: "2.0",
      id: "catalog",
      result: { tools: [{ name: "browser_click" }], nextCursor: "obsolete" },
    },
    prepared,
  );
  assert.deepEqual(
    output.result.tools.map((tool) => tool.name),
    ["browser_docs", "browser_execute", "browser_tabs"],
  );
  assert.equal(output.result.nextCursor, undefined);
  const error = {
    jsonrpc: "2.0",
    id: "catalog",
    error: { code: -32_602, message: "Unsupported protocol" },
  };
  assert.deepEqual(transformed(error, prepared), error);
});

test("docs validate through upstream ping and remain available during human control", () => {
  const message = request("browser_docs", { topic: "screenshots" });
  const prepared = prepare(message);
  assert.deepEqual(JSON.parse(prepared.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  });
  const output = transformed({ jsonrpc: "2.0", id: 1, result: {} }, prepared);
  assert.match(output.result.content[0].text, /image\(await page.screenshot/u);
  assert.equal(requiresControl("POST", message), false);
  assert.equal(requiresControl("POST", request("browser_execute", { code: "return 1;" })), true);
  assert.equal(requiresControl("POST", request("browser_docs_extra")), true);
  assert.equal(
    requiresControl("POST", {
      method: "other",
      params: { name: "browser_docs" },
    }),
    true,
  );
  assert.equal(requiresControl("POST", [message, request("browser_click")]), true);
  assert.equal(requiresControl("DELETE", message), true);
});

test("execute wraps native Playwright code without running it in the gateway", () => {
  delete globalThis.codeModeShouldNeverRun;
  const code =
    'globalThis.codeModeShouldNeverRun = true; await page.getByRole("button").click(); return await page.title();';
  const prepared = prepare(request("browser_execute", { code }));
  const upstream = JSON.parse(prepared.body);
  assert.equal(upstream.params.name, "browser_run_code_unsafe");
  assert.match(
    upstream.params.arguments.code,
    /page\.__remoteBrowserCodeMode.run\(page, async \(\{ page, context, browser, image, files, recording \}\)/u,
  );
  assert.ok(upstream.params.arguments.code.includes(code));
  assert.equal(globalThis.codeModeShouldNeverRun, undefined);
});

test("tab targeting forwards validated coordinates and only the gateway supplies owner", () => {
  const prepared = prepareCodeMode(
    Buffer.from(
      JSON.stringify(
        request("browser_execute", {
          code: "return page.url();",
          tabId: "target",
          leaseId: "task-token",
        }),
      ),
    ),
    "authenticated-key",
  );
  const script = JSON.parse(prepared.body).params.arguments.code;
  assert.ok(script.includes('"tabId":"target"'));
  assert.ok(script.includes('"leaseId":"task-token"'));
  assert.ok(script.includes('"owner":"authenticated-key"'));
  for (const args of [
    { code: "return 1;", tabId: "" },
    { code: "return 1;", tabId: 1 },
    { code: "return 1;", leaseId: "token" },
    { code: "return 1;", tabId: "target", owner: "forged" },
  ]) {
    assert.equal(prepare(request("browser_execute", args)).executes, false);
  }
});

test("tab management is generated without client code and validates action-specific arguments", () => {
  for (const args of [
    { action: "list" },
    { action: "reserve", tabId: "tab", task: "Research", ttlMs: 1000 },
    { action: "renew", tabId: "tab", leaseId: "token" },
    { action: "release", tabId: "tab", leaseId: "token" },
  ]) {
    const prepared = prepare(request("browser_tabs", args));
    assert.equal(prepared.executes, true);
    const script = JSON.parse(prepared.body).params.arguments.code;
    assert.ok(script.includes(`browser.tabs.${args.action}(`));
    assert.ok(script.includes('"manageTabs":true'));
    assert.equal(requiresControl("POST", request("browser_tabs", args)), true);
  }
  for (const args of [
    {},
    { action: "close" },
    { action: "list", tabId: "tab" },
    { action: "reserve" },
    { action: "renew", tabId: "tab" },
    { action: "release", tabId: "tab", leaseId: "token", ttlMs: 1000 },
    { action: "reserve", tabId: "tab", ttlMs: 0 },
    { action: "reserve", tabId: "tab", owner: "forged" },
  ]) {
    assert.equal(prepare(request("browser_tabs", args)).executes, false);
  }
});

test("invalid code and arguments return compact tool errors after upstream session validation", () => {
  for (const args of [
    {},
    { code: " " },
    { code: 12 },
    { code: "a".repeat(32_769) },
    { code: "if (" },
    { code: "return 1;", extra: true },
  ]) {
    const prepared = prepare(request("browser_execute", args));
    assert.equal(JSON.parse(prepared.body).method, "ping");
    const output = transformed({ jsonrpc: "2.0", id: 1, result: {} }, prepared);
    assert.equal(output.result.isError, true);
    assert.equal(output.result.structuredContent.ok, false);
    const expired = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32_000, message: "Session expired" },
    };
    assert.deepEqual(transformed(expired, prepared), expired);
  }
  const prepared = prepare(request("browser_docs", { topic: "secrets" }));
  assert.equal(transformed({ jsonrpc: "2.0", id: 1, result: {} }, prepared).result.isError, true);
  const nullArgs = prepare(request("browser_docs", null));
  assert.equal(transformed({ jsonrpc: "2.0", id: 1, result: {} }, nullArgs).result.isError, true);
});

test("execution output separates screenshots from compact JSON and removes echoed code", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
  const prepared = prepare(request("browser_execute", { code: "return 1;" }));
  const output = transformed(
    response(envelope({ images: [{ mimeType: "image/png", data: png }] })),
    prepared,
  ).result;
  assert.deepEqual(output.structuredContent, {
    ok: true,
    value: { title: "Example" },
    durationMs: 12,
  });
  assert.deepEqual(JSON.parse(output.content[0].text), output.structuredContent);
  assert.deepEqual(output.content[1], {
    type: "image",
    mimeType: "image/png",
    data: png,
  });
  assert.equal(output.content[0].text.includes(png), false);
  assert.equal(JSON.stringify(output).includes("SECRET_SHOULD_NOT_BE_RETURNED"), false);
});

test("ordinary script errors are compact tool errors, while missing completions fail closed", () => {
  const prepared = prepare(request("browser_execute", { code: "return 1;" }));
  const output = transformed(
    response(
      envelope({
        ok: false,
        value: null,
        error: {
          name: "TimeoutError",
          message: "The button was not found.",
          stack: "PRIVATE_STACK",
        },
      }),
    ),
    prepared,
  ).result;
  assert.equal(output.isError, true);
  assert.deepEqual(output.structuredContent.error, {
    name: "TimeoutError",
    message: "The button was not found.",
  });
  assert.equal(JSON.stringify(output).includes("PRIVATE_STACK"), false);
  const unicodeError = transformed(
    response(
      envelope({
        ok: false,
        error: { name: "Error", message: "\u0000💻".repeat(4096) },
      }),
    ),
    prepared,
  ).result.structuredContent.error;
  assert.ok(Buffer.byteLength(JSON.stringify(unicodeError)) <= 4096);
  assert.throws(
    () => transformed({ jsonrpc: "2.0", id: 1, result: {} }, prepared),
    /completion envelope/u,
  );
  assert.throws(
    () => transformed({ jsonrpc: "2.0", method: "notifications/message" }, prepared),
    /incomplete/u,
  );
  assert.throws(
    () =>
      transformed(
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            content: [{ type: "text", text: "ECHOED_CREDENTIAL" }],
          },
        },
        prepared,
      ),
    (error) =>
      /completion envelope/u.test(error.message) && !error.message.includes("ECHOED_CREDENTIAL"),
  );
});

test("output bounds prevent oversized data and unsupported screenshots", () => {
  const prepared = prepare(request("browser_execute", { code: "return 1;" }));
  assert.equal(
    transformed(response(envelope({ value: "a".repeat(32_769) })), prepared).result.isError,
    true,
  );
  assert.equal(
    transformed(response(envelope({ images: [{}, {}, {}] })), prepared).result.isError,
    true,
  );
  assert.throws(
    () =>
      transformed(response(envelope({ images: [{ mimeType: "text/html", data: "" }] })), prepared),
    /Invalid screenshot/u,
  );
  assert.throws(
    () =>
      transformed(
        response(
          envelope({
            images: [
              {
                mimeType: "image/png",
                data: Buffer.from("not png").toString("base64"),
              },
            ],
          }),
        ),
        prepared,
      ),
    /does not match/u,
  );
  const largeScreenshot = Buffer.alloc(1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(largeScreenshot);
  const image = {
    mimeType: "image/png",
    data: largeScreenshot.toString("base64"),
  };
  assert.equal(
    transformed(response(envelope({ images: [image] })), prepared).result.content[1].data,
    image.data,
  );
});

test("SSE comments, event IDs and notifications survive response replacement", () => {
  const prepared = prepare(request("browser_execute", { code: "return 1;" }));
  const notification =
    'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"Ready"}}';
  const source = `: keep-alive\r\n\r\n${notification}\r\n\r\nid: event-2\r\nevent: message\r\ndata: ${JSON.stringify(response(envelope()))}\r\n\r\n`;
  const output = transformCodeModeResponse(
    Buffer.from(source),
    "text/event-stream; charset=utf-8",
    prepared,
  );
  assert.ok(output.startsWith(`: keep-alive\r\n\r\n${notification}\r\n\r\n`));
  assert.ok(output.includes("id: event-2\r\nevent: message\r\ndata: "));
  assert.equal(output.includes("SECRET_SHOULD_NOT_BE_RETURNED"), false);
  assert.match(output, /structuredContent/u);
});

test("legacy names, initialize and notifications are passed through unchanged", () => {
  for (const message of [
    request("browser_navigate", { url: "https://example.com" }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]) {
    const prepared = prepare(message);
    assert.deepEqual(JSON.parse(prepared.body), message);
    assert.equal(prepared.plans.size, 0);
  }
});

test("initialization advertises documentation resources and resources use the same live reference without control", () => {
  const initialized = prepare({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const handshake = transformed(
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "upstream" },
        instructions: "Do not expose upstream tool instructions",
        capabilities: { tools: {} },
      },
    },
    initialized,
  ).result;
  assert.equal(handshake.protocolVersion, "2024-11-05");
  assert.ok(handshake.capabilities.resources);
  assert.equal(handshake.instructions, undefined);
  const message = { jsonrpc: "2.0", id: 2, method: "resources/list" };
  const catalog = transformed({ jsonrpc: "2.0", id: 2, result: {} }, prepare(message)).result;
  assert.ok(
    catalog.resources.some((resource) => resource.uri === "remote-browser://docs/inspection"),
  );
  assert.equal(requiresControl("POST", message), false);
  const read = {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: "remote-browser://docs/inspection" },
  };
  const resource = transformed({ jsonrpc: "2.0", id: 3, result: {} }, prepare(read)).result
    .contents[0];
  const docs = transformed(
    { jsonrpc: "2.0", id: 4, result: {} },
    prepare(request("browser_docs", { topic: "inspection" }, 4)),
  ).result.content[0];
  assert.equal(resource.text, docs.text);
  assert.equal(requiresControl("POST", read), false);
  const unknown = { ...read, params: { uri: "file:///etc/passwd" } };
  const failed = transformed({ jsonrpc: "2.0", id: 3, result: {} }, prepare(unknown));
  assert.equal(failed.error.code, -32_002);
  assert.equal(failed.result, undefined);
});
