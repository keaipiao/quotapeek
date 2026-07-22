import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { QuotaCoordinator } from "../src/host/quota-coordinator.mjs";

function createManualRetryTimers() {
  let nextId = 1;
  const entries = [];
  const setRetryTimeout = (callback, waitMs) => {
    const handle = { id: nextId++, unref() {} };
    entries.push({ handle, callback, waitMs, cleared: false, fired: false });
    return handle;
  };
  const clearRetryTimeout = (handle) => {
    const entry = entries.find((candidate) => candidate.handle === handle);
    if (entry) entry.cleared = true;
  };
  const active = () => entries.filter((entry) => !entry.cleared && !entry.fired);
  const fireNext = async (expectedWaitMs) => {
    const [entry] = active();
    assert.ok(entry, `expected an active ${expectedWaitMs} ms retry`);
    assert.equal(entry.waitMs, expectedWaitMs);
    entry.fired = true;
    await entry.callback();
    return entry;
  };
  return { setRetryTimeout, clearRetryTimeout, active, fireNext };
}

test("coordinator publishes a normalized startup snapshot and closes provider", async () => {
  let closed = false;
  const snapshot = { schemaVersion: 1, fetchedAtMs: Date.now(), buckets: [], resetCreditsAvailable: null };
  const provider = {
    async start() {},
    async readNormalizedRateLimits() { return snapshot; },
    onRateLimitsUpdated() { return () => {}; },
    async close() { closed = true; }
  };
  const published = [];
  const coordinator = new QuotaCoordinator({
    provider,
    publish: async (value) => published.push(value),
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });
  await coordinator.start();
  assert.deepEqual(published, [snapshot]);
  await coordinator.stop();
  assert.equal(closed, true);
});

test("coordinator does not invent a quota value on provider failure", async () => {
  const unavailable = [];
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async readNormalizedRateLimits() { throw Object.assign(new Error("no auth"), { code: "E_AUTH_UNSUPPORTED" }); },
      async close() {}
    },
    publish: async () => assert.fail("must not publish a fabricated snapshot"),
    publishUnavailable: async (value) => unavailable.push(value),
    staleAfterMs: 0,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });
  await coordinator.start();
  assert.equal(unavailable[0].reasonCode, "E_AUTH_UNSUPPORTED");
  await coordinator.stop();
});

test("an account update during an active refresh queues one complete follow-up read", async () => {
  const provider = new EventEmitter();
  let readCount = 0;
  let releaseFirstRead;
  let markFirstReadStarted;
  const firstReadStarted = new Promise((resolve) => { markFirstReadStarted = resolve; });
  const firstReadGate = new Promise((resolve) => { releaseFirstRead = resolve; });
  provider.start = async () => {};
  provider.read = async () => {
    readCount += 1;
    if (readCount === 1) {
      markFirstReadStarted();
      await firstReadGate;
    }
    return { schemaVersion: 1, fetchedAtMs: Date.now(), buckets: [], resetCreditsAvailable: null };
  };
  provider.close = async () => {};

  const published = [];
  const coordinator = new QuotaCoordinator({
    provider,
    publish: async (value) => published.push(value),
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });
  const starting = coordinator.start();
  await firstReadStarted;
  provider.emit("changed", "account");
  releaseFirstRead();
  await starting;

  assert.equal(readCount, 2);
  assert.equal(published.length, 2);
  await coordinator.stop();
});

test("a context change across a snapshot read queues a stable reread", async () => {
  const accountA = Object.freeze({ size: 10, mtimeMs: 100 });
  const accountB = Object.freeze({ size: 20, mtimeMs: 200 });
  const contexts = [accountA, accountB, accountB, accountB];
  let readCount = 0;
  const publications = [];
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() {
        readCount += 1;
        return { schemaVersion: 1, fetchedAtMs: Date.now(), buckets: [], resetCreditsAvailable: null };
      },
      async close() {}
    },
    captureReadContext: async () => contexts.shift() ?? accountB,
    sameReadContext: (left, right) => left.size === right.size && left.mtimeMs === right.mtimeMs,
    publish: async (value, context) => {
      publications.push({ value, context });
      return context.accountContextStable;
    },
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  await coordinator.start();
  assert.equal(readCount, 2);
  assert.deepEqual(publications.map(({ context }) => context.accountContextStable), [false, true]);
  assert.equal(publications[1].context.accountContextAfter, accountB);
  await coordinator.stop();
});

