import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AppServerQuotaProvider, resolveCodexRuntime } from "../app-server/index.mjs";
import { CdpWatcher, createWindowsOwnerValidator } from "../cdp/index.mjs";
import { toPublicUnavailableReasonCode } from "../contracts.mjs";
import { CodexQuotaError } from "../errors.mjs";
import { acquireFileLock, readJson } from "../fs-utils.mjs";
import { getPaths, PACKAGE_ROOT } from "../paths.mjs";
import { removeSession, updateSession } from "../session-state.mjs";
import { createFileLogger, redactLogText } from "./logger.mjs";
import { QuotaCoordinator } from "./quota-coordinator.mjs";
import {
  readQuotaAccountContext,
  readQuotaCacheEntry,
  removeQuotaCache,
  sameQuotaAccountContext,
  writeQuotaCache
} from "./quota-cache.mjs";
import { RendererBridge } from "./renderer-bridge.mjs";

const HEARTBEAT_MS = 15_000;
const PROVIDER_RETRY_MS = 30_000;
const PARENT_GATE_TIMEOUT_MS = 15_000;

/**
 * Long-lived local host. The parent writes daemon identity once, then this
 * process becomes the sole session writer for the remainder of the lifetime.
 */
export async function daemonCommand(flags = {}, injected = {}) {
  const env = injected.env ?? process.env;
  const paths = injected.paths ?? getPaths(env);
  const sessionPath = resolveRequiredPath(flags.session ?? paths.session, "--session");
  if (!samePath(sessionPath, paths.session)) {
    throw new Error("The daemon session path must be the managed Codex Quota session file");
  }

  const engineRoot = resolveRequiredPath(flags["engine-root"] ?? PACKAGE_ROOT, "--engine-root");
  const nonce = requireText(flags.nonce, "--nonce");
  const processPid = injected.processPid ?? process.pid;
  const processExecPath = resolve(injected.processExecPath ?? process.execPath);
  const read = injected.readJson ?? readJson;
  const initial = await read(sessionPath);
  if (!initial || initial.nonce !== nonce) throw new Error("Session identity changed before daemon startup");
  if (initial.status === "error") throw new Error("Refusing to start an errored session");
  if (!samePath(initial.engineRoot, engineRoot) || !samePath(initial.nodePath, processExecPath)) {
    throw new CodexQuotaError("E_DAEMON_IDENTITY", "Daemon runtime does not match the pending session");
  }

  const now = injected.now ?? Date.now;
  const update = injected.updateSession ?? updateSession;
  const remove = injected.removeSession ?? removeSession;
  const logPath = injected.logPath ?? join(paths.logs, `daemon-${new Date(now()).toISOString().slice(0, 10)}.jsonl`);
  const log = injected.log ?? (injected.createLogger ?? createFileLogger)(logPath);
  const daemonLockPath = paths.daemonLock ?? join(paths.root, "daemon.lock");
  const lock = injected.acquireDaemonLock ?? acquireFileLock;

  let releaseDaemonLock = null;
  let ownsSession = false;
  let watcher = null;
  let bridge = null;
  let coordinator = null;
  let providerRetryTimer = null;
  let providerStartPromise = null;
  let heartbeatTimer = null;
  let sessionHeartbeatTimer = null;
  let stopping = false;
  let stopWaiter = null;
  const stopController = new AbortController();
  if (injected.signal?.aborted) stopController.abort();
  else injected.signal?.addEventListener?.("abort", () => stopController.abort(), { once: true });
  let normalStop = false;
  let quotaStatus = "loading";
  let quotaErrorCode = null;
  let liveSnapshotPublished = false;
  let sessionWriteQueue = Promise.resolve();
  let cacheReplayPromise = Promise.resolve();
  const quotaCachePath = resolve(paths.quotaCache ?? join(paths.root, "quota-cache.json"));
  if (!samePath(quotaCachePath, join(paths.root, "quota-cache.json"))) {
    throw new Error("The quota cache path must be the managed Codex Quota cache file");
  }
  const codexAuthPath = paths.codexAuth;
  const loadQuotaCacheEntry = injected.readQuotaCacheEntry ?? readQuotaCacheEntry;
  const saveQuotaCache = injected.writeQuotaCache ?? writeQuotaCache;
  const deleteQuotaCache = injected.removeQuotaCache ?? removeQuotaCache;
  const getQuotaAccountContext = injected.readQuotaAccountContext ?? readQuotaAccountContext;
  const cacheEnabled = !/^(?:1|true|yes)$/i.test(String(env.CODEX_QUOTA_DISABLE_CACHE ?? ""));
  const captureQuotaAccountContext = () => getQuotaAccountContext({ authPath: codexAuthPath });
  const sameReadContext = (left, right) => (
    (left === null && right === null) || sameQuotaAccountContext(left, right)
  );

  const safeUpdate = (patch) => {
    if (!ownsSession) return Promise.resolve(null);
    const operation = sessionWriteQueue.then(() => update(sessionPath, nonce, patch));
    sessionWriteQueue = operation.catch((error) => {
      log("warn", "session.update.failed", { code: error?.code ?? "E_SESSION_UPDATE" });
      return null;
    });
    return operation.catch(() => null);
  };

  const publishUnavailable = async (value) => {
    await cacheReplayPromise.catch(() => {});
    const code = toPublicUnavailableReasonCode(safeErrorCode(value));
    quotaStatus = "unavailable";
    quotaErrorCode = code;
    await bridge?.unavailable({
      schemaVersion: 1,
      reasonCode: code,
      atMs: now()
    }).catch(() => []);
    await safeUpdate({ quotaStatus: "unavailable", quotaErrorCode: code });
  };

  const scheduleProviderRetry = () => {
    if (stopping || coordinator || providerStartPromise || providerRetryTimer) return;
    providerRetryTimer = setTimeout(() => {
      providerRetryTimer = null;
      void ensureProvider();
    }, injected.providerRetryMs ?? PROVIDER_RETRY_MS);
    providerRetryTimer.unref?.();
  };

  const recoverProvider = async (candidate, error) => {
    if (stopping || coordinator !== candidate) return;
    coordinator = null;
    await candidate.stop().catch(() => {});
    log("warn", "provider.closed", { code: safeErrorCode(error) });
    await publishUnavailable(error ?? { reason: "E_APP_SERVER_CLOSED" });
    scheduleProviderRetry();
  };

  const startProvider = async () => {
    if (stopping || coordinator) return Boolean(coordinator);
    let candidate = null;
    let provider = null;
    try {
      const runtime = await (injected.resolveRuntime ?? resolveCodexRuntime)({ env });
      provider = injected.createProvider
        ? await injected.createProvider({ runtime })
        : new AppServerQuotaProvider({ runtime, env });
      candidate = injected.createCoordinator
        ? await injected.createCoordinator({ provider, bridge, log })
        : new QuotaCoordinator({
            provider,
            publish: async (snapshot, readContext = {}) => {
              await cacheReplayPromise.catch(() => {});
              const contextWasChecked = readContext.accountContextChecked === true;
              const contextIsStable = contextWasChecked && readContext.accountContextStable === true;
              if (contextWasChecked && !contextIsStable) {
                if (cacheEnabled) await deleteQuotaCache(quotaCachePath).catch(() => false);
                log("warn", "quota.snapshot.context.changed");
                return;
              }
              liveSnapshotPublished = true;
              quotaStatus = "available";
              quotaErrorCode = null;
              await bridge.publish(snapshot);
              if (cacheEnabled) {
                if (contextIsStable && readContext.accountContextAfter) {
                  // writeQuotaCache re-stats auth.json and refuses the write if
                  // it changed since the post-snapshot capture.
                  await saveQuotaCache(quotaCachePath, snapshot, {
                    now,
                    authPath: codexAuthPath,
                    expectedAccountContext: readContext.accountContextAfter
                  }).catch((error) => {
                    log("warn", "quota.cache.write.failed", { code: safeErrorCode(error) });
                  });
                } else {
                  await deleteQuotaCache(quotaCachePath).catch(() => false);
                }
              }
              await safeUpdate({ quotaStatus: "available", quotaErrorCode: null, quotaUpdatedAtMs: now() });
            },
            publishUnavailable,
            log,
            captureReadContext: captureQuotaAccountContext,
            sameReadContext
          });
      coordinator = candidate;
      provider.once?.("closed", (error) => { void recoverProvider(candidate, error); });
      await candidate.start();
      if (stopping) {
        if (coordinator === candidate) coordinator = null;
        await candidate.stop().catch(() => {});
        return false;
      }
      log("info", "provider.started", { source: runtime.source ?? "resolved" });
      return true;
    } catch (error) {
      if (coordinator === candidate) coordinator = null;
      await candidate?.stop?.().catch(() => {});
      log("warn", "provider.start.failed", {
        code: safeErrorCode(error),
        message: safeErrorMessage(error)
      });
      await publishUnavailable(error);
      scheduleProviderRetry();
      return false;
    }
  };

  const ensureProvider = () => {
    if (providerStartPromise) return providerStartPromise;
    providerStartPromise = startProvider().finally(() => {
      providerStartPromise = null;
      if (!coordinator) scheduleProviderRetry();
    });
    return providerStartPromise;
  };

  try {
    releaseDaemonLock = await lock(daemonLockPath, {
      operation: "daemon",
      nonce,
      engineRoot,
      nodePath: processExecPath
    });
    const gated = await (injected.waitForParentIdentity ?? waitForParentIdentity)({
      sessionPath,
      nonce,
      pid: processPid,
      engineRoot,
      nodePath: processExecPath,
      readJson: read,
      sleep: injected.sleep,
      now,
      timeoutMs: injected.parentGateTimeoutMs
    });
    ownsSession = true;

    const ownerValidator = injected.ownerValidator ?? createWindowsOwnerValidator();
    watcher = injected.watcher ?? (injected.createWatcher ?? ((options) => new CdpWatcher(options)))({
      port: gated.port,
      browserId: gated.browserId,
      browserWebSocketUrl: gated.browserWebSocketUrl,
      ownerValidator
    });
    watcher.on?.("watcherTransientError", ({ error, failureCount } = {}) => {
      log("warn", "watcher.poll.transient", {
        code: safeErrorCode(error),
        failureCount: Number(failureCount) || 1
      });
    });
    watcher.on?.("watcherRecovered", ({ failureCount } = {}) => {
      log("info", "watcher.poll.recovered", { failureCount: Number(failureCount) || 1 });
    });
    let firstRendererReady = false;
    watcher.on?.("pageReady", () => {
      if (firstRendererReady) return;
      firstRendererReady = true;
      log("info", "renderer.ready");
      void safeUpdate({ rendererReadyAtMs: now() });
    });
    bridge = injected.bridge ?? (injected.createBridge ?? ((options) => new RendererBridge(options)))({ watcher, engineRoot });
    stopWaiter = injected.waitForStop
      ? Promise.resolve(injected.waitForStop({ watcher, paths, nonce, signal: stopController.signal }))
      : waitForDaemonStop({ watcher, paths, nonce, signal: stopController.signal });
    const startupStopped = stopWaiter.then((stop) => {
      const error = stop?.error instanceof Error
        ? stop.error
        : new CodexQuotaError("E_DAEMON_STOPPED_BEFORE_READY", "Daemon received a stop signal before it became ready", stop);
      error.stop = stop;
      throw error;
    });

    const cachedEntryPromise = cacheEnabled
      ? loadQuotaCacheEntry(quotaCachePath, { now, authPath: codexAuthPath }).catch(() => null)
      : deleteQuotaCache(quotaCachePath).then(() => null).catch(() => null);
    await Promise.race([bridge.start(), startupStopped]);
    log("info", "renderer.bridge.started");
    cacheReplayPromise = cachedEntryPromise.then(async (cachedEntry) => {
      if (!cachedEntry || liveSnapshotPublished || stopping) return false;
      const currentAccountContext = await captureQuotaAccountContext();
      if (!sameQuotaAccountContext(cachedEntry.accountContext, currentAccountContext)) {
        await deleteQuotaCache(quotaCachePath).catch(() => false);
        log("info", "quota.cache.context.changed");
        return false;
      }
      if (liveSnapshotPublished || stopping) return false;
      quotaStatus = "cached";
      await bridge.publishCached(cachedEntry.snapshot);
      log("info", "quota.cache.replayed");
      await safeUpdate({ quotaStatus: "cached", quotaErrorCode: null });
      return true;
    }).catch((error) => {
      log("warn", "quota.cache.replay.failed", { code: safeErrorCode(error) });
      return false;
    });
    const initialProviderStart = ensureProvider();
    if (watcher.terminalError) throw watcher.terminalError;

    await safeUpdate({
      status: "ready",
      daemonPid: processPid,
      quotaStatus,
      quotaErrorCode,
      daemonStartedAtMs: now(),
      readyAtMs: now()
    });
    log("info", "daemon.ready", { pid: processPid, port: gated.port });

    heartbeatTimer = setInterval(() => {
      void bridge.heartbeat().catch(() => []);
    }, injected.heartbeatMs ?? HEARTBEAT_MS);

    sessionHeartbeatTimer = setInterval(() => {
      void safeUpdate({ daemonHeartbeatAtMs: now() });
    }, injected.sessionHeartbeatMs ?? HEARTBEAT_MS);

    void initialProviderStart;

    const stop = await stopWaiter;
    if (stop?.reason === "cdp-closed") {
      throw stop.error instanceof Error
        ? stop.error
        : new CodexQuotaError("E_CDP_CLOSED", "The verified CDP watcher stopped unexpectedly");
    }
    normalStop = true;
    log("info", "daemon.stopping", { reason: stop?.reason ?? "requested" });
    await safeUpdate({ status: "stopping", stopReason: stop?.reason ?? "requested" });
    return { ok: true, reason: stop?.reason ?? "requested" };
  } catch (error) {
    if (error?.stop?.reason === "uninstall-request" || error?.stop?.reason === "session-replaced") {
      normalStop = true;
    }
    log("error", "daemon.failed", {
      code: safeErrorCode(error),
      message: safeErrorMessage(error)
    });
    if (ownsSession && !normalStop) {
      await safeUpdate({
        status: "error",
        errorCode: safeErrorCode(error),
        errorMessage: safeErrorMessage(error),
        failedAtMs: now()
      });
    }
    throw error;
  } finally {
    stopping = true;
    stopController.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sessionHeartbeatTimer) clearInterval(sessionHeartbeatTimer);
    if (providerRetryTimer) clearTimeout(providerRetryTimer);
    await cacheReplayPromise.catch(() => {});
    await providerStartPromise?.catch(() => {});
    await coordinator?.stop?.().catch(() => {});
    coordinator = null;
    await bridge?.cleanup("daemon-stop").catch(() => {});
    await sessionWriteQueue.catch(() => {});
    if (normalStop) {
      await remove(sessionPath, nonce).catch(() => false);
      await rm(paths.stopRequest, { force: true }).catch(() => {});
    }
    await releaseDaemonLock?.().catch(() => {});
  }
}

