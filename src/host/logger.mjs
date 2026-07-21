import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_DIRECTORY_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LOG_FILE_MAX_BYTES = 1024 * 1024;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /["']?\bauthorization\b["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[^\s,"'}]+["']?/gi,
  /["']?\b(?:openai[_-]?api[_-]?key|api[_-]?key)\b["']?\s*[:=]\s*["']?[^\s,"'}]+["']?/gi,
  /["']?\b(?:access|refresh|id|bearer)?[_-]?token\b["']?\s*[:=]\s*["']?[^\s,"'}]+["']?/gi,
  /["']?\b(?:cookie|set-cookie|session|sessionid)\b["']?\s*[:=]\s*["']?[^\s,"'}]+["']?/gi,
  /\bbearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
];

const SAFE_DETAIL_KEYS = new Set([
  "bucketCount", "code", "failureCount", "message", "pid", "port", "reason", "source"
]);
const SAFE_LOG_CODES = new Set([
  "E_ANCHOR_AMBIGUOUS", "E_APP_SERVER_CLOSED", "E_APP_SERVER_UNSUPPORTED",
  "E_AUTH_UNSUPPORTED", "E_BROWSER_ID_CHANGED", "E_CACHE", "E_CDP_CLOSED",
  "E_CDP_OWNER_MISMATCH", "E_CODEX_RUNTIME_UNAVAILABLE", "E_DAEMON",
  "E_DAEMON_IDENTITY", "E_DAEMON_PARENT_TIMEOUT", "E_DAEMON_START",
  "E_DAEMON_STOPPED_BEFORE_READY", "E_LAYOUT_OVERLAP", "E_LIMIT_SCHEMA",
  "E_RATE_LIMIT_READ", "E_RATE_LIMIT_SCHEMA", "E_RATE_LIMIT_STALE",
  "E_RENDERER", "E_RENDERER_SIGNATURE", "E_RUNNING_WITHOUT_CDP",
  "E_RUNTIME_INTEGRITY", "E_SESSION_IDENTITY", "E_SESSION_UPDATE",
  "EACCES", "ENOENT", "EPERM",
]);

export function redactLogText(value, env = process.env) {
  let output = String(value);
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  const localPaths = [
    [env?.LOCALAPPDATA, "%LOCALAPPDATA%"],
    [env?.USERPROFILE, "%USERPROFILE%"],
  ].filter(([path]) => typeof path === "string" && path)
    .sort((left, right) => right[0].length - left[0].length);
  for (const [path, marker] of localPaths) output = replaceCaseInsensitive(output, path, marker);
  return output;
}

function replaceCaseInsensitive(value, search, replacement) {
  let output = String(value);
  const needle = String(search).toLowerCase();
  if (!needle) return output;
  let fromIndex = 0;
  while (fromIndex <= output.length) {
    const index = output.toLowerCase().indexOf(needle, fromIndex);
    if (index < 0) break;
    output = `${output.slice(0, index)}${replacement}${output.slice(index + search.length)}`;
    fromIndex = index + replacement.length;
  }
  return output;
}

export function createFileLogger(path, options = {}) {
  let queue = Promise.resolve();
  const append = options.appendFile ?? appendFile;
  const makeDirectory = options.mkdir ?? mkdir;
  const inspect = options.stat ?? stat;
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_FILE_MAX_BYTES;
  return (level, event, details = {}) => {
    const safeDetails = {};
    for (const [key, value] of Object.entries(details)) {
      if (!SAFE_DETAIL_KEYS.has(key)) continue;
      safeDetails[key] = key === "code"
        ? SAFE_LOG_CODES.has(String(value)) ? String(value) : "E_REDACTED"
        : redactLogText(value);
    }
    const line = `${JSON.stringify({ time: new Date().toISOString(), level, event, ...safeDetails })}\n`;
    queue = queue.then(async () => {
      await makeDirectory(dirname(path), { recursive: true });
      if (Buffer.byteLength(line, "utf8") > maxBytes) return;
      const current = await inspect(path).catch(() => null);
      if (current && current.size + Buffer.byteLength(line, "utf8") > maxBytes) return;
      await append(path, line, { encoding: "utf8", mode: 0o600 });
    }).catch(() => {});
    return queue;
  };
}

export async function pruneLogDirectory(directory, options = {}) {
  if (typeof directory !== "string" || !directory) throw new TypeError("Log directory is required");
  const list = options.readdir ?? readdir;
  const inspect = options.stat ?? stat;
  const remove = options.rm ?? rm;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_LOG_RETENTION_MS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_LOG_DIRECTORY_MAX_BYTES;
  const entries = await list(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry?.isFile?.() || !/^(?:daemon-.+\.(?:log|jsonl)|launcher-error\.log)$/i.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const info = await inspect(path).catch(() => null);
    if (!info || !Number.isFinite(info.size) || !Number.isFinite(info.mtimeMs)) continue;
    if (now() - info.mtimeMs > maxAgeMs) {
      await remove(path, { force: true }).catch(() => {});
      continue;
    }
    files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  let retainedBytes = 0;
  for (const file of files) {
    retainedBytes += file.size;
    if (retainedBytes <= maxTotalBytes) continue;
    await remove(file.path, { force: true }).catch(() => {});
  }
}
