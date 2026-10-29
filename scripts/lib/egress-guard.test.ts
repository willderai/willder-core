// The egress guard selfhost:smoke preloads: a connection to any host but loopback and the
// allowed ones is refused before it is made and recorded, whichever API opened it. The
// refused hosts are TEST-NET addresses (RFC 5737), so even a broken guard reaches nothing.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const GUARD = path.join(__dirname, "egress-guard.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "egress-guard-"));

const PROBE = `
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const settle = (socket, label) => new Promise((resolve) => {
  socket.setTimeout(500, () => { socket.destroy(); resolve(label + ": attempted"); });
  socket.on("connect", () => { socket.destroy(); resolve(label + ": connected"); });
  socket.on("error", (e) => resolve(label + ": " + e.message));
});
(async () => {
  const server = http.createServer((_, res) => res.end("ok")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  const results = await Promise.all([
    settle(net.connect(5432, "192.0.2.1"), "net port-host"),
    settle(net.connect({ host: "192.0.2.2", port: 5432 }), "net options"),
    settle(tls.connect({ host: "192.0.2.3", port: 443 }), "tls"),
    fetch("https://192.0.2.5/", { signal: AbortSignal.timeout(2000) }).then(() => "fetch: connected", (e) => "fetch: " + (e.cause?.message ?? e.message)),
    settle(net.connect(5432, "192.0.2.4"), "allowed"),
    settle(net.connect(5432, "127.0.0.1.nip.invalid"), "loopback-shaped name"),
    fetch("http://127.0.0.1:" + port + "/").then((r) => r.text()).then((t) => "loopback: " + t),
    fetch("http://localhost:" + port + "/").then((r) => r.text()).then((t) => "localhost: " + t, (e) => "localhost: " + e.message),
  ]);
  server.close();
  console.log(JSON.stringify(results));
})();
`;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("egress-guard.mjs", () => {
  it("refuses and records connections to other hosts by net, tls and fetch, and lets loopback and allowed hosts through", () => {
    const log = path.join(scratch, "egress.jsonl");
    const run = spawnSync(process.execPath, [`--import=${pathToFileURL(GUARD).href}`, "-e", PROBE], {
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        SELFHOST_EGRESS_ALLOW: " 192.0.2.4 ,db.example",
        SELFHOST_EGRESS_LOG: log,
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const results = JSON.parse(run.stdout) as string[];
    const refusal = (host: string) => `selfhost egress guard: refused a connection to ${host}`;
    expect(results).toEqual([
      `net port-host: ${refusal("192.0.2.1")}`,
      `net options: ${refusal("192.0.2.2")}`,
      `tls: ${refusal("192.0.2.3")}`,
      `fetch: ${refusal("192.0.2.5")}`,
      expect.not.stringContaining("refused"),
      `loopback-shaped name: ${refusal("127.0.0.1.nip.invalid")}`,
      "loopback: ok",
      expect.stringMatching(/^localhost: (ok|.*ECONNREFUSED.*)$/),
    ]);
    const recorded = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { host: string }).host);
    expect(recorded.sort()).toEqual(["127.0.0.1.nip.invalid", "192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.5"]);
  });
});
