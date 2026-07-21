import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { daemonCommand, waitForDaemonStop, waitForParentIdentity } from "../src/host/daemon.mjs";
import { readJson, writeJsonAtomic } from "../src/fs-utils.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-daemon-"));
  const paths = {
    root,
    session: join(root, "session.json"),
    codexAuth: join(root, "auth.json"),
    quotaCache: join(root, "quota-cache.json"),
    daemonLock: join(root, "daemon.lock"),
    stopRequest: join(root, "stop.request"),
    logs: join(root, "logs")
  };
  const state = {
    schemaVersion: 1,
    nonce: "test-nonce",
    status: "starting",
    engineRoot: root,
    nodePath: process.execPath,
    daemonIdentityReady: true,
    daemonPid: process.pid,
    daemonExecutablePath: process.execPath,
    daemonCommandLine: "verified daemon command",
    daemonStartTime: "2026-07-21T12:00:00.000Z",
    port: 19222,
    browserId: "browser-test",
    browserWebSocketUrl: "ws://127.0.0.1:19222/devtools/browser/browser-test"
  };
  await writeFile(paths.codexAuth, "test-auth-context", "utf8");
  await writeJsonAtomic(paths.session, state);
  return { root, paths, state };
}

test("daemon reaches ready, publishes through the bridge, and cleans up after a stop", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const watcher = new EventEmitter();
  const patches = [];
  const events = [];
  const bridge = {
    async start() { events.push("bridge:start"); },
    async publish(snapshot) { events.push(`publish:${snapshot.buckets.length}`); },
    async unavailable() {},
    async heartbeat() {},
    async cleanup() { events.push("bridge:cleanup"); }
  };
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });

  const result = await daemonCommand({
    session: paths.session,
    nonce: state.nonce,
    "engine-root": root
  }, {
    paths,
    watcher,
    bridge,
    log() {},
    resolveRuntime: async () => ({ source: "fake" }),
    createProvider: async () => ({}),
    createCoordinator: async ({ bridge: target }) => ({
      async start() {
        await target.publish({
          schemaVersion: 1,
          fetchedAtMs: 1,
          buckets: [],
          resetCreditsAvailable: null
        });
      },
      async stop() { events.push("coordinator:stop"); }
    }),
    updateSession: async (path, nonce, patch) => {
      patches.push(patch);
      const { updateSession } = await import("../src/session-state.mjs");
      const next = await updateSession(path, nonce, patch);
      if (patch.status === "ready") resolveStop({ reason: "test-stop" });
      return next;
    },
    waitForStop: () => stopped,
    heartbeatMs: 60_000,
    sessionHeartbeatMs: 60_000
  });

  assert.deepEqual(result, { ok: true, reason: "test-stop" });
  assert.ok(patches.some((patch) => patch.status === "ready"));
  assert.ok(patches.some((patch) => patch.status === "stopping"));
  assert.deepEqual(events, ["bridge:start", "publish:0", "coordinator:stop", "bridge:cleanup"]);
  await assert.rejects(readFile(paths.session, "utf8"), { code: "ENOENT" });
});

test("daemon records an unavailable provider without fabricating quota", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const unavailable = [];
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });

  await daemonCommand({ session: paths.session, nonce: state.nonce, "engine-root": root }, {
    paths,
    watcher: new EventEmitter(),
    bridge: {
      async start() {},
      async publish() { assert.fail("must not publish a made-up quota"); },
      async unavailable(value) { unavailable.push(value); },
      async heartbeat() {},
      async cleanup() {}
    },
    log() {},
    resolveRuntime: async () => { throw Object.assign(new Error("signed out"), { code: "E_AUTH_UNSUPPORTED" }); },
    updateSession: async (path, nonce, patch) => {
      const { updateSession } = await import("../src/session-state.mjs");
      const next = await updateSession(path, nonce, patch);
      if (patch.status === "ready") resolveStop({ reason: "test-stop" });
      return next;
    },
    waitForStop: () => stopped,
    heartbeatMs: 60_000,
    sessionHeartbeatMs: 60_000
  });

  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].reasonCode, "E_AUTH_UNSUPPORTED");
  assert.equal(Object.hasOwn(unavailable[0], "remainingPercent"), false);
});

