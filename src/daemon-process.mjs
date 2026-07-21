import { execFile, spawn as nodeSpawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { basename, join, posix, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { CodexQuotaError } from "./errors.mjs";
import { pruneLogDirectory } from "./host/logger.mjs";
import { systemWindowsPowerShellPath } from "./windows-trust.mjs";

const DEFAULT_INFO_TIMEOUT_MS = 5_000;
const DEFAULT_INFO_INTERVAL_MS = 75;
const DEFAULT_SPAWN_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

function daemonError(code, message, details) {
  return new CodexQuotaError(code, message, details);
}

async function defaultInfoRunner(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_INFO_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: options.env ?? process.env
    });
    return { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error?.stdout === "string" && error.stdout.trim()) {
      return {
        code: error.code,
        signal: error.signal ?? null,
        stdout: error.stdout,
        stderr: error.stderr ?? ""
      };
    }
    throw error;
  }
}

function normalizeComparablePath(value, platform = process.platform) {
  if (typeof value !== "string" || !value) return null;
  if (platform === "win32") return win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
  return posix.normalize(resolve(value)).replace(/\/+$/, "");
}

function samePath(left, right, platform) {
  const normalizedLeft = normalizeComparablePath(left, platform);
  const normalizedRight = normalizeComparablePath(right, platform);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function parseHelperEnvelope(stdout) {
  const lines = String(stdout ?? "").replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw daemonError("E_DAEMON_INFO", "Daemon helper returned unexpected stdout");
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    throw daemonError("E_DAEMON_INFO", "Daemon helper returned invalid JSON");
  }
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean") {
    throw daemonError("E_DAEMON_INFO", "Daemon helper returned an invalid envelope");
  }
  return value;
}

/** Parse the quoting form emitted by Windows CreateProcess/Node spawn. */
export function parseWindowsCommandLine(commandLine) {
  if (typeof commandLine !== "string") throw new TypeError("commandLine must be a string");
  const args = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/.test(commandLine[index] ?? "")) index += 1;
    if (index >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length) {
      const character = commandLine[index];
      if (!quoted && /\s/.test(character)) break;
      if (character === "\\") {
        let count = 0;
        while (commandLine[index] === "\\") {
          count += 1;
          index += 1;
        }
        if (commandLine[index] === "\"") {
          value += "\\".repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            value += "\"";
            index += 1;
          } else if (quoted && commandLine[index + 1] === "\"") {
            value += "\"";
            index += 2;
          } else {
            quoted = !quoted;
            index += 1;
          }
        } else {
          value += "\\".repeat(count);
        }
        continue;
      }
      if (character === "\"") {
        if (quoted && commandLine[index + 1] === "\"") {
          value += "\"";
          index += 2;
        } else {
          quoted = !quoted;
          index += 1;
        }
        continue;
      }
      value += character;
      index += 1;
    }
    args.push(value);
    while (/\s/.test(commandLine[index] ?? "")) index += 1;
  }
  return args;
}

