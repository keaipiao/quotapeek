/**
 * @typedef {Object} QuotaWindow
 * @property {"primary"|"secondary"} kind
 * @property {number} usedPercent
 * @property {number} remainingPercent
 * @property {number|null} durationMinutes
 * @property {number|null} resetsAtMs
 */

/**
 * @typedef {Object} QuotaBucket
 * @property {string} id
 * @property {string|null} name
 * @property {string|null} planType
 * @property {QuotaWindow[]} windows
 * @property {string|null} reachedType
 */

/**
 * The only account data allowed to cross into the renderer.
 * @typedef {Object} QuotaSnapshot
 * @property {1} schemaVersion
 * @property {number} fetchedAtMs
 * @property {QuotaBucket[]} buckets
 * @property {number|null} resetCreditsAvailable
 */

export const QUOTA_SCHEMA_VERSION = 1;
export const RENDERER_GLOBAL = "__CODEX_QUOTA_PANEL__";
export const PUBLIC_UNAVAILABLE_REASON_CODES = Object.freeze([
  "E_APP_SERVER_CLOSED",
  "E_APP_SERVER_UNSUPPORTED",
  "E_AUTH_UNSUPPORTED",
  "E_CODEX_RUNTIME_UNAVAILABLE",
  "E_RATE_LIMIT_READ",
  "E_RATE_LIMIT_SCHEMA",
  "E_RATE_LIMIT_STALE",
  "E_RATE_LIMIT_UNAVAILABLE",
]);
const PUBLIC_UNAVAILABLE_REASON_CODE_SET = new Set(PUBLIC_UNAVAILABLE_REASON_CODES);
const MAX_RENDERER_BUCKETS = 32;
const MAX_RENDERER_WINDOWS = 2;

export function assertQuotaSnapshot(value) {
  if (!value || value.schemaVersion !== QUOTA_SCHEMA_VERSION || !Array.isArray(value.buckets)) {
    throw new TypeError("Invalid normalized quota snapshot");
  }
  return value;
}

/**
 * Construct the complete, explicit allow-list DTO that may cross the CDP
 * boundary.  Do not replace this with object spreading: provider responses can
 * grow over time and renderer expressions must never inherit account or debug
 * fields accidentally.
 */
export function toRendererQuotaSnapshot(value) {
  assertQuotaSnapshot(value);
  if (value.buckets.length > MAX_RENDERER_BUCKETS) throw new TypeError("Too many normalized quota buckets");
  const buckets = [];
  for (let index = 0; index < value.buckets.length; index += 1) {
    buckets.push(toRendererBucket(value.buckets[index]));
  }
  return {
    schemaVersion: QUOTA_SCHEMA_VERSION,
    fetchedAtMs: finiteOrNull(value.fetchedAtMs, "fetchedAtMs"),
    buckets,
    resetCreditsAvailable: nullableNonNegativeSafeInteger(value.resetCreditsAvailable, "resetCreditsAvailable"),
  };
}

export function toRendererUnavailableState(value) {
  const source = value && typeof value === "object" ? value : {};
  const candidate = typeof source.reasonCode === "string" ? source.reasonCode : source.reason;
  return {
    schemaVersion: QUOTA_SCHEMA_VERSION,
    reasonCode: toPublicUnavailableReasonCode(candidate),
    atMs: Number.isFinite(source.atMs) ? source.atMs : Date.now(),
  };
}

export function toPublicUnavailableReasonCode(value) {
  return typeof value === "string" && PUBLIC_UNAVAILABLE_REASON_CODE_SET.has(value)
    ? value
    : "E_RATE_LIMIT_UNAVAILABLE";
}

function toRendererBucket(value) {
  if (!value || typeof value.id !== "string" || !value.id || value.id.length > 128 || !Array.isArray(value.windows)) {
    throw new TypeError("Invalid normalized quota bucket");
  }
  if (value.windows.length > MAX_RENDERER_WINDOWS) throw new TypeError("Too many normalized quota windows");
  const windows = [];
  for (let index = 0; index < value.windows.length; index += 1) {
    windows.push(toRendererWindow(value.windows[index]));
  }
  return {
    id: value.id,
    name: nullableString(value.name, 256, "name"),
    planType: nullableString(value.planType, 128, "planType"),
    windows,
    reachedType: nullableString(value.reachedType, 128, "reachedType"),
  };
}

function toRendererWindow(value) {
  if (!value || (value.kind !== "primary" && value.kind !== "secondary")) {
    throw new TypeError("Invalid normalized quota window");
  }
  return {
    kind: value.kind,
    usedPercent: boundedFinite(value.usedPercent, "usedPercent", 0, 100),
    remainingPercent: boundedFinite(value.remainingPercent, "remainingPercent", 0, 100),
    durationMinutes: nullableNonNegativeSafeInteger(value.durationMinutes, "durationMinutes"),
    resetsAtMs: nullableNonNegativeSafeInteger(value.resetsAtMs, "resetsAtMs"),
  };
}

function finiteOrNull(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`Invalid normalized quota ${field}`);
  return value;
}

function boundedFinite(value, field, minimum, maximum) {
  const number = finiteOrNull(value, field);
  if (number < minimum || number > maximum) throw new TypeError(`Invalid normalized quota ${field}`);
  return number;
}

function nullableNonNegativeSafeInteger(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid normalized quota ${field}`);
  return value;
}

function nullableString(value, maximumLength, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new TypeError(`Invalid normalized quota ${field}`);
  }
  return value;
}
