import { setTimeout as delay } from "node:timers/promises";

export class QuotaCoordinator {
  #provider;
  #publish;
  #publishUnavailable;
  #log;
  #pollMinMs;
  #pollMaxMs;
  #staleAfterMs;
  #captureReadContext;
  #sameReadContext;
  #stopped = false;
  #refreshing = null;
  #queuedReason = null;
  #pollAbort = new AbortController();
  #lastSuccessAtMs = 0;
  #unsubscribe = null;
  #resetTimer = null;

  constructor(options) {
    this.#provider = options.provider;
    this.#publish = options.publish;
    this.#publishUnavailable = options.publishUnavailable ?? (() => {});
    this.#log = options.log ?? (() => {});
    this.#pollMinMs = options.pollMinMs ?? 60_000;
    this.#pollMaxMs = options.pollMaxMs ?? 120_000;
    this.#staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    this.#captureReadContext = options.captureReadContext ?? null;
    this.#sameReadContext = options.sameReadContext ?? Object.is;
  }

  get lastSuccessAtMs() {
    return this.#lastSuccessAtMs;
  }

  async start() {
    await this.#provider.start();
    if (typeof this.#provider.onRateLimitsUpdated === "function") {
      this.#unsubscribe = this.#provider.onRateLimitsUpdated(() => {
        void this.refresh("notification");
      });
    } else if (typeof this.#provider.on === "function") {
      const handler = (change) => {
        void this.refresh(change === "account" ? "account" : "notification");
      };
      this.#provider.on("changed", handler);
      this.#unsubscribe = () => this.#provider.off?.("changed", handler);
    }
    await this.refresh("startup");
    void this.#pollLoop();
  }

  async refresh(reason = "manual") {
    if (this.#stopped) return null;
    if (this.#refreshing) {
      this.#queueRefresh(reason);
      return this.#refreshing;
    }
    this.#refreshing = this.#refreshLoop(reason).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#pollAbort.abort();
    if (this.#resetTimer) clearTimeout(this.#resetTimer);
    try { this.#unsubscribe?.(); } catch {}
    await this.#provider.close();
  }

  async #pollLoop() {
    while (!this.#stopped) {
      const span = Math.max(0, this.#pollMaxMs - this.#pollMinMs);
      const waitMs = this.#pollMinMs + Math.floor(Math.random() * (span + 1));
      try {
        await delay(waitMs, undefined, { signal: this.#pollAbort.signal });
      } catch (error) {
        if (error?.name === "AbortError") return;
        throw error;
      }
      await this.refresh("poll");
    }
  }

  async #refreshLoop(initialReason) {
    let reason = initialReason;
    let lastSnapshot = null;
    while (!this.#stopped && reason) {
      this.#queuedReason = null;
      const snapshot = await this.#refreshOnce(reason);
      if (snapshot) lastSnapshot = snapshot;
      reason = this.#queuedReason;
    }
    return lastSnapshot;
  }

  async #refreshOnce(reason) {
    try {
      const reader = this.#provider.readNormalizedRateLimits ?? this.#provider.read;
      if (typeof reader !== "function") throw new TypeError("Quota provider has no read method");
      const contextBefore = await this.#readContext();
      const snapshot = await reader.call(this.#provider);
      const contextAfter = await this.#readContext();
      if (this.#stopped) return null;

      const contextChecked = typeof this.#captureReadContext === "function";
      const contextStable = !contextChecked || this.#sameReadContext(contextBefore, contextAfter);
      if (!contextStable) this.#queueRefresh("account-context");
      this.#lastSuccessAtMs = Date.now();
      await this.#publish(snapshot, Object.freeze({
        accountContextChecked: contextChecked,
        accountContextStable: contextStable,
        accountContextBefore: contextBefore,
        accountContextAfter: contextAfter,
      }));
      if (contextStable) this.#scheduleResetRefresh(snapshot);
      this.#log("info", "quota.refresh.ok", {
        reason,
        bucketCount: snapshot.buckets.length,
        accountContextStable: contextStable
      });
      return contextStable ? snapshot : null;
    } catch (error) {
      const ageMs = this.#lastSuccessAtMs ? Date.now() - this.#lastSuccessAtMs : Infinity;
      this.#log("warn", "quota.refresh.failed", {
        reason,
        code: error?.code ?? "E_RATE_LIMIT_READ",
        message: error instanceof Error ? error.message : String(error)
      });
      if (!this.#queuedReason && ageMs >= this.#staleAfterMs) {
        await this.#publishUnavailable({
          schemaVersion: 1,
          reasonCode: error?.code ?? "E_RATE_LIMIT_STALE",
          atMs: Date.now()
        });
      }
      return null;
    }
  }

  async #readContext() {
    if (typeof this.#captureReadContext !== "function") return null;
    try {
      return await this.#captureReadContext();
    } catch {
      return null;
    }
  }

  #queueRefresh(reason) {
    const candidate = typeof reason === "string" && reason ? reason : "notification";
    if (!this.#queuedReason || candidate === "account" || candidate === "account-context") {
      this.#queuedReason = candidate;
    }
  }

  #scheduleResetRefresh(snapshot) {
    if (this.#resetTimer) clearTimeout(this.#resetTimer);
    const candidates = snapshot.buckets
      .flatMap((bucket) => bucket.windows)
      .map((window) => window.resetsAtMs)
      .filter((value) => Number.isFinite(value) && value > Date.now());
    if (candidates.length === 0) return;
    const waitMs = Math.min(...candidates) - Date.now() + 2_000;
    this.#resetTimer = setTimeout(() => {
      this.#resetTimer = null;
      void this.refresh("reset-boundary");
    }, Math.min(waitMs, 2_147_000_000));
  }
}
