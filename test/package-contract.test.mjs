import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_ROOT } from "../src/paths.mjs";

function runNpm(args, cwd) {
  const executable = process.env.npm_execpath ? process.execPath : process.env.ComSpec;
  const invocation = process.env.npm_execpath
    ? [process.env.npm_execpath, ...args]
    : ["/d", "/c", "npm.cmd", ...args];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run")
  );
  env.npm_config_dry_run = "false";
  assert.ok(executable, "npm or the Windows command processor is unavailable");
  return spawnSync(executable, invocation, {
    cwd,
    encoding: "utf8",
    env
  });
}

test("the packed package installs only the codex-quota executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-package-contract-"));
  const packRoot = root;
  const installRoot = join(root, "install");
  try {
    const pack = runNpm(
      ["pack", ".", "--ignore-scripts", "--json", "--pack-destination", packRoot],
      PACKAGE_ROOT
    );
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const result = JSON.parse(pack.stdout);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "@elonmark/codex-quota");
    assert.equal(result[0].version, "0.4.1");
    assert.equal(result[0].filename, "elonmark-codex-quota-0.4.1.tgz");
    const packagedPaths = result[0].files.map(({ path }) => path);
    assert.ok(packagedPaths.includes("bin/codex-quota.mjs"));
    assert.equal(packagedPaths.filter((path) => path.startsWith("bin/")).length, 1);
    assert.equal(packagedPaths.some((path) => path.startsWith("test/")), false);

    const archive = join(packRoot, result[0].filename);
    await mkdir(installRoot);
    const install = runNpm(
      ["install", archive, "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"],
      root
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const shimRoot = join(installRoot, "node_modules", ".bin");
    const shims = await readdir(shimRoot);
    assert.ok(shims.includes("codex-quota.cmd"));
    assert.equal(shims.includes("codex-q.cmd"), false);

    const installedMetadata = JSON.parse(await readFile(
      join(installRoot, "node_modules", "@elonmark", "codex-quota", "package.json"),
      "utf8"
    ));
    assert.deepEqual(installedMetadata.bin, { "codex-quota": "bin/codex-quota.mjs" });

    const version = runNpm(["exec", "--prefix", installRoot, "--", "codex-quota", "version"], root);
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.equal(version.stdout.trim(), "0.4.1");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
