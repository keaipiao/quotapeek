import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  classifyGlobalAction,
  emitDoctorHuman,
  emitInstallHuman,
  emitResult,
  emitUninstallHuman,
  main,
  validateInvocation
} from "../src/cli.mjs";
import { parseArgs } from "../src/cli-args.mjs";
import { PACKAGE_ROOT } from "../src/paths.mjs";

function captureIo() {
  const capture = { stdout: "", stderr: "", exitCode: 0 };
  return {
    capture,
    io: {
      stdout(value) { capture.stdout += value; },
      stderr(value) { capture.stderr += value; },
      setExitCode(value) { capture.exitCode = value; }
    }
  };
}

test("public package and executable names cannot invoke the unrelated codex-quota package", async () => {
  const metadata = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const readme = await readFile(join(PACKAGE_ROOT, "README.md"), "utf8");
  const lock = JSON.parse(await readFile(join(PACKAGE_ROOT, "package-lock.json"), "utf8"));
  const renderer = await readFile(join(PACKAGE_ROOT, "src", "renderer", "panel-inject.js"), "utf8");
  const client = await readFile(join(PACKAGE_ROOT, "src", "app-server", "client.mjs"), "utf8");
  assert.equal(metadata.name, "quotapeek");
  assert.deepEqual(metadata.os, ["win32"]);
  assert.deepEqual(metadata.cpu, ["x64"]);
  assert.deepEqual(Object.keys(metadata.bin), ["quotapeek"]);
  assert.equal(metadata.bin.quotapeek, "bin/quotapeek.mjs");
  assert.equal(metadata.author, "keaipiao");
  assert.equal(metadata.repository.url, "git+https://github.com/keaipiao/quotapeek.git");
  assert.ok(metadata.files.includes("README.zh-CN.md"));
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[""].version, metadata.version);
  assert.match(renderer, new RegExp(`const VERSION = ${JSON.stringify(metadata.version)}`));
  assert.match(client, new RegExp(`version: ${JSON.stringify(metadata.version)}`));
  assert.doesNotMatch(readme, /npx(?:\.cmd)?\s+(?:--yes\s+)?codex-quota(?:\s|@|$)/i);
  assert.match(readme, /npx\.cmd --yes quotapeek@latest install/);
});

test("unknown commands produce a coded human error and a nonzero result", async () => {
  const { capture, io } = captureIo();
  const result = await main(["not-a-command"], io);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_UNKNOWN_COMMAND");
  assert.match(capture.stderr, /^\[E_UNKNOWN_COMMAND\]/);
  assert.equal(capture.exitCode, 1);
});

test("global help is classified before any command with side effects", () => {
  for (const argv of [["uninstall", "--help"], ["install", "-h"], ["start", "--help"]]) {
    assert.equal(classifyGlobalAction(argv, parseArgs(argv)), "help");
  }
});

test("invocation validation rejects unknown options, extra arguments, and malformed booleans", () => {
  assert.throws(() => validateInvocation(parseArgs(["uninstall", "--unknown"])), /Unknown option/);
  assert.throws(() => validateInvocation(parseArgs(["uninstall", "extra"])), /Unexpected argument/);
  assert.throws(() => validateInvocation(parseArgs(["doctor", "--live=maybe"])), /boolean/);
});

test("the conventional global --version form returns the package version", async () => {
  const { capture, io } = captureIo();
  const result = await main(["--version"], io);
  assert.equal(result.ok, true);
  assert.equal(result.version, "0.2.0");
  assert.equal(capture.stdout, "0.2.0\n");
});

test("--json produces one structured error result and marks failure", async () => {
  const { capture, io } = captureIo();
  const result = await main(["not-a-command", "--json"], io);
  assert.equal(capture.stderr, "");
  assert.deepEqual(JSON.parse(capture.stdout), result);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "E_UNKNOWN_COMMAND",
      message: result.error.message
    }
  });
  assert.equal(capture.exitCode, 1);
});

test("the published executable returns a nonzero status for structured and human errors", () => {
  const entry = join(PACKAGE_ROOT, "bin", "quotapeek.mjs");
  const json = spawnSync(process.execPath, [entry, "not-a-command", "--json"], { encoding: "utf8" });
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).error.code, "E_UNKNOWN_COMMAND");
  assert.equal(json.stderr, "");

  const human = spawnSync(process.execPath, [entry, "not-a-command"], { encoding: "utf8" });
  assert.equal(human.status, 1);
  assert.match(human.stderr, /^\[E_UNKNOWN_COMMAND\]/);
});

