/** Native activation across local/remote ancestors, descendants and consumption. */
import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { STYLE, STATE } from "./fixtures/user-activation-smoke.js";
import { cli, assert, withEngine, wait } from "./harness.js";
import type { Wire } from "./harness.js";

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

function framePage(query: URLSearchParams) {
  const name = JSON.stringify(query.get("name"));
  const nest = query.get("nest");
  return `<!doctype html>${STYLE}<button>Frame button</button>${nest ? `<iframe style="left:0;width:200px;height:150px" src="${escape(nest)}"></iframe>` : ""}<script>${STATE}const post=data=>top.postMessage(Object.assign({frame:${name},state:state()},data),'*');document.querySelector('button').onclick=e=>post({clicked:true,trusted:e.isTrusted});onmessage=e=>{const d=e.data||{};if(d.relay)frames[0].postMessage(d.relay,'*');if(d.cmd==='query')post({seq:d.seq});if(d.cmd==='synthetic'){document.querySelector('button').click();post({seq:d.seq});}};requestAnimationFrame(()=>requestAnimationFrame(()=>post({ready:true})));</script>`;
}

function topPage(query: URLSearchParams) {
  return `<!doctype html>${STYLE}<button>Top button</button>${query
    .getAll("src")
    .map(
      (source, index) =>
        `<iframe id="f${index}" allow="fullscreen" style="left:${index * 320}px;width:300px;height:300px" src="${escape(source)}"></iframe>`,
    )
    .join(
      "",
    )}<script>${STATE}window.log={};window.topClick=null;window.layoutReady=false;window.frame=index=>document.getElementById('f'+index).contentWindow;onmessage=e=>{if(e.data&&e.data.frame)log[e.data.frame]=Object.assign(log[e.data.frame]||{},e.data);};document.querySelector('button').onclick=e=>topClick={trusted:e.isTrusted};requestAnimationFrame(()=>requestAnimationFrame(()=>layoutReady=true));</script>`;
}

function url(origin: string, path: string, params: Record<string, string | string[]>) {
  const result = new URL(path, origin);
  for (const [key, values] of Object.entries(params)) {
    for (const value of Array.isArray(values) ? values : [values]) {
      result.searchParams.append(key, value);
    }
  }
  return result.href;
}

const inactive = { active: false, sticky: false };

const active = { active: true, sticky: true };

const consumed = { active: false, sticky: true };

