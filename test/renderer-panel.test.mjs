import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const injectorSource = await readFile(new URL("../src/renderer/panel-inject.js", import.meta.url), "utf8");
const nativeCardSuppressorSource = await readFile(
  new URL("../src/renderer/native-card-suppress.js", import.meta.url),
  "utf8",
);

class FakeStyle {
  constructor() {
    this._cssText = "";
    this._properties = new Map();
    this._priorities = new Map();
  }

  set cssText(value) {
    this._cssText = String(value);
    for (const declaration of this._cssText.split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      const name = declaration.slice(0, separator).trim();
      const propertyValue = declaration.slice(separator + 1).trim();
      if (!name) continue;
      this.setProperty(name, propertyValue);
    }
  }

  get cssText() {
    return this._cssText;
  }

  setProperty(name, value, priority = "") {
    const property = String(name);
    const propertyValue = String(value);
    const camelName = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    this._properties.set(property, propertyValue);
    this._priorities.set(property, String(priority));
    this[camelName] = propertyValue;
  }

  getPropertyValue(name) {
    const property = String(name);
    const camelName = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return this._properties.get(property) ?? this[camelName] ?? "";
  }

  getPropertyPriority(name) {
    return this._priorities.get(String(name)) ?? "";
  }

  removeProperty(name) {
    const property = String(name);
    const camelName = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const previous = this.getPropertyValue(property);
    this._properties.delete(property);
    this._priorities.delete(property);
    delete this[camelName];
    return previous;
  }
}

class FakeElement {
  constructor(tagName, rect = null) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.className = "";
    this.id = "";
    this.textContent = "";
    this._rect = rect || { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
    this._shadow = null;
    this._rootConnected = false;
    this.clientWidth = this._rect.width;
    this.clientHeight = this._rect.height;
    this.scrollWidth = this._rect.width;
    this.scrollHeight = this._rect.height;
    this._computed = { display: "block", flexDirection: "column", position: "static", overflowY: "visible" };
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get nextSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index < 0 ? null : this.parentElement.children[index + 1] || null;
  }