test("any command result with ok false, including doctor, marks a nonzero exit", () => {
  const { capture, io } = captureIo();
  emitResult({ ok: false, checks: [] }, true, io, () => {});
  assert.equal(capture.exitCode, 1);
  assert.deepEqual(JSON.parse(capture.stdout), { ok: false, checks: [] });
});

test("human doctor failures carry a stable error code", () => {
  const { capture, io } = captureIo();
  emitDoctorHuman({ ok: false, checks: [] }, () => "Doctor found blocking failures.\n", io);
  assert.match(capture.stderr, /^\[E_DOCTOR_FAILED\]/);
});

test("--no-shortcuts install output does not claim a shortcut was created", () => {
  const { capture, io } = captureIo();
  emitInstallHuman({
    ok: true,
    install: { version: "0.1.0", engineRoot: "C:\\runtime" },
    shortcuts: { skipped: true }
  }, io);
  assert.match(capture.stdout, /Installation does not start Codex/);
  assert.match(capture.stdout, /Shortcuts were not created/);
  assert.match(capture.stdout, /quotapeek start/);
  assert.doesNotMatch(capture.stdout, /Launch it with/);
});

test("default install output says to open the shortcut without a second command", () => {
  const { capture, io } = captureIo();
  emitInstallHuman({
    ok: true,
    install: { version: "0.2.0", engineRoot: "C:\\runtime" },
    shortcuts: { created: [] }
  }, io);
  assert.match(capture.stdout, /Installation does not start Codex/);
  assert.match(capture.stdout, /open the 'Codex \+ Quota' shortcut directly/);
  assert.match(capture.stdout, /do not need to run 'quotapeek start'/);
});

test("uninstall result preserves shortcut ownership mismatches for callers", async () => {
  const { capture, io } = captureIo();
  const result = {
    ok: true,
    shortcuts: { skipped: [{ path: "C:\\Desktop\\Codex + Quota.lnk", reason: "ownership-mismatch" }] },
    cdpMayStillBeOpen: false
  };
  emitUninstallHuman(result, io);
  assert.match(capture.stdout, /1 same-name shortcut/);
});

test("shortcut scripts use the hidden static launcher and transactional owned removal", async () => {
  const create = await readFile(join(PACKAGE_ROOT, "windows", "create-shortcuts.ps1"), "utf8");
  const remove = await readFile(join(PACKAGE_ROOT, "windows", "remove-shortcuts.ps1"), "utf8");
  const hidden = await readFile(join(PACKAGE_ROOT, "windows", "hidden-launch.ps1"), "utf8");
  assert.match(create, /-WindowStyle Hidden/);
  assert.match(create, /hidden-launch\.ps1/);
  assert.match(create, /Managed by codex-sidebar-quota/);
  assert.match(create, /codex-sidebar-quota-create-/);
  assert.match(create, /Copy-Item[\s\S]+\.Save\(\)[\s\S]+Copy-Item/);
  assert.match(remove, /ownership-mismatch/);
  for (const script of [create, remove]) {
    assert.match(script, /\$managedEngines = Normalize-Path \(Split-Path -Parent \$resolvedEngine\)/);
    assert.doesNotMatch(script, /SpecialFolder\]::LocalApplicationData/);
  }
  assert.match(remove, /Copy-Item[\s\S]+Remove-Item[\s\S]+Copy-Item/);
  for (const script of [create, remove]) {
    assert.match(script, /function Get-SystemPowerShellPath/);
    assert.match(script, /\$windowsRoot = "C:\\Windows"/);
    assert.match(script, /\$windowsRoot -notmatch '\^\[A-Za-z\]:\[\\\\\/\]'/);
    assert.match(script, /\$powerShellPath = Get-SystemPowerShellPath/);
    assert.doesNotMatch(script, /Join-Path \$env:SystemRoot/);
  }
  assert.match(hidden, /& \$resolvedNode \$entryPoint start --installed/);
  assert.match(hidden, /launcher-error\.log/);
  assert.match(hidden, /%LOCALAPPDATA%/);
  assert.match(hidden, /%USERPROFILE%/);
});
