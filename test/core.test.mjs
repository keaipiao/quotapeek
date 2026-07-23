import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/cli-args.mjs";
import { createShortcuts, installCommand, getInstalledRuntime } from "../src/commands/install.mjs";
import { PACKAGE_ROOT, assertManagedPath, getPaths } from "../src/paths.mjs";
import { redactLogText } from "../src/host/logger.mjs";

test("CLI parses boolean, value, and positional arguments", () => {
  assert.deepEqual(parseArgs(["start", "--port", "54321", "--no-desktop", "tail"]), {
    command: "start",
    positionals: ["tail"],
    flags: { port: "54321", desktop: false }
  });
});

test("managed paths cannot escape the product root", () => {
  assert.throws(() => assertManagedPath("C:\\Windows", "C:\\Users\\tester\\AppData\\Local\\CodexQuota"));
  assert.match(assertManagedPath(
    "C:\\Users\\tester\\AppData\\Local\\CodexQuota\\engines\\one",
    "C:\\Users\\tester\\AppData\\Local\\CodexQuota"
  ), /CodexQuota/i);
});

test("Codex auth path prefers an explicit CODEX_HOME and otherwise uses the user profile", () => {
  const explicit = getPaths({
    LOCALAPPDATA: "C:\\Local",
    USERPROFILE: "C:\\Users\\tester",
    CODEX_HOME: "D:\\Portable Codex"
  });
  assert.equal(explicit.codexAuth, "D:\\Portable Codex\\auth.json");

  const standard = getPaths({
    LOCALAPPDATA: "C:\\Local",
    USERPROFILE: "C:\\Users\\tester"
  });
  assert.equal(standard.codexAuth, "C:\\Users\\tester\\.codex\\auth.json");
});

test("installer stages a source-independent runtime without shortcuts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-quota-install-test-"));
  const env = { ...process.env, LOCALAPPDATA: temporary };
  try {
    const result = await installCommand({
      sourceRoot: PACKAGE_ROOT,
      env,
      noShortcuts: true,
      allowNonWindows: true
    });
    assert.equal(result.ok, true);
    const installed = await getInstalledRuntime({ env });
    assert.equal(installed.version, "0.4.6");
    const bin = await readFile(join(installed.engineRoot, "bin", "codex-quota.mjs"), "utf8");
    assert.match(bin, /src\/cli\.mjs/);
    const icon = await readFile(join(installed.engineRoot, "windows", "assets", "codex-quota.ico"));
    assert.ok(icon.length > 0);
    const paths = getPaths(env);
    assert.equal(installed.engineRoot.startsWith(paths.engines), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("installed runtime verification fails closed after a shipped byte changes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-quota-integrity-test-"));
  const env = { ...process.env, LOCALAPPDATA: temporary };
  try {
    const result = await installCommand({
      sourceRoot: PACKAGE_ROOT,
      env,
      noShortcuts: true,
      allowNonWindows: true
    });
    await appendFile(join(result.install.engineRoot, "windows", "assets", "codex-quota.ico"), "tampered");
    await assert.rejects(
      getInstalledRuntime({ env }),
      (error) => error?.code === "E_RUNTIME_INTEGRITY"
    );
    const diagnosticRecord = await getInstalledRuntime({ env, verify: false });
    assert.equal(diagnosticRecord.engineRoot, result.install.engineRoot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a shortcut failure restores the previous installation record and removes the new snapshot", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "codex-quota-rollback-test-"));
  const env = { ...process.env, LOCALAPPDATA: temporary };
  try {
    const first = await installCommand({
      sourceRoot: PACKAGE_ROOT,
      env,
      noShortcuts: true,
      allowNonWindows: true
    });
    await assert.rejects(
      installCommand({
        sourceRoot: PACKAGE_ROOT,
        env,
        allowNonWindows: true,
        createShortcuts: async () => { throw new Error("shortcut denied"); }
      }),
      /shortcut denied/
    );
    const installed = await getInstalledRuntime({ env });
    assert.equal(installed.engineRoot, first.install.engineRoot);
    assert.deepEqual(await readdir(getPaths(env).engines), [installed.engineName]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("shortcut creation defaults to absolute inbox PowerShell and keeps an injectable override", async (t) => {
  const engineRoot = await mkdtemp(join(tmpdir(), "codex-quota-shortcut-test-"));
  t.after(() => rm(engineRoot, { recursive: true, force: true }));
  await mkdir(join(engineRoot, "windows"), { recursive: true });
  await writeFile(join(engineRoot, "windows", "create-shortcuts.ps1"), "# fixture\n");
  const install = { engineRoot, nodePath: "C:\\Program Files\\nodejs\\node.exe" };
  const calls = [];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
  };

  await createShortcuts(install, {
    env: { SystemRoot: "D:\\FixtureWindows" },
    runProcess
  });
  await createShortcuts(install, {
    powershell: "powershell-test-override.exe",
    runProcess
  });

  assert.equal(
    calls[0].command,
    "D:\\FixtureWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].command, "powershell-test-override.exe");
});

test("logger redacts tokens and email addresses", () => {
  const value = redactLogText("email=user@example.com token=secret sk-1234567890abcdef");
  assert.doesNotMatch(value, /user@example\.com|sk-1234/);
});