  get isConnected() {
    if (this._rootConnected) return true;
    return Boolean(this.parentElement && this.parentElement.isConnected);
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.parentNode = this;
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentElement) child.parentElement.removeChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error("Reference is not a child");
    this.children.splice(index, 0, child);
    child.parentElement = this;
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("Child is not attached");
    this.children.splice(index, 1);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }

  contains(element) {
    if (element === this) return true;
    return this.children.some((child) => child.contains(element));
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  attachShadow() {
    this._shadow = new FakeElement("shadow-root", this._rect);
    this._shadow._rootConnected = true;
    return this._shadow;
  }

  querySelectorAll(selector) {
    const descendants = [];
    const visit = (node) => {
      for (const child of node.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    if (selector === "*") return descendants;
    return descendants.filter((element) => matchesSelector(element, selector));
  }
}

function matchesSelector(element, selector) {
  const tag = element.tagName.toLowerCase();
  if (selector === "footer") return tag === "footer";
  if (selector === "[role=\"contentinfo\"]") return element.getAttribute("role") === "contentinfo";
  if (selector === "[role=\"status\"][aria-live=\"polite\"]") {
    return element.getAttribute("role") === "status" && element.getAttribute("aria-live") === "polite";
  }
  if (selector === "[data-sidebar-footer]") return element.hasAttribute("data-sidebar-footer");
  if (selector === "[data-slot]") return element.hasAttribute("data-slot");
  if (selector === "[data-testid]") return element.hasAttribute("data-testid");
  if (selector === "button[aria-haspopup=\"menu\"]") {
    return tag === "button" && element.getAttribute("aria-haspopup") === "menu";
  }
  if (selector === "[role=\"button\"][aria-haspopup=\"menu\"]") {
    return element.getAttribute("role") === "button" && element.getAttribute("aria-haspopup") === "menu";
  }
  return false;
}

function textTree(element) {
  return [element.textContent, ...element.children.map(textTree)].join(" ");
}

function findTree(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const match = findTree(child, predicate);
    if (match) return match;
  }
  return null;
}

function findAllTree(element, predicate, matches = []) {
  if (predicate(element)) matches.push(element);
  for (const child of element.children) findAllTree(child, predicate, matches);
  return matches;
}

function rect(top, bottom, width = 260, left = 0) {
  return { top, bottom, left, right: left + width, width, height: bottom - top };
}

function createEnvironment(options = {}) {
  let clock = options.clock ?? 1_800_000_000_000;
  let shellVisible = options.shellReady !== false;
  const root = new FakeElement("html", rect(0, 800));
  root._rootConnected = true;
  root.setAttribute("lang", options.htmlLanguage ?? "en");
  const body = new FakeElement("body", rect(0, 800));
  root.appendChild(body);
  const main = new FakeElement("main", rect(0, 800, 900, 260));
  main.className = "main-surface";
  body.appendChild(main);
  const composer = new FakeElement("div", rect(700, 780, 700, 300));
  composer.className = "composer-surface-chrome";
  main.appendChild(composer);
  const surfaceFixtures = [];

  function createSidebarSurface(kind = "docked", overrides = {}) {
    const sidebarRect = overrides.sidebarRect ?? options.sidebarRect ?? rect(0, 800);
    const sidebar = new FakeElement("aside", sidebarRect);
    if (kind === "floating") {
      sidebar.setAttribute("data-testid", "app-shell-floating-left-panel");
    } else {
      sidebar.className = "app-shell-left-panel";
    }
    sidebar.clientWidth = sidebarRect.width;
    sidebar.scrollWidth = sidebarRect.width;

    const layout = new FakeElement("div", rect(0, 800));
    layout._computed = { display: "flex", flexDirection: "column", position: "static", overflowY: "visible" };
    sidebar.appendChild(layout);
    const scroller = new FakeElement("nav", rect(60, 700));
    scroller.setAttribute("data-app-action-sidebar-scroll", "");
    scroller._computed = { display: "block", flexDirection: "column", position: "static", overflowY: "auto" };
    scroller.clientHeight = 640;
    scroller.scrollHeight = 1_400;
    layout.appendChild(scroller);
    const footerTop = overrides.footerTop ?? options.footerTop ?? 760;
    const footer = new FakeElement("footer", rect(footerTop, 800));
    if (overrides.stickyFooter ?? options.stickyFooter) footer._computed.position = "sticky";
    footer.setAttribute("role", "contentinfo");
    footer.setAttribute("data-sidebar-footer", "");
    layout.appendChild(footer);
    const accountButton = new FakeElement("button", rect(768, 796, 236, 12));
    if ((overrides.menuTrigger ?? options.menuTrigger) !== false) {
      accountButton.setAttribute("aria-haspopup", "menu");
    }
    if (overrides.identityMarker ?? options.identityMarker) {
      accountButton.setAttribute("data-testid", "sidebar-account-profile");
    }
    accountButton.setAttribute("aria-expanded", "false");
    footer.appendChild(accountButton);
    return { kind, sidebar, layout, scroller, footer, accountButton };
  }

  function attachInitialSurface(kind) {
    if (kind === "none") return null;
    const fixture = createSidebarSurface(kind);
    surfaceFixtures.push(fixture);
    body.appendChild(fixture.sidebar);
    return fixture;
  }

  const initialSurface = attachInitialSurface(options.initialSurface ?? "docked");
  const sidebar = initialSurface?.sidebar ?? null;
  const layout = initialSurface?.layout ?? null;
  const scroller = initialSurface?.scroller ?? null;
  const footer = initialSurface?.footer ?? null;
  const accountButton = initialSurface?.accountButton ?? null;

  const intervals = [];
  const timeouts = [];
  const observers = [];
  const resizeObservers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, config) {
      this.target = target;
      this.config = config;
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.targets = [];
      resizeObservers.push(this);
    }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }

  const fakeDocument = {
    documentElement: root,
    body,
    readyState: options.readyState ?? "complete",
    createElement(tagName) {
      const element = new FakeElement(tagName);
      if (tagName === "section") {
        element._rect = options.hostRect || rect(700, 760);
        element.clientWidth = element._rect.width;
        element.clientHeight = element._rect.height;
        element.scrollWidth = element._rect.width;
        element.scrollHeight = element._rect.height;
      }
      return element;
    },
    querySelector(selector) {
      if (!shellVisible) return null;
      if (selector === "main.main-surface") return main.isConnected ? main : null;
      if (selector === ".composer-surface-chrome") return composer.isConnected ? composer : null;
      if (selector === "[role=\"main\"]") return null;
      if (selector === "aside.app-shell-left-panel") {
        return surfaceFixtures.find((fixture) => fixture.kind === "docked" && fixture.sidebar.isConnected)?.sidebar ?? null;
      }
      if (selector === "aside[data-testid=\"app-shell-floating-left-panel\"]") {
        return surfaceFixtures.find((fixture) => fixture.kind === "floating" && fixture.sidebar.isConnected)?.sidebar ?? null;
      }
      return null;
    },
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    removeEventListener(name, callback) {
      if (documentListeners.get(name) === callback) documentListeners.delete(name);
    },
  };

  class ClockDate extends Date {
    static now() { return clock; }
  }

  const language = options.language ?? "zh-CN";
  const window = {
    document: fakeDocument,
    location: { protocol: options.protocol ?? "app:" },
    navigator: {
      language,
      languages: options.languages ?? [language],
    },
    Date: ClockDate,
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    getComputedStyle(element) {
      if (element.id === "codex-quota-panel") {
        return { display: "block", flexDirection: "column", position: "static", overflowY: "hidden" };
      }
      const computed = element._computed || { display: "block", flexDirection: "column", position: "static", overflowY: "visible" };
      return {
        ...computed,
        display: element.style.display || computed.display,
        marginBottom: element.style.marginBottom || computed.marginBottom || "0px",
        paddingBottom: element.style.paddingBottom || computed.paddingBottom || "0px",
      };
    },
    setInterval(callback, milliseconds) {
      const handle = { callback, milliseconds, active: true };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle) { if (handle) handle.active = false; },
    setTimeout(callback, milliseconds) {
      const handle = { callback, milliseconds, active: true };
      timeouts.push(handle);
      return handle;
    },
    clearTimeout(handle) { if (handle) handle.active = false; },
    requestAnimationFrame(callback) { callback(); },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    removeEventListener(name, callback) {
      if (windowListeners.get(name) === callback) windowListeners.delete(name);
    },
  };

  if (options.reactLocale !== undefined) {
    const intlContext = {};
    const provider = {
      type: intlContext,
      memoizedProps: {
        value: {
          locale: options.reactLocale,
          messages: options.reactMessages ?? { ready: "ready" },
          formatMessage() {},
        },
      },
      child: null,
      sibling: null,
    };
    window.__REACT_INTL_CONTEXT__ = intlContext;
    window.__codexRoot = {
      _internalRoot: {
        current: { type: null, memoizedProps: null, child: provider, sibling: null },
      },
    };
  }

  const context = vm.createContext({ window, Date: ClockDate, Intl, console });
  const evaluate = () => new vm.Script(injectorSource).runInContext(context);
  function notifyRootMutation(records) {
    const observer = observers.find((entry) => !entry.disconnected && entry.target === root);
    if (observer) observer.callback(records);
    return observer;
  }
  function attachSurface(kind = "docked", overrides = {}) {
    const fixture = createSidebarSurface(kind, overrides);
    surfaceFixtures.push(fixture);
    body.appendChild(fixture.sidebar);
    notifyRootMutation([{ addedNodes: [fixture.sidebar], removedNodes: [] }]);
    return fixture;
  }
  function detachSurface(fixture = initialSurface) {
    if (!fixture?.sidebar?.parentElement) return false;
    fixture.sidebar.parentElement.removeChild(fixture.sidebar);
    notifyRootMutation([{ addedNodes: [], removedNodes: [fixture.sidebar] }]);
    return true;
  }
  return {
    window,
    root,
    sidebar,
    layout,
    scroller,
    footer,
    accountButton,
    intervals,
    timeouts,
    observers,
    resizeObservers,
    surfaceFixtures,
    evaluate,
    attachSurface,
    detachSurface,
    notifyRootMutation,
    advance(milliseconds) { clock += milliseconds; },
    revealShell() { shellVisible = true; },
    dispatchDocument(name) {
      const callback = documentListeners.get(name);
      if (callback) {
        documentListeners.delete(name);
        fakeDocument.readyState = "complete";
        callback();
      }
    },
    dispatchWindow(name) {
      const callback = windowListeners.get(name);
      if (callback) callback();
    },
  };
}

function snapshot(fetchedAtMs) {
  return {
    schemaVersion: 1,
    fetchedAtMs,
    buckets: [
      {
        id: "codex",
        name: null,
        windows: [
          { kind: "primary", usedPercent: 25, remainingPercent: 75, durationMinutes: 300, resetsAtMs: fetchedAtMs + 3_600_000 },
          { kind: "secondary", usedPercent: 60, remainingPercent: 40, durationMinutes: 10_080, resetsAtMs: fetchedAtMs + 86_400_000 },
        ],
      },
      {
        id: "codex_bengalfox",
        name: "GPT-5.3-Codex-Spark",
        windows: [
          { kind: "primary", usedPercent: 10, remainingPercent: 90, durationMinutes: 1_440, resetsAtMs: fetchedAtMs + 7_200_000 },
        ],
      },
    ],
  };
}

