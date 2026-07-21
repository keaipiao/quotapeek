import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexQuotaError } from "../errors.mjs";
import { systemWindowsPowerShellPath } from "../windows-trust.mjs";
import { readAppPageTargets, readBrowserIdentity, waitForBrowserIdentity } from "./endpoint.mjs";
import { chooseLoopbackPort } from "./loopback.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_HELPER_PATH = fileURLToPath(new URL("../../windows/codex-cdp.ps1", import.meta.url));

export function parsePowerShellJson(stdout) {
  const text = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("Windows helper returned no JSON");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("Windows helper returned unexpected stdout");
  let result;
  try {
    result = JSON.parse(lines[0]);
  } catch {
    throw new Error("Windows helper returned invalid JSON");
  }
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new Error("Windows helper returned an invalid result envelope");
  }
  return result;
}

async function defaultRunner({ powershellPath, helperPath, action, port, timeoutMs, env }) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "RemoteSigned",
    "-File", helperPath,
    "-Action", action,
  ];
  if (port !== undefined) args.push("-Port", String(port));
  try {
    const result = await execFileAsync(powershellPath, args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    // PowerShell uses a non-zero exit code for structured errors. Preserve its
    // stdout so the caller can recover the typed error envelope.
    if (typeof error?.stdout === "string" && error.stdout.trim()) {
      return { stdout: error.stdout, stderr: error.stderr ?? "", exitCode: error.code };
    }
    throw error;
  }
}

export async function invokeWindowsCdpHelper(action, {
  port,
  helperPath = DEFAULT_HELPER_PATH,
  env = process.env,
  powershellPath = systemWindowsPowerShellPath(env),
  timeoutMs = 20_000,
  runner = defaultRunner,
  onLog,
} = {}) {
  if (!new Set(["inspect", "launch", "verify-owner"]).has(action)) throw new TypeError("Invalid helper action");
  const execution = await runner({ powershellPath, helperPath, action, port, timeoutMs, env });
  const { stdout, stderr } = execution;
  if (stderr && onLog) onLog(String(stderr));
  const result = parsePowerShellJson(stdout);
  const rawExitCode = execution.exitCode ?? execution.code;
  if (rawExitCode !== undefined && (Number(rawExitCode) === 0) !== result.ok) {
    throw new CodexQuotaError(
      "E_WINDOWS_HELPER_STATUS",
      "Windows helper exit status disagrees with its JSON result"
    );
  }
  if (!result.ok) {
    throw new CodexQuotaError(
      result.error?.code || "E_WINDOWS_HELPER",
      result.error?.message || "Windows CDP helper failed",
      result.error?.details,
    );
  }
  return result;
}

export async function inspectStorePackage(options = {}) {
  const result = await invokeWindowsCdpHelper("inspect", options);
  return {
    package: result.package,
    packageName: result.package?.name ?? null,
    version: result.package?.version ?? null,
    running: Boolean(result.running),
    processes: Array.isArray(result.processes) ? result.processes : result.processes ? [result.processes] : [],
  };
}

export async function verifyCdpListenerOwner(port, options = {}) {
  const result = await invokeWindowsCdpHelper("verify-owner", { ...options, port });
  return { package: result.package, owner: result.owner, ok: true };
}

async function waitForVerifiedOwner(port, {
  timeoutMs = 30_000,
  intervalMs = 150,
  ...helperOptions
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await verifyCdpListenerOwner(port, helperOptions);
    } catch (error) {
      if (error?.code === "E_CDP_OWNER_MISMATCH") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new CodexQuotaError("E_CDP_NOT_READY", "Timed out waiting for a verified Codex CDP listener", {
    port,
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

function ownerFingerprint(value) {
  const owner = value?.owner;
  if (!owner) return null;
  return JSON.stringify([owner.pid, owner.startedAt, owner.executablePath, owner.packageFullName]);
}

function assertSameOwner(before, after) {
  const expected = ownerFingerprint(before);
  const actual = ownerFingerprint(after);
  if (!expected || !actual || expected !== actual) {
    throw new CodexQuotaError("E_CDP_OWNER_MISMATCH", "The CDP listener owner changed during endpoint discovery", {
      before: before?.owner,
      after: after?.owner,
    });
  }
}

/**
 * Cold-starts the verified Store client with loopback CDP. If the client is
 * already running without the requested endpoint, this returns the helper's
 * E_RUNNING_WITHOUT_CDP error and never terminates the existing process.
 */
export async function launchCodexWithCdp({
  port,
  fetchImpl = globalThis.fetch,
  launchTimeoutMs = 30_000,
  portOptions,
  ...helperOptions
} = {}) {
  const selectedPort = port ?? await chooseLoopbackPort(portOptions);
  const launch = await invokeWindowsCdpHelper("launch", {
    ...helperOptions,
    port: selectedPort,
    timeoutMs: Math.min(helperOptions.timeoutMs ?? 20_000, launchTimeoutMs),
  });
  const initialOwner = launch.owner
    ? Promise.resolve({ package: launch.package, owner: launch.owner, ok: true })
    : waitForVerifiedOwner(selectedPort, {
        ...helperOptions,
        timeoutMs: launchTimeoutMs,
      });
  const [owner, identity] = await Promise.all([
    initialOwner,
    waitForBrowserIdentity({
      port: selectedPort,
      fetchImpl,
      timeoutMs: launchTimeoutMs,
    }),
  ]);
  const ownerAfterDiscovery = await verifyCdpListenerOwner(selectedPort, helperOptions);
  assertSameOwner(owner, ownerAfterDiscovery);
  return Object.freeze({
    port: selectedPort,
    browserId: identity.browserId,
    browserWebSocketUrl: identity.webSocketDebuggerUrl,
    browser: identity.browser,
    protocolVersion: identity.protocolVersion,
    package: ownerAfterDiscovery.package ?? launch.package,
    owner: ownerAfterDiscovery.owner,
    started: Boolean(launch.started),
    activationPid: launch.activationPid ?? null,
  });
}

export async function inspectCdpEndpoint({
  port,
  fetchImpl = globalThis.fetch,
  ...helperOptions
} = {}) {
  const verified = await verifyCdpListenerOwner(port, helperOptions);
  const identity = await readBrowserIdentity({ port, fetchImpl });
  const targets = await readAppPageTargets({ port, fetchImpl });
  const verifiedAfterDiscovery = await verifyCdpListenerOwner(port, helperOptions);
  assertSameOwner(verified, verifiedAfterDiscovery);
  return Object.freeze({
    port,
    package: verifiedAfterDiscovery.package,
    owner: verifiedAfterDiscovery.owner,
    browserId: identity.browserId,
    browserWebSocketUrl: identity.webSocketDebuggerUrl,
    browser: identity.browser,
    protocolVersion: identity.protocolVersion,
    appPageTargets: targets,
  });
}

export function createWindowsOwnerValidator(options = {}) {
  return ({ port }) => verifyCdpListenerOwner(port, options);
}