export async function waitForParentIdentity({
  sessionPath,
  nonce,
  pid,
  engineRoot,
  nodePath,
  readJson: read = readJson,
  sleep = delay,
  now = Date.now,
  timeoutMs = PARENT_GATE_TIMEOUT_MS,
  intervalMs = 50
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const state = await read(sessionPath, null).catch(() => null);
    if (!state) throw new CodexQuotaError("E_SESSION_IDENTITY", "Pending daemon session disappeared");
    if (state.nonce !== nonce) throw new CodexQuotaError("E_SESSION_IDENTITY", "Pending daemon session was replaced");
    if (state.status === "error") {
      throw new CodexQuotaError(state.errorCode ?? state.error?.code ?? "E_DAEMON_START", state.errorMessage ?? state.error?.message ?? "Parent rejected daemon startup");
    }
    if (state.daemonIdentityReady === true) {
      if (Number(state.daemonPid) !== Number(pid) ||
          !samePath(state.engineRoot, engineRoot) ||
          !samePath(state.nodePath, nodePath) ||
          !samePath(state.daemonExecutablePath, nodePath) ||
          typeof state.daemonCommandLine !== "string" || !state.daemonCommandLine ||
          typeof state.daemonStartTime !== "string" || !Number.isFinite(Date.parse(state.daemonStartTime))) {
        throw new CodexQuotaError("E_DAEMON_IDENTITY", "Parent supplied an invalid daemon identity gate");
      }
      return state;
    }
    await sleep(intervalMs);
  }
  throw new CodexQuotaError("E_DAEMON_PARENT_TIMEOUT", "Timed out waiting for the parent to verify daemon identity");
}