test("daemon becomes ready while the initial quota provider is still loading", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  let resolveProvider;
  const providerGate = new Promise((resolve) => { resolveProvider = resolve; });
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  let resolveReady;
  const readySeen = new Promise((resolve) => { resolveReady = resolve; });
  let providerFinished = false;
  const patches = [];

  const running = daemonCommand({
    session: paths.session,
    nonce: state.nonce,
    "engine-root": root
  }, {
    paths,
    watcher: new EventEmitter(),
    bridge: {
      async start() {},
      async publish() {},
      async unavailable() {},
      async heartbeat() {},
      async cleanup() {}
    },
    log() {},
    resolveRuntime: async () => ({ source: "fake" }),
    createProvider: async () => ({}),
    createCoordinator: async () => ({
      async start() {
        await providerGate;
        providerFinished = true;
      },
      async stop() {}
    }),
    updateSession: async (path, nonce, patch) => {
      patches.push(patch);
      const { updateSession } = await import("../src/session-state.mjs");
      const next = await updateSession(path, nonce, patch);
      if (patch.status === "ready") resolveReady();
      return next;
    },
    waitForStop: () => stopped,
    heartbeatMs: 60_000,
    sessionHeartbeatMs: 60_000
  });

  await readySeen;
  assert.equal(providerFinished, false);
  assert.ok(patches.some((patch) => patch.status === "ready" && patch.quotaStatus === "loading"));
  resolveProvider();
  resolveStop({ reason: "test-stop" });
  assert.deepEqual(await running, { ok: true, reason: "test-stop" });
  assert.equal(providerFinished, true);
});

test("daemon revalidates cached account context after bridge startup before replay", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const accountA = Object.freeze({ size: 10, mtimeMs: 100 });
  const accountB = Object.freeze({ size: 20, mtimeMs: 200 });
  let currentAccount = accountA;
  let cachedPublishCount = 0;
  let cacheDeleteCount = 0;
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });

  const result = await daemonCommand({
    session: paths.session,
    nonce: state.nonce,
    "engine-root": root
  }, {
    paths,
    watcher: new EventEmitter(),
    bridge: {
      async start() { currentAccount = accountB; },
      async publishCached() { cachedPublishCount += 1; },
      async unavailable() {},
      async heartbeat() {},
      async cleanup() {}
    },
    log() {},
    readQuotaCacheEntry: async () => ({
      accountContext: accountA,
      snapshot: {
        schemaVersion: 1,
        fetchedAtMs: 1_800_000_000_000,
        buckets: [{
          id: "codex",
          name: null,
          planType: null,
          reachedType: null,
          windows: [{
            kind: "primary",
            usedPercent: 25,
            remainingPercent: 75,
            durationMinutes: 10_080,
            resetsAtMs: 1_800_000_060_000
          }]
        }],
        resetCreditsAvailable: null
      }
    }),
    readQuotaAccountContext: async () => currentAccount,
    removeQuotaCache: async () => { cacheDeleteCount += 1; return true; },
    resolveRuntime: async () => ({ source: "fake" }),
    createProvider: async () => new EventEmitter(),
    createCoordinator: async () => ({ async start() {}, async stop() {} }),
    updateSession: async (path, nonce, patch) => {
      const { updateSession } = await import("../src/session-state.mjs");
      const next = await updateSession(path, nonce, patch);
      if (patch.status === "ready") resolveStop({ reason: "test-stop" });
      return next;
    },
    waitForStop: () => stopped,
    heartbeatMs: 60_000,
    sessionHeartbeatMs: 60_000
  });

  assert.deepEqual(result, { ok: true, reason: "test-stop" });
  assert.equal(cachedPublishCount, 0);
  assert.equal(cacheDeleteCount, 1);
});

test("daemon startup failure is retained as a diagnostic session", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(daemonCommand({
    session: paths.session,
    nonce: state.nonce,
    "engine-root": root
  }, {
    paths,
    watcher: new EventEmitter(),
    bridge: {
      async start() { throw Object.assign(new Error("renderer unavailable"), { code: "E_RENDERER" }); },
      async unavailable() {},
      async cleanup() {}
    },
    log() {}
  }), /renderer unavailable/);

  const retained = await readJson(paths.session);
  assert.equal(retained.status, "error");
  assert.equal(retained.errorCode, "E_RENDERER");
});

