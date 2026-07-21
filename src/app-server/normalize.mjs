import { QUOTA_SCHEMA_VERSION } from "../contracts.mjs";
import { CodexQuotaError, ERROR_CODES } from "../errors.mjs";

const MAX_UNIX_SECONDS = 253_402_300_799;
const MAX_BUCKETS = 32;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 256;
const MAX_ENUM_LENGTH = 128;
const PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_usage_based", "business",
  "enterprise_cbp_usage_based", "enterprise", "edu", "unknown"
]);
const REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);

function schemaError(message) {
  return new CodexQuotaError(ERROR_CODES.RATE_LIMIT_SCHEMA, message);
}

function optionalString(value, maxLength, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  if (value.length > maxLength) throw schemaError(`${field} exceeds its size limit`);
  return value;
}

function normalizeDuration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function unixSecondsToMs(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UNIX_SECONDS) return null;
  return value * 1000;
}

function normalizeWindow(kind, value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError(`Invalid ${kind} rate-limit window`);
  }
  if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) {
    throw schemaError(`Invalid ${kind} used percentage`);
  }

  const usedPercent = Math.min(100, Math.max(0, value.usedPercent));
  return {
    kind,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    durationMinutes: normalizeDuration(value.windowDurationMins),
    resetsAtMs: unixSecondsToMs(value.resetsAt)
  };
}

function normalizeBucket(id, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError("Invalid rate-limit bucket");
  }
  const windows = [
    normalizeWindow("primary", value.primary),
    normalizeWindow("secondary", value.secondary)
  ].filter(Boolean);

  const planType = optionalString(value.planType, MAX_ENUM_LENGTH, "Plan type");
  const reachedType = optionalString(value.rateLimitReachedType, MAX_ENUM_LENGTH, "Reached type");
  return {
    id,
    name: optionalString(value.limitName, MAX_LABEL_LENGTH, "Rate-limit name"),
    planType: PLAN_TYPES.has(planType) ? planType : null,
    windows,
    reachedType: REACHED_TYPES.has(reachedType) ? reachedType : null
  };
}

function resetCreditCount(value) {
  const count = value?.rateLimitResetCredits?.availableCount;
  if (typeof count === "bigint") {
    return count >= 0n && count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null;
  }
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/**
 * Allow-list and normalize app-server's account/rateLimits/read result.
 * Arbitrary account fields (including email and tokens) are never copied.
 *
 * @param {unknown} result
 * @param {number} [nowMs]
 * @returns {import("../contracts.mjs").QuotaSnapshot}
 */
export function normalizeRateLimits(result, nowMs = Date.now()) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw schemaError("Invalid account/rateLimits/read response");
  }
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError("nowMs must be a non-negative finite number");
  }

  const buckets = [];
  const byId = result.rateLimitsByLimitId;
  if (byId !== null && byId !== undefined) {
    if (typeof byId !== "object" || Array.isArray(byId)) {
      throw schemaError("Invalid rateLimitsByLimitId map");
    }
    const entries = Object.entries(byId);
    if (entries.length > MAX_BUCKETS) throw schemaError("Too many rate-limit buckets");
    for (const [id, bucket] of entries) {
      if (bucket === null || bucket === undefined) continue;
      const normalizedId = optionalString(id, MAX_ID_LENGTH, "Rate-limit id");
      if (!normalizedId) throw schemaError("Rate-limit id is empty");
      buckets.push(normalizeBucket(normalizedId, bucket));
    }
  }

  if (buckets.length === 0) {
    const fallback = result.rateLimits;
    if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
      throw schemaError("No usable rate-limit bucket was returned");
    }
    const id = optionalString(fallback.limitId, MAX_ID_LENGTH, "Rate-limit id") ?? "codex";
    buckets.push(normalizeBucket(id, fallback));
  }

  return {
    schemaVersion: QUOTA_SCHEMA_VERSION,
    fetchedAtMs: nowMs,
    buckets,
    resetCreditsAvailable: resetCreditCount(result)
  };
}
