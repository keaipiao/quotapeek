import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";

import { resolveCodexRuntime, verifyAppManagedCodexSignature } from "../src/app-server/runtime.mjs";
import { ERROR_CODES } from "../src/errors.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(path, contents = "fixture") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}

async function npmShim(root, options = {}) {
  const shim = await executable(join(root, options.shimName ?? "codex.cmd"));
  const packageRoot = join(root, "node_modules", "@openai", "codex");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: options.packageName ?? "@openai/codex"
  }));
  const entry = options.entry ?? await executable(join(packageRoot, "bin", "codex.js"));
  return { shim, packageRoot, entry };
}

test("uses an explicit executable before every discovery source", async (t) => {
  const root = await fixture(t);
  const explicit = await executable(join(root, process.platform === "win32" ? "chosen.exe" : "chosen"));
  const runtime = await resolveCodexRuntime({
    codexPath: explicit,
    env: { PATH: "", LOCALAPPDATA: join(root, "missing") }
  });

  assert.equal(runtime.command, explicit);
  assert.equal(runtime.resolvedPath, explicit);
  assert.equal(runtime.source, "explicit");
  assert.deepEqual(runtime.argsPrefix, []);
});

test("runs an explicit JavaScript entry through the current Node runtime", async (t) => {
  const root = await fixture(t);
  const entry = await executable(join(root, "codex.mjs"));
  const runtime = await resolveCodexRuntime({ codexPath: entry, nodePath: "node-fixture" });

  assert.equal(runtime.command, "node-fixture");
  assert.deepEqual(runtime.argsPrefix, [entry]);
});

test("selects the newest app-managed Codex binary", async (t) => {
  const root = await fixture(t);
  const localAppData = join(root, "local");
  const bin = join(localAppData, "OpenAI", "Codex", "bin");
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const oldPath = await executable(join(bin, "old", name));
  const newPath = await executable(join(bin, "new", name));
  await utimes(oldPath, new Date(1_000), new Date(1_000));
  await utimes(newPath, new Date(2_000), new Date(2_000));

  const runtime = await resolveCodexRuntime({
    env: { LOCALAPPDATA: localAppData, PATH: "" },
    verifyAppManagedSignature: async () => true
  });

  assert.equal(runtime.resolvedPath, newPath);
  assert.equal(runtime.source, "app-managed");
});

test("resolves the official npm command shim to its JavaScript entry", async (t) => {
  const root = await fixture(t);
  const npmRoot = join(root, "npm");
  const shimName = process.platform === "win32" ? "codex.cmd" : "codex";
  const { shim, entry } = await npmShim(npmRoot, { shimName });
  const runtime = await resolveCodexRuntime({
    codexPath: process.platform === "win32" ? shim : entry,
    nodePath: "test-node"
  });

  assert.equal(runtime.command, "test-node");
  assert.equal(runtime.resolvedPath, entry);
  assert.deepEqual(runtime.argsPrefix, [entry]);
});

test("Windows automatic discovery rejects a bare codex.exe on PATH", async (t) => {
  const root = await fixture(t);
  await executable(join(root, "codex.exe"));

  await assert.rejects(
    resolveCodexRuntime({
      platform: "win32",
      env: { PATH: root, PATHEXT: ".EXE;.CMD" }
    }),
    (error) => error.code === ERROR_CODES.RUNTIME_UNAVAILABLE
  );
});

test("Windows PATH discovery accepts a structurally valid official npm shim", async (t) => {
  const root = await fixture(t);
  const { entry } = await npmShim(root);
  const runtime = await resolveCodexRuntime({
    platform: "win32",
    env: { PATH: root, PATHEXT: ".EXE;.CMD" },
    nodePath: "node-fixture"
  });

  assert.equal(runtime.command, "node-fixture");
  assert.equal(runtime.resolvedPath, entry);
  assert.equal(runtime.source, "npm");
});

test("npm shim discovery rejects a neighboring package with the wrong identity", async (t) => {
  const root = await fixture(t);
  const { shim } = await npmShim(root, { packageName: "lookalike-codex" });

  await assert.rejects(
    resolveCodexRuntime({ codexPath: shim, platform: "win32" }),
    (error) => error.code === ERROR_CODES.RUNTIME_UNAVAILABLE && error.details.source === "explicit"
  );
});

