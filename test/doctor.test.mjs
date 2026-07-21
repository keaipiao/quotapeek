import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { doctorCommand, redactLocalPath } from "../src/commands/doctor.mjs";
import { manifestDigest } from "../src/runtime-manifest.mjs";

const TEST_PATHS = {
  root: "C:\\Users\\test\\AppData\\Local\\CodexQuota",
  session: "C:\\Users\\test\\AppData\\Local\\CodexQuota\\session.json"
};

test("doctor path redaction replaces user-local prefixes before reports are shared", () => {
  const env = {
    USERPROFILE: "C:\\Users\\alice",
    LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
  };
  assert.equal(
    redactLocalPath("C:\\Users\\alice\\AppData\\Local\\Programs\\node.exe", env),
    "%LOCALAPPDATA%\\Programs\\node.exe"
  );
  assert.equal(
    redactLocalPath("C:\\Users\\alice\\tools\\node.exe", env),
    "%USERPROFILE%\\tools\\node.exe"
  );
});

function baseServices(overrides = {}) {
  return {
    platform: "win32",
    arch: "x64",
    nodeVersion: "v24.0.0",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    getPaths: () => TEST_PATHS,
    getInstalledRuntime: async () => null,
    readJson: async (_path, fallback) => fallback,
    inspectStorePackage: async () => ({ packageName: "OpenAI.Codex", version: "1.2.3" }),
    resolveCodexRuntime: async () => ({ source: "app-managed" }),
    ...overrides
  };
}

test("doctor reports a healthy base environment without requiring a live account read", async () => {
  let clientCreated = false;
  const result = await doctorCommand({}, baseServices({
    createAppServerClient() {
      clientCreated = true;
      throw new Error("must not be called");
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(clientCreated, false);
  assert.equal(result.checks.find((check) => check.id === "store-package").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "daemon").status, "warn");
});

test("live doctor reveals capability counts but no quota values or account identifiers", async () => {
  const result = await doctorCommand({ live: true }, baseServices({
    createAppServerClient: () => ({
      async start() {},
      async readAccount() { return { accountType: "chatgpt" }; },
      async readNormalizedRateLimits() {
        return {
          schemaVersion: 1,
          fetchedAtMs: 1,
          buckets: [{ id: "first" }, { id: "second" }],
          resetCreditsAvailable: null
        };
      },
      async close() {}
    })
  }));

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result), /Received 2 quota bucket/);
  assert.doesNotMatch(JSON.stringify(result), /remainingPercent|usedPercent|email|token/i);
});

test("doctor validates the recorded daemon before probing its CDP endpoint", async () => {
  const session = {
    nonce: "nonce",
    daemonPid: 123,
    daemonExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    daemonCommandLine: "command",
    daemonStartTime: "2026-01-01T00:00:00.000Z",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    engineRoot: "C:\\Users\\test\\AppData\\Local\\CodexQuota\\engines\\1",
    port: 32123,
    browserId: "browser-id"
  };
  let probed = false;
  const result = await doctorCommand({}, baseServices({
    readJson: async (path, fallback) => path === TEST_PATHS.session ? session : fallback,
    validateRecordedDaemon: async () => ({ valid: true }),
    inspectCdpEndpoint: async () => {
      probed = true;
      return { browserId: "browser-id", appPageTargets: [{ id: "page" }] };
    }
  }));

  assert.equal(probed, true);
  assert.equal(result.checks.find((check) => check.id === "daemon").status, "pass");
  assert.equal(result.checks.find((check) => check.id === "cdp").status, "pass");
});

test("doctor fails a changed installed runtime", async () => {
  const expected = [{ path: "package.json", size: 2, sha256: "a".repeat(64) }];
  const install = {
    version: "0.1.0",
    engineName: "engine",
    engineRoot: "C:\\Users\\test\\AppData\\Local\\CodexQuota\\engines\\engine",
    manifestSha256: manifestDigest(expected)
  };
  const result = await doctorCommand({}, baseServices({
    getInstalledRuntime: async () => install,
    readJson: async (path, fallback) => path === join(install.engineRoot, "runtime-manifest.json") ? expected : fallback,
    createRuntimeManifest: async () => [{ ...expected[0], size: 3 }]
  }));

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === "runtime-integrity").status, "fail");
});

test("a live read failure does not contradict a verified app-server runtime check", async () => {
  const result = await doctorCommand({ live: true }, baseServices({
    createAppServerClient: () => ({
      async start() { throw new Error("stdio unavailable"); },
      async close() {}
    })
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.checks.filter((check) => check.id === "app-server-runtime").map((check) => check.status),
    ["pass"]
  );
  assert.equal(result.checks.find((check) => check.id === "live-rate-limits").status, "fail");
});