test("native-card suppression permanently covers docked, floating, and fixed Codex surfaces", () => {
  const root = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      element.parentNode = this;
      return element;
    },
    removeChild(element) {
      this.children.splice(this.children.indexOf(element), 1);
      element.parentNode = null;
    },
  };
  const document = {
    head: root,
    documentElement: root,
    createElement: () => ({ id: "", textContent: "", parentNode: null }),
    getElementById: (id) => root.children.find((element) => element.id === id) || null,
  };
  const window = {
    document,
    location: { protocol: "app:" },
  };
  const context = vm.createContext({ window });
  const result = new vm.Script(nativeCardSuppressorSource).runInContext(context);
  const style = root.children[0];

  assert.equal(result.active, true);
  assert.equal(result.reason, null);
  assert.equal(style.id, "codex-quota-native-card-suppressor");
  assert.match(style.textContent, /aside\.app-shell-left-panel/);
  assert.match(style.textContent, /aside\[data-testid="app-shell-floating-left-panel"\]/);
  assert.match(style.textContent, /div\.pointer-events-none\.fixed\[class\*="spacing-token-sidebar"\]/);
  assert.match(style.textContent, /role="status"/);
  assert.match(style.textContent, /> progress\[max="100"\]\[value\]/);
  assert.match(style.textContent, /button\[type="button"\]\.no-drag/);
  assert.doesNotMatch(style.textContent, /usage|quota|remaining|额度|%/i);
  assert.doesNotMatch(
    nativeCardSuppressorSource,
    /setTimeout|clearTimeout|setInterval|clearInterval|SELF_CLEANUP|deadline|expiresAt|panelBlockReason/,
  );
  const second = new vm.Script(nativeCardSuppressorSource).runInContext(context);
  assert.equal(second.active, true);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0], style);

  window.__CODEX_QUOTA_NATIVE_CARD_SUPPRESSOR__.cleanup("test");
  assert.equal(root.children.length, 0);
  assert.equal(window.__CODEX_QUOTA_NATIVE_CARD_SUPPRESSOR__, undefined);
});

test("native-card suppression installs as soon as a document root appears before DOMContentLoaded", () => {
  const root = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      element.parentNode = this;
      return element;
    },
    removeChild(element) {
      this.children.splice(this.children.indexOf(element), 1);
      element.parentNode = null;
    },
  };
  let readyHandler = null;
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() { this.disconnected = true; }
  }
  const document = {
    head: null,
    documentElement: null,
    createElement: () => ({ id: "", textContent: "", parentNode: null }),
    getElementById: (id) => root.children.find((element) => element.id === id) || null,
    addEventListener(name, callback) { if (name === "DOMContentLoaded") readyHandler = callback; },
    removeEventListener(name, callback) {
      if (name === "DOMContentLoaded" && readyHandler === callback) readyHandler = null;
    },
  };
  const window = {
    document,
    location: { protocol: "app:" },
    MutationObserver: FakeMutationObserver,
  };
  const initial = new vm.Script(nativeCardSuppressorSource).runInContext(vm.createContext({ window }));
  assert.equal(initial.active, false);
  assert.equal(initial.pending, true);
  assert.equal(typeof readyHandler, "function");
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, document);

  document.documentElement = root;
  observers[0].callback([{ type: "childList" }]);
  assert.equal(window.__CODEX_QUOTA_NATIVE_CARD_SUPPRESSOR__.status().active, true);
  assert.equal(root.children[0].id, "codex-quota-native-card-suppressor");
  assert.equal(observers[0].disconnected, true);
  assert.equal(readyHandler, null);
  window.__CODEX_QUOTA_NATIVE_CARD_SUPPRESSOR__.cleanup("test");
  assert.equal(root.children.length, 0);
});

test("panel controller contains no translated or structural native-card matcher", () => {
  assert.doesNotMatch(
    injectorSource,
    /nativeLowUsageAlertScore|nativeQuotaScore|findNativeQuota|nativeQuotaHidden|subtreeText|NATIVE_HIDDEN|EARLY_NATIVE/,
  );
  assert.doesNotMatch(injectorSource, /usage\s+remaining|dismiss\s+usage\s+alert/i);
  assert.doesNotMatch(injectorSource, /role="status"[\s\S]*rounded-2xl[\s\S]*progress/);
});

test("injector evaluates to a structured result and mounts in normal flow before the account footer", () => {
  const environment = createEnvironment();
  environment.scroller.scrollTop = 760;
  const result = environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;

  assert.equal(result.mounted, true);
  assert.equal(result.geometryValidated, true);
  assert.equal(typeof api.mount, "function");
  assert.equal(typeof api.update, "function");
  assert.equal(typeof api.unavailable, "function");
  assert.equal(typeof api.heartbeat, "function");
  assert.equal(typeof api.status, "function");
  assert.equal(typeof api.cleanup, "function");

  const host = environment.layout.children.at(-2);
  assert.equal(host.id, "codex-quota-panel");
  assert.equal(host.nextSibling, environment.footer);
  assert.equal(host.style.position, "static");
  assert.equal(host.style.flex, "0 0 auto");
  assert.equal(host.style.zIndex, "auto");
  assert.equal(host.style.pointerEvents, "none");
  assert.equal(result.scrollDocked, true);
  assert.equal(environment.scroller.style.marginBottom, "var(--sidebar-footer-height)");
  assert.equal(environment.scroller.style.paddingBottom, "var(--padding-row-x, 8px)");
  assert.equal(environment.scroller.style.getPropertyPriority("padding-bottom"), "important");
  assert.equal(environment.scroller.style.getPropertyValue("--sidebar-scroll-footer-edge"), "100%");
  assert.equal(environment.scroller.style.getPropertyPriority("--sidebar-scroll-footer-edge"), "important");
  assert.equal(environment.scroller.scrollTop, 760);
  assert.equal(result.freshness, "loading");
  assert.match(textTree(host._shadow), /正在读取额度/);
});

test("Codex React-Intl locale overrides navigator and the incorrect html lang", () => {
  const english = createEnvironment({
    reactLocale: "en-US",
    language: "zh-CN",
    htmlLanguage: "zh-CN",
  });
  const englishResult = english.evaluate();
  const englishHost = english.layout.children.at(-2);
  assert.equal(englishResult.locale, "en");
  assert.equal(englishResult.localeSource, "codex-react-intl");
  assert.equal(englishHost.getAttribute("lang"), "en");
  assert.equal(englishHost.getAttribute("aria-label"), "Codex usage limits");
  assert.match(textTree(englishHost._shadow), /Loading usage limits/);
  assert.doesNotMatch(textTree(englishHost._shadow), /正在读取额度/);

  const chinese = createEnvironment({
    reactLocale: "zh-CN",
    language: "en-US",
    htmlLanguage: "en",
  });
  const chineseResult = chinese.evaluate();
  const chineseHost = chinese.layout.children.at(-2);
  assert.equal(chineseResult.locale, "zh-CN");
  assert.equal(chineseHost.getAttribute("lang"), "zh-CN");
  assert.match(textTree(chineseHost._shadow), /正在读取额度/);
});

