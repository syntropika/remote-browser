/** Exercise the shipped client's HTTPS/WSS trust and framing without changing system trust. */
import filePath from "node:path";

import { assert, INIT, Rpc, Mcp, wait } from "../harness.js";

const { join } = filePath;
export async function verifyTlsNetwork(binary: string, root: string) {
  const key = join(root, "tls-server.key");
  const cert = join(root, "tls-server.crt");
  const ca = join(root, "tls-ca.crt");
  const caKey = join(root, "tls-ca.key");
  const csr = join(root, "tls-server.csr");
  const extensions = join(root, "tls-extensions.txt");
  await Bun.write(
    extensions,
    "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  for (const args of [
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      ca,
      "-days",
      "1",
      "-subj",
      "/CN=Remote Browser Test CA",
    ],
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost"],
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-extfile",
      extensions,
    ],
  ]) {
    const child = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "ignore" });
    assert.equal(await child.exited, 0, "Could not create the disposable TLS fixture");
  }
  const secret = "synthetic-tls-network-client-key-only";
  const session = crypto.randomUUID();
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("tls-network-ok"),
  });
  let received = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request, service) {
      if (request.headers.get("authorization") !== `Bearer ${secret}`) {
        return new Response(null, { status: 401 });
      }
      const url = new URL(request.url);
      if (url.pathname.endsWith("/connect") && service.upgrade(request)) {
        return undefined;
      }
      if (url.pathname === "/mcp") {
        const value: unknown = await request.json();
        if (!value || typeof value !== "object" || !("id" in value)) {
          return new Response(null, { status: 202 });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            protocolVersion: INIT.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "tls-fixture", version: "1" },
          },
        });
      }
      return Response.json({ networkSessionId: session, profileId: "default", connected: true });
    },
    websocket: {
      open(socket) {
        socket.send(
          JSON.stringify({ type: "open", id: 1, host: "127.0.0.1", port: destination.port }),
        );
      },
      message(socket, message) {
        if (typeof message === "string") {
          const value: unknown = JSON.parse(message);
          if (value && typeof value === "object" && "type" in value && value.type === "connected") {
            const request = Buffer.from(
              "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            );
            const frame = Buffer.alloc(request.length + 4);
            frame.writeUInt32BE(1);
            request.copy(frame, 4);
            socket.send(frame);
          }
        } else {
          received += message.subarray(4).toString();
        }
      },
    },
  });
  const clients: Rpc[] = [];
  try {
    const connect = (trusted: boolean) => {
      const client = new Rpc([binary, "mcp", "--connect", `https://localhost:${server.port}`], {
        ...process.env,
        REMOTE_BROWSER_API_KEY: secret,
        SSL_CERT_FILE: trusted ? ca : join(root, "missing-ca.pem"),
        SSL_CERT_DIR: join(root, "missing-certificates"),
      });
      clients.push(client);
      return client;
    };
    const rejected = await connect(false).send({
      jsonrpc: "2.0",
      method: "initialize",
      params: INIT,
    });
    assert(rejected.error, "An untrusted TLS server must be rejected");
    const rpc = connect(true);
    const mcp = new Mcp(rpc);
    await mcp.request("initialize", INIT);
    await mcp.call("browser_network", {
      action: "open",
      exposeNetwork: `127.0.0.1:${destination.port}`,
    });
    await wait(() => received.includes("tls-network-ok"));
    for (const client of clients) {
      assert(!client.logs.join("\n").includes(secret));
    }
  } finally {
    for (const client of clients) {
      await client.exit(false);
    }
    await Promise.all([server.stop(true), destination.stop(true)]);
  }
}
