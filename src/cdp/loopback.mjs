import { randomInt } from "node:crypto";
import { createServer } from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);

function asUrl(value, label) {
  let parsed;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    throw new TypeError(`${label} is not a valid URL`);
  }
  return parsed;
}

function assertCommonLoopbackUrl(parsed, expectedPort, label) {
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new TypeError(`${label} must use a literal loopback address`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} must not contain credentials`);
  }
  if (parsed.hash) {
    throw new TypeError(`${label} must not contain a fragment`);
  }
  if (parsed.search) {
    throw new TypeError(`${label} must not contain a query`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`${label} must contain an explicit valid port`);
  }
  if (expectedPort !== undefined && port !== Number(expectedPort)) {
    throw new TypeError(`${label} points to an unexpected port`);
  }
  return parsed;
}

export function assertLoopbackHttpUrl(value, expectedPort) {
  const parsed = assertCommonLoopbackUrl(asUrl(value, "HTTP endpoint"), expectedPort, "HTTP endpoint");
  if (parsed.protocol !== "http:") {
    throw new TypeError("HTTP endpoint must use http:");
  }
  return parsed;
}

export function assertLoopbackWebSocketUrl(value, expectedPort) {
  const parsed = assertCommonLoopbackUrl(asUrl(value, "WebSocket endpoint"), expectedPort, "WebSocket endpoint");
  if (parsed.protocol !== "ws:") {
    throw new TypeError("WebSocket endpoint must use ws:");
  }
  if (!parsed.pathname.startsWith("/devtools/")) {
    throw new TypeError("WebSocket endpoint is not a DevTools endpoint");
  }
  return parsed;
}

export function browserIdFromWebSocketUrl(value, expectedPort) {
  const parsed = assertLoopbackWebSocketUrl(value, expectedPort);
  const match = /^\/devtools\/browser\/([A-Za-z0-9._-]+)$/.exec(parsed.pathname);
  if (!match) throw new TypeError("Browser WebSocket endpoint has an invalid identity path");
  return match[1];
}

function canBind(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Selects an unused random dynamic/private port. The socket is deliberately
 * released before Appx activation, so callers must still verify the eventual
 * listener owner before trusting the endpoint.
 */
export async function chooseLoopbackPort({
  min = 49152,
  max = 65535,
  attempts = 64,
  host = "127.0.0.1",
  random = randomInt,
} = {}) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1024 || max > 65535 || min > max) {
    throw new RangeError("Invalid loopback port range");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = random(min, max + 1);
    if (await canBind(host, port)) return port;
  }
  throw new Error(`Could not find a free loopback port after ${attempts} attempts`);
}

export function isAppPageUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "app:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