test("an unloaded non-English Codex message pack mirrors the visible English fallback", () => {
  const environment = createEnvironment({
    reactLocale: "zh-CN",
    reactMessages: {},
    language: "zh-CN",
  });
  const result = environment.evaluate();
  const host = environment.layout.children.at(-2);
  assert.equal(result.locale, "en");
  assert.equal(result.localeSource, "codex-react-intl");
  assert.match(textTree(host._shadow), /Loading usage limits/);
});

test("Traditional Chinese locales use Traditional Chinese panel and accessibility text", () => {
  const environment = createEnvironment({ reactLocale: "zh-Hant", language: "en-US" });
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  const host = environment.layout.children.at(-2);
  const progress = findTree(host._shadow, (element) => element.getAttribute("role") === "progressbar");
  assert.equal(api.status().locale, "zh-TW");
  const regional = createEnvironment({ reactLocale: "zh-HK-u-nu-latn", language: "en-US" });
  regional.evaluate();
  assert.equal(regional.window.__CODEX_QUOTA_PANEL__.status().locale, "zh-TW");
  assert.match(textTree(host._shadow), /Codex 通用額度/);
  assert.match(textTree(host._shadow), /剩餘 75%/);
  assert.match(textTree(host._shadow), /每週限額/);
  assert.equal(progress.getAttribute("aria-valuetext"), "剩餘 75%");
});

test("unknown locales fall back to English and English covers every quota state", () => {
  const environment = createEnvironment({ language: "de-DE", htmlLanguage: "en" });
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const host = environment.layout.children.at(-2);
  assert.equal(api.status().locale, "en");
  assert.equal(api.status().formatLocale, "de-DE");
  assert.match(textTree(host._shadow), /Loading usage limits/);

  api.update({ snapshot: snapshot(1_800_000_000_000), availability: "cached" });
  assert.match(textTree(host._shadow), /Refreshing/);
  assert.match(textTree(host._shadow), /Remaining 75\s?%/);

  api.update(snapshot(1_800_000_000_000));
  assert.match(textTree(host._shadow), /Live/);
  assert.match(textTree(host._shadow), /5-hour limit/);
  assert.match(textTree(host._shadow), /Weekly limit/);
  const progress = findTree(host._shadow, (element) => element.getAttribute("role") === "progressbar");
  assert.equal(progress.getAttribute("aria-label"), "Codex general quota, 5-hour limit");
  assert.match(progress.getAttribute("aria-valuetext"), /^75\s?% remaining$/);

  api.unavailable({ reasonCode: "E_AUTH_UNSUPPORTED" });
  assert.match(textTree(host._shadow), /Sign in to ChatGPT in Codex first/);
});

test("a live Codex locale change rerenders in place and preserves the scroll bottom", () => {
  const environment = createEnvironment({ reactLocale: "zh-CN", language: "en-US" });
  environment.scroller.scrollTop = 760;
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  const host = environment.layout.children.at(-2);
  const provider = environment.window.__codexRoot._internalRoot.current.child;
  provider.memoizedProps.value.locale = "en-US";
  provider.memoizedProps.value.messages = { ready: "ready" };

  const localeInterval = environment.intervals.find((entry) => entry.active && entry.milliseconds === 5_000);
  assert.ok(localeInterval);
  localeInterval.callback();

  assert.equal(environment.layout.children.at(-2), host);
  assert.equal(api.status().locale, "en");
  assert.match(textTree(host._shadow), /Codex usage limits/);
  assert.match(textTree(host._shadow), /Remaining 75%/);
  assert.equal(environment.scroller.scrollTop, 760);

  api.cleanup();
  assert.equal(localeInterval.active, false);
});

test("a cached snapshot is shown immediately as refreshing until live data arrives", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const cached = api.update({ snapshot: snapshot(1_800_000_000_000), availability: "cached" });
  const host = environment.layout.children.at(-2);
  assert.equal(cached.freshness, "stale");
  assert.equal(cached.cached, true);
  assert.match(textTree(host._shadow), /正在刷新/);
  assert.match(textTree(host._shadow), /剩余 75%/);

  const live = api.update(snapshot(1_800_000_000_000));
  assert.equal(live.freshness, "fresh");
  assert.equal(live.cached, false);
  assert.match(textTree(host._shadow), /实时/);
});

test("update renders only the general Codex bucket with user-facing limit labels", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const value = snapshot(1_800_000_000_000);
  value.buckets.reverse();
  const status = api.update(value);
  const host = environment.layout.children.at(-2);
  const renderedText = textTree(host._shadow);

  assert.equal(status.freshness, "fresh");
  assert.equal(status.bucketCount, 2);
  assert.equal(status.displayedBucketCount, 1);
  assert.match(renderedText, /Codex 通用额度/);
  assert.doesNotMatch(renderedText, /GPT-5\.3-Codex-Spark|codex_bengalfox/);
  assert.doesNotMatch(renderedText, /主窗口|次窗口/);
  assert.match(renderedText, /剩余 75%/);
  assert.match(renderedText, /5 小时限额/);
  assert.match(renderedText, /每周限额/);
  const progress = findTree(host._shadow, (element) => element.getAttribute("role") === "progressbar");
  assert.ok(progress);
  assert.equal(progress.getAttribute("aria-valuenow"), "75");
  assert.equal(progress.getAttribute("aria-valuetext"), "剩余 75%");
});

test("the general quota header shows a known plan beside the title without replacing freshness", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const value = snapshot(1_800_000_000_000);
  value.buckets[0].planType = "pro";
  value.buckets[1].planType = "plus";
  api.update(value);
  const host = environment.layout.children.at(-2);
  const renderedText = textTree(host._shadow);

  assert.match(renderedText, /Codex 通用额度/);
  assert.match(renderedText, /Pro 20×/);
  assert.doesNotMatch(renderedText, /Plus/);
  assert.match(renderedText, /实时/);

  api.update({ snapshot: value, availability: "cached" });
  const cachedText = textTree(host._shadow);
  assert.match(cachedText, /正在刷新/);
  assert.doesNotMatch(cachedText, /Pro 20×/);

  api.update(value);
  assert.match(textTree(host._shadow), /Pro 20×/);

  environment.advance(4 * 60 * 1000);
  const countdownInterval = environment.intervals.find((entry) => entry.milliseconds === 30_000 && entry.active);
  countdownInterval.callback();
  assert.match(textTree(host._shadow), /Pro 20×/);
  assert.match(textTree(host._shadow), /可能已过期/);

  environment.advance(12 * 60 * 1000);
  countdownInterval.callback();
  assert.doesNotMatch(textTree(host._shadow), /Pro 20×/);
  assert.match(textTree(host._shadow), /暂不可用/);
});

