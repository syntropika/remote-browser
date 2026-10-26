import { assert, serve, withEngine } from "./harness.js";
import type { Engine, Wire } from "./harness.js";

export { assert, wait, sleep } from "./harness.js";

export async function pointerFixture(
  binary: string,
  pages: Record<string, string | ((origin: string) => string)>,
  run: (context: {
    engine: Engine;
    tab: string;
    evaluate: (script: string) => Promise<Wire>;
    human: (kind: string, x?: number, y?: number, error?: boolean) => Promise<Wire>;
    click: (x: number, y: number) => Promise<void>;
    origin: string;
  }) => Promise<void>,
) {
  const server = serve((request, origin) => {
    const page = pages[new URL(request.url).pathname] ?? pages["/"];
    return new Response(typeof page === "function" ? page(origin) : page, {
      headers: { "Content-Type": "text/html" },
    });
  });
  try {
    await withEngine(binary, async (engine) => {
      const tab = (await engine.call("tabs"))[0].id;
      const evaluate = (script: string) => engine.call("evaluate", tab, { script });
      const human = (kind: string, x?: number, y?: number, error = false) =>
        engine.call(
          "input",
          tab,
          { kind, ...(x === undefined ? {} : { x, y }) },
          { human: true, error },
        );
      const click = async (x: number, y: number) => {
        await engine.call("take", tab, {}, { human: true });
        await human("click", x, y);
        await engine.call("return", tab, {}, { human: true });
      };
      await engine.call("navigate", tab, { url: server.origin });
      await run({ engine, tab, evaluate, human, click, origin: server.origin });
      assert(!(await engine.call("status")).uncertain);
    });
  } finally {
    await server.stop();
  }
}
