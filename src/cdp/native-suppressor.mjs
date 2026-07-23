import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readAppPageTargets, readBrowserIdentity } from "./endpoint.mjs";
import { CdpSession } from "./session.mjs";

const NATIVE_SUPPRESSOR_PATH = Object.freeze(["src", "renderer", "native-card-suppress.js"]);
const NATIVE_OPERATION_TIMEOUT_MS = 2_500;
const TARGET_POLL_INTERVAL_MS = 50;
const TARGET_SETTLE_MS = 500;
const CDP_STEP_TIMEOUT_MS = 500;

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`${label} timed out`));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function assertBrowserIdentity(identity, browserId, browserWebSocketUrl) {
  if (identity.browserId !== browserId || identity.webSocketDebuggerUrl !== browserWebSocketUrl) {
    const error = new Error("The Codex browser identity changed before native quota suppression");
    error.code = "E_BROWSER_ID_CHANGED";
    throw error;
  }
}

function remainingMs(deadlineAtMs, now) {
  return Math.max(0, deadlineAtMs - now());
}

function deadlineCall(operation, deadlineAtMs, now, label, capMs = Number.POSITIVE_INFINITY) {
  const timeoutMs = Math.min(capMs, remainingMs(deadlineAtMs, now));
  if (timeoutMs <= 0) return Promise.reject(new Error(`${label} timed out`));
  try {
    return withTimeout(operation(), timeoutMs, label);
  } catch (error) {
    return Promise.reject(error);
  }
}

function assertEvaluationSucceeded(evaluation, label) {
  if (evaluation?.exceptionDetails) throw new Error(`${label} failed`);
  return evaluation;
}

