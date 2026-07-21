import { EventEmitter } from "node:events";
import { CodexQuotaError, ERROR_CODES } from "../errors.mjs";
import { readAppPageTargets, readBrowserIdentity } from "./endpoint.mjs";
import { CdpSession } from "./session.mjs";
import { verifyCdpListenerOwner } from "./windows-launcher.mjs";

export const DEFAULT_CODEX_RENDERER_PROBE = String.raw`(() => {
  try {
    return location.protocol === "app:"
      && Boolean(document.querySelector("main.main-surface"))
      && Boolean(document.querySelector("aside.app-shell-left-panel"))
      && Boolean(document.querySelector(".composer-surface-chrome") || document.querySelector("[role=main]"));
  } catch {
    return false;
  }
})()`;

const GUARDED_SKIP_MARKER = "__codexQuotaRendererProbeSkipped";

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted || milliseconds <= 0) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function targetFingerprint(target) {
  return JSON.stringify([String(target.url ?? ""), String(target.webSocketDebuggerUrl ?? "")]);
}

/*
 * Keep the renderer predicate and the injected expression in one JavaScript
 * turn. This closes the gap between a successful probe and a navigation: if
 * the target has already become an auxiliary renderer, the payload is not
 * executed there even if its navigation event is still in flight.
 */
function guardedRendererExpression(probeExpression, expression) {
  return `(() => {\n` +
    `  const __codexQuotaProbe = (${probeExpression});\n` +
    `  if (__codexQuotaProbe !== true && !(__codexQuotaProbe && __codexQuotaProbe.ok === true)) {\n` +
    `    return { ${GUARDED_SKIP_MARKER}: true };\n` +
    `  }\n` +
    `  (() => {\n${expression}\n  })();\n` +
    `  return { ${GUARDED_SKIP_MARKER}: false };\n` +
    `})()`;
}

function wasGuardedExpressionSkipped(evaluation) {
  return evaluation?.result?.value?.[GUARDED_SKIP_MARKER] === true;
}

function isTerminalIdentityError(error) {
  return error?.code === ERROR_CODES.CDP_OWNER_MISMATCH
    || error?.code === ERROR_CODES.BROWSER_ID_CHANGED;
}

export class CdpWatcher extends EventEmitter {
  #port;
  #browserId;
  #browserWebSocketUrl;
  #fetchImpl;
  #WebSocketImpl;
  #ownerValidator;
  #pollIntervalMs;
  #identityCheckEvery;
  #ownerCheckEvery;
  #requestTimeoutMs;
  #anchor;
  // #trackedTargets includes connecting/probing sessions. #pages contains only
  // renderers that completed both the probe and bootstrap successfully.
  #trackedTargets = new Map();
  #pages = new Map();
  #ignoredTargets = new Map();
  #abort = new AbortController();
  #loopPromise;
  #started = false;
  #closing = false;
  #terminalError;
  #bootstrapSource = "";
  #cleanupExpression;
  #onPageReady;
  #onPageRemoved;
  #targetProbeExpression;
  #probeTimeoutMs;
  #probeIntervalMs;
  #probeRetryMinMs;
  #probeRetryMaxMs;
  #ignoredRetryMs;
  #navigationSettleMs;
  #ownerFingerprint;
  #maxConsecutivePollFailures;
  #consecutivePollFailures = 0;