export function buildDaemonSpec({ nodePath, engineRoot, sessionPath, nonce }) {
  for (const [name, value] of Object.entries({ nodePath, engineRoot, sessionPath, nonce })) {
    if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`);
  }
  const entryPath = join(engineRoot, "bin", "codex-quota.mjs");
  return Object.freeze({
    command: nodePath,
    arguments: Object.freeze([
      entryPath,
      "daemon",
      "--session", sessionPath,
      "--nonce", nonce,
      "--engine-root", engineRoot
    ]),
    entryPath,
    engineRoot,
    nodePath,
    sessionPath,
    nonce
  });
}

function commandMatches(commandLine, spec, platform) {
  const argv = parseWindowsCommandLine(commandLine);
  if (argv.length !== spec.arguments.length + 1) return false;
  if (!samePath(argv[0], spec.command, platform)) return false;
  for (let index = 0; index < spec.arguments.length; index += 1) {
    const actual = argv[index + 1];
    const expected = spec.arguments[index];
    if (index === 0 || index === 3 || index === 7) {
      if (!samePath(actual, expected, platform)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

export function validateDaemonInfo(info, spec, expected = {}, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!info || !Number.isSafeInteger(info.pid) || info.pid <= 0) {
    return { valid: false, reason: "invalid-pid" };
  }
  if (!samePath(info.executablePath, spec.command, platform)) {
    return { valid: false, reason: "executable-path" };
  }
  if (typeof info.commandLine !== "string" || !commandMatches(info.commandLine, spec, platform)) {
    return { valid: false, reason: "command-line" };
  }
  if (typeof info.startTime !== "string" || !Number.isFinite(Date.parse(info.startTime))) {
    return { valid: false, reason: "start-time" };
  }
  if (expected.executablePath && !samePath(info.executablePath, expected.executablePath, platform)) {
    return { valid: false, reason: "recorded-executable-path" };
  }
  if (expected.commandLine && info.commandLine !== expected.commandLine) {
    return { valid: false, reason: "recorded-command-line" };
  }
  if (expected.startTime && info.startTime !== expected.startTime) {
    return { valid: false, reason: "recorded-start-time" };
  }
  return { valid: true, info };
}

export async function readDaemonInfo(pid, options = {}) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) throw new TypeError("pid must be a positive integer");
  const helperPath = options.helperPath;
  if (typeof helperPath !== "string" || !helperPath) throw new TypeError("helperPath is required");
  const powershellPath = options.powershellPath ?? systemWindowsPowerShellPath(options.env);
  const runner = options.runner ?? defaultInfoRunner;
  const result = await runner(powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "RemoteSigned",
    "-File", helperPath,
    "-TargetPid", String(pid)
  ], {
    windowsHide: true,
    env: options.env ?? process.env,
    timeoutMs: options.queryTimeoutMs ?? DEFAULT_INFO_TIMEOUT_MS
  });
  const envelope = parseHelperEnvelope(result.stdout);
  const rawExitCode = result.code ?? result.exitCode;
  if (rawExitCode !== undefined && (Number(rawExitCode) === 0) !== envelope.ok) {
    throw daemonError("E_DAEMON_INFO_STATUS", "Daemon helper exit status disagrees with its JSON result", {
      pid: Number(pid)
    });
  }
  if (!envelope.ok) {
    throw daemonError(
      envelope.error?.code || "E_DAEMON_INFO",
      envelope.error?.message || "Unable to inspect daemon process",
      { pid: Number(pid) }
    );
  }
  return Object.freeze({
    pid: Number(envelope.pid),
    startTime: typeof envelope.startTime === "string" ? envelope.startTime : null,
    executablePath: typeof envelope.executablePath === "string" ? envelope.executablePath : null,
    commandLine: typeof envelope.commandLine === "string" ? envelope.commandLine : null
  });
}

export async function validateRecordedDaemon(session, spec, options = {}) {
  if (!session || !Number.isSafeInteger(Number(session.daemonPid)) || Number(session.daemonPid) <= 0) {
    return { valid: false, reason: "missing-pid" };
  }
  if (!session.daemonExecutablePath || !session.daemonCommandLine || !session.daemonStartTime) {
    return { valid: false, reason: "missing-recorded-identity" };
  }
  try {
    const info = await readDaemonInfo(Number(session.daemonPid), options);
    if (info.pid !== Number(session.daemonPid)) return { valid: false, reason: "pid" };
    return validateDaemonInfo(info, spec, {
      executablePath: session.daemonExecutablePath,
      commandLine: session.daemonCommandLine,
      startTime: session.daemonStartTime
    }, options);
  } catch (error) {
    return { valid: false, reason: error?.code ?? "inspection", error };
  }
}

export async function waitForDaemonInfo(pid, spec, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INFO_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INFO_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + timeoutMs;
  let lastReason = "not-found";
  while (now() < deadline) {
    try {
      const info = await readDaemonInfo(pid, options);
      if (info.pid !== Number(pid)) {
        throw daemonError("E_DAEMON_IDENTITY", "Daemon helper returned a different PID", { pid });
      }
      if (!info.executablePath || !info.commandLine || !info.startTime) {
        lastReason = "identity-not-ready";
        await sleep(intervalMs);
        continue;
      }
      const validation = validateDaemonInfo(info, spec, {}, options);
      if (validation.valid) return info;
      lastReason = validation.reason;
      throw daemonError("E_DAEMON_IDENTITY", "Spawned daemon identity did not match", {
        pid,
        reason: validation.reason
      });
    } catch (error) {
      if (!new Set(["E_PROCESS_NOT_FOUND", "E_DAEMON_INFO"]).has(error?.code)) throw error;
      lastReason = error.code;
    }
    await sleep(intervalMs);
  }
  throw daemonError("E_DAEMON_IDENTITY_TIMEOUT", "Timed out waiting for daemon process identity", {
    pid,
    reason: lastReason
  });
}

async function awaitSpawn(child, timeoutMs) {
  if (!child || typeof child.once !== "function") throw daemonError("E_DAEMON_SPAWN", "Daemon spawn returned no process");
  await new Promise((resolvePromise, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off?.("spawn", onSpawn);
      child.off?.("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolvePromise();
    };
    const onError = () => {
      cleanup();
      reject(daemonError("E_DAEMON_SPAWN", "Failed to spawn Codex Quota daemon"));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    timer = setTimeout(() => {
      cleanup();
      reject(daemonError("E_DAEMON_SPAWN_TIMEOUT", "Timed out waiting for daemon spawn"));
    }, timeoutMs);
    timer.unref?.();
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw daemonError("E_DAEMON_SPAWN", "Spawned daemon has no valid PID");
  }
}

export async function spawnDaemon(spec, options = {}) {
  const logsPath = options.logsPath;
  if (typeof logsPath !== "string" || !logsPath) throw new TypeError("logsPath is required");
  const mkdirImpl = options.mkdir ?? mkdir;
  const openImpl = options.open ?? open;
  const spawnImpl = options.spawn ?? nodeSpawn;
  await mkdirImpl(logsPath, { recursive: true });
  await (options.pruneLogs ?? pruneLogDirectory)(logsPath).catch(() => {});
  const safeNonce = spec.nonce.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
  const stamp = options.timestamp ?? Date.now();
  const stdoutPath = join(logsPath, `daemon-${stamp}-${safeNonce}.stdout.log`);
  const stderrPath = join(logsPath, `daemon-${stamp}-${safeNonce}.stderr.log`);
  const stdout = await openImpl(stdoutPath, "a", 0o600);
  let stderr;
  try {
    stderr = await openImpl(stderrPath, "a", 0o600);
  } catch (error) {
    await stdout.close();
    throw error;
  }

  let child;
  try {
    child = spawnImpl(spec.command, [...spec.arguments], {
      detached: !options.foreground,
      windowsHide: true,
      shell: false,
      cwd: spec.engineRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", stdout.fd, stderr.fd]
    });
    await awaitSpawn(child, options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
  } finally {
    await Promise.allSettled([stdout.close(), stderr.close()]);
  }
  if (!options.foreground) child.unref?.();
  return Object.freeze({
    child,
    pid: child.pid,
    stdoutPath,
    stderrPath,
    executableName: basename(spec.command)
  });
}
