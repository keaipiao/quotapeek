import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readQuotaCache, readQuotaCacheEntry, writeQuotaCache } from "../src/host/quota-cache.mjs";

function snapshot(fetchedAtMs) {
  return {
    schemaVersion: 1,
    fetchedAtMs,
    buckets: [{
      id: "codex",
      name: "GPT-5.3-Codex-Spark",
      planType: "plus",
      reachedType: "spark-limit",
      windows: [{
        kind: "primary",
        usedPercent: 90,
        remainingPercent: 10,
        durationMinutes: 300,
        resetsAtMs: fetchedAtMs + 30_000,
      }],
    }, {
      id: "codex",
      name: null,
      planType: "plus",
      reachedType: "weekly",
      windows: [{
        kind: "primary",
        usedPercent: 25,
        remainingPercent: 75,
        durationMinutes: 10_080,
        resetsAtMs: fetchedAtMs + 60_000,
        token: "private-window-token",
      }],
      email: "private@example.test",
    }],
    resetCreditsAvailable: 12,
    accessToken: "private-access-token",
  };
}

async function cacheFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "quota-cache.json");
  const authPath = join(root, "auth.json");
  await writeFile(authPath, "test-auth-context", "utf8");
  return { root, path, authPath };
}

async function assertMissing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

test("quota cache persists only the displayed general Codex bucket and minimal window fields", async (t) => {
  const { path, authPath } = await cacheFixture(t);
  const now = 1_800_000_000_000;
  await writeQuotaCache(path, snapshot(now - 1_000), { now: () => now, authPath });

  const rawText = await readFile(path, "utf8");
  assert.doesNotMatch(rawText, /private|email|token|access|spark|name|planType|reachedType|resetCredits/i);
  const raw = JSON.parse(rawText);
  assert.deepEqual(Object.keys(raw.snapshot).sort(), ["buckets", "fetchedAtMs", "schemaVersion"]);
  assert.equal(raw.snapshot.buckets.length, 1);
  assert.deepEqual(Object.keys(raw.snapshot.buckets[0]).sort(), ["id", "windows"]);
  assert.equal(raw.snapshot.buckets[0].id, "codex");
  assert.deepEqual(Object.keys(raw.snapshot.buckets[0].windows[0]).sort(), [
    "durationMinutes", "kind", "remainingPercent", "resetsAtMs", "usedPercent"
  ]);

  const cached = await readQuotaCache(path, { now: () => now, authPath });
  assert.equal(cached.buckets.length, 1);
  assert.equal(cached.buckets[0].id, "codex");
  assert.equal(cached.buckets[0].windows[0].remainingPercent, 75);
});

test("quota cache rejects a different auth-file context and physically deletes the cache", async (t) => {
  const { path, authPath } = await cacheFixture(t);
  const now = 1_800_000_000_000;
  await writeQuotaCache(path, snapshot(now - 1_000), { now: () => now, authPath });

  // A different size is deterministic even on filesystems with coarse mtime resolution.
  await writeFile(authPath, "different-account-context-with-a-new-size", "utf8");
  assert.equal(await readQuotaCache(path, { now: () => now, authPath }), null);
  await assertMissing(path);
});

test("expired, future, and malformed cache files are rejected and physically deleted", async (t) => {
  const now = 1_800_000_000_000;

  for (const scenario of ["expired", "future", "malformed"]) {
    const { path, authPath } = await cacheFixture(t);
    if (scenario === "expired") {
      await writeQuotaCache(path, snapshot(now - 16 * 60_000), { now: () => now, authPath });
    } else if (scenario === "future") {
      await writeQuotaCache(path, snapshot(now), { now: () => now + 120_000, authPath });
    } else {
      await writeFile(path, "{not-json", "utf8");
    }
    assert.equal(await readQuotaCache(path, { now: () => now, authPath }), null, scenario);
    await assertMissing(path);
  }
});

test("missing auth.json disables persistence and removes any previous cache", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-cache-no-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "quota-cache.json");
  const authPath = join(root, "missing-auth.json");
  await writeFile(path, "stale", "utf8");

  const result = await writeQuotaCache(path, snapshot(1_800_000_000_000), { authPath });
  assert.equal(result, null);
  await assertMissing(path);
});

test("a cache write is refused when auth context changed after the snapshot read", async (t) => {
  const { path, authPath } = await cacheFixture(t);
  const now = 1_800_000_000_000;
  await writeQuotaCache(path, snapshot(now - 1_000), { now: () => now, authPath });
  const entry = await readQuotaCacheEntry(path, { now: () => now, authPath });
  assert.ok(entry?.accountContext);

  await writeFile(authPath, "account-switched-after-rate-limit-read", "utf8");
  const result = await writeQuotaCache(path, snapshot(now), {
    now: () => now,
    authPath,
    expectedAccountContext: entry.accountContext
  });
  assert.equal(result, null);
  await assertMissing(path);
});