  constructor({
    port,
    browserId,
    browserWebSocketUrl,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    ownerValidator = ({ port: listenerPort }) => verifyCdpListenerOwner(listenerPort),
    pollIntervalMs = 1_200,
    identityCheckEvery = 5,
    ownerCheckEvery = 50,
    requestTimeoutMs = 5_000,
    targetProbeExpression = DEFAULT_CODEX_RENDERER_PROBE,
    probeTimeoutMs = 10_000,
    probeIntervalMs = 200,
    probeRetryMinMs = 250,
    probeRetryMaxMs = 2_000,
    ignoredRetryMs = 30_000,
    navigationSettleMs = 25,
    maxConsecutivePollFailures = 3,
  } = {}) {
    super();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Invalid CDP port");
    if (typeof browserId !== "string" || !/^[A-Za-z0-9._-]+$/.test(browserId)) throw new TypeError("A valid browserId is required");
    const resolvedBrowserWebSocketUrl = browserWebSocketUrl ?? `ws://127.0.0.1:${port}/devtools/browser/${browserId}`;
    if (typeof resolvedBrowserWebSocketUrl !== "string" || !resolvedBrowserWebSocketUrl) throw new TypeError("browserWebSocketUrl is required");
    this.#port = port;
    this.#browserId = browserId;
    this.#browserWebSocketUrl = resolvedBrowserWebSocketUrl;
    this.#fetchImpl = fetchImpl;
    this.#WebSocketImpl = WebSocketImpl;
    if (typeof ownerValidator !== "function") throw new TypeError("ownerValidator must be a function");
    this.#ownerValidator = ownerValidator;
    if (!Number.isInteger(identityCheckEvery) || identityCheckEvery < 1) throw new RangeError("identityCheckEvery must be positive");
    if (!Number.isInteger(ownerCheckEvery) || ownerCheckEvery < 1) throw new RangeError("ownerCheckEvery must be positive");
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new RangeError("pollIntervalMs must be non-negative");
    if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 0) throw new RangeError("probeTimeoutMs must be non-negative");
    if (!Number.isFinite(probeIntervalMs) || probeIntervalMs < 0) throw new RangeError("probeIntervalMs must be non-negative");
    if (!Number.isFinite(probeRetryMinMs) || probeRetryMinMs < 0) throw new RangeError("probeRetryMinMs must be non-negative");
    if (!Number.isFinite(probeRetryMaxMs) || probeRetryMaxMs < probeRetryMinMs) {
      throw new RangeError("probeRetryMaxMs must be at least probeRetryMinMs");
    }
    if (!Number.isFinite(ignoredRetryMs) || ignoredRetryMs < 0) throw new RangeError("ignoredRetryMs must be non-negative");
    if (!Number.isFinite(navigationSettleMs) || navigationSettleMs < 0) throw new RangeError("navigationSettleMs must be non-negative");
    if (!Number.isInteger(maxConsecutivePollFailures) || maxConsecutivePollFailures < 0) {
      throw new RangeError("maxConsecutivePollFailures must be a non-negative integer");
    }
    this.#pollIntervalMs = pollIntervalMs;
    this.#identityCheckEvery = identityCheckEvery;
    this.#ownerCheckEvery = ownerCheckEvery;
    this.#requestTimeoutMs = requestTimeoutMs;
    if (typeof targetProbeExpression !== "string" || !targetProbeExpression.trim()) {
      throw new TypeError("targetProbeExpression must be a non-empty JavaScript string");
    }
    this.#targetProbeExpression = targetProbeExpression;
    this.#probeTimeoutMs = probeTimeoutMs;
    this.#probeIntervalMs = probeIntervalMs;
    this.#probeRetryMinMs = probeRetryMinMs;
    this.#probeRetryMaxMs = probeRetryMaxMs;
    this.#ignoredRetryMs = ignoredRetryMs;
    this.#navigationSettleMs = navigationSettleMs;
    this.#maxConsecutivePollFailures = maxConsecutivePollFailures;
  }

  get size() { return this.#pages.size; }
  get terminalError() { return this.#terminalError; }

  async start({
    bootstrapSource,
    cleanupExpression,
    onPageReady,
    onPageRemoved,
  } = {}) {
    if (this.#started) return this;
    if (typeof bootstrapSource !== "string" || !bootstrapSource.trim()) {
      throw new TypeError("bootstrapSource must be a non-empty JavaScript string");
    }
    if (cleanupExpression !== undefined && typeof cleanupExpression !== "string") {
      throw new TypeError("cleanupExpression must be a JavaScript string");
    }
    this.#bootstrapSource = bootstrapSource;
    this.#cleanupExpression = cleanupExpression;
    this.#onPageReady = onPageReady;
    this.#onPageRemoved = onPageRemoved;

    this.#anchor = new CdpSession(this.#browserWebSocketUrl, {
      port: this.#port,
      WebSocketImpl: this.#WebSocketImpl,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    this.#anchor.once("close", () => {
      if (this.#closing) return;
      this.#terminalError = new CodexQuotaError(
        ERROR_CODES.BROWSER_ID_CHANGED,
        "The original CDP browser identity connection closed",
        { browserId: this.#browserId },
      );
      this.emit("watcherError", this.#terminalError);
      this.#abort.abort();
    });
    try {
      await this.#anchor.connect();
      // The parent already verified the launch. One post-connect owner and
      // browser-identity check closes the handoff race without paying for two
      // separate PowerShell owner inspections during every cold start.
      await Promise.all([this.#validateOwner(), this.#validateIdentity()]);
      if (this.#terminalError) throw this.#terminalError;
      this.#started = true;

      await this.#syncTargets();
      this.#loopPromise = this.#watchLoop();
      return this;
    } catch (error) {
      this.#terminalError = error;
      this.#closing = true;
      this.#abort.abort();
      await this.#closeSessions();
      throw error;
    }
  }

  async #validateOwner() {
    const result = await this.#ownerValidator({ port: this.#port });
    if (!result || result.ok === false) {
      throw new CodexQuotaError(ERROR_CODES.CDP_OWNER_MISMATCH, "CDP listener owner validation failed", result);
    }
    if (result.owner) {
      const fingerprint = JSON.stringify([
        result.owner.pid,
        result.owner.startedAt,
        result.owner.executablePath,
        result.owner.packageFullName,
      ]);
      if (this.#ownerFingerprint && this.#ownerFingerprint !== fingerprint) {
        throw new CodexQuotaError(ERROR_CODES.CDP_OWNER_MISMATCH, "The CDP listener owner changed", {
          expected: this.#ownerFingerprint,
          actual: fingerprint,
        });
      }
      this.#ownerFingerprint = fingerprint;
    }
  }

  async #validateIdentity() {
    const identity = await readBrowserIdentity({
      port: this.#port,
      fetchImpl: this.#fetchImpl,
      timeoutMs: Math.min(this.#requestTimeoutMs, 2_000),
    });
    if (identity.browserId !== this.#browserId || identity.webSocketDebuggerUrl !== this.#browserWebSocketUrl) {
      throw new CodexQuotaError(ERROR_CODES.BROWSER_ID_CHANGED, "The CDP browser identity changed", {
        expectedBrowserId: this.#browserId,
        actualBrowserId: identity.browserId,
      });
    }
  }

  async #watchLoop() {
    // start() has just performed owner and browser identity validation twice.
    let iteration = 1;
    while (!this.#abort.signal.aborted) {
      try {
        if (iteration % this.#ownerCheckEvery === 0) await this.#validateOwner();
        if (iteration % this.#identityCheckEvery === 0) await this.#validateIdentity();
        await this.#syncTargets();
        if (this.#consecutivePollFailures > 0) {
          this.emit("watcherRecovered", { failureCount: this.#consecutivePollFailures });
          this.#consecutivePollFailures = 0;
        }
        iteration += 1;
      } catch (error) {
        const nextFailureCount = this.#consecutivePollFailures + 1;
        if (isTerminalIdentityError(error) || nextFailureCount > this.#maxConsecutivePollFailures) {
          this.#terminalError = error;
          this.emit("watcherError", error);
          this.#abort.abort();
          break;
        }
        this.#consecutivePollFailures = nextFailureCount;
        this.emit("watcherTransientError", { error, failureCount: nextFailureCount });
      }
      await abortableDelay(this.#pollIntervalMs, this.#abort.signal);
    }
    this.#closing = true;
    await this.#closeSessions();
  }

  async #syncTargets() {
    const targets = await readAppPageTargets({
      port: this.#port,
      fetchImpl: this.#fetchImpl,
      timeoutMs: Math.min(this.#requestTimeoutMs, 2_000),
    });
    const targetById = new Map(targets.map((target) => [target.id, target]));

    for (const [id, page] of this.#trackedTargets) {
      if (!targetById.has(id)) await this.#removePage(id, page, "target-removed");
    }
    for (const id of this.#ignoredTargets.keys()) {
      if (!targetById.has(id)) this.#ignoredTargets.delete(id);
    }

    const additions = [];
    for (const target of targets) {
      const fingerprint = targetFingerprint(target);
      const page = this.#trackedTargets.get(target.id);
      if (page) {
        if (page.fingerprint !== fingerprint) {
          const endpointChanged = page.target.webSocketDebuggerUrl !== target.webSocketDebuggerUrl;
          if (endpointChanged) {
            await this.#removePage(target.id, page, "target-endpoint-changed");
            additions.push(this.#addPage(target));
          } else {
            page.target = target;
            page.fingerprint = fingerprint;
            this.#scheduleRevalidation(page, "target-url-changed", this.#navigationSettleMs);
          }
        }
        continue;
      }

      const ignored = this.#ignoredTargets.get(target.id);
      if (ignored && ignored.fingerprint === fingerprint && Date.now() < ignored.retryAt) continue;
      if (ignored) this.#ignoredTargets.delete(target.id);
      additions.push(this.#addPage(target));
    }
    await Promise.all(additions);
  }

  #isCurrent(page, generation) {
    return !page.closed
      && page.generation === generation
      && this.#trackedTargets.get(page.target.id) === page
      && !this.#abort.signal.aborted;
  }

  async #probeCodexRenderer(page, generation) {
    const deadline = Date.now() + this.#probeTimeoutMs;
    do {
      if (!this.#isCurrent(page, generation)) return "stale";
      try {
        const probe = await page.session.send("Runtime.evaluate", {
          expression: this.#targetProbeExpression,
          awaitPromise: false,
          returnByValue: true,
          userGesture: false,
        });
        if (!this.#isCurrent(page, generation)) return "stale";
        const probeValue = probe?.result?.value;
        if (probeValue === true || probeValue?.ok === true) return "match";
      } catch (error) {
        if (!page.session.isOpen) throw error;
        // Context destruction during a navigation is expected. Retry within the
        // same bounded probe window so a slow main renderer can still attach.
      }
      if (Date.now() >= deadline || this.#abort.signal.aborted) return "timeout";
      await abortableDelay(this.#probeIntervalMs, this.#abort.signal);
    } while (!this.#abort.signal.aborted);
    return "stale";
  }

  #deactivatePage(page, reason) {
    if (this.#pages.get(page.target.id) !== page) return;
    this.#pages.delete(page.target.id);
    page.active = false;
    this.#notifyRemoved(page, reason).catch((error) => this.emit("pageError", { target: page.target, error }));
  }

  #scheduleRevalidation(page, reason, delayMs = 0) {
    if (page.closed || this.#trackedTargets.get(page.target.id) !== page) return Promise.resolve(false);
    if (reason !== "renderer-probe-timeout") page.probeRetryCount = 0;
    const generation = ++page.generation;
    this.#deactivatePage(page, reason);
    const validation = (async () => {
      await abortableDelay(delayMs, this.#abort.signal);
      if (!this.#isCurrent(page, generation)) return false;
      const probeResult = await this.#probeCodexRenderer(page, generation);
      if (probeResult === "stale") return false;
      if (probeResult !== "match") {
        page.probeRetryCount += 1;
        const retryDelay = Math.min(
          this.#probeRetryMaxMs,
          this.#probeRetryMinMs * (2 ** Math.min(8, page.probeRetryCount - 1))
        );
        this.#scheduleRevalidation(page, "renderer-probe-timeout", retryDelay);
        return false;
      }
      if (!this.#isCurrent(page, generation)) return false;
      page.probeRetryCount = 0;

      const evaluated = await page.session.send("Runtime.evaluate", {
        expression: guardedRendererExpression(this.#targetProbeExpression, this.#bootstrapSource),
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      });
      if (!this.#isCurrent(page, generation)) return false;
      if (wasGuardedExpressionSkipped(evaluated)) {
        this.#ignorePage(page, "renderer-changed-before-bootstrap");
        return false;
      }

      page.active = true;
      this.#pages.set(page.target.id, page);
      const evaluate = async (expression, options = {}) => {
        if (!this.#isCurrent(page, generation) || this.#pages.get(page.target.id) !== page) {
          throw new Error("Renderer is no longer active");
        }
        const replay = await page.session.send("Runtime.evaluate", {
          expression: guardedRendererExpression(this.#targetProbeExpression, expression),
          awaitPromise: options.awaitPromise ?? true,
          returnByValue: options.returnByValue ?? true,
          userGesture: false,
        });
        if (wasGuardedExpressionSkipped(replay)) {
          this.#scheduleRevalidation(page, "renderer-changed-before-replay", this.#navigationSettleMs);
          throw new Error("Renderer changed before state replay");
        }
        return replay;
      };
      await this.#onPageReady?.({ target: page.target, session: page.session, result: evaluated, evaluate });
      if (!this.#isCurrent(page, generation)) return false;
      this.emit("pageReady", { target: page.target, session: page.session, result: evaluated });
      return true;
    })().catch((error) => {
      if (this.#isCurrent(page, generation)) {
        this.#ignorePage(page, "renderer-validation-error", { emitIgnored: false });
        this.emit("pageError", { target: page.target, error });
      }
      return false;
    });
    page.validationPromise = validation;
    return validation;
  }

  async #addPage(target) {
    if (this.#trackedTargets.has(target.id)) return false;
    const session = new CdpSession(target.webSocketDebuggerUrl, {
      port: this.#port,
      WebSocketImpl: this.#WebSocketImpl,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    const page = {
      target,
      fingerprint: targetFingerprint(target),
      session,
      generation: 0,
      active: false,
      closed: false,
      intentionalClose: false,
      probeRetryCount: 0,
      validationPromise: null,
    };
    this.#trackedTargets.set(target.id, page);

    session.once("close", () => {
      if (page.intentionalClose || page.closed) return;
      page.closed = true;
      page.generation += 1;
      if (this.#trackedTargets.get(target.id) === page) this.#trackedTargets.delete(target.id);
      this.#deactivatePage(page, "socket-closed");
      this.#ignoredTargets.set(target.id, {
        fingerprint: page.fingerprint,
        retryAt: Date.now() + this.#ignoredRetryMs,
      });
    });
    session.on("Runtime.executionContextsCleared", () => {
      this.#scheduleRevalidation(page, "execution-contexts-cleared", this.#navigationSettleMs);
    });
    session.on("Page.frameNavigated", ({ frame } = {}) => {
      if (!frame || frame.parentId) return;
      if (typeof frame.url === "string" && frame.url) {
        page.target = Object.freeze({ ...page.target, url: frame.url });
        page.fingerprint = targetFingerprint(page.target);
      }
      this.#scheduleRevalidation(page, "main-frame-navigated", this.#navigationSettleMs);
    });

    try {
      await session.connect();
      await Promise.all([
        session.send("Runtime.enable"),
        session.send("Page.enable"),
      ]);
      this.#scheduleRevalidation(page, "target-added");
      return true;
    } catch (error) {
      if (!page.closed && this.#trackedTargets.get(target.id) === page) {
        this.#ignorePage(page, "target-connect-error", { emitIgnored: false });
        this.emit("pageError", { target: page.target, error });
      }
      return false;
    }
  }

  #ignorePage(page, reason, { emitIgnored = true } = {}) {
    if (page.closed) return;
    page.generation += 1;
    this.#deactivatePage(page, reason);
    page.closed = true;
    page.intentionalClose = true;
    if (this.#trackedTargets.get(page.target.id) === page) this.#trackedTargets.delete(page.target.id);
    this.#ignoredTargets.set(page.target.id, {
      fingerprint: page.fingerprint,
      retryAt: Date.now() + this.#ignoredRetryMs,
    });
    page.session.close();
    if (emitIgnored) this.emit("targetIgnored", { target: page.target, reason });
  }

  async #removePage(id, page, reason) {
    if (page.closed) return;
    const wasActive = this.#pages.get(id) === page;
    page.generation += 1;
    page.closed = true;
    page.intentionalClose = true;
    if (this.#trackedTargets.get(id) === page) this.#trackedTargets.delete(id);
    if (this.#pages.get(id) === page) this.#pages.delete(id);
    if (wasActive && page.session.isOpen && this.#cleanupExpression) {
      try {
        await page.session.send("Runtime.evaluate", {
          expression: guardedRendererExpression(this.#targetProbeExpression, this.#cleanupExpression),
          awaitPromise: true,
          returnByValue: true,
        }, { timeoutMs: 1_000 });
      } catch { /* Target may already be gone. */ }
    }
    page.session.close();
    if (wasActive) await this.#notifyRemoved(page, reason);
  }

  async #notifyRemoved(page, reason) {
    try {
      await this.#onPageRemoved?.({ target: page.target, reason });
    } finally {
      this.emit("pageRemoved", { target: page.target, reason });
    }
  }

  async evaluateAll(expression, { awaitPromise = true, returnByValue = true } = {}) {
    if (typeof expression !== "string" || !expression.trim()) throw new TypeError("expression is required");
    const results = [];
    const guardedExpression = guardedRendererExpression(this.#targetProbeExpression, expression);
    for (const page of [...this.#pages.values()]) {
      if (!page.active || this.#pages.get(page.target.id) !== page) continue;
      try {
        const result = await page.session.send("Runtime.evaluate", {
          expression: guardedExpression,
          awaitPromise,
          returnByValue,
          userGesture: false,
        });
        if (wasGuardedExpressionSkipped(result)) {
          this.#scheduleRevalidation(page, "renderer-changed-before-update", this.#navigationSettleMs);
          results.push({ targetId: page.target.id, ok: false, skipped: true });
        } else {
          results.push({ targetId: page.target.id, ok: true, result });
        }
      } catch (error) {
        results.push({ targetId: page.target.id, ok: false, error });
      }
    }
    return results;
  }

  async #closeSessions() {
    const pages = [...this.#trackedTargets.entries()];
    for (const [id, page] of pages) await this.#removePage(id, page, "watcher-closed");
    this.#ignoredTargets.clear();
    this.#anchor?.close();
  }

  async close() {
    if (this.#closing) return this.#loopPromise;
    this.#closing = true;
    this.#abort.abort();
    if (this.#loopPromise) await this.#loopPromise;
    else await this.#closeSessions();
  }
}
