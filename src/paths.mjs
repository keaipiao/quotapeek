import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getLocalAppData(env = process.env) {
  const value = env.LOCALAPPDATA;
  if (!value) throw new Error("LOCALAPPDATA is unavailable; Codex Quota currently supports Windows only");
  return resolve(value);
}

export function getPaths(env = process.env) {
  const root = join(getLocalAppData(env), "CodexQuota");
  const userHome = env.USERPROFILE || env.HOME || homedir();
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()
    ? resolve(env.CODEX_HOME)
    : join(resolve(userHome), ".codex");
  return Object.freeze({
    root,
    engines: join(root, "engines"),
    config: join(root, "install.json"),
    session: join(root, "session.json"),
    quotaCache: join(root, "quota-cache.json"),
    codexAuth: join(codexHome, "auth.json"),
    daemonLock: join(root, "daemon.lock"),
    stopRequest: join(root, "stop.request"),
    logs: join(root, "logs"),
    lock: join(root, "operation.lock")
  });
}

export function assertManagedPath(path, root) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const prefix = `${resolvedRoot.toLowerCase()}\\`;
  if (resolvedPath.toLowerCase() !== resolvedRoot.toLowerCase() &&
      !resolvedPath.toLowerCase().startsWith(prefix)) {
    throw new Error(`Refusing to manage a path outside ${resolvedRoot}`);
  }
  return resolvedPath;
}
