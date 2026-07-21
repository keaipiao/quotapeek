import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { buildDaemonSpec, validateRecordedDaemon } from "../daemon-process.mjs";
import { acquireFileLock, isProcessRunning, pathExists, readJson } from "../fs-utils.mjs";
import { PACKAGE_ROOT, assertManagedPath, getPaths } from "../paths.mjs";
import { runProcess } from "../process-utils.mjs";
import { systemWindowsPowerShellPath } from "../windows-trust.mjs";

export async function uninstallCommand(options = {}, injected = {}) {
  const services = {
    acquireFileLock,
    isProcessRunning,
    pathExists,
    readJson,
    validateRecordedDaemon,
    runProcess,
    sleep: delay,
    ...injected
  };
  const paths = getPaths(options.env);
  await mkdir(paths.root, { recursive: true });
  const release = await services.acquireFileLock(paths.lock, { operation: "uninstall" });
  let rootRemoved = false;
  try {
    const install = await services.readJson(paths.config, null).catch(() => null);
    const session = await services.readJson(paths.session, null).catch(() => null);
    const daemonLockPath = paths.daemonLock ?? join(paths.root, "daemon.lock");
    const daemonLock = await services.readJson(daemonLockPath, null).catch(() => null);
    const lifecyclePid = positivePid(daemonLock?.pid ?? daemonLock?.daemonPid);
    const recordedPid = positivePid(session?.daemonPid);
    let daemonStopped = true;

    if (lifecyclePid && services.isProcessRunning(lifecyclePid) && lifecyclePid !== recordedPid) {
      return failure(
        "E_DAEMON_LIFECYCLE_ACTIVE",
        `Daemon lifecycle PID ${lifecyclePid} is still running, but no matching complete session can be verified; runtime and shortcuts were preserved`,
        session
      );
    }

    if (recordedPid && services.isProcessRunning(recordedPid)) {
      const identity = await validateSessionDaemon(session, paths, options, services);
      if (!identity.valid) {
        return failure(
          "E_DAEMON_IDENTITY",
          `A process is using the recorded PID, but daemon identity could not be verified (${identity.reason}); runtime and shortcuts were preserved`,
          session
        );
      }
      await writeFile(paths.stopRequest, `${JSON.stringify({ requestedAtMs: Date.now(), nonce: session.nonce })}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      daemonStopped = await waitForProcessExit(recordedPid, options.stopTimeoutMs ?? 8_000, services);
    }

    if (!daemonStopped) {
      return failure(
        "E_DAEMON_STOP_TIMEOUT",
        "Daemon did not stop before the timeout; runtime and shortcuts were preserved",
        session
      );
    }

    const lockAfterStop = await services.readJson(daemonLockPath, null).catch(() => null);
    const lockAfterPid = positivePid(lockAfterStop?.pid ?? lockAfterStop?.daemonPid);
    if (lockAfterPid && services.isProcessRunning(lockAfterPid)) {
      return failure(
        "E_DAEMON_LIFECYCLE_ACTIVE",
        `Daemon lifecycle PID ${lockAfterPid} is still running after the stop request; runtime and shortcuts were preserved`,
        session
      );
    }

    let installedEngineRoot = PACKAGE_ROOT;
    if (install?.engineRoot) {
      try {
        installedEngineRoot = assertManagedPath(install.engineRoot, paths.root);
        if (resolve(dirname(installedEngineRoot)).toLowerCase() !== resolve(paths.engines).toLowerCase()) {
          throw new Error("Installed runtime is not a direct child of the managed engines directory");
        }
      } catch (error) {
        return failure(
          "E_INSTALL_IDENTITY",
          `Installed runtime path is not managed (${safeMessage(error)}); runtime and shortcuts were preserved`,
          session,
          true
        );
      }
    }
    const helper = join(PACKAGE_ROOT, "windows", "remove-shortcuts.ps1");
    if (!await services.pathExists(helper)) {
      return failure(
        "E_SHORTCUT_HELPER_MISSING",
        `Shortcut removal helper is missing: ${helper}; runtime and shortcuts were preserved`,
        session,
        true
      );
    }

    let helperProcess;
    try {
      helperProcess = await services.runProcess(options.powershell ?? systemWindowsPowerShellPath(options.env), [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", helper,
        "-EngineRoot", installedEngineRoot,
        "-NodePath", install?.nodePath ?? process.execPath
      ], { shell: false });
    } catch (error) {
      return failure(
        "E_SHORTCUT_REMOVE",
        `Shortcut helper could not run (${safeMessage(error)}); runtime and shortcuts were preserved`,
        session,
        true
      );
    }
    let helperEnvelope;
    try {
      helperEnvelope = parseHelperEnvelope(helperProcess.stdout);
    } catch (error) {
      return failure("E_SHORTCUT_REMOVE", `${safeMessage(error)}; runtime and shortcuts were preserved`, session, true);
    }
    if (helperProcess.code !== 0 || !helperEnvelope.ok) {
      const rawHelperCode = helperEnvelope.error?.code;
      const helperCode = typeof rawHelperCode === "string" && /^[A-Z0-9_.-]{1,80}$/.test(rawHelperCode)
        ? rawHelperCode
        : "E_SHORTCUT_REMOVE";
      const helperMessage = safeMessage(helperEnvelope.error?.message || helperProcess.stderr?.trim() || "Shortcut removal failed");
      return failure(helperCode, `${helperMessage}; runtime and shortcuts were preserved`, session, true);
    }

    assertManagedPath(paths.root, join(paths.root, ".."));
    await rm(paths.root, { recursive: true, force: true });
    rootRemoved = true;
    return {
      ok: true,
      daemonStopped: true,
      cdpMayStillBeOpen: Boolean(session?.port),
      removedRoot: paths.root,
      shortcuts: helperEnvelope
    };
  } finally {
    if (!rootRemoved) await release();
  }
}

function positivePid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function failure(code, message, session, daemonStopped = false) {
  return {
    ok: false,
    daemonStopped,
    cdpMayStillBeOpen: Boolean(session?.port),
    message,
    error: { code, message }
  };
}

function parseHelperEnvelope(stdout) {
  const lines = String(stdout ?? "").replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("Shortcut helper returned unexpected stdout");
  let envelope;
  try {
    envelope = JSON.parse(lines[0]);
  } catch {
    throw new Error("Shortcut helper returned invalid JSON");
  }
  if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
    throw new Error("Shortcut helper returned an invalid result envelope");
  }
  return envelope;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 300);
}

async function validateSessionDaemon(session, paths, options, services) {
  if (!session.nonce || !session.nodePath || !session.engineRoot) {
    return { valid: false, reason: "missing-recorded-identity" };
  }
  try {
    const spec = buildDaemonSpec({
      nodePath: session.nodePath,
      engineRoot: session.engineRoot,
      sessionPath: paths.session,
      nonce: session.nonce
    });
    return services.validateRecordedDaemon(session, spec, {
      helperPath: join(PACKAGE_ROOT, "windows", "daemon-info.ps1"),
      powershellPath: options.powershell,
      env: options.env,
      platform: process.platform
    });
  } catch (error) {
    return { valid: false, reason: error?.code ?? "inspection" };
  }
}

async function waitForProcessExit(pid, timeoutMs, services) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!services.isProcessRunning(pid)) return true;
    await services.sleep(100);
  }
  return !services.isProcessRunning(pid);
}
