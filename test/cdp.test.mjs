import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CdpSession,
  CdpWatcher,
  DEFAULT_CODEX_RENDERER_PROBE,
  assertLoopbackWebSocketUrl,
  browserIdFromWebSocketUrl,
  chooseLoopbackPort,
  parseAppPageTargets,
  parseBrowserVersion,
  parsePowerShellJson,
} from "../src/cdp/index.mjs";
import { invokeWindowsCdpHelper } from "../src/cdp/windows-launcher.mjs";

test("strict loopback URL validation rejects non-literal, credentialed, and cross-port endpoints", () => {
  assert.equal(
    assertLoopbackWebSocketUrl("ws://127.0.0.1:54321/devtools/browser/abc", 54321).hostname,
    "127.0.0.1",
  );
  assert.equal(browserIdFromWebSocketUrl("ws://127.0.0.1:54321/devtools/browser/id-1", 54321), "id-1");
  assert.throws(() => assertLoopbackWebSocketUrl("ws://localhost:54321/devtools/browser/abc", 54321), /literal loopback/);
  assert.throws(() => assertLoopbackWebSocketUrl("ws://user@127.0.0.1:54321/devtools/browser/abc", 54321), /credentials/);
  assert.throws(() => assertLoopbackWebSocketUrl("ws://127.0.0.1:54322/devtools/browser/abc", 54321), /unexpected port/);
  assert.throws(() => assertLoopbackWebSocketUrl("ws://127.0.0.1:54321/devtools/browser/abc?token=x", 54321), /query/);
  assert.throws(() => browserIdFromWebSocketUrl("ws://127.0.0.1:54321/devtools/page/abc", 54321), /identity path/);
});

test("browser and page discovery accept only app pages on the verified endpoint", () => {
  const version = parseBrowserVersion({
    Browser: "Owl/150",
    "Protocol-Version": "1.3",
    webSocketDebuggerUrl: "ws://127.0.0.1:55001/devtools/browser/browser-1",
  }, 55001);
  assert.equal(version.browserId, "browser-1");

  const pages = parseAppPageTargets([
    { id: "main", type: "page", url: "app://codex/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:55001/devtools/page/main" },
    { id: "https", type: "page", url: "https://example.test/", webSocketDebuggerUrl: "ws://evil.test/devtools/page/https" },
    { id: "worker", type: "service_worker", url: "app://codex/worker", webSocketDebuggerUrl: "ws://127.0.0.1:55001/devtools/page/worker" },
  ], 55001);
  assert.deepEqual(pages.map((page) => page.id), ["main"]);
  assert.throws(() => parseAppPageTargets([
    { id: "bad", type: "page", url: "app://codex/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:55002/devtools/page/bad" },
  ], 55001), /unexpected port/);
});

test("random high-port selection only returns a bindable dynamic port", async () => {
  const port = await chooseLoopbackPort();
  assert.ok(port >= 49152 && port <= 65535);
});

test("PowerShell JSON envelopes are strict and preserve typed helper errors", async () => {
  assert.deepEqual(parsePowerShellJson('{"ok":true,"action":"inspect"}\n'), { ok: true, action: "inspect" });
  assert.throws(() => parsePowerShellJson("log line\n{\"ok\":true}"), /unexpected stdout/);

  await assert.rejects(
    invokeWindowsCdpHelper("launch", {
      port: 55001,
      runner: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, error: { code: "E_RUNNING_WITHOUT_CDP", message: "already running", details: { pids: [1] } } }),
        stderr: "diagnostic only\n",
      }),
    }),
    (error) => error.code === "E_RUNNING_WITHOUT_CDP" && error.details.pids[0] === 1,
  );

  await assert.rejects(
    invokeWindowsCdpHelper("inspect", {
      runner: async () => ({ exitCode: 1, stdout: '{"ok":true}', stderr: "" }),
    }),
    (error) => error.code === "E_WINDOWS_HELPER_STATUS",
  );
});

