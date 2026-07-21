import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";

import { CodexQuotaError, ERROR_CODES } from "../errors.mjs";
import { systemWindowsPowerShellPath } from "../windows-trust.mjs";

const APP_MANAGED_SEGMENTS = ["OpenAI", "Codex", "bin"];
const NPM_ENTRY_SEGMENTS = ["node_modules", "@openai", "codex", "bin", "codex.js"];
const OFFICIAL_NPM_PACKAGE = "@openai/codex";
const OFFICIAL_WINDOWS_SIGNER = "OpenAI OpCo, LLC";
const AUTHENTICODE_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);
const AUTHENTICODE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = [Environment]::GetEnvironmentVariable('CODEX_QUOTA_SIGNATURE_TARGET', 'Process')",
  "if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing signature target' }",
  "$signature = Get-AuthenticodeSignature -LiteralPath $target",
  "$subject = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject }",
  "[pscustomobject]@{ status = [string]$signature.Status; subject = $subject } | ConvertTo-Json -Compress"
].join("; ");

function runtimeError(message, details) {
  return new CodexQuotaError(ERROR_CODES.RUNTIME_UNAVAILABLE, message, details);
}

function normalizedKey(path, platform) {
  return platform === "win32" ? path.toLowerCase() : path;
}

function isWindowsAppsPath(path, platform) {
  return platform === "win32" && /[\\/]program files[\\/]windowsapps[\\/]/i.test(path);
}

async function isFile(path, platform) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithinRoot(root, candidate, platform) {
  const pathApi = platform === "win32" ? win32 : { relative, isAbsolute };
  const child = pathApi.relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${platform === "win32" ? "\\" : sep}`)
    && !pathApi.isAbsolute(child);
}

async function npmEntryBeside(wrapperPath, platform) {
  const packageRoot = join(dirname(wrapperPath), ...NPM_ENTRY_SEGMENTS.slice(0, -2));
  const entry = join(packageRoot, ...NPM_ENTRY_SEGMENTS.slice(-2));
  try {
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (metadata?.name !== OFFICIAL_NPM_PACKAGE) return null;
    const [resolvedPackageRoot, resolvedEntry] = await Promise.all([
      realpath(packageRoot),
      realpath(entry)
    ]);
    if (!isWithinRoot(resolvedPackageRoot, resolvedEntry, platform)) return null;
    return (await isFile(resolvedEntry, platform)) ? resolvedEntry : null;
  } catch {
    return null;
  }
}

async function describeCandidate(path, source, platform, nodePath) {
  if (isWindowsAppsPath(path, platform)) return null;
  if (!(await isFile(path, platform))) return null;

  const extension = extname(path).toLowerCase();
  if (platform === "win32" && source !== "explicit" && source !== "app-managed"
      && !new Set([".cmd", ".bat", ".ps1"]).has(extension)) {
    // Automatic Windows discovery accepts a verified app binary or a validated
    // npm shim only. In particular, never execute a bare codex.exe from PATH.
    return null;
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return Object.freeze({
      command: nodePath,
      argsPrefix: Object.freeze([path]),
      resolvedPath: path,
      source
    });
  }

  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    // The official global npm shim sits next to node_modules/@openai/codex/bin/codex.js.
    // Resolve to that script instead of invoking a shell wrapper with user-controlled args.
    const entry = await npmEntryBeside(path, platform);
    if (!entry) return null;
    return Object.freeze({
      command: nodePath,
      argsPrefix: Object.freeze([entry]),
      resolvedPath: entry,
      source: source === "explicit" ? source : "npm"
    });
  }

  return Object.freeze({
    command: path,
    argsPrefix: Object.freeze([]),
    resolvedPath: path,
    source
  });
}

function splitDistinguishedName(subject) {
  const parts = [];
  let value = "";
  let quoted = false;
  let escaped = false;
  for (const character of String(subject)) {
    if (escaped) {
      value += `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      quoted = !quoted;
      value += character;
      continue;
    }
    if (character === "," && !quoted) {
      parts.push(value);
      value = "";
      continue;
    }
    value += character;
  }
  if (escaped) value += "\\";
  parts.push(value);
  return parts;
}