test("plan labels are allow-listed and hide internal or unknown plan types", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const { formatPlanLabel } = environment.window.__CODEX_QUOTA_PANEL__.__test;

  assert.equal(formatPlanLabel("free"), "Free");
  assert.equal(formatPlanLabel("go"), "Go");
  assert.equal(formatPlanLabel("plus"), "Plus");
  assert.equal(formatPlanLabel("prolite"), "Pro 5×");
  assert.equal(formatPlanLabel("pro"), "Pro 20×");
  assert.equal(formatPlanLabel("team"), "Team");
  assert.equal(formatPlanLabel("business"), "Business");
  assert.equal(formatPlanLabel("enterprise"), "Enterprise");
  assert.equal(formatPlanLabel("edu"), "Edu");
  assert.equal(formatPlanLabel("self_serve_business_usage_based"), null);
  assert.equal(formatPlanLabel("enterprise_cbp_usage_based"), null);
  assert.equal(formatPlanLabel("unknown"), null);
  assert.equal(formatPlanLabel("future-plan"), null);
  assert.equal(formatPlanLabel(null), null);
});

test("a model-specific bucket is never used as a fallback for general quota", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const value = snapshot(1_800_000_000_000);
  value.buckets = [value.buckets[1]];
  api.update(value);
  const host = environment.layout.children.at(-2);
  const renderedText = textTree(host._shadow);
  assert.match(renderedText, /通用额度暂不可用/);
  assert.doesNotMatch(renderedText, /GPT-5\.3-Codex-Spark|剩余 90%/);
  assert.equal(api.status().displayedBucketCount, 0);
});

test("general bucket selection fails closed on ambiguous unnamed buckets", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const hooks = environment.window.__CODEX_QUOTA_PANEL__.__test;
  const window = { kind: "primary", remainingPercent: 50 };

  const namedCodex = { id: "codex", name: "Codex", windows: [window] };
  const unnamedUnknown = { id: "future-model", name: null, windows: [window] };
  assert.equal(hooks.selectGeneralBucket([unnamedUnknown, namedCodex]), namedCodex);
  assert.equal(hooks.selectGeneralBucket([
    unnamedUnknown,
    { id: "another-future-model", name: null, windows: [window] },
  ]), null);

  const raw = snapshot(1_800_000_000_000);
  const general = raw.buckets[0];
  raw.buckets = Array.from({ length: 31 }, (_, index) => ({
    id: `future-${index}`,
    name: `Future ${index}`,
    windows: general.windows,
  }));
  raw.buckets.push(general);
  const normalized = hooks.normalizeSnapshot(raw);
  assert.equal(normalized.buckets.length, 32);
  assert.equal(hooks.selectGeneralBucket(normalized.buckets).id, "codex");
});

test("remaining quota uses explicit healthy, warning, and critical thresholds", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const hooks = api.__test;
  assert.equal(hooks.remainingTone(100), "healthy");
  assert.equal(hooks.remainingTone(51), "healthy");
  assert.equal(hooks.remainingTone(50), "warning");
  assert.equal(hooks.remainingTone(21), "warning");
  assert.equal(hooks.remainingTone(20), "warning");
  assert.equal(hooks.remainingTone(19.9), "critical");
  assert.equal(hooks.remainingTone(0), "critical");

  api.update(snapshot(1_800_000_000_000));
  const host = environment.layout.children.at(-2);
  const windows = findAllTree(host._shadow, (element) => element.className === "quota-window");
  assert.deepEqual(windows.map((element) => element.getAttribute("data-level")), ["healthy", "warning"]);
  const styleText = host._shadow.children[0].textContent;
  assert.match(styleText, /--quota-warning:[^;]*#e0a100/);
  assert.doesNotMatch(styleText, /--quota-warning:[^;]*editor-warning-foreground/);
  assert.match(styleText, /--quota-critical:[^;]*#c2413b/);
  assert.match(styleText, /data-level="warning"[^}]*var\(--quota-warning\)/s);
  assert.match(styleText, /data-level="critical"[^}]*var\(--quota-critical\)/s);
});

test("limit labels describe the period instead of exposing primary and secondary protocol fields", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const hooks = environment.window.__CODEX_QUOTA_PANEL__.__test;
  assert.equal(hooks.formatLimitLabel(300), "5 小时限额");
  assert.equal(hooks.formatLimitLabel(1_440), "每日限额");
  assert.equal(hooks.formatLimitLabel(10_080), "每周限额");
  assert.equal(hooks.formatLimitLabel(43_200), "每月限额");
  assert.equal(hooks.formatLimitLabel(null), "使用限额");
});

test("an update with no sidebar keeps the latest quota snapshot ready for a later surface", () => {
  const environment = createEnvironment({ initialSurface: "none" });
  const initial = environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const fetchedAtMs = 1_800_000_000_000;

  assert.equal(initial.mounted, false);
  assert.equal(initial.reason, "sidebar-not-present");
  assert.equal(initial.lifecycleObserved, true);

  const updated = api.update(snapshot(fetchedAtMs));
  assert.equal(updated.mounted, false);
  assert.equal(updated.reason, "sidebar-not-present");
  assert.equal(updated.sidebarSurface, null);
  assert.equal(updated.bucketCount, 2);
  assert.equal(updated.displayedBucketCount, 1);
  assert.equal(updated.fetchedAtMs, fetchedAtMs);
  assert.equal(updated.freshness, "fresh");
});

test("a floating sidebar mutation mounts synchronously with the retained 75% snapshot", () => {
  const environment = createEnvironment({ initialSurface: "none" });
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));

  const floating = environment.attachSurface("floating");
  const status = api.status();
  const host = floating.layout.children.at(-2);

  assert.equal(status.mounted, true);
  assert.equal(status.sidebarSurface, "floating");
  assert.equal(host.id, "codex-quota-panel");
  assert.equal(host.nextSibling, floating.footer);
  assert.match(textTree(host._shadow), /75%/);
});

test("settings-style sidebar detach and reattach restores the retained panel immediately", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  const originalHost = environment.layout.children.at(-2);

  assert.equal(environment.detachSurface(), true);
  const detached = api.status();
  assert.equal(detached.mounted, false);
  assert.equal(detached.reason, "sidebar-not-present");
  assert.equal(detached.bucketCount, 2);
  assert.equal(originalHost.isConnected, false);

  const restoredSurface = environment.attachSurface("docked");
  const restored = api.status();
  const restoredHost = restoredSurface.layout.children.at(-2);

  assert.equal(restored.mounted, true);
  assert.equal(restored.sidebarSurface, "docked");
  assert.equal(restored.bucketCount, 2);
  assert.equal(restoredHost.id, "codex-quota-panel");
  assert.equal(restoredHost.nextSibling, restoredSurface.footer);
  assert.match(textTree(restoredHost._shadow), /75%/);
});