test("CDP helper uses the shared absolute system PowerShell fallback", async () => {
  const calls = [];
  const runner = async (options) => {
    calls.push(options);
    return { exitCode: 0, stdout: '{"ok":true,"action":"inspect"}\n', stderr: "" };
  };

  await invokeWindowsCdpHelper("inspect", { env: {}, runner });
  await invokeWindowsCdpHelper("inspect", { env: { SystemRoot: "relative-windows" }, runner });
  await invokeWindowsCdpHelper("inspect", { env: { SystemRoot: "\\Windows" }, runner });
  await invokeWindowsCdpHelper("inspect", { env: { SystemRoot: "D:\\Windows" }, runner });

  const fallback = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.deepEqual(calls.slice(0, 3).map(({ powershellPath }) => powershellPath), [fallback, fallback, fallback]);
  assert.equal(calls[3].powershellPath, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(calls[1].env, { SystemRoot: "relative-windows" });
});

class FakeWebSocket extends EventEmitter {
  static instances = [];
  static commandLog = [];
  static targetStates = new Map();

  constructor(url) {
    super();
    this.url = url;
    this.targetId = /\/devtools\/page\/([^/]+)$/.exec(new URL(url).pathname)?.[1] ?? null;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  send(serialized) {
    const command = JSON.parse(serialized);
    const state = this.targetId ? FakeWebSocket.targetStates.get(this.targetId) : null;
    const isMainAtSend = state?.isMain ?? false;
    FakeWebSocket.commandLog.push({ url: this.url, command, targetId: this.targetId, isMainAtSend });
    let result = {};
    if (command.method === "Runtime.evaluate") {
      if (command.params.expression === DEFAULT_CODEX_RENDERER_PROBE) {
        const nextProbe = state?.probeSequence?.length ? state.probeSequence.shift() : isMainAtSend;
        result = { result: { type: "boolean", value: nextProbe } };
      } else if (command.params.expression.includes("__codexQuotaRendererProbeSkipped")) {
        result = {
          result: {
            type: "object",
            value: { __codexQuotaRendererProbeSkipped: !isMainAtSend },
          },
        };
      } else {
        result = { result: { type: "boolean", value: true } };
      }
    }
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: command.id, result }) }));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code, reason }));
  }

  emitProtocol(method, params = {}) {
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({ method, params }),
    }));
  }

  static reset() {
    FakeWebSocket.instances = [];
    FakeWebSocket.commandLog = [];
    FakeWebSocket.targetStates = new Map();
  }

  static setTargetState(targetId, state) {
    const previous = FakeWebSocket.targetStates.get(targetId) ?? {};
    FakeWebSocket.targetStates.set(targetId, { ...previous, ...state });
  }

  static pageSocket(targetId) {
    return FakeWebSocket.instances.findLast((socket) => socket.targetId === targetId && socket.readyState === 1);
  }
}

