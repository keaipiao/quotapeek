import { setTimeout as delay } from "node:timers/promises";

export class QuotaCoordinator {
  #provider;
  #publish;
  #publishUnavailable;
  #log;
  #pollMinMs;
  #pollMaxMs;
  #retryDelaysMs;
  #staleAfterMs;
  #captureReadContext;
  #sameReadContext;
  #setRetryTimeout;
  #clearRetryTimeout;
  #now;
  #stopped = false;
  #refreshing = null;
  #queuedReason = null;
  #pollAbort = new AbortController();
  #consecutiveFailures = 0;
  #unavailablePublishedForFailureStreak = false;
  #retryGeneration = 0;
  #lastSuccessAtMs = 0;
  #unsubscribe = null;
  #retryTimer = null;
  #resetTimer = null;

  constructor(options) {
    this.#provider = options.provider;
    this.#publish = options.publish;
    this.#publishUnavailable = options.publishUnavailable ?? (() => {});
    this.#log = options.log ?? (() => {});
    this.#pollMinMs = options.pollMinMs ?? 60_000;
    this.#pollMaxMs = options.pollMaxMs ?? 120_000;
    const retryDelaysMs = options.retryDelaysMs ?? [5_000, 15_000, 30_000];
    if (!Array.isArray(retryDelaysMs) || retryDelaysMs.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new TypeError("retryDelaysMs must contain only non-negative finite numbers");
    }
    this.#retryDelaysMs = Object.freeze([...retryDelaysMs]);
    this.#staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
    this.#captureReadContext = options.captureReadContext ?? null;
    this.#sameReadContext = options.sameReadContext ?? Object.is;
    this.#setRetryTimeout = options.setRetryTimeout ?? setTimeout;
    this.#clearRetryTimeout = options.clearRetryTimeout ?? clearTimeout;
    this.#now = options.now ?? Date.now;
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
    this.#cancelRetry();
    if (this.#resetTimer) clearTimeout(this.#resetTimer);
    this.#resetTimer = null;
    try { this.#unsubscribe?.(); } catch {}
    const activeRefresh = this.#refreshing;
    const [closeResult] = await Promise.allSettled([
      Promise.resolve().then(() => this.#provider.close()),
      activeRefresh ?? Promise.resolve()
    ]);
    if (closeResult.status === "rejected") throw closeResult.reason;
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
      const publishResult = await this.#publish(snapshot, Object.freeze({
        accountContextChecked: contextChecked,
        accountContextStable: contextStable,
        accountContextBefore: contextBefore,
        accountContextAfter: contextAfter,
      }));
      if (this.#stopped) return null;
      if (publishResult === false) {
        this.#writeLog("info", "quota.refresh.discarded", { reason, accountContextStable: contextStable });
        return null;
      }
      this.#lastSuccessAtMs = this.#now();
      this.#recordSuccess();
      if (contextStable) this.#scheduleResetRefresh(snapshot);
      this.#writeLog("info", "quota.refresh.ok", {
        reason,
        bucketCount: snapshot.buckets.length,
        accountContextStable: contextStable
      });
      return contextStable ? snapshot : null;
    } catch (error) {
      if (this.#stopped) return null;
      const ageMs = this.#lastSuccessAtMs ? this.#now() - this.#lastSuccessAtMs : Infinity;
      const retryDelayMs = this.#recordFailure();
      this.#writeLog("warn", "quota.refresh.failed", {
        reason,
        code: error?.code ?? "E_RATE_LIMIT_READ",
        message: error instanceof Error ? error.message : String(error),
        failureCount: this.#consecutiveFailures,
        retryDelayMs
      });
      if (!this.#queuedReason && !this.#unavailablePublishedForFailureStreak && ageMs >= this.#staleAfterMs) {
        try {
          await this.#publishUnavailable({
            schemaVersion: 1,
            reasonCode: error?.code ?? "E_RATE_LIMIT_STALE",
            atMs: this.#now()
          });
          this.#unavailablePublishedForFailureStreak = true;
        } catch (publishError) {
          this.#writeLog("warn", "quota.unavailable.publish.failed", {
            code: publishError?.code ?? "E_UNAVAILABLE_PUBLISH",
            message: publishError instanceof Error ? publishError.message : String(publishError)
          });
        }
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

  #recordSuccess() {
    this.#consecutiveFailures = 0;
    this.#unavailablePublishedForFailureStreak = false;
    this.#cancelRetry();
  }

  #recordFailure() {
    this.#consecutiveFailures += 1;
    if (this.#retryDelaysMs.length === 0) return null;
    const index = Math.min(this.#consecutiveFailures - 1, this.#retryDelaysMs.length - 1);
    const waitMs = this.#retryDelaysMs[index];
    this.#scheduleRetry(waitMs);
    return waitMs;
  }

  #scheduleRetry(waitMs) {
    if (this.#stopped) return;
    this.#cancelRetry();
    const generation = ++this.#retryGeneration;
    const run = async () => {
      if (this.#stopped || generation !== this.#retryGeneration) return;
      this.#retryTimer = null;
      const activeRefresh = this.#refreshing;
      if (activeRefresh) {
        try { await activeRefresh; } catch {}
        if (this.#stopped || generation !== this.#retryGeneration) return;
      }
      try {
        await this.refresh("retry");
      } catch (error) {
        this.#writeLog("warn", "quota.refresh.unhandled", {
          reason: "retry",
          code: error?.code ?? "E_REFRESH_UNHANDLED",
          message: error instanceof Error ? error.message : String(error)
        });
        if (!this.#stopped && !this.#retryTimer) this.#recordFailure();
      }
    };
    this.#retryTimer = this.#setRetryTimeout(run, waitMs);
    this.#retryTimer?.unref?.();
  }

  #cancelRetry() {
    this.#retryGeneration += 1;
    if (this.#retryTimer) this.#clearRetryTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #writeLog(level, event, details) {
    try { this.#log(level, event, details); } catch {}
  }

  #scheduleResetRefresh(snapshot) {
    if (this.#resetTimer) clearTimeout(this.#resetTimer);
    const nowMs = this.#now();
    const candidates = snapshot.buckets
      .flatMap((bucket) => bucket.windows)
      .map((window) => window.resetsAtMs)
      .filter((value) => Number.isFinite(value) && value > nowMs);
    if (candidates.length === 0) return;
    const waitMs = Math.min(...candidates) - nowMs + 2_000;
    this.#resetTimer = setTimeout(() => {
      this.#resetTimer = null;
      void this.refresh("reset-boundary");
    }, Math.min(waitMs, 2_147_000_000));
  }
}
