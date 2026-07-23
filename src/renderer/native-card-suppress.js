(function codexQuotaNativeCardSuppressor() {
  "use strict";

  const GLOBAL_KEY = "__CODEX_QUOTA_NATIVE_CARD_SUPPRESSOR__";
  const STYLE_ID = "codex-quota-native-card-suppressor";
  const runtime = typeof window === "object" ? window : globalThis;
  const documentRef = runtime.document;

  const existing = runtime[GLOBAL_KEY];
  if (existing && typeof existing.ensure === "function") return existing.ensure();
  if (!documentRef || !runtime.location || runtime.location.protocol !== "app:") {
    return { active: false, reason: "document-not-eligible" };
  }

  /*
   * This policy deliberately matches the native component's DOM contract, not
   * translated copy. Codex renders the same component in the docked sidebar,
   * the responsive floating sidebar, and a fixed bottom-left slot while both
   * sidebars are closed. The stylesheet is installed for the whole document
   * lifetime so every React remount is suppressed before its first paint.
   */
  const STYLE_TEXT = `
    :is(
      aside.app-shell-left-panel,
      aside[data-testid="app-shell-floating-left-panel"],
      div.pointer-events-none.fixed[class*="spacing-token-sidebar"]
    ) div.w-full:has(
      > div[role="status"][aria-live="polite"].flex.w-full.flex-col.gap-3.rounded-2xl.border
        > progress[max="100"][value]
    ):has(
      > div[role="status"][aria-live="polite"].flex.w-full.flex-col.gap-3.rounded-2xl.border
        > div:first-child button[type="button"].no-drag
    ),
    :is(
      aside.app-shell-left-panel,
      aside[data-testid="app-shell-floating-left-panel"],
      div.pointer-events-none.fixed[class*="spacing-token-sidebar"]
    ) div[role="status"][aria-live="polite"].flex.w-full.flex-col.gap-3.rounded-2xl.border:has(
      > progress[max="100"][value]
    ):has(
      > div:first-child button[type="button"].no-drag
    ) {
      display: none !important;
    }
  `;

  let api = null;
  let domReadyHandler = null;
  let rootObserver = null;

  function currentStyle() {
    return typeof documentRef.getElementById === "function"
      ? documentRef.getElementById(STYLE_ID)
      : null;
  }

  function stopPendingInstall() {
    if (domReadyHandler && typeof documentRef.removeEventListener === "function") {
      documentRef.removeEventListener("DOMContentLoaded", domReadyHandler);
    }
    domReadyHandler = null;
    if (rootObserver) rootObserver.disconnect();
    rootObserver = null;
  }

  function installStyle() {
    const present = currentStyle();
    if (present) {
      if (present.textContent !== STYLE_TEXT) present.textContent = STYLE_TEXT;
      stopPendingInstall();
      return true;
    }
    const root = documentRef.head || documentRef.documentElement;
    if (!root || typeof documentRef.createElement !== "function") return false;
    const style = documentRef.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    root.appendChild(style);
    stopPendingInstall();
    return true;
  }

  function waitForStyleRoot() {
    if (domReadyHandler || rootObserver) return;
    if (typeof documentRef.addEventListener === "function") {
      domReadyHandler = () => {
        domReadyHandler = null;
        installStyle();
      };
      documentRef.addEventListener("DOMContentLoaded", domReadyHandler, { once: true });
    }
    if (typeof runtime.MutationObserver === "function") {
      rootObserver = new runtime.MutationObserver(() => installStyle());
      rootObserver.observe(documentRef, { childList: true, subtree: true });
    }
  }

  function ensure() {
    if (!installStyle()) waitForStyleRoot();
    return api.status();
  }

  function cleanup(reason = "manual-cleanup") {
    stopPendingInstall();
    const style = currentStyle();
    if (style && style.parentNode) style.parentNode.removeChild(style);
    if (runtime[GLOBAL_KEY] === api) delete runtime[GLOBAL_KEY];
    return { active: false, pending: false, reason };
  }

  api = Object.freeze({
    ensure,
    cleanup,
    status: () => ({
      active: Boolean(currentStyle()),
      pending: Boolean(domReadyHandler || rootObserver),
      reason: currentStyle() ? null : domReadyHandler || rootObserver ? "style-root-pending" : "inactive",
    }),
  });
  runtime[GLOBAL_KEY] = api;
  return ensure();
}());
