import assert from "node:assert/strict";
import test from "node:test";

import {
  mapLaunchToSessionInput,
  createPendingLaunchRecord,
  parseStartOptions,
  startCommand,
  waitForSessionTerminal
} from "../src/commands/start.mjs";
import { createSessionRecord } from "../src/session-state.mjs";

const ROOT = "C:\\Users\\Tester\\AppData\\Local\\CodexQuota";
const ENGINE = `${ROOT}\\engines\\0.1.0-test`;
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const PATHS = Object.freeze({
  root: ROOT,
  engines: `${ROOT}\\engines`,
  config: `${ROOT}\\install.json`,
  session: `${ROOT}\\session.json`,
  daemonLock: `${ROOT}\\daemon.lock`,
  stopRequest: `${ROOT}\\stop.request`,
  logs: `${ROOT}\\logs`,
  lock: `${ROOT}\\operation.lock`
});

function launchFixture(port = 54321) {
  return {
    port,
    browserId: "browser-fixture",
    browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-fixture`,
    started: true,
    activationPid: 111,
    package: {
      name: "OpenAI.Codex",
      packageFullName: "OpenAI.Codex_26.715.8383.0_x64__fixture",
      packageFamilyName: "OpenAI.Codex_fixture",
      version: "26.715.8383.0",
      executablePath: "C:\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe"
    },
    owner: {
      pid: 222,
      startedAt: "2026-07-21T12:00:00Z",
      executablePath: "C:\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
      packageFullName: "OpenAI.Codex_26.715.8383.0_x64__fixture",
      packageFamilyName: "OpenAI.Codex_fixture"
    }
  };
}

function harness(overrides = {}) {
  let session = overrides.initialSession ?? null;
  const events = [];
  let released = 0;
  const dependencies = {
    platform: "win32",
    packageRoot: "D:\\repo\\codex-quota",
    processExecPath: "C:\\source-node.exe",
    getPaths: () => PATHS,
    getInstalledRuntime: async () => ({ engineRoot: ENGINE, nodePath: NODE, version: "0.1.0" }),
    acquireFileLock: async (path, metadata) => {
      events.push(["lock", path, metadata]);
      return async () => { released += 1; };
    },
    pathExists: async () => true,
    readJson: async () => session,
    writeJsonAtomic: async (_path, value) => {
      session = structuredClone(value);
      events.push(["write", session.status]);
    },
    createSessionRecord: (launch, extra) => createSessionRecord(launch, { nonce: "session-nonce", createdAtMs: 1, ...extra }),
    updateSession: async (_path, nonce, patch) => {
      assert.equal(session.nonce, nonce);
      session = { ...session, ...structuredClone(patch), updatedAtMs: 2 };
      events.push(["update", ...Object.keys(patch)]);
      return session;
    },
    launchCodexWithCdp: async (options) => {
      events.push(["launch", options]);
      return launchFixture(options.port ?? 54321);
    },
    chooseLoopbackPort: async () => 54321,
    createNonce: () => "session-nonce",
    spawnDaemon: async (spec, options) => {
      events.push(["spawn", spec, options]);
      return {
        pid: 333,
        stdoutPath: `${PATHS.logs}\\stdout.log`,
        stderrPath: `${PATHS.logs}\\stderr.log`
      };
    },
    waitForDaemonInfo: async (pid, spec) => {
      events.push(["daemon-info", pid, spec]);
      return {
        pid,
        executablePath: spec.command,
        commandLine: "verified command line",
        startTime: "2026-07-21T12:00:01Z"
      };
    },
    validateRecordedDaemon: async () => ({ valid: true }),
    waitForSessionTerminal: async () => {
      session = { ...session, status: "ready", readyAtMs: 3 };
      return session;
    },
    removeStopRequest: async (path) => { events.push(["remove-stop", path]); },
    ...overrides.dependencies
  };
  return {
    dependencies,
    events,
    get released() { return released; },
    get session() { return session; },
    set session(value) { session = value; }
  };
}

test("parses port and daemon mode flags strictly", () => {
  assert.deepEqual(parseStartOptions({ port: "54321", installed: true, foreground: "false" }), {
    port: 54321,
    installed: true,
    foreground: false
  });
  for (const port of [1023, 65536, "1.5", true]) {
    assert.throws(() => parseStartOptions({ port }), /--port/);
  }
  assert.throws(() => parseStartOptions({ foreground: "yes" }), /boolean/);
});

test("maps nested verified package and owner identities into the session schema", () => {
  const mapped = mapLaunchToSessionInput(launchFixture());
  assert.deepEqual(mapped, {
    port: 54321,
    browserId: "browser-fixture",
    browserWebSocketUrl: "ws://127.0.0.1:54321/devtools/browser/browser-fixture",
    packageName: "OpenAI.Codex",
    packageFullName: "OpenAI.Codex_26.715.8383.0_x64__fixture",
    packageFamilyName: "OpenAI.Codex_fixture",
    packageVersion: "26.715.8383.0",
    executablePath: "C:\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
    processId: 222
  });
});

test("pending launch records retain the selected port before browser discovery", () => {
  assert.deepEqual(createPendingLaunchRecord({
    port: 54321,
    runtime: { engineRoot: ENGINE, nodePath: NODE, source: "installed" },
    nonce: "pending-nonce",
    createdAtMs: 12
  }), {
    schemaVersion: 1,
    nonce: "pending-nonce",
    status: "launching",
    createdAtMs: 12,
    port: 54321,
    browserId: null,
    browserWebSocketUrl: null,
    daemonPid: null,
    daemonIdentityReady: false,
    engineRoot: ENGINE,
    nodePath: NODE,
    runtimeSource: "installed"
  });
});

test("starts through the installed runtime and records verified daemon identity", async () => {
  const h = harness();
  const result = await startCommand({ port: "55000", foreground: true }, h.dependencies);

  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(result.port, 55000);
  assert.equal(result.daemonPid, 333);
  assert.equal(result.runtimeSource, "installed");
  assert.equal(h.released, 1);
  assert.equal(h.session.packageVersion, "26.715.8383.0");
  assert.equal(h.session.packageFullName, "OpenAI.Codex_26.715.8383.0_x64__fixture");
  assert.equal(h.session.appProcessId, 222);
  assert.equal(h.session.appStartedAt, "2026-07-21T12:00:00Z");
  assert.equal(h.session.daemonExecutablePath, NODE);
  assert.equal(h.session.daemonStartTime, "2026-07-21T12:00:01Z");

  const spawn = h.events.find(([name]) => name === "spawn");
  assert.equal(spawn[1].command, NODE);
  assert.deepEqual(spawn[1].arguments, [
    `${ENGINE}\\bin\\codex-quota.mjs`,
    "daemon",
    "--session", PATHS.session,
    "--nonce", "session-nonce",
    "--engine-root", ENGINE
  ]);
  assert.equal(spawn[2].foreground, true);
  assert.equal(spawn[2].logsPath, PATHS.logs);
});

test("falls back to source PACKAGE_ROOT/process.execPath when no install exists", async () => {
  const h = harness({
    dependencies: {
      getInstalledRuntime: async () => null
    }
  });
  const result = await startCommand({ allowNonWindows: true }, h.dependencies);
  const spawn = h.events.find(([name]) => name === "spawn");

  assert.equal(result.runtimeSource, "source");
  assert.equal(spawn[1].command, "C:\\source-node.exe");
  assert.match(spawn[1].entryPath, /D:\\repo\\codex-quota\\bin\\codex-quota\.mjs$/i);
});

test("--installed fails closed when the installed runtime is unavailable", async () => {
  const h = harness({ dependencies: { getInstalledRuntime: async () => null } });
  await assert.rejects(
    startCommand({ installed: true }, h.dependencies),
    (error) => error.code === "E_RUNTIME_NOT_INSTALLED"
  );
  assert.equal(h.events.some(([name]) => name === "launch"), false);
  assert.equal(h.released, 1);
});

test("reuses only a fully validated existing daemon", async () => {
  const existing = {
    schemaVersion: 1,
    nonce: "existing-nonce",
    status: "ready",
    port: 54000,
    daemonPid: 444,
    engineRoot: ENGINE,
    nodePath: NODE,
    daemonExecutablePath: NODE,
    daemonCommandLine: "existing command",
    daemonStartTime: "2026-07-21T12:00:00Z"
  };
  let validationCount = 0;
  const h = harness({
    initialSession: existing,
    dependencies: {
      validateRecordedDaemon: async () => {
        validationCount += 1;
        return { valid: true };
      }
    }
  });
  const result = await startCommand({}, h.dependencies);

  assert.equal(result.reused, true);
  assert.equal(result.daemonPid, 444);
  assert.equal(validationCount, 2);
  assert.equal(h.events.some(([name]) => name === "launch"), false);
  assert.equal(h.events.some(([name]) => name === "spawn"), false);
});

test("an existing daemon on a different requested port is left untouched", async () => {
  const existing = {
    nonce: "existing-nonce",
    status: "ready",
    port: 54000,
    daemonPid: 444,
    engineRoot: ENGINE,
    nodePath: NODE,
    daemonExecutablePath: NODE,
    daemonCommandLine: "existing command",
    daemonStartTime: "2026-07-21T12:00:00Z"
  };
  const h = harness({ initialSession: existing });
  await assert.rejects(
    startCommand({ port: 55000 }, h.dependencies),
    (error) => error.code === "E_DAEMON_PORT_MISMATCH"
  );
  assert.deepEqual(h.session, existing);
  assert.equal(h.events.some(([name]) => name === "launch" || name === "spawn"), false);
});

test("a verified daemon from another runtime blocks replacement without being killed", async () => {
  const oldEngine = `${ROOT}\\engines\\old-runtime`;
  const oldNode = "C:\\old-node\\node.exe";
  const existing = {
    nonce: "old-runtime-nonce",
    status: "ready",
    port: 54000,
    daemonPid: 446,
    engineRoot: oldEngine,
    nodePath: oldNode,
    daemonExecutablePath: oldNode,
    daemonCommandLine: "verified old runtime command",
    daemonStartTime: "2026-07-21T12:00:00Z"
  };
  let inspectedSpec;
  const h = harness({
    initialSession: existing,
    dependencies: {
      validateRecordedDaemon: async (_session, spec) => {
        inspectedSpec = spec;
        return { valid: true };
      }
    }
  });

  await assert.rejects(
    startCommand({}, h.dependencies),
    (error) => error.code === "E_DAEMON_RUNTIME_MISMATCH" && /fully exit Codex/i.test(error.message)
  );
  assert.equal(inspectedSpec.command, oldNode);
  assert.equal(inspectedSpec.engineRoot, oldEngine);
  assert.deepEqual(h.session, existing);
  assert.equal(h.events.some(([name]) => name === "launch" || name === "spawn"), false);
  assert.equal(h.events.some(([name]) => /kill|terminate/i.test(name)), false);
  assert.equal(h.released, 1);
});

test("an unverified old PID is never killed and its verified CDP port is reused", async () => {
  const existing = {
    nonce: "old",
    status: "ready",
    port: 54123,
    daemonPid: 555,
    engineRoot: ENGINE,
    nodePath: NODE,
    daemonExecutablePath: NODE,
    daemonCommandLine: "wrong",
    daemonStartTime: "2026-07-21T12:00:00Z"
  };
  const h = harness({
    initialSession: existing,
    dependencies: { validateRecordedDaemon: async (session) => session.nonce === "old" ? { valid: false, reason: "command-line" } : { valid: true } }
  });
  await startCommand({}, h.dependencies);

  assert.deepEqual(h.events.find(([name]) => name === "launch")[1], { port: 54123 });
  assert.equal(h.events.some(([name]) => /kill|terminate/i.test(name)), false);
});

test("an identity mismatch on a still-running PID fails closed instead of spawning twice", async () => {
  const existing = {
    nonce: "old",
    status: "starting",
    port: 54123,
    daemonPid: 555,
    engineRoot: ENGINE,
    nodePath: NODE,
    daemonExecutablePath: NODE,
    daemonCommandLine: "incomplete",
    daemonStartTime: "2026-07-21T12:00:00Z"
  };
  const h = harness({
    initialSession: existing,
    dependencies: {
      isProcessRunning: () => true,
      validateRecordedDaemon: async () => ({ valid: false, reason: "command-line" })
    }
  });
  await assert.rejects(startCommand({}, h.dependencies), (error) => error.code === "E_DAEMON_IDENTITY");
  assert.equal(h.events.some(([name]) => name === "launch" || name === "spawn"), false);
  assert.deepEqual(h.session, existing);
});

test("parent never overwrites the session after daemon identity ownership transfers", async () => {
  const h = harness({
    dependencies: {
      waitForSessionTerminal: async () => {
        throw Object.assign(new Error("failed for user@example.test with sk-1234567890abcdef"), {
          code: "E_DAEMON_READY_TIMEOUT"
        });
      }
    }
  });
  await assert.rejects(startCommand({}, h.dependencies), (error) => error.code === "E_DAEMON_READY_TIMEOUT");

  assert.equal(h.session.status, "starting");
  assert.equal(h.session.daemonIdentityReady, true);
  assert.equal(Object.hasOwn(h.session, "error"), false);
  assert.equal(h.released, 1);
});

test("a failure before identity handoff is retained with sanitized diagnostics", async () => {
  const h = harness({
    dependencies: {
      waitForDaemonInfo: async () => {
        throw Object.assign(new Error("failed for user@example.test with sk-1234567890abcdef"), {
          code: "E_DAEMON_IDENTITY"
        });
      }
    }
  });
  await assert.rejects(startCommand({}, h.dependencies), (error) => error.code === "E_DAEMON_IDENTITY");
  assert.equal(h.session.status, "error");
  assert.equal(h.session.error.code, "E_DAEMON_IDENTITY");
  assert.doesNotMatch(JSON.stringify(h.session.error), /user@example\.test|sk-1234/);
});

test("a failure after selecting a port leaves a recoverable pending launch diagnostic", async () => {
  const h = harness({
    dependencies: {
      launchCodexWithCdp: async () => {
        throw Object.assign(new Error("browser discovery timed out"), { code: "E_CDP_NOT_READY" });
      }
    }
  });
  await assert.rejects(startCommand({}, h.dependencies), (error) => error.code === "E_CDP_NOT_READY");
  assert.equal(h.session.port, 54321);
  assert.equal(h.session.nonce, "session-nonce");
  assert.equal(h.session.status, "error");
  assert.equal(h.session.error.code, "E_CDP_NOT_READY");
  assert.equal(h.events.some(([name]) => name === "spawn"), false);
});

test("waitForSessionTerminal observes ready, daemon error, and nonce replacement", async () => {
  const ready = await waitForSessionTerminal("session.json", "n", {
    readJson: async () => ({ nonce: "n", status: "ready" }),
    timeoutMs: 100,
    sleep: async () => {}
  });
  assert.equal(ready.status, "ready");

  await assert.rejects(
    waitForSessionTerminal("session.json", "n", {
      readJson: async () => ({ nonce: "n", status: "error", error: { code: "E_FIXTURE", message: "failed" } }),
      timeoutMs: 100,
      sleep: async () => {}
    }),
    (error) => error.code === "E_FIXTURE"
  );
  await assert.rejects(
    waitForSessionTerminal("session.json", "n", {
      readJson: async () => ({ nonce: "n", status: "error", errorCode: "E_FLAT", errorMessage: "flat failure" }),
      timeoutMs: 100,
      sleep: async () => {}
    }),
    (error) => error.code === "E_FLAT" && /flat failure/.test(error.message)
  );
  await assert.rejects(
    waitForSessionTerminal("session.json", "n", {
      readJson: async () => ({ nonce: "other", status: "starting" }),
      timeoutMs: 100,
      sleep: async () => {}
    }),
    (error) => error.code === "E_SESSION_IDENTITY"
  );
});