function decodeDistinguishedNameValue(value) {
  let normalized = value.trim();
  if (normalized.length >= 2 && normalized.startsWith("\"") && normalized.endsWith("\"")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\\([,+'"\\<>;=# ])/g, "$1");
}

function hasOfficialSignerSubject(subject) {
  if (typeof subject !== "string" || !subject) return false;
  return splitDistinguishedName(subject).some((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return false;
    const attribute = part.slice(0, separator).trim().toUpperCase();
    if (attribute !== "O" && attribute !== "CN") return false;
    return decodeDistinguishedNameValue(part.slice(separator + 1)) === OFFICIAL_WINDOWS_SIGNER;
  });
}

async function runAuthenticodeProcess(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      shell: false,
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: options.env
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : ""
    };
  }
}

/** Verify the app-managed Windows binary without invoking a command shell. */
export async function verifyAppManagedCodexSignature(path, options = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const env = {
    ...(options.env ?? process.env),
    CODEX_QUOTA_SIGNATURE_TARGET: path
  };
  const powershellPath = options.powershellPath ?? systemWindowsPowerShellPath(env);
  const runner = options.runner ?? runAuthenticodeProcess;
  let result;
  try {
    result = await runner(powershellPath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command", AUTHENTICODE_SCRIPT
    ], {
      shell: false,
      windowsHide: true,
      timeoutMs: options.timeoutMs ?? AUTHENTICODE_TIMEOUT_MS,
      env
    });
  } catch {
    return false;
  }
  if (Number(result?.code) !== 0) return false;
  try {
    const envelope = JSON.parse(String(result.stdout ?? "").replace(/^\uFEFF/, "").trim());
    return envelope?.status === "Valid" && hasOfficialSignerSubject(envelope.subject);
  } catch {
    return false;
  }
}

async function appManagedCandidates(root, platform) {
  if (!root) return [];
  const candidates = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, platform === "win32" ? "codex.exe" : "codex");
      if (!(await isFile(path, platform))) continue;
      const info = await stat(path);
      candidates.push({ path, mtimeMs: info.mtimeMs });
    }
  } catch {
    return [];
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  return candidates.map(({ path }) => path);
}

function executableNames(platform, pathExt) {
  if (platform !== "win32") return ["codex"];
  const extensions = String(pathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  const preferred = [".exe", ".cmd", ".bat", ""];
  const unique = [];
  for (const extension of [...preferred, ...extensions]) {
    const name = `codex${extension}`;
    if (!unique.includes(name)) unique.push(name);
  }
  return unique;
}

function pathCandidates(env, platform) {
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const directories = String(env.PATH || env.Path || "").split(pathDelimiter).filter(Boolean);
  const names = executableNames(platform, env.PATHEXT);
  return directories.flatMap((directory) => names.map((name) => join(directory, name)));
}

function npmCandidates(env, platform) {
  const roots = [env.APPDATA && join(env.APPDATA, "npm"), env.npm_config_prefix].filter(Boolean);
  const names = platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["bin/codex", "codex"];
  return roots.flatMap((root) => names.map((name) => join(root, name)));
}

function makeAbsolute(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Resolve a spawn-safe Codex CLI runtime.
 *
 * @param {object} [options]
 * @param {string} [options.codexPath] Explicit executable, JS entry, or official npm shim.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.cwd]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.nodePath]
 * @param {(path:string, options:object) => Promise<boolean>} [options.verifyAppManagedSignature]
 * @returns {Promise<{command:string,argsPrefix:readonly string[],resolvedPath:string,source:string}>}
 */
export async function resolveCodexRuntime(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const nodePath = options.nodePath ?? process.execPath;
  const explicit = options.codexPath ?? env.CODEX_QUOTA_CODEX_PATH;

  if (explicit) {
    // Deliberate user trust override: explicit native binaries are not subject
    // to automatic-source signature policy. Script shims still must resolve to
    // a structurally valid @openai/codex package so they can run without shell.
    const explicitPath = makeAbsolute(explicit, cwd);
    const runtime = await describeCandidate(explicitPath, "explicit", platform, nodePath);
    if (runtime) return runtime;
    throw runtimeError("The configured Codex runtime is unavailable or unsupported", {
      source: "explicit",
      path: explicitPath
    });
  }

  const managedRoot = env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, ...APP_MANAGED_SEGMENTS)
    : null;
  const candidateGroups = [
    { source: "app-managed", paths: await appManagedCandidates(managedRoot, platform) },
    { source: "path", paths: pathCandidates(env, platform) },
    { source: "npm", paths: npmCandidates(env, platform) }
  ];
  const visited = new Set();

  for (const group of candidateGroups) {
    for (const candidate of group.paths) {
      const absolute = makeAbsolute(candidate, cwd);
      const key = normalizedKey(absolute, platform);
      if (visited.has(key)) continue;
      visited.add(key);
      if (group.source === "app-managed" && platform === "win32") {
        const signatureVerifier = options.verifyAppManagedSignature ?? verifyAppManagedCodexSignature;
        let trusted = false;
        try {
          trusted = await signatureVerifier(absolute, {
            env,
            powershellPath: options.powershellPath,
            runner: options.signatureRunner
          });
        } catch {
          // Automatic discovery is fail-closed and may continue to a valid npm runtime.
        }
        if (!trusted) continue;
      }
      const runtime = await describeCandidate(absolute, group.source, platform, nodePath);
      if (runtime) return runtime;
    }
  }

  throw runtimeError("No supported Codex runtime was found", {
    searchedAppManaged: Boolean(managedRoot),
    searchedPath: Boolean(env.PATH || env.Path),
    searchedNpm: Boolean(env.APPDATA || env.npm_config_prefix)
  });
}