test("npm shim discovery rejects an entry whose real path escapes the package root", async (t) => {
  const root = await fixture(t);
  const npmRoot = join(root, "npm");
  const packageRoot = join(npmRoot, "node_modules", "@openai", "codex");
  const outsideBin = join(root, "outside-bin");
  await executable(join(npmRoot, "codex.cmd"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  await executable(join(outsideBin, "codex.js"));
  await symlink(outsideBin, join(packageRoot, "bin"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    resolveCodexRuntime({ codexPath: join(npmRoot, "codex.cmd"), platform: "win32" }),
    (error) => error.code === ERROR_CODES.RUNTIME_UNAVAILABLE
  );
});

test("an unsigned app-managed candidate is skipped in favor of an official npm shim", async (t) => {
  const root = await fixture(t);
  const localAppData = join(root, "local");
  const appBinary = await executable(join(localAppData, "OpenAI", "Codex", "bin", "one", "codex.exe"));
  const npmRoot = join(root, "npm");
  const { entry } = await npmShim(npmRoot);
  const checked = [];

  const runtime = await resolveCodexRuntime({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData, APPDATA: root, PATH: "" },
    nodePath: "node-fixture",
    verifyAppManagedSignature: async (path) => {
      checked.push(path);
      return false;
    }
  });

  assert.deepEqual(checked, [appBinary]);
  assert.equal(runtime.resolvedPath, entry);
  assert.equal(runtime.source, "npm");
});

test("Authenticode validation uses absolute inbox PowerShell without a shell", async () => {
  const target = "C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\one\\codex.exe";
  const calls = [];
  const valid = await verifyAppManagedCodexSignature(target, {
    env: { SystemRoot: "D:\\Windows" },
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        code: 0,
        stdout: `${JSON.stringify({ status: "Valid", subject: "CN=OpenAI OpCo\\, LLC, O=OpenAI" })}\n`,
        stderr: ""
      };
    }
  });

  assert.equal(valid, true);
  assert.equal(calls[0].command, win32.join(
    "D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
  ));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.CODEX_QUOTA_SIGNATURE_TARGET, target);
  assert.equal(calls[0].args.includes(target), false);
});

test("Authenticode validation requires both Valid status and the exact OpenAI signer", async () => {
  const target = "C:\\fixture\\codex.exe";
  const verify = (envelope) => verifyAppManagedCodexSignature(target, {
    runner: async () => ({ code: 0, stdout: JSON.stringify(envelope), stderr: "" })
  });

  assert.equal(await verify({ status: "NotSigned", subject: 'CN="OpenAI OpCo, LLC"' }), false);
  assert.equal(await verify({ status: "Valid", subject: "CN=OpenAI OpCo LLC" }), false);
  assert.equal(await verify({ status: "Valid", subject: 'O="OpenAI OpCo, LLC", CN=OpenAI' }), true);
});

test("CODEX_QUOTA_CODEX_PATH remains an explicit user-trust override", async (t) => {
  const root = await fixture(t);
  const explicit = await executable(join(root, "custom-codex.exe"));
  let signatureChecks = 0;
  const runtime = await resolveCodexRuntime({
    platform: "win32",
    env: { CODEX_QUOTA_CODEX_PATH: explicit, PATH: "" },
    verifyAppManagedSignature: async () => {
      signatureChecks += 1;
      return false;
    }
  });

  assert.equal(runtime.resolvedPath, explicit);
  assert.equal(runtime.source, "explicit");
  assert.equal(signatureChecks, 0);
});

test("an invalid explicit path fails instead of silently selecting another runtime", async (t) => {
  const root = await fixture(t);
  const pathDir = join(root, "path");
  await executable(join(pathDir, process.platform === "win32" ? "codex.exe" : "codex"));

  await assert.rejects(
    resolveCodexRuntime({
      codexPath: join(root, "missing"),
      env: { PATH: pathDir }
    }),
    (error) => error.code === ERROR_CODES.RUNTIME_UNAVAILABLE && error.details.source === "explicit"
  );
});

test("reports a sanitized discovery failure", async () => {
  await assert.rejects(
    resolveCodexRuntime({ env: { PATH: "" } }),
    (error) => error.code === ERROR_CODES.RUNTIME_UNAVAILABLE
  );
});
