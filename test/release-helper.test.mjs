import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_ROOT } from "../src/paths.mjs";

const VERSION = "0.4.0";
const TAG = `v${VERSION}`;
const ARCHIVE = `elonmark-codex-quota-${VERSION}.tgz`;
const CHECKSUM = `${ARCHIVE}.sha256`;
const WINDOWS_POWERSHELL = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
);
const POWERSHELL_7 = join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "PowerShell", "7", "pwsh.exe"
);
const POWERSHELL_HOSTS = [
  { name: "PowerShell 7", executable: POWERSHELL_7, arguments: ["-NoProfile"] },
  {
    name: "Windows PowerShell 5.1",
    executable: WINDOWS_POWERSHELL,
    arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass"]
  }
].filter(({ executable }) => existsSync(executable));

assert.ok(POWERSHELL_HOSTS.length > 0, "a supported PowerShell host is required");

const FAKE_GH = String.raw`
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const remoteRoot = process.env.FAKE_GH_REMOTE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.calls.push(args);

function save() {
  writeFileSync(statePath, JSON.stringify(state));
}

if (args[0] === "release" && args[1] === "view") {
  save();
  process.stdout.write(JSON.stringify(state.release));
} else if (args[0] === "release" && args[1] === "download") {
  const pattern = args[args.indexOf("--pattern") + 1];
  const destination = args[args.indexOf("--dir") + 1];
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(remoteRoot, pattern), join(destination, pattern));
  save();
} else if (args[0] === "release" && args[1] === "edit") {
  state.release.isDraft = false;
  state.release.isImmutable = true;
  if (!args.includes("--latest=false")) state.latestTag = state.release.tagName;
  save();
} else if (args[0] === "release" && args[1] === "list") {
  if (state.failReleaseList) {
    save();
    process.stderr.write("simulated release list failure");
    process.exitCode = 1;
  } else {
    const releases = [
      ...(state.latestTag ? [{ tagName: state.latestTag, isLatest: true }] : []),
      ...state.publishedTags
        .filter((tagName) => tagName !== state.latestTag)
        .map((tagName) => ({ tagName, isLatest: false }))
    ];
    save();
    process.stdout.write(JSON.stringify(releases));
  }
} else {
  save();
  process.stderr.write("unexpected fake gh invocation: " + args.join(" "));
  process.exitCode = 2;
}
`;

async function fixture({
  draft,
  immutable,
  latestTag,
  publishedTags = [],
  extraAsset = false,
  failReleaseList = false
}) {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-release-helper-"));
  const assets = join(root, "assets");
  const remote = join(root, "remote");
  const fakeBin = join(root, "bin");
  await Promise.all([mkdir(assets), mkdir(remote), mkdir(fakeBin)]);

  const archiveBytes = Buffer.from("verified release fixture\n", "utf8");
  const hash = createHash("sha256").update(archiveBytes).digest("hex");
  await Promise.all([
    writeFile(join(assets, ARCHIVE), archiveBytes),
    writeFile(join(assets, CHECKSUM), `${hash}  ${ARCHIVE}\n`, "ascii"),
    writeFile(join(remote, ARCHIVE), archiveBytes),
    writeFile(join(remote, CHECKSUM), `${hash}  ${ARCHIVE}\n`, "ascii")
  ]);

  const statePath = join(root, "state.json");
  const state = {
    latestTag,
    publishedTags,
    failReleaseList,
    calls: [],
    release: {
      assets: [{ name: ARCHIVE }, { name: CHECKSUM }, ...(extraAsset ? [{ name: "unexpected.exe" }] : [])],
      isDraft: draft,
      isImmutable: immutable,
      isPrerelease: false,
      name: `Codex Quota ${VERSION}`,
      tagName: TAG
    }
  };
  await writeFile(statePath, JSON.stringify(state));
  const fakeScript = join(root, "fake-gh.mjs");
  await writeFile(fakeScript, FAKE_GH);
  await writeFile(join(fakeBin, "gh.cmd"), `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, "ascii");
  return { root, assets, remote, fakeBin, statePath };
}

function runHelper(item, mode, powershell = POWERSHELL_HOSTS[0]) {
  return spawnSync(powershell.executable, [
    ...powershell.arguments,
    "-File", join(PACKAGE_ROOT, ".github", "scripts", "reconcile-release.ps1"),
    "-Mode", mode,
    "-AssetsDirectory", item.assets,
    "-Tag", TAG,
    "-Repository", "keaipiao/codex-quota",
    "-Version", VERSION
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${item.fakeBin};${process.env.PATH}`,
      RUNNER_TEMP: item.root,
      FAKE_GH_STATE: item.statePath,
      FAKE_GH_REMOTE: item.remote
    }
  });
}

