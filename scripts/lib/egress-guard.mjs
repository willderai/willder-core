// Refuses, and records, every TCP connection this Node process opens to a host it was not
// told about. `npm run selfhost:smoke` preloads it (node --import) into each process it
// starts, so a self-hosted install that calls out to anything besides its own database,
// its memory service and the model endpoint fails the smoke instead of passing quietly.
//
// The one rule: only loopback and the hosts in SELFHOST_EGRESS_ALLOW (comma-separated)
// are reached. Any other connection is destroyed before it is made (before its DNS lookup,
// too) and appended as one JSON line to the file SELFHOST_EGRESS_LOG names. It covers TCP
// and TLS through node:net, which fetch, node-postgres and the Neo4j driver all use; UDP
// and child processes that do not preload it are outside it.
import { appendFileSync } from "node:fs";
import net from "node:net";

const allowed = new Set(
  (process.env.SELFHOST_EGRESS_ALLOW ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const logFile = process.env.SELFHOST_EGRESS_LOG;

/** True for `localhost` or a literal loopback address; never for a hostname that only starts with `127.`. */
function isLoopback(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  const v4 = bare.startsWith("::ffff:") ? bare.slice("::ffff:".length) : bare;
  return net.isIPv4(v4) && v4.startsWith("127.");
}

/** The host a Socket#connect call targets, or null for a local IPC path. */
function targetHost(args) {
  // net.connect() normalizes its arguments into an array before calling Socket#connect.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") return null;
    return typeof first.host === "string" && first.host !== "" ? first.host : "localhost";
  }
  const rest = Array.isArray(args[0]) ? args[0].slice(1) : args.slice(1);
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  return typeof rest[0] === "string" && rest[0] !== "" ? rest[0] : "localhost";
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = targetHost(args);
  if (host === null || isLoopback(host) || allowed.has(host.replace(/^\[|\]$/g, "").toLowerCase())) {
    return connect.apply(this, args);
  }
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ host, pid: process.pid, at: new Date().toISOString() })}\n`);
  process.nextTick(() => this.destroy(new Error(`selfhost egress guard: refused a connection to ${host}`)));
  return this;
};
