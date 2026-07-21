import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildDaemonSpec,
  parseWindowsCommandLine,
  readDaemonInfo,
  spawnDaemon,
  validateDaemonInfo,
  validateRecordedDaemon,
  waitForDaemonInfo
} from "../src/daemon-process.mjs";

const FIXTURE = Object.freeze({
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  engineRoot: "C:\\Users\\Test User\\AppData\\Local\\CodexQuota\\engines\\0.1.0-test",
  sessionPath: "C:\\Users\\Test User\\AppData\\Local\\CodexQuota\\session.json",
  nonce: "nonce-123"
});

function quote(value) {
  return `"${value}"`;
}

function commandLine(spec, nonce = spec.nonce) {
  return [
    quote(spec.command),
    quote(spec.entryPath),
    "daemon",
    "--session", quote(spec.sessionPath),
    "--nonce", nonce,
    "--engine-root", quote(spec.engineRoot)
  ].join(" ");
}

test("buildDaemonSpec produces the exact supported daemon command", () => {
  const spec = buildDaemonSpec(FIXTURE);
  assert.equal(spec.command, FIXTURE.nodePath);
  assert.deepEqual(spec.arguments, [
    `${FIXTURE.engineRoot}\\bin\\codex-quota.mjs`,
    "daemon",
    "--session", FIXTURE.sessionPath,
    "--nonce", FIXTURE.nonce,
    "--engine-root", FIXTURE.engineRoot
  ]);
});

test("Windows command-line parsing preserves quoted paths and escaped quotes", () => {
  assert.deepEqual(
    parseWindowsCommandLine('"C:\\Program Files\\node.exe" "C:\\a b\\entry.mjs" daemon "a\\\"b"'),
    ["C:\\Program Files\\node.exe", "C:\\a b\\entry.mjs", "daemon", 'a"b']
  );
});

test("daemon identity requires executable, exact argv, and recorded start time", () => {
  const spec = buildDaemonSpec(FIXTURE);
  const info = {
    pid: 1234,
    executablePath: FIXTURE.nodePath,
    commandLine: commandLine(spec),
    startTime: "2026-07-21T12:34:56.1234567Z"
  };
  assert.equal(validateDaemonInfo(info, spec, {}, { platform: "win32" }).valid, true);
  assert.equal(validateDaemonInfo({ ...info, executablePath: "C:\\bad.exe" }, spec, {}, { platform: "win32" }).reason, "executable-path");
  assert.equal(validateDaemonInfo({ ...info, commandLine: commandLine(spec, "wrong") }, spec, {}, { platform: "win32" }).reason, "command-line");
  assert.equal(validateDaemonInfo(info, spec, { startTime: "2026-07-21T12:34:57Z" }, { platform: "win32" }).reason, "recorded-start-time");
});

test("readDaemonInfo invokes only the packaged daemon-info helper", async () => {
  const calls = [];
  const info = await readDaemonInfo(4321, {
    helperPath: "C:\\engine\\windows\\daemon-info.ps1",
    powershellPath: "powershell-fixture.exe",
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          ok: true,
          pid: 4321,
          startTime: "2026-07-21T12:34:56Z",
          executablePath: FIXTURE.nodePath,
          commandLine: "fixture"
        })}\n`
      };
    }
  });

  assert.equal(info.pid, 4321);
  assert.equal(calls[0].command, "powershell-fixture.exe");
  assert.deepEqual(calls[0].args.slice(-4), ["-File", "C:\\engine\\windows\\daemon-info.ps1", "-TargetPid", "4321"]);
});

test("readDaemonInfo uses the shared absolute PowerShell fallback for malformed SystemRoot", async () => {
  const commands = [];
  const runner = async (command) => {
    commands.push(command);
    return {
      code: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        ok: true,
        pid: 4321,
        startTime: "2026-07-21T12:34:56Z",
        executablePath: FIXTURE.nodePath,
        commandLine: "fixture"
      })}\n`
    };
  };

  await readDaemonInfo(4321, {
    helperPath: "C:\\engine\\windows\\daemon-info.ps1",
    env: { SystemRoot: "relative-windows" },
    runner
  });
  await readDaemonInfo(4321, {
    helperPath: "C:\\engine\\windows\\daemon-info.ps1",
    env: { SystemRoot: "\\Windows" },
    runner
  });

  assert.deepEqual(commands, [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  ]);
});