test("an externally removed current host is synchronously remounted by the root observer", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  const removedHost = environment.layout.children.at(-2);

  environment.layout.removeChild(removedHost);
  environment.notifyRootMutation([{
    type: "childList",
    target: environment.layout,
    addedNodes: [],
    removedNodes: [removedHost],
  }]);

  const status = api.status();
  const replacementHost = environment.layout.children.at(-2);
  assert.equal(status.mounted, true);
  assert.notEqual(replacementHost, removedHost);
  assert.equal(replacementHost.id, "codex-quota-panel");
  assert.equal(replacementHost.nextSibling, environment.footer);
  assert.equal(environment.layout.children.filter((element) => element.id === "codex-quota-panel").length, 1);
  assert.match(textTree(replacementHost._shadow), /75%/);
});

test("an existing zero-size floating sidebar mounts synchronously when an attribute makes it visible", () => {
  const environment = createEnvironment({
    initialSurface: "floating",
    sidebarRect: rect(0, 0, 0),
  });
  const initial = environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  const [floating] = environment.surfaceFixtures;

  assert.equal(initial.mounted, false);
  assert.equal(api.status().reason, "sidebar-not-present");
  assert.equal(environment.surfaceFixtures.length, 1);

  floating.sidebar._rect = rect(0, 800);
  floating.sidebar.clientWidth = 260;
  floating.sidebar.scrollWidth = 260;
  floating.sidebar.className = "is-visible";
  environment.notifyRootMutation([{
    type: "attributes",
    target: floating.sidebar,
    attributeName: "class",
    oldValue: "",
  }]);

  const status = api.status();
  const host = floating.layout.children.at(-2);
  assert.equal(status.mounted, true);
  assert.equal(status.sidebarSurface, "floating");
  assert.equal(host.id, "codex-quota-panel");
  assert.equal(host.nextSibling, floating.footer);
  assert.match(textTree(host._shadow), /75%/);
});

test("cleanup does not overwrite an externally replaced scroll fade edge", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  environment.scroller.style.setProperty("--sidebar-scroll-footer-edge", "95%", "important");

  api.cleanup();

  assert.equal(environment.scroller.style.getPropertyValue("--sidebar-scroll-footer-edge"), "95%");
  assert.equal(environment.scroller.style.getPropertyPriority("--sidebar-scroll-footer-edge"), "important");
});

test("unavailable clears quota values and exposes an unavailable status", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  const result = api.unavailable({ reasonCode: "E_APP_SERVER_CLOSED", atMs: 1_800_000_100_000 });
  const host = environment.layout.children.at(-2);
  const renderedText = textTree(host._shadow);

  assert.equal(result.freshness, "unavailable");
  assert.equal(result.bucketCount, 0);
  assert.match(renderedText, /暂时无法连接 Codex 额度服务/);
  assert.doesNotMatch(renderedText, /剩余 75%/);
  assert.equal(findTree(host._shadow, (element) => element.getAttribute("role") === "progressbar"), null);
});

test("an aging snapshot transitions from fresh to stale and then hides unavailable values", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  environment.advance(4 * 60 * 1000);
  assert.equal(api.status().freshness, "stale");
  const countdownInterval = environment.intervals.find((entry) => entry.milliseconds === 30_000 && entry.active);
  countdownInterval.callback();
  let host = environment.layout.children.at(-2);
  assert.match(textTree(host._shadow), /可能已过期/);
  assert.match(textTree(host._shadow), /剩余 75%/);

  environment.advance(12 * 60 * 1000);
  countdownInterval.callback();
  host = environment.layout.children.at(-2);
  assert.equal(api.status().freshness, "unavailable");
  assert.match(textTree(host._shadow), /暂不可用/);
  assert.doesNotMatch(textTree(host._shadow), /剩余 75%/);
});

test("normalization clamps percentages and rejects malformed snapshots", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const hooks = environment.window.__CODEX_QUOTA_PANEL__.__test;
  assert.equal(hooks.normalizeSnapshot(null), null);
  assert.equal(hooks.normalizeSnapshot({ schemaVersion: 2, fetchedAtMs: 1, buckets: [] }), null);
  const normalized = hooks.normalizeSnapshot({
    schemaVersion: 1,
    fetchedAtMs: 100,
    buckets: [{
      id: "codex",
      windows: [
        { kind: "primary", usedPercent: -20, durationMinutes: 300 },
        { kind: "secondary", remainingPercent: 140, durationMinutes: 1_440 },
      ],
    }],
  });
  assert.equal(normalized.buckets[0].windows[0].remainingPercent, 100);
  assert.equal(normalized.buckets[0].windows[1].remainingPercent, 100);
});

test("anchor scorer requires a unique bottom semantic candidate", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const hooks = environment.window.__CODEX_QUOTA_PANEL__.__test;
  const bottomScore = hooks.scoreAnchorMetrics({
    sidebar: rect(0, 800), anchor: rect(750, 800), parent: rect(0, 800),
    semanticScore: 42, position: "static", parentDisplay: "flex", parentDirection: "column",
  });
  const upperScore = hooks.scoreAnchorMetrics({
    sidebar: rect(0, 800), anchor: rect(100, 150), parent: rect(0, 800),
    semanticScore: 42, position: "static", parentDisplay: "flex", parentDirection: "column",
  });
  assert.ok(Number.isFinite(bottomScore));
  assert.equal(upperScore, Number.NEGATIVE_INFINITY);
  const insetFooterScore = hooks.scoreAnchorMetrics({
    sidebar: rect(0, 800), anchor: rect(680, 740), parent: rect(0, 800),
    semanticScore: 42, position: "static", parentDisplay: "flex", parentDirection: "column",
  });
  assert.ok(bottomScore - insetFooterScore >= 12);
  assert.equal(hooks.chooseUniqueScored([{ id: "a", score: 90 }, { id: "b", score: 84 }]).reason, "anchor-ambiguous");
  assert.equal(hooks.chooseUniqueScored([{ id: "a", score: 90 }, { id: "b", score: 70 }]).candidate.id, "a");
});

test("re-evaluation is idempotent and never inserts a duplicate host", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const firstApi = environment.window.__CODEX_QUOTA_PANEL__;
  const secondResult = environment.evaluate();
  const hosts = environment.layout.children.filter((element) => element.id === "codex-quota-panel");
  assert.equal(secondResult.mounted, true);
  assert.equal(environment.window.__CODEX_QUOTA_PANEL__, firstApi);
  assert.equal(hosts.length, 1);
});

