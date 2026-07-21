import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRateLimits } from "../src/app-server/normalize.mjs";
import { ERROR_CODES } from "../src/errors.mjs";

function bucket(overrides = {}) {
  return {
    limitId: "codex",
    limitName: "Codex",
    planType: "plus",
    primary: {
      usedPercent: 27.5,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000
    },
    secondary: null,
    rateLimitReachedType: null,
    ...overrides
  };
}

test("normalizes the multi-bucket response and prefers its map", () => {
  const result = normalizeRateLimits({
    rateLimits: bucket({ limitId: "legacy", limitName: "Legacy" }),
    rateLimitsByLimitId: {
      codex: bucket(),
      review: bucket({
        limitId: "ignored-map-key-wins",
        limitName: "Code review",
        primary: null,
        secondary: {
          usedPercent: 10,
          windowDurationMins: 10_080,
          resetsAt: 1_900_000_000
        },
        rateLimitReachedType: "rate_limit_reached"
      })
    },
    rateLimitResetCredits: { availableCount: 2, credits: [] }
  }, 123_456);

  assert.deepEqual(result, {
    schemaVersion: 1,
    fetchedAtMs: 123_456,
    buckets: [
      {
        id: "codex",
        name: "Codex",
        planType: "plus",
        windows: [{
          kind: "primary",
          usedPercent: 27.5,
          remainingPercent: 72.5,
          durationMinutes: 300,
          resetsAtMs: 1_800_000_000_000
        }],
        reachedType: null
      },
      {
        id: "review",
        name: "Code review",
        planType: "plus",
        windows: [{
          kind: "secondary",
          usedPercent: 10,
          remainingPercent: 90,
          durationMinutes: 10_080,
          resetsAtMs: 1_900_000_000_000
        }],
        reachedType: "rate_limit_reached"
      }
    ],
    resetCreditsAvailable: 2
  });
});

test("falls back to the historical single bucket", () => {
  const result = normalizeRateLimits({
    rateLimits: bucket({ limitId: null }),
    rateLimitsByLimitId: {},
    rateLimitResetCredits: null
  }, 1);

  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].id, "codex");
  assert.equal(result.resetCreditsAvailable, null);
});

test("strictly clamps percentages without coercing strings", () => {
  const result = normalizeRateLimits({
    rateLimits: bucket({
      primary: { usedPercent: -12, windowDurationMins: -1, resetsAt: "1800000000" },
      secondary: { usedPercent: 132, windowDurationMins: 60.5, resetsAt: 1_800_000_000_000 }
    })
  }, 2);

  assert.deepEqual(result.buckets[0].windows, [
    {
      kind: "primary",
      usedPercent: 0,
      remainingPercent: 100,
      durationMinutes: null,
      resetsAtMs: null
    },
    {
      kind: "secondary",
      usedPercent: 100,
      remainingPercent: 0,
      durationMinutes: null,
      resetsAtMs: null
    }
  ]);
});

test("copies only renderer-safe allow-listed fields", () => {
  const secretEmail = "private@example.test";
  const secretToken = "sk-secret-never-copy";
  const result = normalizeRateLimits({
    account: { email: secretEmail, accessToken: secretToken },
    email: secretEmail,
    token: secretToken,
    rateLimits: {
      ...bucket({ planType: secretToken, rateLimitReachedType: secretEmail }),
      credits: { token: secretToken },
      unknown: { email: secretEmail }
    },
    rateLimitResetCredits: {
      availableCount: 1n,
      credits: [{ token: secretToken, email: secretEmail }]
    }
  }, 3);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private@example\.test/);
  assert.doesNotMatch(serialized, /sk-secret-never-copy/);
  assert.equal(result.buckets[0].planType, null);
  assert.equal(result.buckets[0].reachedType, null);
  assert.equal(result.resetCreditsAvailable, 1);
});

test("rejects malformed schemas instead of inventing quota", () => {
  for (const value of [null, [], {}, { rateLimits: { primary: { usedPercent: "50" } } }]) {
    assert.throws(
      () => normalizeRateLimits(value, 1),
      (error) => error.code === ERROR_CODES.RATE_LIMIT_SCHEMA
    );
  }
  assert.throws(() => normalizeRateLimits({ rateLimits: bucket() }, Number.NaN), TypeError);
});

test("ignores unsafe reset-credit counts", () => {
  assert.equal(normalizeRateLimits({
    rateLimits: bucket(),
    rateLimitResetCredits: { availableCount: Number.MAX_SAFE_INTEGER + 1 }
  }, 4).resetCreditsAvailable, null);

  assert.equal(normalizeRateLimits({
    rateLimits: bucket(),
    rateLimitResetCredits: { availableCount: BigInt(Number.MAX_SAFE_INTEGER) + 1n }
  }, 4).resetCreditsAvailable, null);
});

test("bounds bucket count and renderer-visible strings", () => {
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
    `bucket-${index}`,
    bucket()
  ]));
  assert.throws(
    () => normalizeRateLimits({ rateLimits: bucket(), rateLimitsByLimitId: tooMany }, 5),
    (error) => error.code === ERROR_CODES.RATE_LIMIT_SCHEMA && /Too many/.test(error.message)
  );

  assert.throws(
    () => normalizeRateLimits({ rateLimits: bucket({ limitName: "x".repeat(257) }) }, 5),
    (error) => error.code === ERROR_CODES.RATE_LIMIT_SCHEMA && /size limit/.test(error.message)
  );

  assert.throws(
    () => normalizeRateLimits({
      rateLimits: bucket(),
      rateLimitsByLimitId: { ["x".repeat(129)]: bucket() }
    }, 5),
    (error) => error.code === ERROR_CODES.RATE_LIMIT_SCHEMA && /size limit/.test(error.message)
  );
});
