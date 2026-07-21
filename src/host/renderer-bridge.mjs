import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RENDERER_GLOBAL,
  toRendererQuotaSnapshot,
  toRendererUnavailableState,
} from "../contracts.mjs";

export class RendererBridge {
  #watcher;
  #engineRoot;
  #lastRendererCall = null;
  #revision = 0;

  constructor({ watcher, engineRoot }) {
    this.#watcher = watcher;
    this.#engineRoot = engineRoot;
  }

  async start() {
    const bootstrapSource = await readFile(join(this.#engineRoot, "src", "renderer", "panel-inject.js"), "utf8");
    return this.#watcher.start({
      bootstrapSource,
      cleanupExpression: buildCallExpression("cleanup", "watcher-closed"),
      onPageReady: ({ evaluate }) => this.#replayOnPage(evaluate),
    });
  }

  async publish(snapshot) {
    const dto = toRendererQuotaSnapshot(snapshot);
    const expression = buildCallExpression("update", dto);
    this.#remember(expression);
    return this.#watcher.evaluateAll(expression);
  }

  async publishCached(snapshot) {
    const dto = toRendererQuotaSnapshot(snapshot);
    const expression = buildCallExpression("update", {
      snapshot: dto,
      availability: "cached",
    });
    this.#remember(expression);
    return this.#watcher.evaluateAll(expression);
  }

  async unavailable(state) {
    const dto = toRendererUnavailableState(state);
    const expression = buildCallExpression("unavailable", dto);
    this.#remember(expression);
    return this.#watcher.evaluateAll(expression);
  }

  async heartbeat() {
    return this.#watcher.evaluateAll(buildCallExpression("heartbeat", Date.now()));
  }

  async status() {
    return this.#watcher.evaluateAll(buildCallExpression("status"));
  }

  async cleanup(reason = "daemon-stop") {
    await this.#watcher.evaluateAll(buildCallExpression("cleanup", reason)).catch(() => []);
    await this.#watcher.close();
  }

  #remember(expression) {
    this.#revision += 1;
    this.#lastRendererCall = { expression, revision: this.#revision };
  }

  async #replayOnPage(evaluate) {
    if (typeof evaluate !== "function") return;
    let replayedRevision = -1;
    while (this.#lastRendererCall && replayedRevision !== this.#lastRendererCall.revision) {
      const call = this.#lastRendererCall;
      await evaluate(call.expression, { awaitPromise: true, returnByValue: true });
      replayedRevision = call.revision;
    }
  }
}

export function buildCallExpression(method, argumentMarker = NO_ARGUMENT) {
  if (!/^[a-z][A-Za-z0-9]*$/.test(method)) throw new TypeError("Invalid renderer method");
  const argument = argumentMarker === NO_ARGUMENT ? "" : JSON.stringify(argumentMarker);
  return `(() => { const api = globalThis[${JSON.stringify(RENDERER_GLOBAL)}]; ` +
    `return api && typeof api.${method} === "function" ? api.${method}(${argument}) : null; })()`;
}

const NO_ARGUMENT = Symbol("no-argument");
