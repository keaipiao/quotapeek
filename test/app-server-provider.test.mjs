import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";

import { AppServerQuotaProvider } from "../src/app-server/provider.mjs";
import { ERROR_CODES } from "../src/errors.mjs";

class StubClient extends EventEmitter {
  constructor(accountType = "chatgpt") {
    super();
    this.accountType = accountType;
    this.closed = false;
    this.startCount = 0;
    this.readCount = 0;
  }

  async start() {
    this.startCount += 1;
  }

  async readAccount() {
    return {
      signedIn: Boolean(this.accountType),
      accountType: this.accountType,
      planType: "plus",
      requiresOpenaiAuth: true
    };
  }

  async readRateLimits() {
    this.readCount += 1;
    return {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        planType: "plus",
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000_000_000 },
        secondary: null,
        rateLimitReachedType: null
      }
    };
  }

  async close() {
    this.closed = true;
  }
}

test("reads complete normalized snapshots", async () => {
  const client = new StubClient();
  const provider = new AppServerQuotaProvider({ client, now: () => 777 });
  await provider.start();
  const snapshot = await provider.read();

  assert.equal(client.startCount, 1);
  assert.equal(client.readCount, 1);
  assert.equal(snapshot.fetchedAtMs, 777);
  assert.equal(snapshot.buckets[0].windows[0].remainingPercent, 80);
  await provider.close();
});

test("forwards only a reread signal for sparse notifications", async () => {
  const client = new StubClient();
  const provider = new AppServerQuotaProvider({ client });
  await provider.start();
  const changed = once(provider, "changed");
  client.emit("rateLimitsUpdated", { token: "must-not-be-forwarded" });

  assert.deepEqual(await changed, ["rateLimits"]);
  assert.equal(client.readCount, 0);
  await provider.close();
});

test("rejects API-key sessions without returning account details", async () => {
  const client = new StubClient("apiKey");
  const provider = new AppServerQuotaProvider({ client });

  await assert.rejects(
    provider.start(),
    (error) => error.code === ERROR_CODES.AUTH_UNSUPPORTED && !/email|token/i.test(error.message)
  );
  await provider.close();
});

test("reports an unexpected app-server close but stays quiet during an intentional close", async () => {
  const client = new StubClient();
  const provider = new AppServerQuotaProvider({ client });
  await provider.start();
  const closed = once(provider, "closed");
  client.emit("close");
  const [error] = await closed;
  assert.equal(error.code, "E_APP_SERVER_CLOSED");

  const intentionalClient = new StubClient();
  const intentional = new AppServerQuotaProvider({ client: intentionalClient });
  let unexpected = 0;
  intentional.on("closed", () => { unexpected += 1; });
  await intentional.start();
  await intentional.close();
  intentionalClient.emit("close");
  assert.equal(unexpected, 0);
});