test("failed reads retry after 5, 15, and capped 30 second delays", async () => {
  const timers = createManualRetryTimers();
  let readCount = 0;
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() {
        readCount += 1;
        throw Object.assign(new Error("temporary app-server failure"), { code: "E_RATE_LIMIT_READ" });
      },
      async close() {}
    },
    publish: async () => assert.fail("a failed read must not publish quota"),
    publishUnavailable: async () => {},
    setRetryTimeout: timers.setRetryTimeout,
    clearRetryTimeout: timers.clearRetryTimeout,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  await coordinator.start();
  assert.deepEqual(timers.active().map(({ waitMs }) => waitMs), [5_000]);
  await timers.fireNext(5_000);
  assert.deepEqual(timers.active().map(({ waitMs }) => waitMs), [15_000]);
  await timers.fireNext(15_000);
  assert.deepEqual(timers.active().map(({ waitMs }) => waitMs), [30_000]);
  await timers.fireNext(30_000);
  assert.deepEqual(timers.active().map(({ waitMs }) => waitMs), [30_000]);
  assert.equal(readCount, 4);
  await coordinator.stop();
});

test("a successful refresh cancels retry and resets the next failure to 5 seconds", async () => {
  const timers = createManualRetryTimers();
  const snapshot = { schemaVersion: 1, fetchedAtMs: Date.now(), buckets: [], resetCreditsAvailable: null };
  let shouldFail = true;
  let readCount = 0;
  const published = [];
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() {
        readCount += 1;
        if (shouldFail) throw new Error("temporary failure");
        return snapshot;
      },
      async close() {}
    },
    publish: async (value) => published.push(value),
    publishUnavailable: async () => {},
    setRetryTimeout: timers.setRetryTimeout,
    clearRetryTimeout: timers.clearRetryTimeout,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  await coordinator.start();
  shouldFail = false;
  await timers.fireNext(5_000);
  assert.deepEqual(published, [snapshot]);
  assert.equal(timers.active().length, 0);

  shouldFail = true;
  await coordinator.refresh("notification");
  assert.deepEqual(timers.active().map(({ waitMs }) => waitMs), [5_000]);
  const [cancelledRetry] = timers.active();

  shouldFail = false;
  await coordinator.refresh("notification");
  assert.equal(timers.active().length, 0);
  assert.deepEqual(published, [snapshot, snapshot]);
  await cancelledRetry.callback();
  assert.equal(readCount, 4, "a cleared retry callback must not perform a stale read");
  await coordinator.stop();
});

test("a retry that becomes due during unavailable publication runs after the active refresh", async () => {
  const timers = createManualRetryTimers();
  const snapshot = { schemaVersion: 1, fetchedAtMs: Date.now(), buckets: [], resetCreditsAvailable: null };
  let readCount = 0;
  let releaseUnavailable;
  let markUnavailableStarted;
  const unavailableStarted = new Promise((resolve) => { markUnavailableStarted = resolve; });
  const unavailableGate = new Promise((resolve) => { releaseUnavailable = resolve; });
  const published = [];
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() {
        readCount += 1;
        if (readCount === 1) throw new Error("temporary failure");
        return snapshot;
      },
      async close() {}
    },
    publish: async (value) => published.push(value),
    publishUnavailable: async () => {
      markUnavailableStarted();
      await unavailableGate;
    },
    setRetryTimeout: timers.setRetryTimeout,
    clearRetryTimeout: timers.clearRetryTimeout,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  const starting = coordinator.start();
  await unavailableStarted;
  const [dueRetry] = timers.active();
  dueRetry.fired = true;
  const retrying = dueRetry.callback();
  await Promise.resolve();
  assert.equal(readCount, 1, "retry must wait for the active unavailable publication");

  releaseUnavailable();
  await starting;
  await retrying;
  assert.equal(readCount, 2);
  assert.deepEqual(published, [snapshot]);
  assert.equal(timers.active().length, 0);
  await coordinator.stop();
});

