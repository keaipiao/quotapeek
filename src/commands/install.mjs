import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexQuotaError, ERROR_CODES } from "../errors.mjs";
import { acquireFileLock, pathExists, readJson, writeJsonAtomic } from "../fs-utils.mjs";
import { PACKAGE_ROOT, assertManagedPath, getPaths } from "../paths.mjs";
import { parseLastJsonLine, runProcess } from "../process-utils.mjs";
import { assertSameManifest, createRuntimeManifest, manifestDigest } from "../runtime-manifest.mjs";
import { systemWindowsPowerShellPath } from "../windows-trust.mjs";

export const RUNTIME_ENTRIES = ["bin", "src", "windows", "package.json", "README.md", "SECURITY.md", "LICENSE"];

export async function readPackageMetadata(root = PACKAGE_ROOT) {
  return readJson(join(root, "package.json"));
}

export async function installCommand(options = {}) {
  if (process.platform !== "win32" && !options.allowNonWindows) {
    throw new Error("Codex Quota currently supports Windows only");
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Node.js 22 or newer is required; found ${process.version}`);

  const paths = getPaths(options.env);
  const release = await acquireFileLock(paths.lock, { operation: "install" });
  try {
    const metadata = await readPackageMetadata(options.sourceRoot ?? PACKAGE_ROOT);
    const sourceRoot = options.sourceRoot ?? PACKAGE_ROOT;
    await mkdir(paths.engines, { recursive: true });

    const nonce = randomUUID().slice(0, 8);
    const staging = assertManagedPath(join(paths.engines, `.staging-${process.pid}-${nonce}`), paths.root);
    const engineRoot = assertManagedPath(join(paths.engines, `${metadata.version}-${Date.now()}-${nonce}`), paths.root);
    await mkdir(staging, { recursive: true });
    try {
      const presentEntries = [];
      for (const entry of RUNTIME_ENTRIES) {
        const source = join(sourceRoot, entry);
        if (!await pathExists(source)) {
          if (entry === "windows") continue;
          throw new Error(`Runtime source is incomplete: ${entry}`);
        }
        presentEntries.push(entry);
        await cp(source, join(staging, entry), { recursive: true, errorOnExist: false, force: true });
      }
      const sourceManifest = await createRuntimeManifest(sourceRoot, presentEntries);
      const stagedManifest = await createRuntimeManifest(staging, presentEntries);
      assertSameManifest(sourceManifest, stagedManifest);
      await writeFile(join(staging, "runtime-manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(staging, engineRoot);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }

    const install = {
      schemaVersion: 1,
      version: metadata.version,
      engineRoot,
      nodePath: process.execPath,
      manifestSha256: manifestDigest(await readJson(join(engineRoot, "runtime-manifest.json"))),
      installedAtMs: Date.now()
    };
    const previousInstall = await readJson(paths.config, null);
    await writeJsonAtomic(paths.config, install);

    let shortcutResult = { skipped: true };
    try {
      if (!options.noShortcuts) {
        const shortcutCreator = options.createShortcuts ?? createShortcuts;
        shortcutResult = await shortcutCreator(install, {
          desktop: options.desktop !== false,
          powershell: options.powershell,
          env: options.env
        });
      }
    } catch (error) {
      try {
        if (previousInstall) await writeJsonAtomic(paths.config, previousInstall);
        else await rm(paths.config, { force: true });
        await rm(engineRoot, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new CodexQuotaError(
          "E_INSTALL_ROLLBACK",
          "Shortcut creation failed and the previous installation record could not be restored",
          {
            installError: safeInstallMessage(error),
            rollbackError: safeInstallMessage(rollbackError)
          }
        );
      }
      throw error;
    }
    return { ok: true, install, shortcuts: shortcutResult };
  } finally {
    await release();
  }
}

export async function createShortcuts(install, options = {}) {
  const script = join(install.engineRoot, "windows", "create-shortcuts.ps1");
  if (!await pathExists(script)) throw new Error(`Shortcut helper is missing: ${script}`);
  const powershell = options.powershell ?? systemWindowsPowerShellPath(options.env);
  const processRunner = options.runProcess ?? runProcess;
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "RemoteSigned",
    "-File", script,
    "-EngineRoot", install.engineRoot,
    "-NodePath", install.nodePath
  ];
  if (options.desktop) args.push("-Desktop");
  const result = await processRunner(powershell, args, { shell: false });
  let envelope = null;
  try {
    envelope = parseLastJsonLine(result.stdout);
  } catch {
    // The exit/status check below produces the stable public error.
  }
  if (result.code !== 0 || envelope?.ok !== true) {
    const rawCode = envelope?.error?.code;
    const code = typeof rawCode === "string" && /^[A-Z0-9_.-]{1,80}$/.test(rawCode)
      ? rawCode
      : "E_SHORTCUT_CREATE";
    const message = envelope?.error?.message || result.stderr.trim() || "Shortcut creation failed";
    throw new CodexQuotaError(code, safeInstallMessage(message));
  }
  return envelope;
}

export async function getInstalledRuntime(options = {}) {
  const paths = getPaths(options.env);
  const install = await readJson(paths.config, null);
  if (!install) return null;
  if (typeof install.engineRoot !== "string" || typeof install.nodePath !== "string") {
    throw runtimeIntegrityError("Installed runtime identity is incomplete");
  }
  let engineRoot;
  try {
    engineRoot = assertManagedPath(install.engineRoot, paths.root);
  } catch (error) {
    throw runtimeIntegrityError("Installed runtime path is outside the managed product directory", error);
  }
  const normalized = { ...install, engineRoot, engineName: basename(engineRoot) };
  if (options.verify === false) return normalized;
  return verifyInstalledRuntime(normalized, { env: options.env });
}

/**
 * Fail closed before executing an installed snapshot. The digest stored in
 * install.json pins the manifest, and the manifest pins every shipped byte.
 */
export async function verifyInstalledRuntime(install, options = {}) {
  const paths = getPaths(options.env);
  let engineRoot;
  try {
    engineRoot = assertManagedPath(install?.engineRoot, paths.root);
  } catch (error) {
    throw runtimeIntegrityError("Installed runtime path is outside the managed product directory", error);
  }
  if (typeof install?.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(install.manifestSha256)) {
    throw runtimeIntegrityError("Installed runtime manifest identity is missing or malformed");
  }
  if (typeof install?.nodePath !== "string" || !await pathExists(install.nodePath)) {
    throw runtimeIntegrityError("Configured Node.js runtime is missing");
  }
  if (!await pathExists(join(engineRoot, "bin", "codex-quota.mjs"))) {
    throw runtimeIntegrityError("Installed runtime entry point is missing");
  }
  try {
    const expected = await readJson(join(engineRoot, "runtime-manifest.json"));
    if (!Array.isArray(expected)) throw new Error("Runtime manifest is malformed");
    if (manifestDigest(expected) !== install.manifestSha256) {
      throw new Error("Runtime manifest digest changed");
    }
    const actual = await createRuntimeManifest(engineRoot, RUNTIME_ENTRIES);
    assertSameManifest(expected, actual);
    return { ...install, engineRoot, engineName: basename(engineRoot) };
  } catch (error) {
    if (error?.code === ERROR_CODES.RUNTIME_INTEGRITY) throw error;
    throw runtimeIntegrityError("Installed runtime failed byte-content verification", error);
  }
}

function runtimeIntegrityError(message, cause) {
  const error = new CodexQuotaError(ERROR_CODES.RUNTIME_INTEGRITY, message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function safeInstallMessage(value) {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}
