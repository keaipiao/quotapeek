import { EventEmitter } from "node:events";

import { CodexQuotaError, ERROR_CODES } from "../errors.mjs";
import { AppServerClient } from "./client.mjs";
import { normalizeRateLimits } from "./normalize.mjs";

function authError() {
  return new CodexQuotaError(
    ERROR_CODES.AUTH_UNSUPPORTED,
    "ChatGPT authentication is required to read Codex account rate limits"
  );
}

/**
 * High-level provider. Change notifications never contain sparse quota data;
 * consumers should call read() to obtain a complete fresh snapshot.
 */
export class AppServerQuotaProvider extends EventEmitter {
  #client;
  #now;
  #ownsClient;
  #started = false;
  #closing = false;
  #onRateLimitsUpdated;
  #onAccountUpdated;
  #onClientClose;

  constructor(options = {}) {
    super();
    this.#client = options.client ?? new AppServerClient(options);
    this.#ownsClient = !options.client;
    this.#now = options.now ?? Date.now;
    this.#onRateLimitsUpdated = () => this.emit("changed", "rateLimits");
    this.#onAccountUpdated = () => this.emit("changed", "account");
    this.#onClientClose = () => {
      if (!this.#started || this.#closing) return;
      this.#started = false;
      this.emit("closed", Object.assign(new Error("Codex app-server process closed"), {
        code: "E_APP_SERVER_CLOSED"
      }));
    };
    this.#client.on("close", this.#onClientClose);
  }

  async start() {
    if (this.#started) return this;
    try {
      await this.#client.start();
      const account = await this.#client.readAccount();
      if (account.accountType !== "chatgpt") throw authError();
      this.#client.on("rateLimitsUpdated", this.#onRateLimitsUpdated);
      this.#client.on("accountUpdated", this.#onAccountUpdated);
      this.#started = true;
      return this;
    } catch (error) {
      if (this.#ownsClient) await this.#client.close().catch(() => {});
      throw error;
    }
  }

  async read() {
    if (!this.#started) throw new Error("Quota provider has not been started");
    const result = await this.#client.readRateLimits();
    return normalizeRateLimits(result, this.#now());
  }

  async close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#client.off("rateLimitsUpdated", this.#onRateLimitsUpdated);
    this.#client.off("accountUpdated", this.#onAccountUpdated);
    this.#started = false;
    try {
      if (this.#ownsClient) await this.#client.close();
    } finally {
      this.#client.off("close", this.#onClientClose);
      this.#closing = false;
    }
  }
}