test("the root lifecycle observer watches structural and visibility changes and debounces stable reconciliation", () => {
  const environment = createEnvironment();
  const initial = environment.evaluate();
  const observer = environment.observers.find((entry) => !entry.disconnected);
  assert.ok(observer);
  assert.equal(initial.lifecycleObserved, true);
  assert.equal(observer.target, environment.root);
  assert.equal(observer.config.childList, true);
  assert.equal(observer.config.subtree, true);
  assert.equal(observer.config.attributes, true);
  assert.deepEqual(
    [...observer.config.attributeFilter].sort(),
    ["aria-hidden", "class", "hidden"],
  );
  assert.deepEqual(
    Object.keys(observer.config).sort(),
    ["attributeFilter", "attributes", "childList", "subtree"],
  );
  observer.callback([{ type: "childList" }]);
  observer.callback([{ type: "childList" }]);
  const activeTimeouts = environment.timeouts.filter((entry) => entry.active && entry.milliseconds === 80);
  assert.equal(activeTimeouts.length, 1);
  assert.equal(activeTimeouts[0].milliseconds, 80);
});

test("heartbeat timeout removes the panel and disconnects its observer", () => {
  const environment = createEnvironment();
  environment.evaluate();
  environment.advance(121_000);
  const heartbeatInterval = environment.intervals.find((entry) => entry.milliseconds === 10_000);
  heartbeatInterval.callback();
  const status = environment.window.__CODEX_QUOTA_PANEL__.status();
  assert.equal(status.mounted, false);
  assert.equal(status.cleaned, true);
  assert.equal(status.reason, "heartbeat-timeout");
  assert.equal(environment.layout.children.some((element) => element.id === "codex-quota-panel"), false);
  assert.ok(environment.observers.every((observer) => observer.disconnected));
});

test("a later heartbeat remounts after timeout and restarts cleanup timers", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  environment.advance(121_000);
  environment.intervals.find((entry) => entry.milliseconds === 10_000 && entry.active).callback();
  const recovered = api.heartbeat();
  assert.equal(recovered.mounted, true);
  assert.equal(recovered.cleaned, false);
  assert.ok(environment.intervals.filter((entry) => entry.milliseconds === 10_000 && entry.active).length === 1);
});

test("failed post-mount geometry validation removes the panel", () => {
  const environment = createEnvironment({ hostRect: rect(730, 790), footerTop: 760 });
  const result = environment.evaluate();
  assert.equal(result.mounted, false);
  assert.equal(result.geometryValidated, false);
  assert.equal(result.reason, "panel-overlaps-account-footer");
  assert.equal(environment.layout.children.some((element) => element.id === "codex-quota-panel"), false);
});

test("bootstrap rejects a wrong protocol and treats a missing sidebar as transient", () => {
  const wrongProtocol = createEnvironment({ protocol: "https:" });
  const wrongProtocolResult = wrongProtocol.evaluate();
  assert.equal(wrongProtocolResult.mounted, false);
  assert.equal(wrongProtocolResult.reason, "protocol-not-allowed");
  assert.equal(wrongProtocol.layout.children.some((element) => element.id === "codex-quota-panel"), false);

  const missingShell = createEnvironment({ shellReady: false });
  missingShell.evaluate();
  const api = missingShell.window.__CODEX_QUOTA_PANEL__;
  const waitingUpdate = api.update(snapshot(1_800_000_000_000));
  assert.equal(waitingUpdate.mounted, false);
  assert.equal(waitingUpdate.bucketCount, 2);
  assert.equal(waitingUpdate.reason, "sidebar-not-present");

  const routeChanged = createEnvironment();
  routeChanged.evaluate();
  routeChanged.window.location.protocol = "https:";
  const detached = routeChanged.window.__CODEX_QUOTA_PANEL__.update(snapshot(1_800_000_000_000));
  assert.equal(detached.mounted, false);
  assert.equal(detached.reason, "protocol-not-allowed");
  assert.equal(detached.bucketCount, 2);
});

test("bootstrap retries on DOMContentLoaded once a sidebar surface becomes visible", () => {
  const environment = createEnvironment({ shellReady: false, readyState: "loading" });
  const initial = environment.evaluate();
  assert.equal(initial.mounted, false);
  assert.equal(initial.reason, "sidebar-not-present");

  environment.revealShell();
  environment.dispatchDocument("DOMContentLoaded");
  assert.equal(environment.window.__CODEX_QUOTA_PANEL__.status().mounted, true);
  assert.equal(environment.layout.children.filter((element) => element.id === "codex-quota-panel").length, 1);
});

test("anchor semantics require an account/profile marker or menu trigger and reject sticky positioning", () => {
  const genericFooter = createEnvironment({ menuTrigger: false });
  const result = genericFooter.evaluate();
  assert.equal(result.mounted, false);
  assert.equal(result.reason, "anchor-not-found");

  const markedAccount = createEnvironment({ menuTrigger: false, identityMarker: true });
  assert.equal(markedAccount.evaluate().mounted, true);
  const hooks = markedAccount.window.__CODEX_QUOTA_PANEL__.__test;
  assert.equal(hooks.scoreAnchorMetrics({
    sidebar: rect(0, 800), anchor: rect(750, 800), parent: rect(0, 800),
    semanticScore: 100, position: "sticky", parentDisplay: "flex", parentDirection: "column",
  }), Number.NEGATIVE_INFINITY);

  const stickyFooter = createEnvironment({ stickyFooter: true });
  const stickyResult = stickyFooter.evaluate();
  assert.equal(stickyResult.mounted, false);
  assert.equal(stickyResult.reason, "anchor-not-found");
});

test("a late account anchor mounts through the bounded fast retry without waiting for heartbeat", () => {
  const environment = createEnvironment({ menuTrigger: false });
  const initial = environment.evaluate();
  assert.equal(initial.mounted, false);
  assert.equal(initial.reason, "anchor-not-found");
  const retry = environment.timeouts.find((entry) => entry.active && entry.milliseconds === 100);
  assert.ok(retry);

  environment.accountButton.setAttribute("aria-haspopup", "menu");
  environment.accountButton.setAttribute("aria-expanded", "false");
  environment.accountButton.setAttribute("data-state", "closed");
  retry.active = false;
  retry.callback();

  const recovered = environment.window.__CODEX_QUOTA_PANEL__.status();
  assert.equal(recovered.mounted, true);
  assert.equal(recovered.geometryValidated, true);
  assert.equal(environment.layout.children.filter((element) => element.id === "codex-quota-panel").length, 1);
});

