import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { AppServerClient } from "../src/app-server/client.mjs";
import { ERROR_CODES } from "../src/errors.mjs";

class FakeChild extends EventEmitter {
  constructor(handler) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.#handler = handler;
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        input += String(chunk);
        while (input.includes("\n")) {
          const newline = input.indexOf("\n");
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (line) {
            const message = JSON.parse(line);
            this.messages.push(message);
            this.#handler?.(message, this);
          }
        }
        callback();
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => this.finish(0));
      }
    });
  }

  #handler;

  send(message, { crlf = false, splitAt = 0 } = {}) {
    const line = `${JSON.stringify(message)}${crlf ? "\r\n" : "\n"}`;
    if (splitAt > 0) {
      this.stdout.write(line.slice(0, splitAt));
      queueMicrotask(() => this.stdout.write(line.slice(splitAt)));
    } else {
      this.stdout.write(line);
    }
  }

  finish(code) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit("close", code, null);
  }

  kill() {
    this.signalCode = "SIGTERM";
    this.emit("close", null, this.signalCode);
    return true;
  }
}

function standardHandler(overrides = {}) {
  return (message, child) => {
    if (message.method === "initialize") {
      child.send({ id: message.id, result: { userAgent: "fixture" } }, { crlf: true, splitAt: 7 });
    } else if (message.method === "account/read") {
      child.send({
        id: message.id,
        result: {
          account: {
            type: "chatgpt",
            email: "must-not-escape@example.test",
            planType: "plus",
            accessToken: "secret-token"
          },
          requiresOpenaiAuth: true
        }
      });
    } else if (message.method === "account/rateLimits/read") {
      child.send({ id: message.id, result: overrides.rateLimits ?? { rateLimits: { limitId: "codex" } } });
    }
  };
}

function makeClient(t, handler = standardHandler(), options = {}) {
  const child = new FakeChild(handler);
  const calls = [];
  const client = new AppServerClient({
    runtime: {
      command: "codex-fixture",
      argsPrefix: ["wrapper.js"],
      source: "fixture",
      resolvedPath: "fixture"
    },
    timeoutMs: 100,
    closeGraceMs: 20,
    spawn(command, args, spawnOptions) {
      calls.push({ command, args, spawnOptions });
      return child;
    },
    ...options
  });
  t.after(() => client.close());
  return { child, calls, client };
}

test("starts app-server over stdio and performs the initialize handshake", async (t) => {
  const { child, calls, client } = makeClient(t);
  await client.start();

  assert.equal(client.started, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "codex-fixture");
  assert.deepEqual(calls[0].args, ["wrapper.js", "app-server", "--stdio"]);
  assert.equal(calls[0].spawnOptions.shell, false);
  assert.deepEqual(child.messages[0], {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "codex-quota", title: "Codex Quota", version: "0.4.5" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    }
  });
  assert.deepEqual(child.messages[1], { method: "initialized", params: {} });
});

test("account/read is allow-listed and never returns email or token fields", async (t) => {
  const { client } = makeClient(t);
  await client.start();
  const account = await client.readAccount();

  assert.deepEqual(account, {
    account: { type: "chatgpt", planType: "plus" },
    signedIn: true,
    accountType: "chatgpt",
    planType: "plus",
    requiresOpenaiAuth: true
  });
  assert.doesNotMatch(JSON.stringify(account), /must-not-escape|secret-token/);
});

test("account/read rejects unknown enum strings from its safe projection", async (t) => {
  const handler = (message, child) => {
    if (message.method === "initialize") child.send({ id: message.id, result: {} });
    if (message.method === "account/read") {
      child.send({
        id: message.id,
        result: {
          account: { type: "private@example.test", planType: "sk-secret-value" },
          requiresOpenaiAuth: true
        }
      });
    }
  };
  const { client } = makeClient(t, handler);
  await client.start();
  const account = await client.readAccount();

  assert.equal(account.account, null);
  assert.equal(account.accountType, null);
  assert.equal(account.planType, null);
  assert.doesNotMatch(JSON.stringify(account), /private@example|sk-secret/);
});