test("readDaemonInfo rejects a successful envelope from a failed helper process", async () => {
  await assert.rejects(
    readDaemonInfo(4321, {
      helperPath: "helper.ps1",
      runner: async () => ({
        code: 1,
        stderr: "",
        stdout: `${JSON.stringify({
          ok: true,
          pid: 4321,
          startTime: "2026-07-21T12:34:56Z",
          executablePath: "C:\\node.exe",
          commandLine: "fixture"
        })}\n`
      })
    }),
    (error) => error.code === "E_DAEMON_INFO_STATUS"
  );
});

test("recorded daemon validation treats a missing or reused PID as invalid and never kills it", async () => {
  const spec = buildDaemonSpec(FIXTURE);
  let calls = 0;
  const result = await validateRecordedDaemon({
    daemonPid: 1234,
    daemonExecutablePath: FIXTURE.nodePath,
    daemonCommandLine: commandLine(spec),
    daemonStartTime: "2026-07-21T12:34:56Z"
  }, spec, {
    helperPath: "helper.ps1",
    platform: "win32",
    runner: async () => {
      calls += 1;
      return { code: 1, stderr: "", stdout: '{"ok":false,"error":{"code":"E_PROCESS_NOT_FOUND","message":"gone"}}\n' };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "E_PROCESS_NOT_FOUND");
});

test("waitForDaemonInfo retries process discovery but rejects identity mismatches", async () => {
  const spec = buildDaemonSpec(FIXTURE);
  let calls = 0;
  const info = await waitForDaemonInfo(1234, spec, {
    helperPath: "helper.ps1",
    platform: "win32",
    timeoutMs: 1_000,
    intervalMs: 0,
    sleep: async () => {},
    runner: async () => {
      calls += 1;
      if (calls === 1) {
        return { code: 1, stderr: "", stdout: '{"ok":false,"error":{"code":"E_PROCESS_NOT_FOUND","message":"wait"}}\n' };
      }
      return {
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          ok: true,
          pid: 1234,
          startTime: "2026-07-21T12:34:56Z",
          executablePath: FIXTURE.nodePath,
          commandLine: commandLine(spec)
        })}\n`
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(info.pid, 1234);
});

class FakeChild extends EventEmitter {
  constructor(pid = 9876) {
    super();
    this.pid = pid;
    this.unrefCount = 0;
  }
  unref() { this.unrefCount += 1; }
}

test("spawnDaemon uses exact argv, detached logs, and no process termination", async () => {
  const spec = buildDaemonSpec(FIXTURE);
  const calls = [];
  const handles = [];
  const child = new FakeChild();
  const resultPromise = spawnDaemon(spec, {
    logsPath: "C:\\Local\\CodexQuota\\logs",
    timestamp: 123,
    mkdir: async () => {},
    open: async (path) => {
      const handle = { path, fd: 100 + handles.length, closeCount: 0, async close() { this.closeCount += 1; } };
      handles.push(handle);
      return handle;
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  });
  const result = await resultPromise;

  assert.equal(calls[0].command, spec.command);
  assert.deepEqual(calls[0].args, spec.arguments);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", 100, 101]);
  assert.equal(child.unrefCount, 1);
  assert.deepEqual(handles.map((handle) => handle.closeCount), [1, 1]);
  assert.match(result.stdoutPath, /daemon-123-nonce-123\.stdout\.log$/);
  assert.equal(typeof child.kill, "undefined");
});

test("foreground daemon is attached while retaining file logs", async () => {
  const spec = buildDaemonSpec(FIXTURE);
  const child = new FakeChild();
  let spawnOptions;
  const handles = [];
  const promise = spawnDaemon(spec, {
    foreground: true,
    logsPath: "C:\\logs",
    mkdir: async () => {},
    open: async () => {
      const handle = { fd: 200 + handles.length, async close() {} };
      handles.push(handle);
      return handle;
    },
    spawn(_command, _args, options) {
      spawnOptions = options;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  });
  await promise;
  assert.equal(spawnOptions.detached, false);
  assert.equal(child.unrefCount, 0);
});
