import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "./fs-utils.mjs";

export function createSessionRecord(launch, overrides = {}) {
  if (!Number.isInteger(launch.port) || launch.port < 1 || launch.port > 65535) {
    throw new TypeError("Launch result has an invalid CDP port");
  }
  if (typeof launch.browserId !== "string" || !launch.browserId) {
    throw new TypeError("Launch result has no Browser ID");
  }
  return {
    schemaVersion: 1,
    nonce: randomUUID(),
    status: "starting",
    createdAtMs: Date.now(),
    daemonPid: null,
    port: launch.port,
    browserId: launch.browserId,
    browserWebSocketUrl: launch.browserWebSocketUrl,
    packageName: launch.packageName ?? "OpenAI.Codex",
    packageFullName: launch.packageFullName ?? null,
    packageFamilyName: launch.packageFamilyName ?? null,
    packageVersion: launch.packageVersion ?? launch.version ?? null,
    executablePath: launch.executablePath ?? null,
    appProcessId: launch.processId ?? null,
    ...overrides
  };
}

export async function updateSession(path, nonce, patch) {
  const current = await readJson(path);
  if (!current || current.nonce !== nonce) throw new Error("Session identity changed");
  const next = { ...current, ...patch, updatedAtMs: Date.now() };
  await writeJsonAtomic(path, next);
  return next;
}

export async function removeSession(path, nonce) {
  const current = await readJson(path, null);
  if (current && current.nonce !== nonce) return false;
  await rm(path, { force: true });
  return true;
}
