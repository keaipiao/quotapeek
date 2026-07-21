import { stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readJson, writeJsonAtomic } from "../fs-utils.mjs";
import { toRendererQuotaSnapshot } from "../contracts.mjs";

export const QUOTA_CACHE_SCHEMA_VERSION = 2;
export const DEFAULT_QUOTA_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const GENERAL_BUCKET_ID = "codex";
const SPARK_LIMIT_NAME = "gpt-5.3-codex-spark";

/**
 * Return a deliberately opaque account context. The auth file contents are
 * never read. Size and modification time form a conservative change detector
 * for sign-in, sign-out, account switching, and credential refresh.
 */
export async function readQuotaAccountContext(options = {}) {
  const authPath = options.authPath ?? join(options.homeDir ?? homedir(), ".codex", "auth.json");
  const getStat = options.stat ?? stat;
  try {
    const metadata = await getStat(authPath);
    const size = Number(metadata.size);
    const mtimeMs = Number(metadata.mtimeMs);
    if (typeof metadata.isFile === "function" && !metadata.isFile()) return null;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
    return Object.freeze({ size, mtimeMs });
  } catch {
    return null;
  }
}

export async function removeQuotaCache(path, options = {}) {
  if (typeof path !== "string" || !path) throw new TypeError("Quota cache path is required");
  const remove = options.unlink ?? unlink;
  try {
    await remove(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readQuotaCache(path, options = {}) {
  const entry = await readQuotaCacheEntry(path, options);
  return entry?.snapshot ?? null;
}

export async function readQuotaCacheEntry(path, options = {}) {
  if (typeof path !== "string" || !path) throw new TypeError("Quota cache path is required");
  const read = options.readJson ?? readJson;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_QUOTA_CACHE_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new TypeError("Quota cache maxAgeMs must be non-negative");

  const [envelope, accountContext] = await Promise.all([
    read(path, null).catch(() => null),
    resolveAccountContext(options)
  ]);
  if (!isValidEnvelope(envelope) || !sameQuotaAccountContext(envelope.accountContext, accountContext)) {
    await removeInvalidCache(path, options);
    return null;
  }
  try {
    const snapshot = fromPersistedSnapshot(envelope.snapshot);
    const currentTime = now();
    const newestTimestamp = Math.max(envelope.savedAtMs, snapshot.fetchedAtMs);
    if (newestTimestamp > currentTime + MAX_FUTURE_SKEW_MS || currentTime - snapshot.fetchedAtMs > maxAgeMs) {
      await removeInvalidCache(path, options);
      return null;
    }
    return Object.freeze({
      snapshot,
      accountContext: Object.freeze({ ...envelope.accountContext }),
    });
  } catch {
    await removeInvalidCache(path, options);
    return null;
  }
}

export async function writeQuotaCache(path, snapshot, options = {}) {
  if (typeof path !== "string" || !path) throw new TypeError("Quota cache path is required");
  const write = options.writeJsonAtomic ?? writeJsonAtomic;
  const now = options.now ?? Date.now;
  const accountContext = await resolveAccountContext(options);
  if (!accountContext || (Object.hasOwn(options, "expectedAccountContext") &&
      !sameQuotaAccountContext(options.expectedAccountContext, accountContext))) {
    await removeInvalidCache(path, options);
    return null;
  }

  const persistedSnapshot = toPersistedSnapshot(snapshot);
  if (!persistedSnapshot) {
    await removeInvalidCache(path, options);
    return null;
  }
  const envelope = {
    schemaVersion: QUOTA_CACHE_SCHEMA_VERSION,
    savedAtMs: now(),
    accountContext,
    snapshot: persistedSnapshot,
  };
  await write(path, envelope);
  return envelope;
}

async function resolveAccountContext(options) {
  if (Object.hasOwn(options, "accountContext")) {
    return isValidAccountContext(options.accountContext) ? options.accountContext : null;
  }
  const readContext = options.readAccountContext ?? readQuotaAccountContext;
  const context = await readContext({
    authPath: options.authPath,
    homeDir: options.homeDir,
    stat: options.stat,
  }).catch(() => null);
  return isValidAccountContext(context) ? context : null;
}

async function removeInvalidCache(path, options) {
  await removeQuotaCache(path, { unlink: options.unlink });
}

function toPersistedSnapshot(value) {
  const safe = toRendererQuotaSnapshot(value);
  const bucket = selectGeneralCodexBucket(safe.buckets);
  if (!bucket || bucket.windows.length === 0 || safe.fetchedAtMs <= 0) return null;
  return {
    schemaVersion: 1,
    fetchedAtMs: safe.fetchedAtMs,
    buckets: [{
      id: GENERAL_BUCKET_ID,
      windows: bucket.windows.map((window) => ({
        kind: window.kind,
        usedPercent: window.usedPercent,
        remainingPercent: window.remainingPercent,
        durationMinutes: window.durationMinutes,
        resetsAtMs: window.resetsAtMs,
      })),
    }],
  };
}

function fromPersistedSnapshot(value) {
  if (!isPlainObjectWithKeys(value, ["schemaVersion", "fetchedAtMs", "buckets"]) ||
      value.schemaVersion !== 1 || !Number.isFinite(value.fetchedAtMs) || value.fetchedAtMs <= 0 ||
      !Array.isArray(value.buckets) || value.buckets.length !== 1) {
    throw new TypeError("Invalid persisted quota snapshot");
  }
  const bucket = value.buckets[0];
  if (!isPlainObjectWithKeys(bucket, ["id", "windows"]) || canonicalIdentifier(bucket.id) !== GENERAL_BUCKET_ID ||
      !Array.isArray(bucket.windows) || bucket.windows.length === 0 || bucket.windows.length > 2) {
    throw new TypeError("Invalid persisted quota bucket");
  }
  for (const window of bucket.windows) {
    if (!isPlainObjectWithKeys(window, ["kind", "usedPercent", "remainingPercent", "durationMinutes", "resetsAtMs"])) {
      throw new TypeError("Invalid persisted quota window");
    }
  }
  if (new Set(bucket.windows.map((window) => window.kind)).size !== bucket.windows.length) {
    throw new TypeError("Duplicate persisted quota window");
  }
  return toRendererQuotaSnapshot({
    schemaVersion: 1,
    fetchedAtMs: value.fetchedAtMs,
    buckets: [{ id: GENERAL_BUCKET_ID, windows: bucket.windows }],
  });
}

function selectGeneralCodexBucket(buckets) {
  const candidates = buckets.filter((bucket) => (
    canonicalIdentifier(bucket.id) === GENERAL_BUCKET_ID &&
    canonicalIdentifier(bucket.name) !== SPARK_LIMIT_NAME
  ));
  const unnamed = candidates.filter((bucket) => bucket.name === null);
  if (unnamed.length === 1) return unnamed[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function canonicalIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[_\s.]+/g, "-");
  return normalized || null;
}

export function sameQuotaAccountContext(left, right) {
  return isValidAccountContext(left) && isValidAccountContext(right) &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function isValidAccountContext(value) {
  return isPlainObjectWithKeys(value, ["size", "mtimeMs"]) &&
    Number.isSafeInteger(value.size) && value.size >= 0 &&
    Number.isFinite(value.mtimeMs) && value.mtimeMs >= 0;
}

function isValidEnvelope(value) {
  return isPlainObjectWithKeys(value, ["schemaVersion", "savedAtMs", "accountContext", "snapshot"]) &&
    value.schemaVersion === QUOTA_CACHE_SCHEMA_VERSION && Number.isFinite(value.savedAtMs) && value.savedAtMs > 0 &&
    isValidAccountContext(value.accountContext) && value.snapshot;
}

function isPlainObjectWithKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
