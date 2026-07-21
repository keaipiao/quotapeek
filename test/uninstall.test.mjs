import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { uninstallCommand } from "../src/commands/uninstall.mjs";
import { getPaths } from "../src/paths.mjs";
import { pathExists, writeJsonAtomic } from "../src/fs-utils.mjs";

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "codex-quota-uninstall-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, LOCALAPPDATA: base, SystemRoot: "D:\\FixtureWindows" };
  const paths = getPaths(env);
  await mkdir(paths.root, { recursive: true });
  return { base, env, paths };
}

test("uninstall removes only the managed product root and invokes the packaged shortcut helper", async (t) => {
  const { base, env, paths } = await fixture(t);
  const calls = [];
  const result = await uninstallCommand({ env }, {
    pathExists: async () => true,
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '{"ok":true,"removed":[],"skipped":[]}\n', stderr: "" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(await pathExists(paths.root), false);
  assert.equal(await pathExists(base), true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].command,
    "D:\\FixtureWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes("RemoteSigned"));
});

test("uninstall keeps an injectable PowerShell path override", async (t) => {
  const { env } = await fixture(t);
  const calls = [];
  const result = await uninstallCommand({ env, powershell: "powershell-test-override.exe" }, {
    pathExists: async () => true,
    runProcess: async (command) => {
      calls.push(command);
      return { code: 0, stdout: '{"ok":true,"removed":[],"skipped":[]}\n', stderr: "" };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["powershell-test-override.exe"]);
});

test("uninstall rejects an install record outside the direct managed engines directory", async (t) => {
  const { env, paths } = await fixture(t);
  await writeJsonAtomic(paths.config, {
    schemaVersion: 1,
    version: "0.3.0",
    engineRoot: join(paths.root, "nested", "runtime"),
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
  });
  let shortcutCalled = false;
  const result = await uninstallCommand({ env }, {
    pathExists: async () => true,
    runProcess: async () => { shortcutCalled = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_INSTALL_IDENTITY");
  assert.equal(shortcutCalled, false);
  assert.equal(await pathExists(paths.root), true);
});

test("uninstall preserves all files when the recorded PID belongs to an unverified process", async (t) => {
  const { env, paths } = await fixture(t);
  await writeJsonAtomic(paths.session, {
    nonce: "nonce",
    daemonPid: 777,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    engineRoot: join(paths.engines, "old"),
    port: 30000
  });
  let shortcutCalled = false;
  const result = await uninstallCommand({ env }, {
    isProcessRunning: () => true,
    validateRecordedDaemon: async () => ({ valid: false, reason: "start-time" }),
    runProcess: async () => { shortcutCalled = true; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_DAEMON_IDENTITY");
  assert.match(result.message, /runtime and shortcuts were preserved/);
  assert.equal(await pathExists(paths.root), true);
  assert.equal(shortcutCalled, false);
});

test("uninstall requests a verified daemon to stop without terminating it", async (t) => {
  const { env, paths } = await fixture(t);
  await writeJsonAtomic(paths.session, {
    nonce: "nonce",
    daemonPid: 888,
    daemonExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
    daemonCommandLine: "verified",
    daemonStartTime: "2026-01-01T00:00:00.000Z",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    engineRoot: join(paths.engines, "old"),
    port: 30000
  });
  let running = true;
  let sleeps = 0;
  const result = await uninstallCommand({ env }, {
    isProcessRunning: () => running,
    validateRecordedDaemon: async () => ({ valid: true }),
    sleep: async () => {
      sleeps += 1;
      running = false;
    },
    pathExists: async () => true,
    runProcess: async () => ({
      code: 0,
      stdout: '{"ok":true,"removed":[],"skipped":[]}\n',
      stderr: ""
    })
  });

  assert.equal(result.ok, true);
  assert.equal(sleeps, 1);
  assert.equal(await pathExists(paths.root), false);
});

test("uninstall does not touch shortcuts or runtime when daemon stop times out", async (t) => {
  const { env, paths } = await fixture(t);
  await writeJsonAtomic(paths.session, {
    nonce: "nonce",
    daemonPid: 991,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    engineRoot: join(paths.engines, "old"),
    port: 30000
  });
  let shortcutCalled = false;
  const result = await uninstallCommand({ env, stopTimeoutMs: 1 }, {
    isProcessRunning: () => true,
    validateRecordedDaemon: async () => ({ valid: true }),
    sleep: async () => {},
    runProcess: async () => { shortcutCalled = true; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_DAEMON_STOP_TIMEOUT");
  assert.equal(shortcutCalled, false);
  assert.equal(await pathExists(paths.root), true);
});

test("uninstall fails closed on a live lifecycle lock without a matching session", async (t) => {
  const { env, paths } = await fixture(t);
  await writeJsonAtomic(paths.daemonLock, { pid: 992 });
  let shortcutCalled = false;
  const result = await uninstallCommand({ env }, {
    isProcessRunning: (pid) => pid === 992,
    runProcess: async () => { shortcutCalled = true; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_DAEMON_LIFECYCLE_ACTIVE");
  assert.equal(shortcutCalled, false);
  assert.equal(await pathExists(paths.root), true);
});

test("uninstall preserves runtime when shortcut helper exits unsuccessfully", async (t) => {
  const { env, paths } = await fixture(t);
  const result = await uninstallCommand({ env }, {
    pathExists: async () => true,
    runProcess: async () => ({
      code: 1,
      stdout: '{"ok":false,"error":{"code":"E_SHORTCUT_REMOVE","message":"denied"}}\n',
      stderr: ""
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.daemonStopped, true);
  assert.equal(result.error.code, "E_SHORTCUT_REMOVE");
  assert.equal(await pathExists(paths.root), true);
});

test("uninstall rejects malformed helper stdout even when the helper exits zero", async (t) => {
  const { env, paths } = await fixture(t);
  const result = await uninstallCommand({ env }, {
    pathExists: async () => true,
    runProcess: async () => ({ code: 0, stdout: "warning\n{}\n", stderr: "" })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_SHORTCUT_REMOVE");
  assert.equal(await pathExists(paths.root), true);
});