export function waitForDaemonStop({ watcher, paths, nonce, signal, pollMs = 500 }) {
  return new Promise((resolveStop) => {
    let settled = false;
    let polling = false;
    let poller = null;
    const settle = (reason, error) => {
      if (settled) return;
      settled = true;
      if (poller) clearInterval(poller);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      watcher.off?.("watcherError", onWatcherError);
      signal?.removeEventListener?.("abort", onAbort);
      resolveStop({ reason, ...(error ? { error } : {}) });
    };
    const onSigint = () => settle("SIGINT");
    const onSigterm = () => settle("SIGTERM");
    const onWatcherError = (error) => settle("cdp-closed", error);
    const onAbort = () => settle("aborted");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    watcher.once?.("watcherError", onWatcherError);
    signal?.addEventListener?.("abort", onAbort, { once: true });

    poller = setInterval(async () => {
      if (polling || settled) return;
      polling = true;
      try {
        const [request, session] = await Promise.all([
          readJson(paths.stopRequest, null).catch(() => null),
          readJson(paths.session, null).catch(() => null)
        ]);
        if (request?.nonce === nonce) settle("uninstall-request");
        else if (session && session.nonce !== nonce) settle("session-replaced");
      } finally {
        polling = false;
      }
    }, pollMs);

    if (watcher.terminalError) queueMicrotask(() => settle("cdp-closed", watcher.terminalError));
    else if (signal?.aborted) queueMicrotask(() => settle("aborted"));
  });
}

