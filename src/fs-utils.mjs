import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    if (process.platform === "win32" && await pathExists(path)) {
      await rm(path, { force: true });
      await rename(temporary, path);
    } else {
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function acquireFileLock(path, metadata = {}) {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(path, {}).catch(() => ({}));
    if (existing.pid && !isProcessRunning(existing.pid)) {
      await rm(path, { force: true });
      handle = await open(path, "wx", 0o600);
    } else {
      throw new Error(`Another Codex Quota operation is active${existing.pid ? ` (PID ${existing.pid})` : ""}`);
    }
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now(), ...metadata })}\n`);
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(path, { force: true }).catch(() => {});
  };
}

export function isProcessRunning(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function fileSize(path) {
  return (await stat(path)).size;
}
