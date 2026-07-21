import test from "node:test";
import assert from "node:assert/strict";
import { buildCallExpression, RendererBridge } from "../src/host/renderer-bridge.mjs";

function quotaSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    fetchedAtMs: 1,
    buckets: [{
      id: "codex",
      name: null,
      planType: null,
      reachedType: null,
      windows: [{
        kind: "primary",
        usedPercent: 25,
        remainingPercent: 75,
        durationMinutes: 300,
        resetsAtMs: 10_000,
      }],
    }],
    resetCreditsAvailable: null,
    ...overrides,
  };
}

function rendererArgument(expression, method) {
  const prefix = `api.${method}(`;
  const start = expression.indexOf(prefix);
  const suffix = ") : null; })()";
  const end = expression.lastIndexOf(suffix);
  assert.ok(start >= 0 && end > start, "renderer call expression has the expected envelope");
  return JSON.parse(expression.slice(start + prefix.length, end));
}

test("renderer bridge serializes only normalized quota data", async () => {
  const expressions = [];
  const watcher = {
    async start() {},
    async evaluateAll(expression) { expressions.push(expression); return []; },
    async close() {}
  };
  const bridge = new RendererBridge({ watcher, engineRoot: process.cwd() });
  const value = quotaSnapshot({
    email: "private@example.test",
    accessToken: "top-secret-token",
    debug: { trace: "private-debug-trace" },
  });
  value.buckets[0].email = "bucket@example.test";
  value.buckets[0].debug = "private-bucket-debug";
  value.buckets[0].windows[0].token = "private-window-token";
  value.buckets.map = () => [{ email: "overridden-map@example.test" }];
  value.buckets[0].windows.map = () => [{ token: "overridden-window-map" }];
  await bridge.publish(value);
  const dto = rendererArgument(expressions[0], "update");
  assert.deepEqual(Object.keys(dto).sort(), ["buckets", "fetchedAtMs", "resetCreditsAvailable", "schemaVersion"]);
  assert.deepEqual(Object.keys(dto.buckets[0]).sort(), ["id", "name", "planType", "reachedType", "windows"]);
  assert.deepEqual(Object.keys(dto.buckets[0].windows[0]).sort(), [
    "durationMinutes", "kind", "remainingPercent", "resetsAtMs", "usedPercent",
  ]);
  assert.match(expressions[0], /remainingPercent/);
  assert.doesNotMatch(expressions[0], /email|accessToken|token|debug|trace|auth|private/i);
});

test("unavailable renderer DTO permits only schemaVersion, reasonCode, and atMs", async () => {
  const expressions = [];
  const watcher = {
    async start() {},
    async evaluateAll(expression) { expressions.push(expression); return []; },
    async close() {},
  };
  const bridge = new RendererBridge({ watcher, engineRoot: process.cwd() });
  await bridge.unavailable({
    schemaVersion: 99,
    reasonCode: "E_APP_SERVER_CLOSED",
    atMs: 1234,
    email: "private@example.test",
    token: "private-token",
    debug: { diagnostics: true },
  });

  assert.deepEqual(Object.keys(rendererArgument(expressions[0], "unavailable")).sort(), ["atMs", "reasonCode", "schemaVersion"]);
  assert.match(expressions[0], /"schemaVersion":1/);
  assert.match(expressions[0], /"reasonCode":"E_APP_SERVER_CLOSED"/);
  assert.match(expressions[0], /"atMs":1234/);
  assert.doesNotMatch(expressions[0], /email|token|debug|diagnostics|private/i);

  expressions.length = 0;
  await bridge.unavailable({ reason: "private provider error text" });
  assert.match(expressions[0], /"reasonCode":"E_RATE_LIMIT_UNAVAILABLE"/);
  assert.doesNotMatch(expressions[0], /private provider error text/);

  expressions.length = 0;
  await bridge.unavailable({ reasonCode: "SECRET_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  assert.match(expressions[0], /"reasonCode":"E_RATE_LIMIT_UNAVAILABLE"/);
  assert.doesNotMatch(expressions[0], /SECRET_TOKEN/);
});

test("new renderer pages immediately receive the last cached snapshot", async () => {
  let startOptions;
  const broadcasts = [];
  const watcher = {
    async start(options) { startOptions = options; },
    async evaluateAll(expression) { broadcasts.push(expression); return []; },
    async close() {},
  };
  const bridge = new RendererBridge({ watcher, engineRoot: process.cwd() });
  await bridge.start();
  await bridge.publish(quotaSnapshot());

  const sent = [];
  await startOptions.onPageReady({
    async evaluate(expression, options) { sent.push({ expression, options }); return {}; },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].expression, broadcasts[0]);
  assert.equal(sent[0].options.awaitPromise, true);
  assert.equal(sent[0].options.returnByValue, true);
});

test("a persisted cache replay is marked cached and remains renderer-safe", async () => {
  const expressions = [];
  const watcher = {
    async start() {},
    async evaluateAll(expression) { expressions.push(expression); return []; },
    async close() {},
  };
  const bridge = new RendererBridge({ watcher, engineRoot: process.cwd() });
  const value = quotaSnapshot({ token: "private-token" });
  await bridge.publishCached(value);
  const envelope = rendererArgument(expressions[0], "update");
  assert.equal(envelope.availability, "cached");
  assert.deepEqual(Object.keys(envelope).sort(), ["availability", "snapshot"]);
  assert.equal(envelope.snapshot.buckets[0].windows[0].remainingPercent, 75);
  assert.doesNotMatch(expressions[0], /private-token|email|accessToken|debug/i);
});

test("the latest unavailable state supersedes a cached snapshot for page replay", async () => {
  let startOptions;
  const watcher = {
    async start(options) { startOptions = options; },
    async evaluateAll() { return []; },
    async close() {},
  };
  const bridge = new RendererBridge({ watcher, engineRoot: process.cwd() });
  await bridge.start();
  await bridge.publish(quotaSnapshot());
  await bridge.unavailable({ reasonCode: "E_RATE_LIMIT_STALE", atMs: 999 });

  const sent = [];
  await startOptions.onPageReady({ async evaluate(expression) { sent.push(expression); } });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\.unavailable\(/);
  assert.doesNotMatch(sent[0], /remainingPercent/);
});

test("renderer expressions cannot inject through method names", () => {
  assert.throws(() => buildCallExpression("cleanup);alert(1)//"));
  assert.match(buildCallExpression("status"), /\.status\(\)/);
});

test("renderer DTO rejects oversized or out-of-range normalized payloads", async () => {
  const bridge = new RendererBridge({
    watcher: { async evaluateAll() {}, async close() {} },
    engineRoot: process.cwd()
  });
  await assert.rejects(bridge.publish(quotaSnapshot({ buckets: Array.from({ length: 33 }, () => quotaSnapshot().buckets[0]) })), /Too many/);
  const tooManyWindows = quotaSnapshot();
  tooManyWindows.buckets[0].windows.push(
    { ...tooManyWindows.buckets[0].windows[0], kind: "secondary" },
    { ...tooManyWindows.buckets[0].windows[0] }
  );
  await assert.rejects(bridge.publish(tooManyWindows), /Too many/);
  const outOfRange = quotaSnapshot();
  outOfRange.buckets[0].windows[0].remainingPercent = 101;
  await assert.rejects(bridge.publish(outOfRange), /remainingPercent/);
});