test("the general bucket uses a readable stacked layout for two limit periods", () => {
  const environment = createEnvironment();
  environment.evaluate();
  environment.window.__CODEX_QUOTA_PANEL__.update(snapshot(1_800_000_000_000));
  const host = environment.layout.children.at(-2);
  const grids = findAllTree(host._shadow, (element) => element.className === "quota-windows");
  const styleText = host._shadow.children[0].textContent;

  assert.equal(grids.length, 1);
  assert.equal(grids[0].getAttribute("data-window-count"), "2");
  assert.equal(grids[0].children.length, 2);
  assert.match(styleText, /quota-windows\[data-window-count="2"\][^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.doesNotMatch(styleText, /grid-template-columns:\s*repeat\(2/);
  assert.match(styleText, /font:\s*12px\/1\.45/);
  assert.match(styleText, /margin:\s*8px 6px 7px/);
  assert.match(styleText, /padding:\s*10px 11px 11px/);
  assert.match(styleText, /max-height:\s*min\(210px, 40vh\)/);
  assert.match(styleText, /quota-progress[^}]*height:\s*5px[^}]*margin-top:\s*6px/s);
  assert.match(styleText, /@media \(forced-colors: active\)[\s\S]*background:\s*Highlight/);
  assert.equal(findAllTree(host._shadow, (element) => element.className === "quota-value-prefix").length, 2);
  assert.equal(findAllTree(host._shadow, (element) => element.className === "quota-percent").length, 2);
});

test("a quota height change preserves a user who was at the conversation-list bottom", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const hooks = environment.window.__CODEX_QUOTA_PANEL__.__test;
  environment.scroller.scrollTop = 760;
  environment.scroller.scrollHeight = 1_400;
  environment.scroller.clientHeight = 640;
  const anchor = hooks.captureBottomScrollAnchor(environment.scroller);
  assert.ok(anchor);

  environment.scroller.scrollHeight = 1_500;
  assert.equal(hooks.alignBottomScrollAnchor(anchor), true);
  assert.equal(environment.scroller.scrollTop, 860);

  environment.scroller.scrollTop = 700;
  environment.scroller.scrollHeight = 1_600;
  assert.equal(hooks.alignBottomScrollAnchor(anchor), false);
  assert.equal(environment.scroller.scrollTop, 700);
});

test("layout validation fails closed instead of silently clipping panel content", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  api.update(snapshot(1_800_000_000_000));
  const host = environment.layout.children.at(-2);
  const panel = findTree(host._shadow, (element) => element.className === "quota-panel");
  panel.clientHeight = 120;
  panel.scrollHeight = 151;

  const result = api.heartbeat();
  assert.equal(result.mounted, false);
  assert.equal(result.reason, "panel-content-vertically-clipped");
});

test("pre-existing native sidebar overflow is tolerated unless the panel increases it", () => {
  const environment = createEnvironment();
  environment.sidebar.scrollWidth = environment.sidebar.clientWidth + 8;
  const initial = environment.evaluate();
  assert.equal(initial.mounted, true);

  environment.sidebar.scrollWidth += 3;
  const increased = environment.window.__CODEX_QUOTA_PANEL__.heartbeat();
  assert.equal(increased.mounted, false);
  assert.equal(increased.reason, "sidebar-horizontal-overflow-increased");
});

test("reserved padding cannot disguise a scrollbar track that still runs behind the panel", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const host = environment.layout.children.at(-2);
  const panel = findTree(host._shadow, (element) => element.className === "quota-panel");
  host._rect = rect(700, 760);
  host.clientWidth = 260;
  host.clientHeight = 60;
  host.scrollWidth = 260;
  host.scrollHeight = 60;
  environment.scroller._rect = rect(60, 800);
  environment.scroller._computed.paddingBottom = "54px";
  const region = {
    element: environment.scroller,
    primary: true,
    beforeClientHeight: 640,
    beforeScrollHeight: 1_400,
    beforeOverflowY: "auto",
    beforePaddingBottom: 54,
  };
  const baseline = { clientWidth: 260, scrollWidth: 260 };

  const strict = api.__test.validateLayout(
    environment.sidebar,
    environment.footer,
    host,
    [region],
    panel,
    baseline
  );
  assert.equal(strict.reason, "panel-overlaps-conversation-scroll-region");

  const settling = api.__test.validateLayout(
    environment.sidebar,
    environment.footer,
    host,
    [region],
    panel,
    baseline,
    { allowReservedBottomSettle: true }
  );
  assert.equal(settling.ok, true);
  assert.equal(settling.pending, true);

  environment.scroller.style.setProperty("padding-bottom", "120px", "important");
  const stillCovered = api.__test.validateLayout(
    environment.sidebar,
    environment.footer,
    host,
    [region],
    panel,
    baseline
  );
  assert.equal(stillCovered.ok, false);
  assert.equal(stillCovered.reason, "conversation-scrollbar-overlaps-panel");

  environment.scroller._rect = rect(60, 700);
  environment.scroller.clientHeight = 640;
  environment.scroller.style.setProperty("padding-bottom", "8px", "important");
  const docked = api.__test.validateLayout(
    environment.sidebar,
    environment.footer,
    host,
    [region],
    panel,
    baseline
  );
  assert.equal(docked.ok, true);
  assert.equal(docked.pending, false);

  region.beforeMaxScroll = 760;
  region.beforeAtBottom = false;
  environment.scroller.scrollHeight = 1_500;
  const changedRange = api.__test.validateLayout(
    environment.sidebar,
    environment.footer,
    host,
    [region],
    panel,
    baseline,
    { enforceScrollRange: true }
  );
  assert.equal(changedRange.reason, "conversation-scroll-range-changed");

  environment.scroller.scrollHeight = 1_400;
  environment.scroller.scrollTop = 700;
  region.beforeAtBottom = true;
  const settlingBottom = api.__test.validateLayout(
    environment.sidebar,
    environment.footer,
    host,
    [region],
    panel,
    baseline,
    { enforceScrollRange: true, allowReservedBottomSettle: true }
  );
  assert.equal(settlingBottom.ok, true);
  assert.equal(settlingBottom.pending, true);
  assert.equal(settlingBottom.reason, "layout-settling");

  const lostBottom = api.__test.validateLayout(
    environment.sidebar,
    environment.footer,
    host,
    [region],
    panel,
    baseline,
    { enforceScrollRange: true }
  );
  assert.equal(lostBottom.reason, "conversation-bottom-position-changed");
});

test("ResizeObserver schedules layout revalidation", () => {
  const environment = createEnvironment();
  environment.evaluate();
  const api = environment.window.__CODEX_QUOTA_PANEL__;
  const host = environment.layout.children.at(-2);
  const panel = findTree(host._shadow, (element) => element.className === "quota-panel");
  const resizeObserver = environment.resizeObservers.find((entry) => !entry.disconnected);
  assert.ok(resizeObserver);
  assert.ok(resizeObserver.targets.includes(panel));

  panel.clientHeight = 80;
  panel.scrollHeight = 120;
  resizeObserver.callback();
  const reconcileTimeout = environment.timeouts.filter((entry) => entry.active).at(-1);
  assert.equal(reconcileTimeout.milliseconds, 80);
  reconcileTimeout.callback();
  assert.equal(api.status().mounted, false);
  assert.equal(api.status().reason, "panel-content-vertically-clipped");
});