function resolveRequiredPath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return resolve(value);
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function safeErrorCode(value) {
  const candidate = typeof value?.code === "string"
    ? value.code
    : typeof value?.reasonCode === "string"
      ? value.reasonCode
      : typeof value?.reason === "string" ? value.reason : "E_DAEMON";
  return SAFE_DIAGNOSTIC_ERROR_CODES.has(candidate) ? candidate : "E_DAEMON";
}

const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
  "E_ANCHOR_AMBIGUOUS",
  "E_APP_SERVER_CLOSED",
  "E_APP_SERVER_UNSUPPORTED",
  "E_AUTH_UNSUPPORTED",
  "E_BROWSER_ID_CHANGED",
  "E_CACHE",
  "E_CDP_CLOSED",
  "E_CDP_OWNER_MISMATCH",
  "E_CODEX_RUNTIME_UNAVAILABLE",
  "E_DAEMON",
  "E_DAEMON_IDENTITY",
  "E_DAEMON_PARENT_TIMEOUT",
  "E_DAEMON_START",
  "E_DAEMON_STOPPED_BEFORE_READY",
  "E_LAYOUT_OVERLAP",
  "E_LIMIT_SCHEMA",
  "E_RATE_LIMIT_READ",
  "E_RATE_LIMIT_SCHEMA",
  "E_RATE_LIMIT_STALE",
  "E_RENDERER",
  "E_RENDERER_SIGNATURE",
  "E_RUNNING_WITHOUT_CDP",
  "E_RUNTIME_INTEGRITY",
  "E_SESSION_IDENTITY",
  "E_SESSION_UPDATE",
  "EACCES",
  "ENOENT",
  "EPERM",
]);

function safeErrorMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return redactLogText(value).slice(0, 500);
}