test("can return a normalized, renderer-safe rate-limit snapshot", async (t) => {
  const response = {
    rateLimits: {
      limitId: "codex",
      limitName: "Codex",
      planType: "plus",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      secondary: null,
      rateLimitReachedType: null,
      token: "must-not-escape"
    },
    email: "must-not-escape@example.test"
  };
  const { client } = makeClient(t, standardHandler({ rateLimits: response }));
  await client.start();
  const snapshot = await client.readNormalizedRateLimits({ nowMs: 42 });

  assert.equal(snapshot.fetchedAtMs, 42);
  assert.equal(snapshot.buckets[0].windows[0].remainingPercent, 75);
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-escape/);
});

test("account/rateLimits/read returns only its correlated result", async (t) => {
  const response = { rateLimits: { limitId: "codex", primary: null } };
  const { child, client } = makeClient(t, standardHandler({ rateLimits: response }));
  await client.start();
  const result = await client.readRateLimits();

  assert.deepEqual(result, response);
  const request = child.messages.find((message) => message.method === "account/rateLimits/read");
  assert.deepEqual(request, { method: "account/rateLimits/read", id: 2 });
});

test("rate-limit notifications emit method-only change events", async (t) => {
  const { child, client } = makeClient(t);
  await client.start();
  const generic = once(client, "notification");
  const changed = once(client, "rateLimitsUpdated");
  child.send({
    method: "account/rateLimits/updated",
    params: { email: "hidden@example.test", token: "hidden-token", rateLimits: { usedPercent: 99 } }
  });

  assert.deepEqual(await generic, ["account/rateLimits/updated"]);
  assert.deepEqual(await changed, []);
});

test("times out a request without leaking payloads", async (t) => {
  const handler = (message, child) => {
    if (message.method === "initialize") child.send({ id: message.id, result: {} });
  };
  const { client } = makeClient(t, handler);
  await client.start();

  await assert.rejects(
    client.readRateLimits({ timeoutMs: 15 }),
    (error) => error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED && /timed out/.test(error.message)
  );
});

test("sanitizes server errors", async (t) => {
  const handler = (message, child) => {
    if (message.method === "initialize") child.send({ id: message.id, result: {} });
    if (message.method === "account/rateLimits/read") {
      child.send({
        id: message.id,
        error: { code: 401, message: "token=super-secret", data: { email: "private@example.test" } }
      });
    }
  };
  const { client } = makeClient(t, handler);
  await client.start();

  await assert.rejects(client.readRateLimits(), (error) => {
    assert.equal(error.code, ERROR_CODES.APP_SERVER_UNSUPPORTED);
    assert.equal(error.details.serverCode, 401);
    assert.doesNotMatch(JSON.stringify(error), /super-secret|private@example\.test/);
    return true;
  });
});

test("invalid JSONL closes the client and rejects pending requests", async (t) => {
  const handler = (message, child) => {
    if (message.method === "initialize") child.send({ id: message.id, result: {} });
    if (message.method === "account/rateLimits/read") child.stdout.write("not-json\n");
  };
  const { client } = makeClient(t, handler);
  await client.start();

  await assert.rejects(
    client.readRateLimits(),
    (error) => error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED && /invalid JSONL/.test(error.message)
  );
  assert.equal(client.started, false);
});

test("close rejects in-flight work and is idempotent", async (t) => {
  const handler = (message, child) => {
    if (message.method === "initialize") child.send({ id: message.id, result: {} });
  };
  const { client } = makeClient(t, handler);
  await client.start();
  const pending = client.readRateLimits({ timeoutMs: 5_000 });

  await client.close();
  await assert.rejects(pending, (error) => error.code === ERROR_CODES.APP_SERVER_UNSUPPORTED);
  await client.close();
  assert.equal(client.started, false);
});