test("an unexpected watcher stop is retained as an error session", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  const watcherError = Object.assign(new Error("browser identity changed"), { code: "E_BROWSER_ID_CHANGED" });

  await assert.rejects(daemonCommand({
    session: paths.session,
    nonce: state.nonce,
    "engine-root": root
  }, {
    paths,
    watcher: new EventEmitter(),
    bridge: {
      async start() {},
      async publish() {},
      async unavailable() {},
      async heartbeat() {},
      async cleanup() {}
    },
    log() {},
    resolveRuntime: async () => ({ source: "fake" }),
    createProvider: async () => ({}),
    createCoordinator: async () => ({ async start() {}, async stop() {} }),
    updateSession: async (path, nonce, patch) => {
      const { updateSession } = await import("../src/session-state.mjs");
      const next = await updateSession(path, nonce, patch);
      if (patch.status === "ready") resolveStop({ reason: "cdp-closed", error: watcherError });
      return next;
    },
    waitForStop: () => stopped,
    heartbeatMs: 60_000,
    sessionHeartbeatMs: 60_000
  }), (error) => error.code === "E_BROWSER_ID_CHANGED");

  const retained = await readJson(paths.session);
  assert.equal(retained.status, "error");
  assert.equal(retained.errorCode, "E_BROWSER_ID_CHANGED");
});

test("daemon rebuilds the provider after an unexpected app-server close", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  let providerCount = 0;
  let coordinatorStarts = 0;
  let resolveStop;
  const stop = new Promise((resolve) => { resolveStop = resolve; });
  const unavailable = [];

  await daemonCommand({ session: paths.session, nonce: state.nonce, "engine-root": root }, {
    paths,
    watcher: new EventEmitter(),
    bridge: {
      async start() {},
      async publish() {},
      async unavailable(value) { unavailable.push(value); },
      async heartbeat() {},
      async cleanup() {}
    },
    log() {},
    resolveRuntime: async () => ({ source: "fake" }),
    createProvider: async () => {
      providerCount += 1;
      return new EventEmitter();
    },
    createCoordinator: async ({ provider }) => ({
      async start() {
        coordinatorStarts += 1;
        if (coordinatorStarts === 1) {
          setTimeout(() => provider.emit("closed", Object.assign(new Error("closed"), {
            code: "E_APP_SERVER_CLOSED"
          })), 10);
        } else {
          setTimeout(() => resolveStop({ reason: "test-stop" }), 5);
        }
      },
      async stop() {}
    }),
    waitForStop: () => stop,
    providerRetryMs: 5,
    heartbeatMs: 60_000,
    sessionHeartbeatMs: 60_000
  });

  assert.equal(providerCount, 2);
  assert.equal(coordinatorStarts, 2);
  assert.ok(unavailable.some((value) => value.reasonCode === "E_APP_SERVER_CLOSED"));
});

test("stop monitor ignores a foreign nonce and accepts the matching request", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const watcher = new EventEmitter();
  const pending = waitForDaemonStop({ watcher, paths, nonce: state.nonce, pollMs: 10 });
  await writeFile(paths.stopRequest, JSON.stringify({ nonce: "foreign" }), "utf8");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  await writeFile(paths.stopRequest, JSON.stringify({ nonce: state.nonce }), "utf8");
  assert.equal((await pending).reason, "uninstall-request");
});

test("parent identity gate waits for the complete one-write handoff", async () => {
  let reads = 0;
  const base = {
    nonce: "nonce",
    status: "starting",
    engineRoot: "C:\\engine",
    nodePath: "C:\\node.exe"
  };
  const ready = await waitForParentIdentity({
    sessionPath: "session.json",
    nonce: "nonce",
    pid: 42,
    engineRoot: base.engineRoot,
    nodePath: base.nodePath,
    readJson: async () => {
      reads += 1;
      if (reads === 1) return { ...base, daemonIdentityReady: false };
      return {
        ...base,
        daemonIdentityReady: true,
        daemonPid: 42,
        daemonExecutablePath: base.nodePath,
        daemonCommandLine: "verified",
        daemonStartTime: "2026-07-21T12:00:00.000Z"
      };
    },
    sleep: async () => {},
    now: (() => { let value = 0; return () => ++value; })(),
    timeoutMs: 100
  });
  assert.equal(ready.daemonPid, 42);
  assert.equal(reads, 2);
});

test("stop monitor observes a watcher error that happened before subscription", async (t) => {
  const { root, paths, state } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const watcher = new EventEmitter();
  watcher.terminalError = Object.assign(new Error("closed"), { code: "E_BROWSER_ID_CHANGED" });
  const stop = await waitForDaemonStop({ watcher, paths, nonce: state.nonce, pollMs: 10 });
  assert.equal(stop.reason, "cdp-closed");
  assert.equal(stop.error.code, "E_BROWSER_ID_CHANGED");
});