function fakeDiscoveryFetch(port, getTargets = () => [
  { id: "main", type: "page", url: "app://codex/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/main` },
  { id: "aux", type: "page", url: "app://codex/aux.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/aux` },
  { id: "web", type: "page", url: "https://example.test", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/web` },
]) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === "/json/version") {
      return new Response(JSON.stringify({
        Browser: "Owl/150",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-1`,
      }), { status: 200 });
    }
    if (path === "/json/list") {
      return new Response(JSON.stringify(getTargets()), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

async function waitFor(predicate, { timeoutMs = 1_000, intervalMs = 2 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("Timed out waiting for fake CDP state");
}

function runtimeEvaluations(targetId) {
  return FakeWebSocket.commandLog.filter(({ command, targetId: loggedTargetId }) => (
    loggedTargetId === targetId && command.method === "Runtime.evaluate"
  ));
}

test("CdpSession correlates commands and responses", async () => {
  FakeWebSocket.reset();
  FakeWebSocket.setTargetState("main", { isMain: true });
  const session = new CdpSession("ws://127.0.0.1:55101/devtools/page/main", {
    port: 55101,
    WebSocketImpl: FakeWebSocket,
  });
  await session.connect();
  const result = await session.send("Runtime.evaluate", { expression: "1 + 1" });
  assert.equal(result.result.value, true);
  session.close();
});

test("CdpWatcher anchors browser identity, probes renderers before bootstrap, and ignores auxiliary app pages", async () => {
  FakeWebSocket.reset();
  FakeWebSocket.setTargetState("main", { isMain: true });
  FakeWebSocket.setTargetState("aux", { isMain: false });
  const port = 55102;
  const ready = [];
  let ownerChecks = 0;
  const watcher = new CdpWatcher({
    port,
    browserId: "browser-1",
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-1`,
    fetchImpl: fakeDiscoveryFetch(port),
    WebSocketImpl: FakeWebSocket,
    ownerValidator: async () => { ownerChecks += 1; return { ok: true }; },
    pollIntervalMs: 60_000,
    probeTimeoutMs: 0,
  });

  await watcher.start({
    bootstrapSource: "globalThis.__CODEX_QUOTA_BOOTSTRAP__ = true",
    cleanupExpression: "delete globalThis.__CODEX_QUOTA_BOOTSTRAP__",
    onPageReady: ({ target }) => ready.push(target.id),
  });
  await waitFor(() => ready.length === 1);
  assert.deepEqual(ready, ["main"]);
  assert.equal(watcher.size, 1);
  assert.ok(ownerChecks >= 1);

  const mainCommands = FakeWebSocket.commandLog.filter((entry) => entry.targetId === "main").map((entry) => entry.command);
  const auxCommands = FakeWebSocket.commandLog.filter((entry) => entry.targetId === "aux").map((entry) => entry.command);
  const mainProbeIndex = mainCommands.findIndex((command) => command.method === "Runtime.evaluate" && command.params.expression === DEFAULT_CODEX_RENDERER_PROBE);
  const mainBootstrapIndex = mainCommands.findIndex((command) => command.method === "Runtime.evaluate" && command.params.expression.includes("__CODEX_QUOTA_BOOTSTRAP__"));
  assert.equal(mainProbeIndex < mainBootstrapIndex, true);
  assert.equal(mainCommands.some((command) => command.method === "Page.addScriptToEvaluateOnNewDocument"), false);
  assert.equal(auxCommands.some((command) => command.method === "Runtime.evaluate" && command.params.expression.includes("__CODEX_QUOTA_BOOTSTRAP__")), false);

  const updates = await watcher.evaluateAll("globalThis.__CODEX_QUOTA_UPDATE__ = 1");
  assert.deepEqual(updates.map(({ targetId, ok }) => ({ targetId, ok })), [{ targetId: "main", ok: true }]);
  await watcher.close();
});

test("CdpWatcher re-probes a target immediately when its URL changes main to auxiliary to main", async () => {
  FakeWebSocket.reset();
  const port = 55103;
  let target = {
    id: "surface",
    type: "page",
    url: "app://codex/index.html",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/surface`,
  };
  FakeWebSocket.setTargetState("surface", { isMain: true });
  const ready = [];
  const watcher = new CdpWatcher({
    port,
    browserId: "browser-1",
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-1`,
    fetchImpl: fakeDiscoveryFetch(port, () => [target]),
    WebSocketImpl: FakeWebSocket,
    ownerValidator: async () => ({ ok: true }),
    pollIntervalMs: 3,
    identityCheckEvery: 100,
    ownerCheckEvery: 100,
    probeTimeoutMs: 8,
    probeIntervalMs: 1,
    ignoredRetryMs: 10_000,
    navigationSettleMs: 0,
  });
  await watcher.start({
    bootstrapSource: "globalThis.__BOOTSTRAP_TRANSITION__ = true",
    onPageReady: ({ target: readyTarget }) => ready.push(readyTarget.url),
  });
  await waitFor(() => ready.length === 1);
  assert.equal(watcher.size, 1);

  FakeWebSocket.setTargetState("surface", { isMain: false });
  target = { ...target, url: "app://codex/aux.html" };
  await waitFor(() => watcher.size === 0);
  await waitFor(() => runtimeEvaluations("surface").filter(({ command }) => (
    command.params.expression === DEFAULT_CODEX_RENDERER_PROBE
  )).length >= 2);
  assert.equal(watcher.size, 0);

  // A changed URL fingerprint invalidates the pending backoff and probes now.
  FakeWebSocket.setTargetState("surface", { isMain: true });
  target = { ...target, url: "app://codex/index.html?returned=1" };
  await waitFor(() => ready.at(-1) === "app://codex/index.html?returned=1");
  assert.equal(watcher.size, 1);
  assert.equal(ready.at(-1), "app://codex/index.html?returned=1");

  const bootstrapAttempts = runtimeEvaluations("surface").filter(({ command }) => (
    command.params.expression.includes("__BOOTSTRAP_TRANSITION__")
  ));
  assert.equal(bootstrapAttempts.length >= 2, true);
  assert.equal(bootstrapAttempts.some(({ isMainAtSend }) => !isMainAtSend), false);
  assert.equal(FakeWebSocket.commandLog.some(({ command }) => command.method === "Page.addScriptToEvaluateOnNewDocument"), false);
  await watcher.close();
});

test("CdpWatcher re-probes Page.frameNavigated transitions without injecting into an auxiliary renderer", async () => {
  FakeWebSocket.reset();
  const port = 55106;
  FakeWebSocket.setTargetState("surface", { isMain: true });
  const ready = [];
  const watcher = new CdpWatcher({
    port,
    browserId: "browser-1",
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-1`,
    fetchImpl: fakeDiscoveryFetch(port, () => [{
      id: "surface",
      type: "page",
      url: "app://codex/index.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/surface`,
    }]),
    WebSocketImpl: FakeWebSocket,
    ownerValidator: async () => ({ ok: true }),
    pollIntervalMs: 60_000,
    probeTimeoutMs: 250,
    probeIntervalMs: 5,
    navigationSettleMs: 0,
  });
  await watcher.start({
    bootstrapSource: "globalThis.__BOOTSTRAP_FRAME_NAV__ = true",
    onPageReady: ({ target }) => ready.push(target.url),
  });
  await waitFor(() => ready.length === 1);

  const pageSocket = FakeWebSocket.pageSocket("surface");
  FakeWebSocket.setTargetState("surface", { isMain: false });
  pageSocket.emitProtocol("Page.frameNavigated", {
    frame: { id: "root", url: "app://codex/aux.html" },
  });
  await waitFor(() => watcher.size === 0);
  await waitFor(() => runtimeEvaluations("surface").filter(({ command }) => (
    command.params.expression === DEFAULT_CODEX_RENDERER_PROBE
  )).length >= 2);

  FakeWebSocket.setTargetState("surface", { isMain: true });
  pageSocket.emitProtocol("Page.frameNavigated", {
    frame: { id: "root", url: "app://codex/index.html?again=1" },
  });
  await waitFor(() => ready.length === 2);
  assert.equal(watcher.size, 1);
  assert.equal(ready[1], "app://codex/index.html?again=1");

  const bootstraps = runtimeEvaluations("surface").filter(({ command }) => (
    command.params.expression.includes("__BOOTSTRAP_FRAME_NAV__")
  ));
  assert.equal(bootstraps.length, 2);
  assert.equal(bootstraps.some(({ isMainAtSend }) => !isMainAtSend), false);
  await watcher.close();
});

test("CdpWatcher removes a reloading page from the active set and bootstraps it again after probing", async () => {
  FakeWebSocket.reset();
  const port = 55104;
  FakeWebSocket.setTargetState("main", { isMain: true });
  const ready = [];
  const watcher = new CdpWatcher({
    port,
    browserId: "browser-1",
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-1`,
    fetchImpl: fakeDiscoveryFetch(port, () => [{
      id: "main",
      type: "page",
      url: "app://codex/index.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/main`,
    }]),
    WebSocketImpl: FakeWebSocket,
    ownerValidator: async () => ({ ok: true }),
    pollIntervalMs: 60_000,
    probeTimeoutMs: 100,
    probeIntervalMs: 1,
    navigationSettleMs: 10,
  });
  await watcher.start({
    bootstrapSource: "globalThis.__BOOTSTRAP_RELOAD__ = true",
    onPageReady: () => ready.push(Date.now()),
  });
  await waitFor(() => ready.length === 1);

  const pageSocket = FakeWebSocket.pageSocket("main");
  pageSocket.emitProtocol("Runtime.executionContextsCleared");
  await waitFor(() => watcher.size === 0);
  const duringReload = await watcher.evaluateAll("globalThis.__UPDATE_DURING_RELOAD__ = true");
  assert.deepEqual(duringReload, []);
  await waitFor(() => ready.length === 2);
  assert.equal(watcher.size, 1);

  const bootstraps = runtimeEvaluations("main").filter(({ command }) => (
    command.params.expression.includes("__BOOTSTRAP_RELOAD__")
  ));
  assert.equal(bootstraps.length, 2);
  assert.equal(FakeWebSocket.commandLog.some(({ command }) => command.method === "Page.addScriptToEvaluateOnNewDocument"), false);
  await watcher.close();
});

test("CdpWatcher starts without blocking on a slow renderer and activates it after probing", async () => {
  FakeWebSocket.reset();
  const port = 55105;
  FakeWebSocket.setTargetState("slow", { isMain: false });
  const watcher = new CdpWatcher({
    port,
    browserId: "browser-1",
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-1`,
    fetchImpl: fakeDiscoveryFetch(port, () => [{
      id: "slow",
      type: "page",
      url: "app://codex/index.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/slow`,
    }]),
    WebSocketImpl: FakeWebSocket,
    ownerValidator: async () => ({ ok: true }),
    pollIntervalMs: 60_000,
    probeTimeoutMs: 250,
    probeIntervalMs: 10,
  });

  const startPromise = watcher.start({ bootstrapSource: "globalThis.__BOOTSTRAP_SLOW__ = true" });
  await waitFor(() => runtimeEvaluations("slow").some(({ command }) => command.params.expression === DEFAULT_CODEX_RENDERER_PROBE));
  await startPromise;
  assert.equal(watcher.size, 0);
  assert.deepEqual(await watcher.evaluateAll("globalThis.__EARLY_UPDATE__ = true"), []);

  FakeWebSocket.setTargetState("slow", { isMain: true });
  await waitFor(() => watcher.size === 1);
  assert.equal(watcher.size, 1);
  assert.ok(runtimeEvaluations("slow").filter(({ command }) => command.params.expression === DEFAULT_CODEX_RENDERER_PROBE).length >= 2);
  assert.equal(runtimeEvaluations("slow").filter(({ command }) => command.params.expression.includes("__BOOTSTRAP_SLOW__")).length, 1);
  await watcher.close();
});

