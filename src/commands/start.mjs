import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { numberFlag } from "../cli-args.mjs";
import {
  buildDaemonSpec,
  spawnDaemon,
  validateRecordedDaemon,
  waitForDaemonInfo
} from "../daemon-process.mjs";
import { CodexQuotaError } from "../errors.mjs";
import { acquireFileLock, isProcessRunning, pathExists, readJson, writeJsonAtomic } from "../fs-utils.mjs";
import { redactLogText } from "../host/logger.mjs";
import { PACKAGE_ROOT, getPaths } from "../paths.mjs";
import { createSessionRecord, updateSession } from "../session-state.mjs";
import { chooseLoopbackPort } from "../cdp/loopback.mjs";
import { installNativeQuotaSuppression } from "../cdp/native-suppressor.mjs";
import { launchCodexWithCdp } from "../cdp/windows-launcher.mjs";
import { getInstalledRuntime } from "./install.mjs";

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_READY_INTERVAL_MS = 100;

function startError(code, message, details) {
  return new CodexQuotaError(code, message, details);
}

function booleanFlag(options, name) {
  const value = options[name];
  if (value === undefined) return false;
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be a boolean flag`);
}

export function parseStartOptions(options = {}) {
  return Object.freeze({
    port: numberFlag(options, "port", { min: 1024, max: 65535 }),
    installed: booleanFlag(options, "installed"),
    foreground: booleanFlag(options, "foreground")
  });
}

function pathEqual(left, right, platform = process.platform) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (platform === "win32") {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

async function selectRuntime(parsed, options, services) {
  const installed = await services.getInstalledRuntime({ env: options.env });
  if (installed) {
    return Object.freeze({
      engineRoot: installed.engineRoot,
      nodePath: installed.nodePath,
      source: "installed",
      version: installed.version ?? null
    });
  }
  if (parsed.installed) {
    throw startError("E_RUNTIME_NOT_INSTALLED", "No valid installed Codex Quota runtime was found");
  }
  return Object.freeze({
    engineRoot: services.packageRoot,
    nodePath: services.processExecPath,
    source: "source",
    version: null
  });
}

function runtimeMatchesSession(runtime, session, platform) {
  return pathEqual(runtime.engineRoot, session?.engineRoot, platform) &&
    pathEqual(runtime.nodePath, session?.nodePath, platform);
}

function safePort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : undefined;
}

/** Flatten the verified launcher's package/owner envelopes for createSessionRecord. */
export function mapLaunchToSessionInput(launch) {
  if (!launch || typeof launch !== "object") throw new TypeError("launch result is required");
  const packageInfo = launch.package && typeof launch.package === "object" ? launch.package : {};
  const owner = launch.owner && typeof launch.owner === "object" ? launch.owner : {};
  return {
    port: launch.port,
    browserId: launch.browserId,
    browserWebSocketUrl: launch.browserWebSocketUrl,
    packageName: packageInfo.name ?? null,
    packageFullName: packageInfo.packageFullName ?? owner.packageFullName ?? null,
    packageFamilyName: packageInfo.packageFamilyName ?? owner.packageFamilyName ?? null,
    packageVersion: packageInfo.version ?? null,
    executablePath: owner.executablePath ?? packageInfo.executablePath ?? null,
    processId: owner.pid ?? null
  };
}

export function createPendingLaunchRecord({ port, runtime, nonce = randomUUID(), createdAtMs = Date.now() }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("Pending launch has an invalid CDP port");
  if (!runtime || typeof runtime.engineRoot !== "string" || typeof runtime.nodePath !== "string") {
    throw new TypeError("Pending launch has an invalid runtime identity");
  }
  if (typeof nonce !== "string" || !nonce) throw new TypeError("Pending launch nonce is required");
  return {
    schemaVersion: 1,
    nonce,
    status: "launching",
    createdAtMs,
    port,
    browserId: null,
    browserWebSocketUrl: null,
    daemonPid: null,
    daemonIdentityReady: false,
    engineRoot: runtime.engineRoot,
    nodePath: runtime.nodePath,
    runtimeSource: runtime.source
  };
}

function sessionError(session) {
  const code = typeof session?.error?.code === "string"
    ? session.error.code
    : typeof session?.errorCode === "string" ? session.errorCode : "E_DAEMON_START";
  const message = typeof session?.error?.message === "string"
    ? session.error.message
    : typeof session?.errorMessage === "string"
      ? session.errorMessage
      : "Codex Quota daemon reported an error";
  return startError(code, redactLogText(message).slice(0, 512));
}

export async function waitForSessionTerminal(sessionPath, nonce, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const read = options.readJson ?? readJson;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const session = await read(sessionPath, null).catch(() => null);
    if (session && session.nonce !== nonce) {
      throw startError("E_SESSION_IDENTITY", "Session identity changed while waiting for daemon readiness");
    }
    if (session?.status === "ready") return session;
    if (session?.status === "error") throw sessionError(session);
    await sleep(intervalMs);
  }
  throw startError("E_DAEMON_READY_TIMEOUT", "Timed out waiting for Codex Quota daemon readiness", {
    sessionPath
  });
}

function diagnosticError(error) {
  const rawCode = typeof error?.code === "string" ? error.code : "E_START";
  const code = /^[A-Z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : "E_START";
  const message = redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 512);
  return { code, message, atMs: Date.now() };
}

async function preserveSessionError(path, nonce, error, services) {
  try {
    const current = await services.readJson(path, null);
    if (!current || current.nonce !== nonce || current.status === "error") return;
    const diagnostic = diagnosticError(error);
    await services.updateSession(path, nonce, {
      status: "error",
      error: diagnostic,
      errorCode: diagnostic.code,
      errorMessage: diagnostic.message,
      failedAtMs: diagnostic.atMs
    });
  } catch {
    // A changed session belongs to another operation; never overwrite it.
  }
}

function daemonInfoOptions(runtime, options, services) {
  return {
    helperPath: join(runtime.engineRoot, "windows", "daemon-info.ps1"),
    powershellPath: options.powershellPath,
    env: options.env,
    runner: services.daemonInfoRunner,
    platform: services.platform,
    timeoutMs: options.daemonInfoTimeoutMs,
    intervalMs: options.daemonInfoIntervalMs,
    sleep: services.sleep,
    now: services.now
  };
}

function resultFromSession(session, reused) {
  return {
    ok: true,
    reused,
    daemonPid: session.daemonPid,
    port: session.port,
    sessionPath: session.sessionPath ?? null,
    status: session.status
  };
}

export async function startCommand(options = {}, dependencies = {}) {
  const parsed = parseStartOptions(options);
  const services = {
    platform: process.platform,
    packageRoot: PACKAGE_ROOT,
    processExecPath: process.execPath,
    getPaths,
    getInstalledRuntime,
    acquireFileLock,
    isProcessRunning,
    pathExists,
    readJson,
    writeJsonAtomic,
    createSessionRecord,
    updateSession,
    launchCodexWithCdp,
    chooseLoopbackPort,
    installNativeQuotaSuppression,
    createNonce: randomUUID,
    buildDaemonSpec,
    spawnDaemon,
    validateRecordedDaemon,
    waitForDaemonInfo,
    waitForSessionTerminal,
    removeStopRequest: (path) => rm(path, { force: true }),
    sleep: delay,
    now: Date.now,
    daemonInfoRunner: undefined,
    ...dependencies
  };
  if (services.platform !== "win32" && !options.allowNonWindows) {
    throw new Error("Codex Quota currently supports Windows only");
  }

  const paths = services.getPaths(options.env);
  const release = await services.acquireFileLock(paths.lock, { operation: "start" });
  let activeNonce = null;
  let ownershipTransferred = false;
  try {
    const runtime = await selectRuntime(parsed, options, services);
    const runtimeEntry = join(runtime.engineRoot, "bin", "codex-quota.mjs");
    const helperPath = join(runtime.engineRoot, "windows", "daemon-info.ps1");
    if (!await services.pathExists(runtimeEntry)) {
      throw startError("E_RUNTIME_INCOMPLETE", "Codex Quota runtime entry is missing");
    }
    if (!await services.pathExists(runtime.nodePath)) {
      throw startError("E_RUNTIME_INCOMPLETE", "Configured Node.js runtime is missing");
    }
    if (!await services.pathExists(helperPath)) {
      throw startError("E_RUNTIME_INCOMPLETE", "Daemon identity helper is missing");
    }

    const existing = await services.readJson(paths.session, null).catch(() => null);
    const infoOptions = daemonInfoOptions(runtime, options, services);
    if (existing?.nonce && existing.engineRoot && existing.nodePath &&
        !runtimeMatchesSession(runtime, existing, services.platform)) {
      let recordedSpec = null;
      try {
        recordedSpec = services.buildDaemonSpec({
          nodePath: existing.nodePath,
          engineRoot: existing.engineRoot,
          sessionPath: paths.session,
          nonce: existing.nonce
        });
      } catch {
        // A malformed stale record is not executable and cannot be reused.
      }
      if (recordedSpec) {
        const recordedValidation = await services.validateRecordedDaemon(existing, recordedSpec, infoOptions);
        if (recordedValidation.valid) {
          throw startError(
            "E_DAEMON_RUNTIME_MISMATCH",
            "A verified Codex Quota daemon is still using a different runtime; fully exit Codex and wait for that daemon to clean itself up before starting again"
          );
        }
      }
    }
    if (existing?.nonce && safePort(existing.port) !== undefined && runtimeMatchesSession(runtime, existing, services.platform)) {
      const existingSpec = services.buildDaemonSpec({
        nodePath: runtime.nodePath,
        engineRoot: runtime.engineRoot,
        sessionPath: paths.session,
        nonce: existing.nonce
      });
      const validation = await services.validateRecordedDaemon(existing, existingSpec, infoOptions);
      if (validation.valid) {
        ownershipTransferred = true;
        if (parsed.port !== undefined && parsed.port !== existing.port) {
          throw startError(
            "E_DAEMON_PORT_MISMATCH",
            `Codex Quota is already running on CDP port ${existing.port}`
          );
        }
        if (existing.status === "error") throw sessionError(existing);
        let terminal = existing;
        if (existing.status !== "ready") {
          terminal = await services.waitForSessionTerminal(paths.session, existing.nonce, {
            timeoutMs: options.readyTimeoutMs,
            intervalMs: options.readyIntervalMs,
            readJson: services.readJson,
            sleep: services.sleep,
            now: services.now
          });
        }
        const finalValidation = await services.validateRecordedDaemon(terminal, existingSpec, infoOptions);
        if (!finalValidation.valid) {
          throw startError("E_DAEMON_IDENTITY", "Existing daemon identity changed", {
            reason: finalValidation.reason
          });
        }
        return {
          ...resultFromSession({ ...terminal, sessionPath: paths.session }, true),
          engineRoot: runtime.engineRoot,
          runtimeSource: runtime.source
        };
      }
      if (existing.daemonPid && services.isProcessRunning(existing.daemonPid)) {
        throw startError(
          "E_DAEMON_IDENTITY",
          `A process is still using recorded daemon PID ${existing.daemonPid}, but its full identity could not be verified (${validation.reason}); no replacement was started`
        );
      }
    }

    if (existing?.daemonPid && services.isProcessRunning(existing.daemonPid)) {
      throw startError(
        "E_DAEMON_IDENTITY",
        `A process is still using recorded daemon PID ${existing.daemonPid}, but its full identity could not be verified; no replacement was started`
      );
    }

    const daemonLockPath = paths.daemonLock ?? join(paths.root, "daemon.lock");
    let daemonLock = null;
    try {
      daemonLock = await services.readJson(daemonLockPath, null);
    } catch {
      if (await services.pathExists(daemonLockPath)) {
        throw startError("E_DAEMON_LIFECYCLE_ACTIVE", "The daemon lifecycle lock exists but could not be verified; no replacement daemon was started");
      }
    }
    if (daemonLock?.pid && services.isProcessRunning(daemonLock.pid)) {
      throw startError(
        "E_DAEMON_LIFECYCLE_ACTIVE",
        `A Codex Quota lifecycle lock is still held by PID ${daemonLock.pid}; no replacement daemon was started`
      );
    }

    const launchPort = parsed.port ?? safePort(existing?.port) ?? await services.chooseLoopbackPort();
    const pending = createPendingLaunchRecord({
      port: launchPort,
      runtime,
      nonce: services.createNonce(),
      createdAtMs: services.now()
    });
    activeNonce = pending.nonce;
    // Persist the selected port before activation. If endpoint discovery fails
    // after Codex starts, the next invocation can recover the exact listener.
    await services.writeJsonAtomic(paths.session, pending);
    const launch = await services.launchCodexWithCdp({ port: launchPort });

    // Install the document-lifetime native-card policy at the earliest safely
    // verified point. It is intentionally fire-and-forget: target discovery
    // is bounded, while the installed stylesheet itself has no visual gap.
    try {
      void Promise.resolve(services.installNativeQuotaSuppression({
        engineRoot: runtime.engineRoot,
        port: launch.port,
        browserId: launch.browserId,
        browserWebSocketUrl: launch.browserWebSocketUrl,
      })).catch(() => null);
    } catch {
      // The daemon watcher performs the same idempotent registration shortly
      // afterwards, so this earliest-start path remains best-effort.
    }

    const session = services.createSessionRecord(mapLaunchToSessionInput(launch), {
      nonce: pending.nonce,
      createdAtMs: pending.createdAtMs,
      engineRoot: runtime.engineRoot,
      nodePath: runtime.nodePath,
      runtimeSource: runtime.source,
      appStartedAt: launch.owner?.startedAt ?? null,
      codexStarted: Boolean(launch.started),
      activationPid: launch.activationPid ?? null,
      daemonIdentityReady: false
    });
    const spec = services.buildDaemonSpec({
      nodePath: runtime.nodePath,
      engineRoot: runtime.engineRoot,
      sessionPath: paths.session,
      nonce: session.nonce
    });
    await services.writeJsonAtomic(paths.session, session);
    await services.removeStopRequest(paths.stopRequest);

    const spawned = await services.spawnDaemon(spec, {
      foreground: parsed.foreground,
      logsPath: paths.logs,
      env: options.env,
      spawnTimeoutMs: options.spawnTimeoutMs
    });
    const daemonInfo = await services.waitForDaemonInfo(spawned.pid, spec, infoOptions);
    await services.updateSession(paths.session, session.nonce, {
      daemonPid: spawned.pid,
      daemonStdoutLog: spawned.stdoutPath,
      daemonStderrLog: spawned.stderrPath,
      daemonExecutablePath: daemonInfo.executablePath,
      daemonCommandLine: daemonInfo.commandLine,
      daemonStartTime: daemonInfo.startTime,
      daemonIdentityReady: true,
      daemonIdentityTransferredAtMs: services.now()
    });
    ownershipTransferred = true;

    const terminal = await services.waitForSessionTerminal(paths.session, session.nonce, {
      timeoutMs: options.readyTimeoutMs,
      intervalMs: options.readyIntervalMs,
      readJson: services.readJson,
      sleep: services.sleep,
      now: services.now
    });
    const finalValidation = await services.validateRecordedDaemon(terminal, spec, infoOptions);
    if (!finalValidation.valid) {
      throw startError("E_DAEMON_IDENTITY", "Daemon identity changed before readiness", {
        reason: finalValidation.reason
      });
    }
    return {
      ...resultFromSession({ ...terminal, sessionPath: paths.session }, false),
      engineRoot: runtime.engineRoot,
      runtimeSource: runtime.source,
      foreground: parsed.foreground,
      logs: {
        stdout: spawned.stdoutPath,
        stderr: spawned.stderrPath
      }
    };
  } catch (error) {
    if (activeNonce && !ownershipTransferred) await preserveSessionError(paths.session, activeNonce, error, services);
    throw error;
  } finally {
    await release();
  }
}