export async function installNativeQuotaSuppression({
  engineRoot,
  port,
  browserId,
  browserWebSocketUrl,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  requestTimeoutMs = 2_000,
  operationTimeoutMs = NATIVE_OPERATION_TIMEOUT_MS,
  targetPollMs = TARGET_POLL_INTERVAL_MS,
  targetSettleMs = TARGET_SETTLE_MS,
  readSource = readFile,
  readIdentity = readBrowserIdentity,
  readTargets = readAppPageTargets,
  createSession = (url, options) => new CdpSession(url, options),
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
  if (typeof engineRoot !== "string" || !engineRoot.trim()) throw new TypeError("engineRoot is required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Invalid CDP port");
  if (typeof browserId !== "string" || !browserId) throw new TypeError("browserId is required");
  if (typeof browserWebSocketUrl !== "string" || !browserWebSocketUrl) {
    throw new TypeError("browserWebSocketUrl is required");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError("requestTimeoutMs must be positive");
  }
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new RangeError("operationTimeoutMs must be positive");
  }
  if (!Number.isFinite(targetPollMs) || targetPollMs <= 0) {
    throw new RangeError("targetPollMs must be positive");
  }
  if (!Number.isFinite(targetSettleMs) || targetSettleMs < 0) {
    throw new RangeError("targetSettleMs must not be negative");
  }
  if (typeof now !== "function" || typeof sleep !== "function") {
    throw new TypeError("now and sleep functions are required");
  }

  const startedAtMs = now();
  const deadlineAtMs = startedAtMs + operationTimeoutMs;
  const [identity, source] = await deadlineCall(() => Promise.all([
    readIdentity({ port, fetchImpl, timeoutMs: Math.min(requestTimeoutMs, operationTimeoutMs) }),
    readSource(join(resolve(engineRoot), ...NATIVE_SUPPRESSOR_PATH), "utf8"),
  ]), deadlineAtMs, now, "Native suppression preparation", operationTimeoutMs);
  assertBrowserIdentity(identity, browserId, browserWebSocketUrl);
  if (typeof source !== "string" || !source.trim()) throw new Error("Native quota suppressor source is empty");

  const executionSource = source;
  const results = [];
  const discoveredTargets = new Set();
  const successfulTargets = new Set();
  const attemptCounts = new Map();
  let settleDeadlineAtMs = null;

  async function injectTarget(target) {
    let session = null;
    try {
      session = createSession(target.webSocketDebuggerUrl, {
        port,
        WebSocketImpl,
        requestTimeoutMs,
      });
      const stepTimeoutMs = Math.min(requestTimeoutMs, CDP_STEP_TIMEOUT_MS);
      await deadlineCall(
        () => session.connect(),
        deadlineAtMs,
        now,
        "Native suppressor CDP connection",
        stepTimeoutMs,
      );
      await deadlineCall(
        () => session.send("Page.addScriptToEvaluateOnNewDocument", { source: executionSource }),
        deadlineAtMs,
        now,
        "Native suppressor document registration",
        stepTimeoutMs,
      );
      const evaluation = await deadlineCall(
        () => session.send("Runtime.evaluate", {
          expression: executionSource,
          awaitPromise: false,
          returnByValue: true,
          userGesture: false,
        }),
        deadlineAtMs,
        now,
        "Native suppressor current-document evaluation",
        stepTimeoutMs,
      );
      assertEvaluationSucceeded(evaluation, "Native suppressor current-document evaluation");
      return { targetId: target.id, ok: true };
    } catch (error) {
      return { targetId: target.id, ok: false, error };
    } finally {
      if (session) session.close();
    }
  }

  while (remainingMs(deadlineAtMs, now) > 0) {
    let targets = [];
    try {
      targets = await deadlineCall(
        () => readTargets({
          port,
          fetchImpl,
          timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remainingMs(deadlineAtMs, now))),
        }),
        deadlineAtMs,
        now,
        "Native suppressor target discovery",
        requestTimeoutMs,
      );
      if (!Array.isArray(targets)) throw new TypeError("Native suppressor target discovery was invalid");
    } catch {
      targets = [];
    }

    let foundNewTarget = false;
    const eligibleTargets = [];
    for (const target of targets) {
      const key = `${target.id}\u0000${target.webSocketDebuggerUrl}`;
      if (!discoveredTargets.has(key)) {
        discoveredTargets.add(key);
        foundNewTarget = true;
      }
      if (!successfulTargets.has(key) && (attemptCounts.get(key) || 0) < 2) {
        eligibleTargets.push({ target, key });
      }
    }

    if (eligibleTargets.length) {
      let identityConfirmed = false;
      try {
        const confirmedIdentity = await deadlineCall(
          () => readIdentity({
            port,
            fetchImpl,
            timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remainingMs(deadlineAtMs, now))),
          }),
          deadlineAtMs,
          now,
          "Native suppressor identity revalidation",
          requestTimeoutMs,
        );
        assertBrowserIdentity(confirmedIdentity, browserId, browserWebSocketUrl);
        identityConfirmed = true;
      } catch (error) {
        if (error && error.code === "E_BROWSER_ID_CHANGED") throw error;
      }

      if (identityConfirmed) {
        for (const { key } of eligibleTargets) {
          attemptCounts.set(key, (attemptCounts.get(key) || 0) + 1);
        }
        const batch = await Promise.all(eligibleTargets.map(({ target }) => injectTarget(target)));
        results.push(...batch);
        for (let index = 0; index < batch.length; index += 1) {
          if (batch[index].ok) successfulTargets.add(eligibleTargets[index].key);
        }
      }
    }

    if (foundNewTarget) {
      settleDeadlineAtMs = Math.min(deadlineAtMs, now() + targetSettleMs);
    }
    if (settleDeadlineAtMs !== null && now() >= settleDeadlineAtMs) break;
    const pollingDeadlineAtMs = settleDeadlineAtMs === null
      ? deadlineAtMs
      : Math.min(deadlineAtMs, settleDeadlineAtMs);
    const delayMs = Math.min(targetPollMs, remainingMs(pollingDeadlineAtMs, now));
    if (delayMs <= 0) break;
    await deadlineCall(() => sleep(delayMs), pollingDeadlineAtMs, now, "Native suppressor target wait");
  }

  return Object.freeze({
    attempted: results.length,
    injected: results.filter((result) => result.ok).length,
    results,
  });
}
