import test from "node:test";
import assert from "node:assert/strict";
import { createSessionRecord } from "../src/session-state.mjs";

test("session records contain CDP identity but no account data", () => {
  const session = createSessionRecord({
    port: 55000,
    browserId: "browser-id",
    browserWebSocketUrl: "ws://127.0.0.1:55000/devtools/browser/browser-id",
    packageVersion: "26.715.8383.0"
  });
  assert.equal(session.status, "starting");
  assert.equal(session.packageVersion, "26.715.8383.0");
  assert.doesNotMatch(JSON.stringify(session), /quota|email|token/i);
});
