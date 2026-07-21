import { CodexQuotaError, ERROR_CODES } from "../errors.mjs";
import {
  assertLoopbackWebSocketUrl,
  browserIdFromWebSocketUrl,
  isAppPageUrl,
} from "./loopback.mjs";

async function responseTextWithLimit(response, maxBytes) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("CDP discovery response exceeded the size limit");
  }
  return text;
}

export async function fetchCdpJson(pathname, {
  port,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
  maxBytes = 1024 * 1024,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Invalid CDP port");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (pathname !== "/json/version" && pathname !== "/json/list") {
    throw new TypeError("Only the required CDP JSON discovery paths are allowed");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${pathname}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
    return JSON.parse(await responseTextWithLimit(response, maxBytes));
  } finally {
    clearTimeout(timer);
  }
}

export function parseBrowserVersion(payload, port) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Invalid /json/version response");
  }
  const webSocketDebuggerUrl = String(payload.webSocketDebuggerUrl ?? "");
  const browserId = browserIdFromWebSocketUrl(webSocketDebuggerUrl, port);
  return Object.freeze({
    browserId,
    webSocketDebuggerUrl,
    browser: typeof payload.Browser === "string" ? payload.Browser : null,
    protocolVersion: typeof payload["Protocol-Version"] === "string" ? payload["Protocol-Version"] : null,
  });
}

export function parseAppPageTargets(payload, port) {
  if (!Array.isArray(payload)) throw new TypeError("Invalid /json/list response");
  const seen = new Set();
  const targets = [];
  for (const item of payload) {
    if (!item || item.type !== "page" || !isAppPageUrl(item.url)) continue;
    const id = String(item.id ?? "");
    if (!id || seen.has(id)) continue;
    const webSocketDebuggerUrl = String(item.webSocketDebuggerUrl ?? "");
    const webSocketUrl = assertLoopbackWebSocketUrl(webSocketDebuggerUrl, port);
    const pathMatch = /^\/devtools\/page\/([^/]+)$/.exec(webSocketUrl.pathname);
    if (!pathMatch || pathMatch[1] !== id) {
      throw new TypeError("Page WebSocket endpoint does not match its target identity");
    }
    seen.add(id);
    targets.push(Object.freeze({
      id,
      type: "page",
      url: String(item.url),
      title: typeof item.title === "string" ? item.title : "",
      webSocketDebuggerUrl,
    }));
  }
  return targets;
}

export async function readBrowserIdentity(options) {
  return parseBrowserVersion(await fetchCdpJson("/json/version", options), options.port);
}

export async function readAppPageTargets(options) {
  return parseAppPageTargets(await fetchCdpJson("/json/list", options), options.port);
}

export async function waitForBrowserIdentity({
  port,
  expectedBrowserId,
  fetchImpl,
  timeoutMs = 30_000,
  requestTimeoutMs = 1_500,
  intervalMs = 150,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const identity = await readBrowserIdentity({ port, fetchImpl, timeoutMs: requestTimeoutMs });
      if (expectedBrowserId && identity.browserId !== expectedBrowserId) {
        throw new CodexQuotaError(ERROR_CODES.BROWSER_ID_CHANGED, "The CDP browser identity changed", {
          expectedBrowserId,
          actualBrowserId: identity.browserId,
        });
      }
      return identity;
    } catch (error) {
      if (error instanceof CodexQuotaError) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new CodexQuotaError("E_CDP_NOT_READY", "Timed out waiting for the Codex CDP endpoint", {
    port,
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}