test("stop cancels a pending retry and ignores its stale callback", async () => {
  const timers = createManualRetryTimers();
  let readCount = 0;
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() {
        readCount += 1;
        throw new Error("temporary failure");
      },
      async close() {}
    },
    publish: async () => {},
    publishUnavailable: async () => {},
    setRetryTimeout: timers.setRetryTimeout,
    clearRetryTimeout: timers.clearRetryTimeout,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  await coordinator.start();
  const [pendingRetry] = timers.active();
  await coordinator.stop();
  assert.equal(timers.active().length, 0);
  await pendingRetry.callback();
  assert.equal(readCount, 1);
});

test("a read interrupted by stop cannot publish unavailable or schedule retry", async () => {
  const timers = createManualRetryTimers();
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const unavailable = [];
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() {
        markReadStarted();
        await readGate;
        throw new Error("provider closed");
      },
      async close() { releaseRead(); }
    },
    publish: async () => {},
    publishUnavailable: async (value) => unavailable.push(value),
    staleAfterMs: 0,
    setRetryTimeout: timers.setRetryTimeout,
    clearRetryTimeout: timers.clearRetryTimeout,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  const starting = coordinator.start();
  await readStarted;
  await coordinator.stop();
  await starting;
  assert.equal(timers.active().length, 0);
  assert.deepEqual(unavailable, []);
});

test("stop waits for an unavailable publication that was already in flight", async () => {
  const timers = createManualRetryTimers();
  let releaseUnavailable;
  let markUnavailableStarted;
  const unavailableStarted = new Promise((resolve) => { markUnavailableStarted = resolve; });
  const unavailableGate = new Promise((resolve) => { releaseUnavailable = resolve; });
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() { throw new Error("temporary failure"); },
      async close() {}
    },
    publish: async () => {},
    publishUnavailable: async () => {
      markUnavailableStarted();
      await unavailableGate;
    },
    setRetryTimeout: timers.setRetryTimeout,
    clearRetryTimeout: timers.clearRetryTimeout,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  const starting = coordinator.start();
  await unavailableStarted;
  let stopFinished = false;
  const stopping = coordinator.stop().then(() => { stopFinished = true; });
  await Promise.resolve();
  assert.equal(stopFinished, false);
  releaseUnavailable();
  await starting;
  await stopping;
  assert.equal(stopFinished, true);
  assert.equal(timers.active().length, 0);
});

test("a previous snapshot becomes unavailable only after 15 minutes without success", async () => {
  const timers = createManualRetryTimers();
  const snapshot = { schemaVersion: 1, fetchedAtMs: 1_000, buckets: [], resetCreditsAvailable: null };
  let nowMs = 1_000;
  let shouldFail = false;
  const unavailable = [];
  const coordinator = new QuotaCoordinator({
    provider: {
      async start() {},
      async read() {
        if (shouldFail) throw Object.assign(new Error("temporary failure"), { code: "E_RATE_LIMIT_READ" });
        return snapshot;
      },
      async close() {}
    },
    publish: async () => {},
    publishUnavailable: async (value) => unavailable.push(value),
    now: () => nowMs,
    setRetryTimeout: timers.setRetryTimeout,
    clearRetryTimeout: timers.clearRetryTimeout,
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  await coordinator.start();
  shouldFail = true;
  nowMs = 1_000 + 5 * 60_000 + 1;
  await coordinator.refresh("notification");
  assert.deepEqual(unavailable, []);

  nowMs = 1_000 + 15 * 60_000 + 1;
  await coordinator.refresh("notification");
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].reasonCode, "E_RATE_LIMIT_READ");
  nowMs += 30_000;
  await coordinator.refresh("notification");
  assert.equal(unavailable.length, 1, "one failure streak must not repeatedly publish unavailable");
  await coordinator.stop();
});
