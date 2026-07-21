import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { CodexQuotaError, ERROR_CODES } from "../errors.mjs";
import { normalizeRateLimits } from "./normalize.mjs";
import { resolveCodexRuntime } from "./runtime.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const MAX_STDOUT_BUFFER = 4 * 1024 * 1024;
const ACCOUNT_TYPES = new Set(["apiKey", "chatgpt", "amazonBedrock"]);
const PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_usage_based", "business",
  "enterprise_cbp_usage_based", "enterprise", "edu", "unknown"
]);

function appServerError(message, details) {
  return new CodexQuotaError(ERROR_CODES.APP_SERVER_UNSUPPORTED, message, details);
}

function sanitizedAccount(result) {
  const account = result?.account;
  const type = ACCOUNT_TYPES.has(account?.type) ? account.type : null;
  const planType = PLAN_TYPES.has(account?.planType) ? account.planType : null;
  return Object.freeze({
    account: type ? Object.freeze({
      type,
      planType
    }) : null,
    signedIn: Boolean(type),
    accountType: type,
    planType,
    requiresOpenaiAuth: result?.requiresOpenaiAuth === true
  });
}

/**
 * Minimal stdio JSONL client for the official Codex app-server.
 */
export class AppServerClient extends EventEmitter {
  #options;
  #child = null;
  #runtime = null;
  #pending = new Map();
  #nextId = 1;
  #stdoutBuffer = "";
  #initialized = false;
  #startPromise = null;
  #closed = false;
  #closeEmitted = false;

  constructor(options = {}) {
    super();
    this.#options = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      closeGraceMs: DEFAULT_CLOSE_GRACE_MS,
      clientInfo: {
        name: "codex-quota",
        title: "Codex Quota",
        version: "0.3.1"
      },
      ...options
    };
  }

  get runtime() {
    return this.#runtime;
  }

  get started() {
    return this.#initialized && !this.#closed;
  }

  async start() {
    if (this.#initialized) return this;
    if (this.#closed) throw appServerError("Codex app-server client is closed");
    if (this.#startPromise) {
      await this.#startPromise;
      return this;
    }

    this.#startPromise = this.#startInternal();
    try {
      await this.#startPromise;
      return this;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    } finally {
      this.#startPromise = null;
    }
  }

  async #startInternal() {
    this.#runtime = this.#options.runtime ?? await resolveCodexRuntime(this.#options);
    const spawnProcess = this.#options.spawn ?? nodeSpawn;
    const args = [...(this.#runtime.argsPrefix ?? []), "app-server", "--stdio"];
    let child;
    try {
      child = spawnProcess(this.#runtime.command, args, {
        cwd: this.#options.cwd,
        env: this.#options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false
      });
    } catch {
      throw appServerError("Failed to launch Codex app-server", {
        source: this.#runtime.source
      });
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      throw appServerError("Codex app-server did not provide stdio streams");
    }
    this.#child = child;
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => this.#acceptStdout(String(chunk)));
    child.stderr.on("data", () => {}); // Deliberately discard: diagnostics can contain account data.
    child.on("error", () => this.#handleClosed("Codex app-server process failed"));
    child.on("close", () => this.#handleClosed("Codex app-server process closed"));

    const initialized = await this.#requestRaw("initialize", {
      clientInfo: this.#options.clientInfo,
      capabilities: {
        experimentalApi: false,
        requestAttestation: false
      }
    });
    if (!initialized || typeof initialized !== "object" || Array.isArray(initialized)) {
      throw appServerError("Codex app-server returned an invalid initialize response");
    }
    this.#write({ method: "initialized", params: {} });
    this.#initialized = true;
  }

  async readAccount(options = {}) {
    this.#assertStarted();
    const result = await this.#requestRaw("account/read", {
      refreshToken: options.refreshToken === true
    }, options.timeoutMs);
    return sanitizedAccount(result);
  }

  async readRateLimits(options = {}) {
    this.#assertStarted();
    return this.#requestRaw("account/rateLimits/read", undefined, options.timeoutMs);
  }

  async readNormalizedRateLimits(options = {}) {
    const result = await this.readRateLimits(options);
    return normalizeRateLimits(result, options.nowMs ?? Date.now());
  }

  #assertStarted() {
    if (!this.#initialized || this.#closed) {
      throw appServerError("Codex app-server client has not been started");
    }
  }

  #requestRaw(method, params, timeoutMs = this.#options.timeoutMs) {
    if (this.#closed) return Promise.reject(appServerError("Codex app-server client is closed"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("timeoutMs must be a positive finite number"));
    }

    const id = this.#nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(appServerError("Codex app-server request timed out", { method, timeoutMs }));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write(message, (error) => {
          if (!error) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(appServerError("Failed to write to Codex app-server", { method }));
        });
      } catch {
        const pending = this.#pending.get(id);
        if (pending) {
          this.#pending.delete(id);
          clearTimeout(pending.timer);
        }
        reject(appServerError("Failed to write to Codex app-server", { method }));
      }
    });
  }

  #write(message, callback) {
    if (!this.#child?.stdin || this.#closed) {
      throw appServerError("Codex app-server stdin is unavailable");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, callback);
  }

  #acceptStdout(chunk) {
    if (this.#closed) return;
    this.#stdoutBuffer += chunk;
    if (this.#stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      this.#handleClosed("Codex app-server sent an oversized message");
      return;
    }
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#handleClosed("Codex app-server sent invalid JSONL");
        return;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;

    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.hasOwn(message, "error")) {
        const serverCode = typeof message.error?.code === "number" || typeof message.error?.code === "string"
          ? message.error.code
          : undefined;
        pending.reject(appServerError("Codex app-server rejected a request", {
          method: pending.method,
          serverCode
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if (Object.hasOwn(message, "id")) {
      // Quota mode does not opt into server-to-client requests. Reject without
      // reflecting params, which might contain private content.
      this.#write({
        id: message.id,
        error: { code: -32601, message: "Unsupported client request" }
      });
      return;
    }

    // Emit method names only. Sparse notification payloads are intentionally
    // not forwarded; the provider must perform a full read.
    if (message.method === "account/rateLimits/updated") {
      this.emit("notification", message.method);
      this.emit("rateLimitsUpdated");
    } else if (message.method === "account/updated") {
      this.emit("notification", message.method);
      this.emit("accountUpdated");
    }
  }

  #handleClosed(message) {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.#closed = true;
    this.#initialized = false;
    const error = appServerError(message);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit("close");
  }

  async close() {
    if (this.#closed && this.#closeEmitted) return;
    this.#closed = true;
    this.#initialized = false;
    const child = this.#child;
    const error = appServerError("Codex app-server client closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();

    if (!child) {
      if (!this.#closeEmitted) {
        this.#closeEmitted = true;
        this.emit("close");
      }
      return;
    }

    const closed = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", resolve);
    });
    child.stdin.end?.();
    const graceMs = this.#options.closeGraceMs;
    let timer;
    await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(resolve, graceMs);
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill?.();
    if (!this.#closeEmitted) {
      this.#closeEmitted = true;
      this.emit("close");
    }
  }
}
