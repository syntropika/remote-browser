/** Reservation-bound helpers for the embedded JavaScript runtime. */
declare const __call: (tool: string, argumentsJson: string) => string;
type Target = string | { role: string; name: string };
type Field = { target: Target; value: string };
type Cursor = { after?: number; limit?: number };

((call: typeof __call) => {
  // oxlint-disable-next-line typescript/require-await -- Async converts synchronous bridge errors into rejected promises.
  const invoke = async (tool: string, args: object = {}): Promise<unknown> => {
    const response: unknown = JSON.parse(call(tool, JSON.stringify(args)));
    if (
      typeof response !== "object" ||
      response === null ||
      !("value" in response || "error" in response)
    ) {
      throw new Error("Invalid page bridge response");
    }
    if ("error" in response && typeof response.error === "string") {
      throw new Error(response.error);
    }
    return "value" in response ? response.value : null;
  };
  const locator = (target: Target) =>
    Object.freeze({
      click: () => invoke("browser_click", { target }),
      fill: (text: string) => invoke("browser_type", { target, text }),
      type: (text: string, options: { submit?: boolean; slowly?: boolean } = {}) =>
        invoke("browser_type", { ...options, target, text }),
      press: (key: string) => invoke("browser_press_key", { target, key }),
      hover: () => invoke("browser_hover", { target }),
      selectOption: (values: string | string[]) =>
        invoke("browser_select_option", {
          target,
          values: Array.isArray(values) ? values : [values],
        }),
    });
  Object.defineProperty(globalThis, "page", {
    value: Object.freeze({
      goto: (url: string) => invoke("browser_navigate", { url }),
      goBack: () => invoke("browser_navigate_back"),
      reload: () => invoke("browser_reload"),
      snapshot: (options: { maxElements?: number } = {}) => invoke("browser_snapshot", options),
      find: (text: string) => invoke("browser_find", { text }),
      locator,
      getByRole: (role: string, { name }: { name: string }) => locator({ role, name }),
      click: (target: Target) => invoke("browser_click", { target }),
      fill: (target: Target, text: string) => invoke("browser_type", { target, text }),
      fillForm: (fields: Field[]) => invoke("browser_fill_form", { fields }),
      selectOption: (target: Target, values: string | string[]) =>
        locator(target).selectOption(values),
      hover: (target: Target) => invoke("browser_hover", { target }),
      drag: (startTarget: Target, endTarget: Target) =>
        invoke("browser_drag", { startTarget, endTarget }),
      press: (key: string) => invoke("browser_press_key", { key }),
      scroll: (x: number, y: number) => invoke("browser_scroll", { x, y }),
      waitForText: (text: string, timeoutMs = 5000) =>
        invoke("browser_wait_for", { text, timeoutMs }),
      waitFor: (options: { text?: string; textGone?: string; timeoutMs?: number }) =>
        invoke("browser_wait_for", options),
      handleDialog: (accept: boolean, promptText?: string) =>
        invoke("browser_handle_dialog", { accept, promptText }),
      evaluate: async (fn: string | (() => unknown)) => {
        const response = await invoke("browser_evaluate", {
          function: typeof fn === "function" ? fn.toString() : fn,
        });
        if (typeof response !== "object" || response === null || !("value" in response)) {
          throw new Error("Invalid evaluation result");
        }
        return response.value;
      },
      screenshot: (options: { fullPage?: boolean } = {}) =>
        invoke("browser_take_screenshot", options),
      consoleMessages: (options: Cursor = {}) => invoke("browser_console_messages", options),
      networkRequests: (options: Cursor = {}) => invoke("browser_network_requests", options),
      upload: (target: Target, fileIds: string[]) => invoke("browser_upload", { target, fileIds }),
      download: (url: string, name: string) => invoke("browser_download", { url, name }),
    }),
  });
})(__call);
Reflect.deleteProperty(globalThis, "__call");
