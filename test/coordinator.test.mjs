import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { QuotaCoordinator } from "../src/host/quota-coordinator.mjs";

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
    publish: async (value, context) => publications.push({ value, context }),
    pollMinMs: 60_000,
    pollMaxMs: 60_000
  });

  await coordinator.start();
  assert.equal(readCount, 2);
  assert.deepEqual(publications.map(({ context }) => context.accountContextStable), [false, true]);
  assert.equal(publications[1].context.accountContextAfter, accountB);
  await coordinator.stop();
});