export async function run(binary: string, _host: string, args: Record<string, Wire> = {}) {
  const servers = ["127.0.0.1", "127.0.0.1", "127.0.0.2"].map((hostname) =>
    Bun.serve({
      hostname,
      port: 0,
      fetch(request) {
        const u = new URL(request.url);
        return new Response(
          u.pathname === "/frame" ? framePage(u.searchParams) : topPage(u.searchParams),
          { headers: { "Content-Type": "text/html" } },
        );
      },
    }),
  );
  const a = servers[0].url.origin;
  const b = a.replace("127.0.0.1", "localhost");
  const c = servers[2].url.origin;
  const d = servers[1].url.origin;
  const results: Record<string, Wire> = {};
  const failures: string[] = [];
  try {
    await withEngine(binary, async (engine) => {
      const tab = (await engine.call("tabs"))[0].id;
      let sequence = 0;
      const evaluate = (script: string) => engine.call("evaluate", tab, { script });
      const ready = (script: string, ms = 6000) => wait(() => evaluate(script), Boolean, ms);
      const load = async (address: string, names: string[]) => {
        await engine.call("navigate", tab, { url: address });
        await ready(
          `return ${["layoutReady", ...names.map((name) => `log[${JSON.stringify(name)}]?.ready`)].join("&&")};`,
        );
      };
      const query = async (target: string, name: string) => {
        sequence++;
        let message: Wire = { cmd: "query", seq: sequence };
        for (let i = 0; i < (target.match(/\.relay/gu) || []).length; i++) {
          message = { relay: message };
        }
        await evaluate(
          `${target.split(".relay")[0]}.postMessage(${JSON.stringify(message)},'*');return true;`,
        );
        await ready(`return log[${JSON.stringify(name)}]?.seq===${sequence};`);
        return evaluate(`return log[${JSON.stringify(name)}].state;`);
      };
      const poll = (target: string, name: string, expected: Wire) =>
        wait(
          () => query(target, name),
          (value) => isDeepStrictEqual(value, expected),
        );
      const top = () => evaluate("return state();");
      const click = async (x: number, y: number) => {
        await engine.call("take", tab, {}, { human: true });
        await engine.call("input", tab, { kind: "click", x, y }, { human: true });
        await engine.call("return", tab, {}, { human: true });
      };
      const check = (name: string, label: string, actual: Wire, expected: Wire) => {
        (results[name] ??= {})[label] = actual;
        try {
          assert.deepEqual(actual, expected);
        } catch (cause) {
          failures.push(`${name}/${label}: ${String(cause)}`);
        }
      };
      for (const [name, origin] of [
        ["same", a],
        ["cross", b],
      ]) {
        await load(url(a, "/top", { src: url(origin, "/frame", { name: "child" }) }), ["child"]);
        check(name, "topBefore", await top(), inactive);
        check(name, "childBefore", await query("frame(0)", "child"), inactive);
        sequence++;
        await evaluate(`frame(0).postMessage({cmd:'synthetic',seq:${sequence}},'*');return true;`);
        await ready(`return log.child.seq===${sequence};`);
        check(name, "syntheticTrusted", await evaluate("return log.child.trusted;"), false);
        check(name, "childAfterSynthetic", await evaluate("return log.child.state;"), inactive);
        check(name, "topAfterSynthetic", await top(), inactive);
        await click(50, 140);
        check(
          name,
          "childAfterClick",
          await ready("return log.child.trusted&&log.child.state;"),
          active,
        );
        check(name, "topAfterClick", await ready("return state().sticky&&state();"), active);
      }
      check("consumption", "topBeforeFullscreen", await top(), active);
      await evaluate(
        "window.fullscreen='pending';document.documentElement.requestFullscreen().then(()=>fullscreen='entered',e=>fullscreen=e.name);return true;",
      );
      await ready("return fullscreen!=='pending';");
      check("consumption", "fullscreen", await evaluate("return fullscreen;"), "entered");
      check("consumption", "topAfterConsumption", await top(), consumed);
      check(
        "consumption",
        "childAfterConsumption",
        await poll("frame(0)", "child", consumed),
        consumed,
      );
      await evaluate("if(document.fullscreenElement)document.exitFullscreen();return true;");
      await evaluate(
        `document.getElementById('f0').src=${JSON.stringify(url(c, "/frame", { name: "next" }))};return true;`,
      );
      check("navigation", "nextReady", Boolean(await ready("return log.next?.ready;")), true);
      check("navigation", "nextBefore", await query("frame(0)", "next"), inactive);
      check("navigation", "topBefore", await top(), consumed);
      await click(50, 140);
      check(
        "navigation",
        "nextAfterClick",
        await ready("return log.next.trusted&&log.next.state;"),
        active,
      );
      check("navigation", "topAfterClick", await ready("return state().active&&state();"), active);
      await load(
        url(a, "/top", {
          src: url(b, "/frame", { name: "middle", nest: url(a, "/frame", { name: "inner" }) }),
        }),
        ["middle", "inner"],
      );
      check(
        "ancestors",
        "before",
        [await top(), await query("frame(0)", "middle"), await query("frame(0).relay", "inner")],
        [inactive, inactive, inactive],
      );
      await click(50, 240);
      check(
        "ancestors",
        "innerAfterClick",
        await ready("return log.inner.trusted&&log.inner.state;"),
        active,
      );
      check("ancestors", "middleAfterClick", await poll("frame(0)", "middle", active), active);
      check("ancestors", "topAfterClick", await ready("return state().active&&state();"), active);
      await load(
        url(a, "/top", {
          src: [
            url(b, "/frame", { name: "middle", nest: url(a, "/frame", { name: "inner" }) }),
            url(d, "/frame", { name: "port" }),
          ],
        }),
        ["middle", "inner", "port"],
      );
      check(
        "descendants",
        "before",
        [
          await top(),
          await query("frame(0)", "middle"),
          await query("frame(0).relay", "inner"),
          await query("frame(1)", "port"),
        ],
        [inactive, inactive, inactive, inactive],
      );
      await click(50, 40);
      check(
        "descendants",
        "topClickTrusted",
        await ready("return topClick&&topClick.trusted;"),
        true,
      );
      check("descendants", "topAfterClick", await top(), active);
      check(
        "descendants",
        "sameOriginInnerAfterClick",
        await poll("frame(0).relay", "inner", active),
        active,
      );
      check(
        "descendants",
        "crossOriginMiddleAfterClick",
        await query("frame(0)", "middle"),
        inactive,
      );
      check("descendants", "crossOriginPortAfterClick", await query("frame(1)", "port"), inactive);
      await load(url(a, "/top", { src: "about:blank" }), []);
      const inherited = framePage(
        new URLSearchParams({
          name: "inherited",
          nest: url(b, "/frame", { name: "middle", nest: url(a, "/frame", { name: "inner" }) }),
        }),
      );
      await evaluate(
        `document.getElementById('f0').srcdoc=${JSON.stringify(inherited)};return true;`,
      );
      check(
        "inheritedSender",
        "ready",
        Boolean(await ready("return log.inherited?.ready&&log.middle?.ready&&log.inner?.ready;")),
        true,
      );
      check(
        "inheritedSender",
        "before",
        [
          await top(),
          await query("frame(0)", "inherited"),
          await query("frame(0).relay", "middle"),
          await query("frame(0).relay.relay", "inner"),
        ],
        [inactive, inactive, inactive, inactive],
      );
      await click(50, 140);
      check(
        "inheritedSender",
        "senderAfterClick",
        await ready("return log.inherited.trusted&&log.inherited.state;"),
        active,
      );
      check("inheritedSender", "topAfterClick", await top(), active);
      check(
        "inheritedSender",
        "sameOriginInnerAfterClick",
        await poll("frame(0).relay.relay", "inner", active),
        active,
      );
      check(
        "inheritedSender",
        "crossOriginMiddleAfterClick",
        await query("frame(0).relay", "middle"),
        inactive,
      );
      check("engine", "uncertain", (await engine.call("status")).uncertain, false);
    });
  } finally {
    for (const server of servers) {
      await server.stop(true);
    }
    if (args.results) {
      await writeFile(args.results, `${JSON.stringify({ results, failures }, null, 2)}\n`);
    }
  }
  console.log(JSON.stringify(results));
  assert.deepEqual(failures, []);
  console.log(
    "PASS: trusted activation propagation, same-origin descendants, consumption, navigation and untrusted click exclusion",
  );
}

if (import.meta.main) {
  await cli(run);
}
