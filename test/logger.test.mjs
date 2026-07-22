import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileLogger,
  pruneLogDirectory,
  redactLogText,
} from "../src/host/logger.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("log redaction removes common token, authorization, cookie, session, and email forms", () => {
  const input = [
    "token=plain-secret",
    "access_token: access-secret",
    "Authorization: Bearer bearer-secret",
    '{"authorization":"Bearer json-secret"}',
    '{"access_token":"json-access"}',
    "OPENAI_API_KEY=json-openai-key",
    "Bearer standalone-secret",
    "Cookie=session-cookie",
    "sessionid: session-secret",
    "person@example.test",
    "sk-abcdefghijklmnopqrstuvwxyz",
  ].join(" ");
  const redacted = redactLogText(input);
  for (const secret of [
    "plain-secret", "access-secret", "bearer-secret", "session-cookie",
    "session-secret", "json-secret", "json-access", "json-openai-key",
    "standalone-secret", "person@example.test", "sk-abcdefghijklmnopqrstuvwxyz",
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const paths = redactLogText(
    "C:\\Users\\alice\\AppData\\Local\\CodexQuota and C:\\Users\\alice\\notes",
    {
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      USERPROFILE: "C:\\Users\\alice",
    }
  );
  assert.equal(paths, "%LOCALAPPDATA%\\CodexQuota and %USERPROFILE%\\notes");
});

test("file logger allow-lists detail keys and stops at its size cap", async (t) => {
  const root = await fixture(t);
  const path = join(root, "daemon-test.jsonl");
  const logger = createFileLogger(path, { maxBytes: 220 });
  await logger("warn", "provider.failed", {
    code: "E_RATE_LIMIT_READ",
    message: "Authorization: Bearer top-secret",
    attempt: 2,
    retryDelayMs: 15_000,
    email: "private@example.test",
    unexpected: "must-not-be-written",
  });
  await logger("warn", "provider.failed", { message: "x".repeat(500) });
  const contents = await readFile(path, "utf8");
  assert.match(contents, /"code":"E_RATE_LIMIT_READ"/);
  assert.match(contents, /"attempt":"2"/);
  assert.match(contents, /"retryDelayMs":"15000"/);
  assert.match(contents, /\[REDACTED\]/);
  assert.doesNotMatch(contents, /top-secret|private@example\.test|must-not-be-written/);
  assert.ok((await stat(path)).size <= 220);
});

test("file logger does not let its first record exceed the size cap", async (t) => {
  const root = await fixture(t);
  const path = join(root, "daemon-test.jsonl");
  const logger = createFileLogger(path, { maxBytes: 100 });
  await logger("error", "oversized", { message: "x".repeat(1_000) });
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("file logger never persists an arbitrary uppercase value as an error code", async (t) => {
  const root = await fixture(t);
  const path = join(root, "daemon-test.jsonl");
  const logger = createFileLogger(path);
  await logger("error", "provider.failed", { code: "SECRET_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  const contents = await readFile(path, "utf8");
  assert.match(contents, /"code":"E_REDACTED"/);
  assert.doesNotMatch(contents, /SECRET_TOKEN/);
});

test("log pruning deletes expired and oldest managed files but leaves unrelated files", async (t) => {
  const root = await fixture(t);
  const now = 2_000_000_000_000;
  const expired = join(root, "daemon-expired.stdout.log");
  const older = join(root, "daemon-older.stderr.log");
  const newer = join(root, "daemon-newer.jsonl");
  const unrelated = join(root, "notes.txt");
  await Promise.all([
    writeFile(expired, "expired"),
    writeFile(older, "123456"),
    writeFile(newer, "abcdef"),
    writeFile(unrelated, "keep"),
  ]);
  await utimes(expired, new Date(now - 10_000), new Date(now - 10_000));
  await utimes(older, new Date(now - 2_000), new Date(now - 2_000));
  await utimes(newer, new Date(now - 1_000), new Date(now - 1_000));

  await pruneLogDirectory(root, {
    now: () => now,
    maxAgeMs: 5_000,
    maxTotalBytes: 8,
  });

  await assert.rejects(stat(expired));
  await assert.rejects(stat(older));
  assert.equal((await readFile(newer, "utf8")), "abcdef");
  assert.equal((await readFile(unrelated, "utf8")), "keep");
});