async function readState(item) {
  return JSON.parse(await readFile(item.statePath, "utf8"));
}

test("finalizing an already published immutable release is a no-op for Latest", async () => {
  const item = await fixture({ draft: false, immutable: true, latestTag: "v0.5.0" });
  try {
    const result = runHelper(item, "finalize");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const state = await readState(item);
    assert.equal(state.latestTag, "v0.5.0");
    assert.equal(state.calls.some((args) => args[0] === "release" && args[1] === "edit"), false);
  } finally {
    await rm(item.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("an older draft publishes without replacing a newer GitHub Latest", async () => {
  const item = await fixture({
    draft: true,
    immutable: false,
    latestTag: "v0.5.0",
    publishedTags: ["v0.3.1"]
  });
  try {
    const result = runHelper(item, "finalize");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const state = await readState(item);
    const edit = state.calls.find((args) => args[0] === "release" && args[1] === "edit");
    assert.ok(edit);
    assert.ok(edit.includes("--latest=false"));
    assert.equal(state.latestTag, "v0.5.0");
    assert.equal(state.release.isImmutable, true);
  } finally {
    await rm(item.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

for (const powershell of POWERSHELL_HOSTS) {
  test(`multiple published releases are enumerated correctly on ${powershell.name}`, async () => {
    const item = await fixture({
      draft: true,
      immutable: false,
      latestTag: "v0.5.0",
      publishedTags: ["v0.3.1", "v0.2.0"]
    });
    try {
      const result = runHelper(item, "finalize", powershell);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const state = await readState(item);
      const edit = state.calls.find((args) => args[0] === "release" && args[1] === "edit");
      assert.ok(edit?.includes("--latest=false"));
      assert.equal(state.latestTag, "v0.5.0");
    } finally {
      await rm(item.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
}

test("a newer draft becomes GitHub Latest and is immutable after publication", async () => {
  const item = await fixture({ draft: true, immutable: false, latestTag: "v0.3.1" });
  try {
    const result = runHelper(item, "finalize");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const state = await readState(item);
    const edit = state.calls.find((args) => args[0] === "release" && args[1] === "edit");
    assert.ok(edit?.includes("--latest"));
    assert.equal(state.latestTag, TAG);
    assert.equal(state.release.isImmutable, true);
  } finally {
    await rm(item.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("prepare fails before mutation when a release contains an unexpected asset", async () => {
  const item = await fixture({ draft: true, immutable: false, latestTag: "v0.3.1", extraAsset: true });
  try {
    const result = runHelper(item, "prepare");
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /unexpected assets/i);
    const state = await readState(item);
    assert.equal(state.calls.some((args) => args[0] === "release" && ["edit", "upload", "create"].includes(args[1])), false);
  } finally {
    await rm(item.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("finalize fails closed when GitHub Latest cannot be queried", async () => {
  const item = await fixture({ draft: true, immutable: false, latestTag: "v0.5.0", failReleaseList: true });
  try {
    const result = runHelper(item, "finalize");
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /determine the current GitHub Latest/i);
    const state = await readState(item);
    assert.equal(state.calls.some((args) => args[0] === "release" && args[1] === "edit"), false);
    assert.equal(state.release.isDraft, true);
  } finally {
    await rm(item.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("prepare rejects an existing published non-immutable release before mutation", async () => {
  const item = await fixture({ draft: false, immutable: false, latestTag: TAG });
  try {
    const result = runHelper(item, "prepare");
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /published GitHub Release is not immutable/i);
    const state = await readState(item);
    assert.equal(state.calls.some((args) => args[0] === "release" && ["edit", "upload", "create"].includes(args[1])), false);
  } finally {
    await rm(item.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
