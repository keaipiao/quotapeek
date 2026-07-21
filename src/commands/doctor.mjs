import { join } from "node:path";

import { AppServerClient, resolveCodexRuntime } from "../app-server/index.mjs";
import { inspectCdpEndpoint, inspectStorePackage } from "../cdp/index.mjs";
import { buildDaemonSpec, validateRecordedDaemon } from "../daemon-process.mjs";
import { pathExists, readJson } from "../fs-utils.mjs";
import { PACKAGE_ROOT, getPaths } from "../paths.mjs";
import { assertSameManifest, createRuntimeManifest, manifestDigest } from "../runtime-manifest.mjs";
import { RUNTIME_ENTRIES, getInstalledRuntime } from "./install.mjs";

export async function doctorCommand(options = {}, injected = {}) {
  const checks = [];
  const add = (id, status, message, details = undefined) => {
    checks.push({ id, status, message, ...(details ? { details } : {}) });
  };
  const services = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    nodePath: process.execPath,
    getPaths,
    getInstalledRuntime,
    readJson,
    pathExists,
    createRuntimeManifest,
    inspectStorePackage,
    inspectCdpEndpoint,
    validateRecordedDaemon,
    resolveCodexRuntime,
    createAppServerClient: (clientOptions) => new AppServerClient(clientOptions),
    ...injected
  };

  if (services.platform === "win32") add("platform", "pass", `Windows ${services.arch}`);
  else add("platform", "fail", `Unsupported platform: ${services.platform}`);

  const nodeMajor = Number(String(services.nodeVersion).replace(/^v/, "").split(".")[0]);
  add(
    "node",
    nodeMajor >= 22 ? "pass" : "fail",
    `${services.nodeVersion} at ${redactLocalPath(services.nodePath, options.env ?? process.env)}`
  );

  const paths = services.getPaths(options.env);
  let install = null;
  try {
    install = await services.getInstalledRuntime({ env: options.env, verify: false });
  } catch (error) {
    add("install", "fail", sanitizeMessage(error));
  }
  if (install) {
    add("install", "pass", `Runtime ${install.version} is installed`, { engineName: install.engineName });
    try {
      const expected = await services.readJson(join(install.engineRoot, "runtime-manifest.json"));
      if (!Array.isArray(expected)) throw new Error("Runtime manifest is malformed");
      if (manifestDigest(expected) !== install.manifestSha256) throw new Error("Runtime manifest digest changed");
      if (!await services.pathExists(install.nodePath)) throw new Error("Configured Node.js runtime is missing");
      const actual = await services.createRuntimeManifest(install.engineRoot, RUNTIME_ENTRIES);
      assertSameManifest(expected, actual);
      add("runtime-integrity", "pass", `Verified ${actual.length} installed runtime file(s)`);
    } catch (error) {
      add("runtime-integrity", "fail", sanitizeMessage(error));
    }
  } else if (!checks.some((check) => check.id === "install")) {
    add("install", "warn", "No valid installed runtime; source commands can still be used");
  }

  const session = await services.readJson(paths.session, null).catch(() => null);
  let daemonValid = false;
  if (!session) {
    add("daemon", "warn", "No active Codex Quota session is recorded");
  } else if (!session.engineRoot || !session.nodePath || !session.nonce) {
    add("daemon", "warn", "Recorded daemon identity is incomplete");
  } else {
    try {
      const spec = buildDaemonSpec({
        nodePath: session.nodePath,
        engineRoot: session.engineRoot,
        sessionPath: paths.session,
        nonce: session.nonce
      });
      const validation = await services.validateRecordedDaemon(session, spec, {
        helperPath: join(PACKAGE_ROOT, "windows", "daemon-info.ps1"),
        env: options.env,
        platform: services.platform
      });
      daemonValid = validation.valid;
      add("daemon", daemonValid ? "pass" : "warn", daemonValid
        ? `Verified daemon PID ${session.daemonPid}`
        : `Recorded daemon is not active (${validation.reason})`);
    } catch (error) {
      add("daemon", "warn", sanitizeMessage(error));
    }
  }

  try {
    const store = await services.inspectStorePackage();
    add("store-package", "pass", `Found ${store.packageName ?? "OpenAI.Codex"} ${store.version ?? ""}`.trim());
  } catch (error) {
    add("store-package", "fail", sanitizeMessage(error));
  }

  if (session?.port && daemonValid) {
    try {
      const endpoint = await services.inspectCdpEndpoint({ port: session.port });
      if (endpoint.browserId !== session.browserId) throw new Error("CDP Browser identity does not match the session");
      add("cdp", "pass", `Verified loopback CDP endpoint with ${endpoint.appPageTargets.length} app renderer(s)`);
    } catch (error) {
      add("cdp", "fail", sanitizeMessage(error));
    }
  } else {
    add("cdp", "warn", "No verified active quota session to inspect");
  }

  let runtime = null;
  try {
    runtime = await services.resolveCodexRuntime({ env: options.env });
    add("app-server-runtime", "pass", "Official Codex app-server runtime is available", {
      source: runtime.source ?? "resolved"
    });
  } catch (error) {
    add("app-server-runtime", options.live ? "fail" : "warn", sanitizeMessage(error));
  }

  if (options.live && runtime) {
    try {
      const client = services.createAppServerClient({ runtime, env: options.env });
      try {
        await client.start();
        const account = await client.readAccount();
        if (account?.accountType !== "chatgpt") {
          add("account", "warn", `Account type does not expose ChatGPT quotas: ${account?.accountType ?? "signed-out"}`);
        } else {
          add("account", "pass", "ChatGPT-backed account is available");
          const snapshot = await client.readNormalizedRateLimits();
          add("rate-limits", "pass", `Received ${snapshot.buckets.length} quota bucket(s)`);
        }
      } finally {
        await client.close();
      }
    } catch (error) {
      add("live-rate-limits", "fail", sanitizeMessage(error));
    }
  }

  const ok = !checks.some((check) => check.status === "fail");
  return { ok, generatedAtMs: Date.now(), checks };
}

export function formatDoctor(result) {
  const icon = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = result.checks.map((check) => `${icon[check.status]}  ${check.id}: ${check.message}`);
  lines.push(result.ok ? "Doctor completed without blocking failures." : "Doctor found blocking failures.");
  return `${lines.join("\n")}\n`;
}

function sanitizeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

export function redactLocalPath(value, env = process.env) {
  let output = String(value ?? "");
  const replacements = [
    [env.LOCALAPPDATA, "%LOCALAPPDATA%"],
    [env.USERPROFILE, "%USERPROFILE%"],
  ].filter(([path]) => typeof path === "string" && path);
  replacements.sort((left, right) => right[0].length - left[0].length);
  for (const [path, marker] of replacements) {
    if (output.toLowerCase().startsWith(path.toLowerCase())) {
      output = `${marker}${output.slice(path.length)}`;
      break;
    }
  }
  return output;
}