test("CdpWatcher tolerates a transient discovery failure and recovers without closing", async () => {
  FakeWebSocket.reset();
  const port = 55107;
  FakeWebSocket.setTargetState("main", { isMain: true });
  const baseFetch = fakeDiscoveryFetch(port, () => [{
    id: "main",
    type: "page",
    url: "app://codex/index.html",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/main`,
  }]);
  let listCalls = 0;
  const transient = [];
  const recovered = [];
  const terminal = [];
  const watcher = new CdpWatcher({
    port,
    browserId: "browser-1",
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-1`,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === "/json/list" && ++listCalls === 2) throw new Error("temporary discovery failure");
      return baseFetch(url, options);
    },
    WebSocketImpl: FakeWebSocket,
    ownerValidator: async () => ({ ok: true }),
    pollIntervalMs: 2,
    identityCheckEvery: 100,
    ownerCheckEvery: 100,
    probeTimeoutMs: 0,
  });
  watcher.on("watcherTransientError", (value) => transient.push(value));
  watcher.on("watcherRecovered", (value) => recovered.push(value));
  watcher.on("watcherError", (value) => terminal.push(value));

  await watcher.start({ bootstrapSource: "globalThis.__TRANSIENT_RECOVERY__ = true" });
  await waitFor(() => recovered.length === 1);
  assert.equal(transient.length, 1);
  assert.equal(transient[0].failureCount, 1);
  assert.equal(terminal.length, 0);
  assert.equal(watcher.terminalError, undefined);
  assert.equal(watcher.size, 1);
  await watcher.close();
});
