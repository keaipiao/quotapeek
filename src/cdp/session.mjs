import { EventEmitter } from "node:events";
import { assertLoopbackWebSocketUrl } from "./loopback.mjs";

function addSocketListener(socket, name, listener, options) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(name, listener, options);
  else if (typeof socket.on === "function") socket.on(name, listener);
  else throw new TypeError("Unsupported WebSocket implementation");
}

function removeSocketListener(socket, name, listener) {
  if (typeof socket.removeEventListener === "function") socket.removeEventListener(name, listener);
  else if (typeof socket.off === "function") socket.off(name, listener);
  else if (typeof socket.removeListener === "function") socket.removeListener(name, listener);
}

async function messageAsText(event) {
  const data = event?.data ?? event;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

export class CdpSession extends EventEmitter {
  #url;
  #port;
  #WebSocketImpl;
  #requestTimeoutMs;
  #socket;
  #nextId = 1;
  #pending = new Map();
  #connectPromise;
  #closed = false;
  #onMessage;
  #onClose;
  #onError;

  constructor(url, {
    port,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = 5_000,
  } = {}) {
    super();
    assertLoopbackWebSocketUrl(url, port);
    if (typeof WebSocketImpl !== "function") {
      throw new TypeError("A WebSocket implementation is required (Node.js 22 or newer)");
    }
    this.#url = String(url);
    this.#port = port;
    this.#WebSocketImpl = WebSocketImpl;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get url() { return this.#url; }
  get isOpen() { return Boolean(this.#socket && this.#socket.readyState === 1 && !this.#closed); }

  async connect() {
    if (this.isOpen) return this;
    if (this.#closed) throw new Error("CDP session is closed");
    if (this.#connectPromise) return this.#connectPromise;

    this.#connectPromise = new Promise((resolve, reject) => {
      const socket = new this.#WebSocketImpl(this.#url);
      this.#socket = socket;
      const onOpen = () => {
        removeSocketListener(socket, "error", onInitialError);
        removeSocketListener(socket, "close", onInitialClose);
        this.#installSocketHandlers(socket);
        resolve(this);
      };
      const onInitialError = (event) => {
        removeSocketListener(socket, "open", onOpen);
        removeSocketListener(socket, "close", onInitialClose);
        const error = event?.error instanceof Error ? event.error : new Error("Could not connect to the CDP WebSocket");
        reject(error);
      };
      const onInitialClose = () => {
        removeSocketListener(socket, "open", onOpen);
        removeSocketListener(socket, "error", onInitialError);
        this.#closed = true;
        reject(new Error("CDP WebSocket closed before opening"));
      };
      addSocketListener(socket, "open", onOpen, { once: true });
      addSocketListener(socket, "error", onInitialError, { once: true });
      addSocketListener(socket, "close", onInitialClose, { once: true });
    });
    try {
      return await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  #installSocketHandlers(socket) {
    this.#onMessage = async (event) => {
      try {
        const payload = JSON.parse(await messageAsText(event));
        if (Number.isInteger(payload.id)) {
          const pending = this.#pending.get(payload.id);
          if (!pending) return;
          this.#pending.delete(payload.id);
          clearTimeout(pending.timer);
          if (payload.error) {
            const error = new Error(payload.error.message || "CDP command failed");
            error.code = payload.error.code;
            error.data = payload.error.data;
            pending.reject(error);
          } else {
            pending.resolve(payload.result ?? {});
          }
          return;
        }
        if (typeof payload.method === "string") {
          this.emit("event", payload);
          this.emit(payload.method, payload.params ?? {}, payload.sessionId);
        }
      } catch (error) {
        this.emit("protocolError", error);
      }
    };
    this.#onClose = (event) => {
      this.#closed = true;
      this.#rejectPending(new Error("CDP WebSocket closed"));
      this.emit("close", event);
    };
    this.#onError = (event) => {
      this.emit("socketError", event?.error ?? event);
    };
    addSocketListener(socket, "message", this.#onMessage);
    addSocketListener(socket, "close", this.#onClose);
    addSocketListener(socket, "error", this.#onError);
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async send(method, params = {}, { timeoutMs = this.#requestTimeoutMs, sessionId } = {}) {
    if (typeof method !== "string" || !method) throw new TypeError("CDP method is required");
    if (!this.isOpen) await this.connect();
    if (!this.isOpen) throw new Error("CDP session is not open");

    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  close(code = 1000, reason = "codex-quota shutdown") {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("CDP session closed"));
    const socket = this.#socket;
    if (!socket) return;
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close(code, reason);
    } catch {
      // Shutdown is best-effort; the process owner check guards future sessions.
    }
  }
}
