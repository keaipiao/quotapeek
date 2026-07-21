(function codexQuotaPanelBootstrap() {
  "use strict";

  const GLOBAL_KEY = "__CODEX_QUOTA_PANEL__";
  const VERSION = "0.3.0";
  const HOST_ID = "codex-quota-panel";
  const SIDEBAR_SELECTOR = "aside.app-shell-left-panel";
  const NATIVE_HIDDEN_ATTR = "data-codex-quota-native-hidden";
  const GENERAL_BUCKET_ID = "codex";
  const SPARK_LIMIT_NAME = "gpt-5.3-codex-spark";
  // Compatibility labels for public plans currently represented by the
  // app-server wire enum. The wire value has no separate Pro multiplier field,
  // so keep that current product mapping centralized here. Internal usage-based
  // workspace variants and unknown future values stay hidden rather than being
  // presented as inferred entitlements.
  const PLAN_LABELS = Object.freeze({
    free: "Free",
    go: "Go",
    plus: "Plus",
    prolite: "Pro 5\u00d7",
    pro: "Pro 20\u00d7",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  });
  const STALE_AFTER_MS = 3 * 60 * 1000;
  const UNAVAILABLE_AFTER_MS = 15 * 60 * 1000;
  const HEARTBEAT_TIMEOUT_MS = 120 * 1000;
  const HEARTBEAT_CHECK_MS = 10 * 1000;
  const LOCALE_CHECK_MS = 5 * 1000;
  const MAX_REACT_FIBERS_FOR_LOCALE = 12_000;
  const RECONCILE_DEBOUNCE_MS = 80;
  const MOUNT_RETRY_DELAYS_MS = Object.freeze([100, 200, 400, 800, 1_200, 1_600, 2_000, 2_000, 2_000]);
  const MIN_ANCHOR_SCORE = 62;
  const UNIQUE_SCORE_MARGIN = 12;
  const PUBLIC_UNAVAILABLE_REASON_CODES = new Set([
    "E_APP_SERVER_CLOSED",
    "E_APP_SERVER_UNSUPPORTED",
    "E_AUTH_UNSUPPORTED",
    "E_CODEX_RUNTIME_UNAVAILABLE",
    "E_RATE_LIMIT_READ",
    "E_RATE_LIMIT_SCHEMA",
    "E_RATE_LIMIT_STALE",
    "E_RATE_LIMIT_UNAVAILABLE",
  ]);

  const runtime = typeof window === "object" ? window : globalThis;
  const documentRef = runtime.document;
  const now = () => Date.now();

  const MESSAGES = Object.freeze({
    en: Object.freeze({
      heading: "Codex usage limits",
      statusFresh: "Live",
      statusLoading: "Loading",
      statusRefreshing: "Refreshing",
      statusStale: "May be outdated",
      statusUnavailable: "Unavailable",
      loading: "Loading usage limits…",
      unavailable: "Usage limits are temporarily unavailable",
      generalUnavailable: "General usage limits are unavailable",
      signIn: "Sign in to ChatGPT in Codex first",
      serviceUnavailable: "Cannot connect to the Codex usage service right now",
      remaining: "Remaining",
      percentUnavailable: "Unavailable",
      unknownWindow: "Unknown window",
      usageLimit: "Usage limit",
      fiveHourLimit: "5-hour limit",
      dailyLimit: "Daily limit",
      weeklyLimit: "Weekly limit",
      monthlyLimit: "Monthly limit",
      refreshing: "Refreshing",
      resetUnknown: "Reset time unknown",
      minuteWindow: (value) => `${value} minute${Number(value) === 1 ? "" : "s"} window`,
      hourWindow: (value) => `${value} hour${Number(value) === 1 ? "" : "s"} window`,
      dayWindow: (value) => `${value} day${Number(value) === 1 ? "" : "s"} window`,
      minuteLimit: (value) => `${value}-minute limit`,
      hourLimit: (value) => `${value}-hour limit`,
      dayLimit: (value) => `${value}-day limit`,
      minutesAfter: (minutes) => `in ${minutes} minute${minutes === 1 ? "" : "s"}`,
      hoursAfter: (hours, minutes) => minutes
        ? `in ${hours} hr ${minutes} min`
        : `in ${hours} hour${hours === 1 ? "" : "s"}`,
      daysAfter: (days, hours) => hours
        ? `in ${days} d ${hours} hr`
        : `in ${days} day${days === 1 ? "" : "s"}`,
      progressLabel: (limitLabel) => `Codex general quota, ${limitLabel}`,
      progressValue: (percent) => `${percent} remaining`,
    }),
    "zh-CN": Object.freeze({
      heading: "Codex 通用额度",
      statusFresh: "实时",
      statusLoading: "加载中",
      statusRefreshing: "正在刷新",
      statusStale: "可能已过期",
      statusUnavailable: "暂不可用",
      loading: "正在读取额度…",
      unavailable: "额度暂时无法读取",
      generalUnavailable: "通用额度暂不可用",
      signIn: "请先在 Codex 中登录 ChatGPT",
      serviceUnavailable: "暂时无法连接 Codex 额度服务",
      remaining: "剩余",
      percentUnavailable: "不可用",
      unknownWindow: "未知窗口",
      usageLimit: "使用限额",
      fiveHourLimit: "5 小时限额",
      dailyLimit: "每日限额",
      weeklyLimit: "每周限额",
      monthlyLimit: "每月限额",
      refreshing: "正在刷新",
      resetUnknown: "刷新时间未知",
      minuteWindow: (value) => `${value} 分钟窗口`,
      hourWindow: (value) => `${value} 小时窗口`,
      dayWindow: (value) => `${value} 天窗口`,
      minuteLimit: (value) => `${value} 分钟限额`,
      hourLimit: (value) => `${value} 小时限额`,
      dayLimit: (value) => `${value} 天限额`,
      minutesAfter: (minutes) => `${minutes} 分钟后`,
      hoursAfter: (hours, minutes) => minutes ? `${hours} 小时 ${minutes} 分钟后` : `${hours} 小时后`,
      daysAfter: (days, hours) => hours ? `${days} 天 ${hours} 小时后` : `${days} 天后`,
      progressLabel: (limitLabel) => `Codex 通用${limitLabel}剩余额度`,
      progressValue: (percent) => `剩余 ${percent}`,
    }),
    "zh-TW": Object.freeze({
      heading: "Codex 通用額度",
      statusFresh: "即時",
      statusLoading: "載入中",
      statusRefreshing: "正在重新整理",
      statusStale: "可能已過期",
      statusUnavailable: "暫時無法使用",
      loading: "正在讀取額度…",
      unavailable: "暫時無法讀取額度",
      generalUnavailable: "通用額度暫時無法使用",
      signIn: "請先在 Codex 中登入 ChatGPT",
      serviceUnavailable: "暫時無法連線至 Codex 額度服務",
      remaining: "剩餘",
      percentUnavailable: "無法使用",
      unknownWindow: "未知週期",
      usageLimit: "使用限額",
      fiveHourLimit: "5 小時限額",
      dailyLimit: "每日限額",
      weeklyLimit: "每週限額",
      monthlyLimit: "每月限額",
      refreshing: "正在重新整理",
      resetUnknown: "重新整理時間未知",
      minuteWindow: (value) => `${value} 分鐘週期`,
      hourWindow: (value) => `${value} 小時週期`,
      dayWindow: (value) => `${value} 天週期`,
      minuteLimit: (value) => `${value} 分鐘限額`,
      hourLimit: (value) => `${value} 小時限額`,
      dayLimit: (value) => `${value} 天限額`,
      minutesAfter: (minutes) => `${minutes} 分鐘後`,
      hoursAfter: (hours, minutes) => minutes ? `${hours} 小時 ${minutes} 分鐘後` : `${hours} 小時後`,
      daysAfter: (days, hours) => hours ? `${days} 天 ${hours} 小時後` : `${days} 天後`,
      progressLabel: (limitLabel) => `Codex 通用${limitLabel}剩餘額度`,
      progressValue: (percent) => `剩餘 ${percent}`,
    }),
  });

  function normalizedLocale(value) {
    if (typeof value !== "string") return null;
    const candidate = value.trim().replace(/_/g, "-");
    if (!candidate || candidate.length > 35 || !/^[A-Za-z0-9-]+$/.test(candidate)) return null;
    try {
      return new Intl.Locale(candidate).toString();
    } catch {
      return candidate;
    }
  }

  function hasOwnMessages(value) {
    if (!value || typeof value !== "object") return false;
    try {
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function codexReactIntlLocale() {
    try {
      const first = runtime.__codexRoot && runtime.__codexRoot._internalRoot
        ? runtime.__codexRoot._internalRoot.current
        : null;
      if (!first || typeof first !== "object") return null;
      const intlContext = runtime.__REACT_INTL_CONTEXT__;
      const pending = [first];
      const visited = new Set();
      let inspected = 0;
      while (pending.length && inspected < MAX_REACT_FIBERS_FOR_LOCALE) {
        const fiber = pending.pop();
        if (!fiber || typeof fiber !== "object" || visited.has(fiber)) continue;
        visited.add(fiber);
        inspected += 1;
        const value = fiber.memoizedProps && fiber.memoizedProps.value;
        const matchesProvider = intlContext
          ? fiber.type === intlContext
          : value && typeof value.formatMessage === "function";
        if (matchesProvider && value && typeof value.formatMessage === "function") {
          const locale = normalizedLocale(value.locale);
          if (locale) {
            const language = locale.toLowerCase().split("-")[0];
            // Codex falls back to English default messages while a non-English
            // locale pack is still unavailable. Mirror what the user sees.
            if (language !== "en" && !hasOwnMessages(value.messages)) return "en";
            return locale;
          }
        }
        if (fiber.sibling) pending.push(fiber.sibling);
        if (fiber.child) pending.push(fiber.child);
      }
    } catch {
      // React internals are best-effort and may change between Codex releases.
    }
    return null;
  }

  function localeCandidates() {
    const candidates = [];
    const reactLocale = codexReactIntlLocale();
    if (reactLocale) candidates.push({ value: reactLocale, source: "codex-react-intl" });
    const root = documentRef && documentRef.documentElement;
    for (const attribute of ["data-locale", "data-language"]) {
      const value = root && typeof root.getAttribute === "function" ? root.getAttribute(attribute) : null;
      if (value) candidates.push({ value, source: `document-${attribute}` });
    }
    const languages = runtime.navigator && Array.isArray(runtime.navigator.languages)
      ? runtime.navigator.languages
      : [];
    for (const value of languages) candidates.push({ value, source: "navigator-languages" });
    if (runtime.navigator && runtime.navigator.language) {
      candidates.push({ value: runtime.navigator.language, source: "navigator-language" });
    }
    try {
      const value = new Intl.DateTimeFormat().resolvedOptions().locale;
      if (value) candidates.push({ value, source: "intl" });
    } catch {
      // English below is the deterministic final fallback.
    }
    const htmlLanguage = root && typeof root.getAttribute === "function" ? root.getAttribute("lang") : null;
    if (htmlLanguage) candidates.push({ value: htmlLanguage, source: "document-lang" });
    return candidates;
  }

  function supportedLocale(value) {
    const locale = normalizedLocale(value);
    if (!locale) return null;
    const lower = locale.toLowerCase();
    if (/^zh-(?:tw|hk|mo)(?:-|$)/.test(lower) || /^zh-hant(?:-|$)/.test(lower)) {
      return "zh-TW";
    }
    if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
    return "en";
  }

  function detectUiLocale() {
    for (const candidate of localeCandidates()) {
      const formatLocale = normalizedLocale(candidate.value);
      const locale = supportedLocale(formatLocale);
      if (locale) return { locale, formatLocale: formatLocale || locale, source: candidate.source };
    }
    return { locale: "en", formatLocale: "en", source: "fallback" };
  }

  function messagesFor(locale) {
    return MESSAGES[locale] || MESSAGES.en;
  }

  function safeReasonCode(value) {
    return typeof value === "string" && PUBLIC_UNAVAILABLE_REASON_CODES.has(value)
      ? value
      : "E_RATE_LIMIT_UNAVAILABLE";
  }

  function unavailableMessage(reasonCode, messages) {
    if (reasonCode === "E_AUTH_UNSUPPORTED") return messages.signIn;
    if (reasonCode === "E_CODEX_RUNTIME_UNAVAILABLE"
      || reasonCode === "E_APP_SERVER_UNSUPPORTED"
      || reasonCode === "E_APP_SERVER_CLOSED") return messages.serviceUnavailable;
    return messages.unavailable;
  }

  function shellCheck() {
    try {
      if (!runtime.location || runtime.location.protocol !== "app:") {
        return { ok: false, reason: "protocol-not-allowed" };
      }
      if (!documentRef || typeof documentRef.querySelector !== "function") {
        return { ok: false, reason: "document-unavailable" };
      }
      const main = documentRef.querySelector("main.main-surface");
      const sidebar = documentRef.querySelector(SIDEBAR_SELECTOR);
      const conversation = documentRef.querySelector(".composer-surface-chrome")
        || documentRef.querySelector("[role=\"main\"]");
      if (!main || !sidebar || !conversation) return { ok: false, reason: "main-shell-not-ready" };
      return { ok: true, reason: null, sidebar };
    } catch {
      return { ok: false, reason: "main-shell-check-failed" };
    }
  }

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function clampPercent(value) {
    const number = finiteNumber(value);
    if (number === null) return null;
    return Math.min(100, Math.max(0, number));
  }

  function safeText(value, fallback, maximumLength) {
    if (typeof value !== "string") return fallback;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!normalized) return fallback;
    return normalized.slice(0, maximumLength);
  }

  function canonicalIdentifier(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase().replace(/[_\s.]+/g, "-");
    return normalized || null;
  }

  function isSparkBucket(bucket) {
    return Boolean(bucket && canonicalIdentifier(bucket.name) === SPARK_LIMIT_NAME);
  }

  function formatPlanLabel(value) {
    const normalized = safeText(value, null, 32);
    if (!normalized) return null;
    const key = normalized.toLowerCase();
    return Object.prototype.hasOwnProperty.call(PLAN_LABELS, key) ? PLAN_LABELS[key] : null;
  }

  function selectGeneralBucket(buckets) {
    if (!Array.isArray(buckets)) return null;
    const candidates = buckets.filter((bucket) => bucket && !isSparkBucket(bucket));
    const unnamedCodex = candidates.filter((bucket) => (
      canonicalIdentifier(bucket.id) === GENERAL_BUCKET_ID && bucket.name === null
    ));
    if (unnamedCodex.length === 1) return unnamedCodex[0];
    const codex = candidates.filter((bucket) => canonicalIdentifier(bucket.id) === GENERAL_BUCKET_ID);
    if (codex.length === 1) return codex[0];
    const unnamed = candidates.filter((bucket) => bucket.name === null);
    return unnamed.length === 1 ? unnamed[0] : null;
  }

  function remainingTone(value) {
    const remaining = clampPercent(value);
    if (remaining === null || remaining <= 20) return "critical";
    if (remaining <= 50) return "warning";
    return "healthy";
  }

  function normalizeWindow(value) {
    if (!value || (value.kind !== "primary" && value.kind !== "secondary")) return null;
    const usedPercent = clampPercent(value.usedPercent);
    const suppliedRemaining = clampPercent(value.remainingPercent);
    const remainingPercent = suppliedRemaining === null
      ? usedPercent === null ? null : 100 - usedPercent
      : suppliedRemaining;
    if (remainingPercent === null) return null;

    const duration = finiteNumber(value.durationMinutes);
    const reset = finiteNumber(value.resetsAtMs);
    return {
      kind: value.kind,
      usedPercent: usedPercent === null ? 100 - remainingPercent : usedPercent,
      remainingPercent,
      durationMinutes: duration !== null && duration > 0 ? Math.round(duration) : null,
      resetsAtMs: reset !== null && reset > 0 ? Math.round(reset) : null,
    };
  }

  function normalizeSnapshot(value) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.buckets)) return null;
    const fetchedAt = finiteNumber(value.fetchedAtMs);
    if (fetchedAt === null || fetchedAt <= 0) return null;

    const buckets = [];
    for (const rawBucket of value.buckets.slice(0, 32)) {
      if (!rawBucket || typeof rawBucket.id !== "string") continue;
      const id = safeText(rawBucket.id, "", 64);
      if (!id || !Array.isArray(rawBucket.windows)) continue;
      const windows = rawBucket.windows.map(normalizeWindow).filter(Boolean).slice(0, 2);
      if (!windows.length) continue;
      windows.sort((left, right) => left.kind === right.kind ? 0 : left.kind === "primary" ? -1 : 1);
      buckets.push({
        id,
        name: safeText(rawBucket.name, null, 64),
        planType: safeText(rawBucket.planType, null, 32),
        reachedType: safeText(rawBucket.reachedType, null, 32),
        windows,
      });
    }

    return {
      schemaVersion: 1,
      fetchedAtMs: Math.round(fetchedAt),
      buckets,
      resetCreditsAvailable: finiteNumber(value.resetCreditsAvailable),
    };
  }

  function freshness(snapshot, atMs, explicitlyUnavailable, forceStale = false) {
    if (explicitlyUnavailable) return "unavailable";
    if (!snapshot) return "loading";
    const age = Math.max(0, atMs - snapshot.fetchedAtMs);
    if (age > UNAVAILABLE_AFTER_MS) return "unavailable";
    if (forceStale || age > STALE_AFTER_MS) return "stale";
    return "fresh";
  }

  function formatNumber(value, locale) {
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
    } catch {
      return String(value);
    }
  }

  function formatPercent(value, locale = detectUiLocale().locale, formatLocale = locale) {
    const clamped = clampPercent(value);
    const messages = messagesFor(locale);
    if (clamped === null) return messages.percentUnavailable;
    const rounded = clamped >= 10 ? Math.round(clamped) : Math.round(clamped * 10) / 10;
    try {
      return new Intl.NumberFormat(formatLocale, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(rounded / 100);
    } catch {
      return `${rounded}%`;
    }
  }

  function durationValue(minutes) {
    const value = finiteNumber(minutes);
    if (value === null || value <= 0) return null;
    if (value < 60) return { unit: "minute", value: Math.round(value) };
    if (value < 24 * 60) {
      const hours = value / 60;
      return { unit: "hour", value: Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10 };
    }
    const days = value / (24 * 60);
    return { unit: "day", value: Number.isInteger(days) ? days : Math.round(days * 10) / 10 };
  }

  function formatDuration(minutes, locale = detectUiLocale().locale, formatLocale = locale) {
    const duration = durationValue(minutes);
    const messages = messagesFor(locale);
    if (!duration) return messages.unknownWindow;
    const value = formatNumber(duration.value, formatLocale);
    if (duration.unit === "minute") return messages.minuteWindow(value);
    if (duration.unit === "hour") return messages.hourWindow(value);
    return messages.dayWindow(value);
  }

  function approximately(value, target, ratio = 0.05) {
    return Number.isFinite(value) && Math.abs(value - target) <= Math.max(1, target * ratio);
  }

  function formatLimitLabel(minutes, locale = detectUiLocale().locale, formatLocale = locale) {
    const value = finiteNumber(minutes);
    const messages = messagesFor(locale);
    if (value === null || value <= 0) return messages.usageLimit;
    if (approximately(value, 300, 0.01)) return messages.fiveHourLimit;
    if (approximately(value, 1_440, 0.01)) return messages.dailyLimit;
    if (approximately(value, 10_080, 0.01)) return messages.weeklyLimit;
    if (approximately(value, 43_200)) return messages.monthlyLimit;
    const duration = durationValue(value);
    if (!duration) return messages.usageLimit;
    const displayValue = formatNumber(duration.value, formatLocale);
    if (duration.unit === "minute") return messages.minuteLimit(displayValue);
    if (duration.unit === "hour") return messages.hourLimit(displayValue);
    return messages.dayLimit(displayValue);
  }

  function formatCountdown(resetAtMs, atMs, locale = detectUiLocale().locale) {
    const reset = finiteNumber(resetAtMs);
    if (reset === null) return "";
    const messages = messagesFor(locale);
    const delta = reset - atMs;
    if (delta <= 0) return messages.refreshing;
    const totalMinutes = Math.max(1, Math.ceil(delta / 60000));
    if (totalMinutes < 60) return messages.minutesAfter(totalMinutes);
    if (totalMinutes < 24 * 60) {
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return messages.hoursAfter(hours, minutes);
    }
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    return messages.daysAfter(days, hours);
  }

  function formatResetTime(resetAtMs, atMs, locale = detectUiLocale().locale, formatLocale = locale) {
    const reset = finiteNumber(resetAtMs);
    const messages = messagesFor(locale);
    if (reset === null) return messages.resetUnknown;
    try {
      const exact = new Intl.DateTimeFormat(formatLocale, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(reset));
      const countdown = formatCountdown(reset, atMs, locale);
      return countdown ? `${exact} · ${countdown}` : exact;
    } catch {
      return formatCountdown(reset, atMs, locale) || messages.resetUnknown;
    }
  }

  function rectFrom(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    const rect = element.getBoundingClientRect();
    if (!rect) return null;
    const values = [rect.top, rect.right, rect.bottom, rect.left, rect.width, rect.height];
    if (!values.every((item) => Number.isFinite(item))) return null;
    return rect;
  }

  function safeComputedStyle(element) {
    try {
      return typeof runtime.getComputedStyle === "function"
        ? runtime.getComputedStyle(element)
        : element && element.style ? element.style : {};
    } catch {
      return {};
    }
  }

  function cssPixels(value) {
    const number = Number.parseFloat(String(value || ""));
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function semanticSignals(element) {
    if (!element || typeof element.getAttribute !== "function") return null;
    const tag = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute("role") || "").toLowerCase();
    const popup = String(element.getAttribute("aria-haspopup") || "").toLowerCase();
    const menuState = String(element.getAttribute("data-state") || "").toLowerCase();
    const testId = String(element.getAttribute("data-testid") || "").toLowerCase();
    const slot = String(element.getAttribute("data-slot") || "").toLowerCase();
    const sidebarFooter = element.hasAttribute && element.hasAttribute("data-sidebar-footer");
    const identityMarker = /(?:^|[-_])(account|profile|user|avatar)(?:$|[-_])/.test(testId)
      || /(?:^|[-_])(account|profile|user|avatar)(?:$|[-_])/.test(slot);
    const stableDataMarker = identityMarker
      || /(?:^|[-_])sidebar[-_]?footer(?:$|[-_])/.test(testId)
      || /(?:^|[-_])sidebar[-_]?footer(?:$|[-_])/.test(slot);
    const expanded = element.getAttribute("aria-expanded") === "true" || element.getAttribute("aria-expanded") === "false";
    return {
      tagFooter: tag === "footer",
      contentInfo: role === "contentinfo",
      menuTrigger: popup === "menu",
      stableMenuTrigger: popup === "menu" && expanded && (menuState === "open" || menuState === "closed"),
      identityMarker,
      stableDataMarker,
      sidebarFooter,
      buttonLike: tag === "button" || role === "button",
      controls: Boolean(element.getAttribute("aria-controls")),
      expanded,
    };
  }

  function semanticScore(signals) {
    if (!signals) return 0;
    let score = 0;
    if (signals.tagFooter) score += 38;
    if (signals.contentInfo) score += 42;
    if (signals.sidebarFooter) score += 42;
    if (signals.stableDataMarker) score += 32;
    if (signals.menuTrigger) score += 26;
    if (signals.stableMenuTrigger) score += 18;
    if (signals.buttonLike) score += 4;
    if (signals.controls) score += 4;
    if (signals.expanded) score += 3;
    return score;
  }

  function scoreAnchorMetrics(metrics) {
    if (!metrics || !metrics.sidebar || !metrics.anchor || !metrics.parent) return Number.NEGATIVE_INFINITY;
    const sidebar = metrics.sidebar;
    const anchor = metrics.anchor;
    const parent = metrics.parent;
    if (sidebar.width <= 0 || sidebar.height <= 0 || anchor.width < 24 || anchor.height < 20) {
      return Number.NEGATIVE_INFINITY;
    }
    if (anchor.bottom < sidebar.top || anchor.top > sidebar.bottom) return Number.NEGATIVE_INFINITY;
    if (metrics.position === "fixed" || metrics.position === "absolute" || metrics.position === "sticky") {
      return Number.NEGATIVE_INFINITY;
    }
    if (metrics.parentPosition === "sticky") return Number.NEGATIVE_INFINITY;
    if (metrics.parentDisplay === "flex"
      && metrics.parentDirection !== "column" && metrics.parentDirection !== "column-reverse") {
      return Number.NEGATIVE_INFINITY;
    }

    const bottomGap = Math.max(0, sidebar.bottom - anchor.bottom);
    const normalizedGap = bottomGap / sidebar.height;
    if (normalizedGap > 0.38) return Number.NEGATIVE_INFINITY;

    let score = metrics.semanticScore || 0;
    // The account affordance is docked to the physical bottom of the sidebar.
    // Give bottom proximity enough weight to separate it from quota-card and
    // conversation overflow menus that expose the same popup semantics.
    score += Math.max(0, 42 - normalizedGap * 200);
    const widthRatio = Math.min(1, anchor.width / sidebar.width);
    score += widthRatio * 12;
    const parentWidthRatio = Math.min(1, parent.width / sidebar.width);
    score += parentWidthRatio * 8;
    if (anchor.height <= sidebar.height * 0.35) score += 7;
    else return Number.NEGATIVE_INFINITY;
    if (metrics.position === "static" || metrics.position === "relative" || !metrics.position) score += 4;
    if (metrics.parentDisplay === "flex" || metrics.parentDisplay === "grid" || metrics.parentDisplay === "block") score += 5;
    if (metrics.parentDirection === "column") score += 4;
    return Math.round(score * 10) / 10;
  }

  function chooseUniqueScored(candidates, minimumScore = MIN_ANCHOR_SCORE, margin = UNIQUE_SCORE_MARGIN) {
    const ranked = candidates
      .filter((candidate) => candidate && Number.isFinite(candidate.score))
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked[0].score < minimumScore) {
      return { candidate: null, reason: "anchor-not-found", ranked };
    }
    if (ranked.length > 1 && ranked[0].score - ranked[1].score < margin) {
      return { candidate: null, reason: "anchor-ambiguous", ranked };
    }
    return { candidate: ranked[0], reason: null, ranked };
  }

  function elementDepth(element, stop) {
    let depth = 0;
    for (let current = element; current && current !== stop; current = current.parentElement) depth += 1;
    return depth;
  }

  function collectSemanticSeeds(sidebar) {
    const seeds = [];
    const seen = new Set();
    const selectors = [
      "footer",
      "[role=\"contentinfo\"]",
      "[data-sidebar-footer]",
      "[data-slot]",
      "[data-testid]",
      "button[aria-haspopup=\"menu\"][aria-expanded][data-state]",
      "[role=\"button\"][aria-haspopup=\"menu\"][aria-expanded][data-state]",
      "button[aria-haspopup=\"menu\"]",
      "[role=\"button\"][aria-haspopup=\"menu\"]",
    ];
    for (const selector of selectors) {
      let matches = [];
      try {
        matches = Array.from(sidebar.querySelectorAll(selector));
      } catch {
        matches = [];
      }
      for (const element of matches) {
        if (seen.has(element)) continue;
        const signals = semanticSignals(element);
        // A generic footer is not enough: the candidate must be tied to the
        // account/profile affordance by a stable marker or a menu trigger.
        if (!signals || (!signals.identityMarker && !signals.menuTrigger)) continue;
        if (!signals || semanticScore(signals) < 20) continue;
        seen.add(element);
        seeds.push({ element, signals, score: semanticScore(signals) });
      }
    }
    return seeds;
  }

  function findAnchor(sidebar) {
    const sidebarRect = rectFrom(sidebar);
    if (!sidebarRect) return { candidate: null, reason: "sidebar-geometry-invalid", ranked: [] };
    const slots = new Map();

    for (const seed of collectSemanticSeeds(sidebar)) {
      const seedCandidates = [];
      let anchor = seed.element;
      for (let hops = 0; anchor && anchor !== sidebar && hops < 8; hops += 1, anchor = anchor.parentElement) {
        const parent = anchor.parentElement;
        if (!parent || !sidebar.contains(anchor) || (parent !== sidebar && !sidebar.contains(parent))) continue;
        const anchorRect = rectFrom(anchor);
        const parentRect = rectFrom(parent);
        if (!anchorRect || !parentRect) continue;
        const anchorStyle = safeComputedStyle(anchor);
        const parentStyle = safeComputedStyle(parent);
        const score = scoreAnchorMetrics({
          sidebar: sidebarRect,
          anchor: anchorRect,
          parent: parentRect,
          semanticScore: seed.score,
          position: String(anchorStyle.position || "static").toLowerCase(),
          parentPosition: String(parentStyle.position || "static").toLowerCase(),
          parentDisplay: String(parentStyle.display || "block").toLowerCase(),
          parentDirection: String(parentStyle.flexDirection || "").toLowerCase(),
        });
        const candidate = {
          anchor,
          parent,
          score,
          semanticScore: seed.score,
          depth: elementDepth(anchor, sidebar),
          signals: seed.signals,
        };
        seedCandidates.push(candidate);
      }
      seedCandidates.sort((left, right) => right.score - left.score);
      const best = seedCandidates[0];
      if (!best) continue;
      const previous = slots.get(best.anchor);
      if (!previous || best.score > previous.score) slots.set(best.anchor, best);
    }

    const candidates = Array.from(slots.values());
    const collapsed = [];
    for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
      const relatedIndex = collapsed.findIndex((other) => (
        other.anchor.contains(candidate.anchor) || candidate.anchor.contains(other.anchor)
      ));
      if (relatedIndex < 0) {
        collapsed.push(candidate);
        continue;
      }
      const other = collapsed[relatedIndex];
      const candidateRect = rectFrom(candidate.anchor);
      const otherRect = rectFrom(other.anchor);
      const candidateWidth = candidateRect ? candidateRect.width : 0;
      const otherWidth = otherRect ? otherRect.width : 0;
      if (candidate.score > other.score + 4 || (Math.abs(candidate.score - other.score) <= 4 && candidateWidth > otherWidth)) {
        collapsed[relatedIndex] = candidate;
      }
    }
    return chooseUniqueScored(collapsed);
  }

  function createElement(tagName, className, textValue) {
    const element = documentRef.createElement(tagName);
    if (className) element.className = className;
    if (textValue !== undefined) element.textContent = textValue;
    return element;
  }

  const state = {
    snapshot: null,
    explicitlyUnavailable: false,
    cachedSnapshot: false,
    unavailableReasonCode: null,
    locale: "en",
    formatLocale: "en",
    localeSource: "fallback",
    sidebar: null,
    anchor: null,
    host: null,
    shadow: null,
    panel: null,
    observer: null,
    observerTarget: null,
    resizeObserver: null,
    scrollRegions: null,
    scrollDock: null,
    sidebarBaseline: null,
    nativeQuotaHidden: new Map(),
    domReadyHandler: null,
    reconcileTimer: null,
    mountRetryTimer: null,
    mountRetryAttempt: 0,
    countdownTimer: null,
    heartbeatTimer: null,
    localeTimer: null,
    languageChangeHandler: null,
    lastHeartbeatMs: now(),
    mountedAtMs: null,
    geometryValidated: false,
    reason: "not-mounted",
    anchorScore: null,
    cleaned: false,
  };

  function clearChildren(element) {
    while (element && element.firstChild) element.removeChild(element.firstChild);
  }

  function refreshLocale(renderIfChanged = true) {
    const detected = detectUiLocale();
    const changed = detected.locale !== state.locale
      || detected.formatLocale !== state.formatLocale
      || detected.source !== state.localeSource;
    state.locale = detected.locale;
    state.formatLocale = detected.formatLocale;
    state.localeSource = detected.source;
    if (state.host) {
      state.host.setAttribute("lang", state.locale);
      state.host.setAttribute("aria-label", messagesFor(state.locale).heading);
    }
    if (changed && renderIfChanged && state.panel && state.host && state.host.isConnected) {
      renderPreservingBottom();
    }
    return changed;
  }

  function render() {
    if (!state.panel) return;
    refreshLocale(false);
    const atMs = now();
    const locale = state.locale;
    const formatLocale = state.formatLocale;
    const messages = messagesFor(locale);
    const currentFreshness = freshness(
      state.snapshot,
      atMs,
      state.explicitlyUnavailable,
      state.cachedSnapshot
    );
    const panel = state.panel;
    clearChildren(panel);
    panel.setAttribute("data-state", currentFreshness);
    panel.setAttribute("lang", locale);
    if (state.host) {
      state.host.setAttribute("lang", locale);
      state.host.setAttribute("aria-label", messages.heading);
    }

    const bucket = selectGeneralBucket(state.snapshot ? state.snapshot.buckets : []);
    const planLabel = currentFreshness !== "loading"
      && currentFreshness !== "unavailable"
      && !state.cachedSnapshot
      && bucket
      ? formatPlanLabel(bucket.planType)
      : null;
    const header = createElement("div", "quota-header");
    const headingGroup = createElement("div", "quota-heading-group");
    const heading = createElement("span", "quota-heading", messages.heading);
    headingGroup.appendChild(heading);
    if (planLabel) headingGroup.appendChild(createElement("span", "quota-plan", `\u00b7 ${planLabel}`));
    const statusLabel = currentFreshness === "fresh"
      ? messages.statusFresh
      : currentFreshness === "loading"
        ? messages.statusLoading
        : state.cachedSnapshot && currentFreshness === "stale"
          ? messages.statusRefreshing
          : currentFreshness === "stale" ? messages.statusStale : messages.statusUnavailable;
    const badge = createElement("span", `quota-badge quota-${currentFreshness}`, statusLabel);
    header.appendChild(headingGroup);
    header.appendChild(badge);
    panel.appendChild(header);

    if (currentFreshness === "loading") {
      panel.appendChild(createElement("div", "quota-empty", messages.loading));
      return;
    }

    if (currentFreshness === "unavailable") {
      panel.appendChild(createElement(
        "div",
        "quota-empty",
        unavailableMessage(state.unavailableReasonCode, messages),
      ));
      return;
    }

    if (!bucket) {
      panel.appendChild(createElement("div", "quota-empty", messages.generalUnavailable));
      return;
    }

    const list = createElement("div", "quota-list");
    const section = createElement("section", "quota-bucket");
    section.setAttribute("data-bucket-id", bucket.id);
    const sortedWindows = bucket.windows.slice().sort((left, right) => {
      const leftDuration = finiteNumber(left.durationMinutes) ?? Number.MAX_SAFE_INTEGER;
      const rightDuration = finiteNumber(right.durationMinutes) ?? Number.MAX_SAFE_INTEGER;
      return leftDuration - rightDuration;
    });
    const windows = createElement("div", "quota-windows");
    windows.setAttribute("data-window-count", String(sortedWindows.length));
    for (const quotaWindow of sortedWindows) {
      const item = createElement("div", "quota-window");
      const limitLabel = formatLimitLabel(quotaWindow.durationMinutes, locale, formatLocale);
      const tone = remainingTone(quotaWindow.remainingPercent);
      item.setAttribute("data-level", tone);
      const valueRow = createElement("div", "quota-window-line");
      valueRow.appendChild(createElement("span", "quota-label", limitLabel));
      const value = createElement("span", "quota-value");
      value.appendChild(createElement("span", "quota-value-prefix", messages.remaining));
      const formattedPercent = formatPercent(quotaWindow.remainingPercent, locale, formatLocale);
      value.appendChild(createElement("strong", "quota-percent", formattedPercent));
      valueRow.appendChild(value);
      item.appendChild(valueRow);
      const progress = createElement("div", "quota-progress");
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", messages.progressLabel(limitLabel));
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      progress.setAttribute("aria-valuenow", String(Math.round(quotaWindow.remainingPercent * 10) / 10));
      progress.setAttribute("aria-valuetext", messages.progressValue(formattedPercent));
      const fill = createElement("span", "quota-progress-fill");
      fill.style.width = `${quotaWindow.remainingPercent}%`;
      progress.appendChild(fill);
      item.appendChild(progress);
      item.appendChild(createElement("div", "quota-reset", formatResetTime(
        quotaWindow.resetsAtMs,
        atMs,
        locale,
        formatLocale,
      )));
      windows.appendChild(item);
    }
    section.appendChild(windows);
    list.appendChild(section);
    panel.appendChild(list);
  }

  function captureBottomScrollAnchor(element) {
    if (!element || !element.isConnected) return null;
    const scrollTop = Math.max(0, finiteNumber(Number(element.scrollTop)) || 0);
    const maximum = Math.max(0, Number(element.scrollHeight) - Number(element.clientHeight));
    if (!Number.isFinite(maximum) || maximum - scrollTop > 2) return null;
    return { element, expectedTop: scrollTop };
  }

  function alignBottomScrollAnchor(anchor) {
    if (!anchor || !anchor.element || !anchor.element.isConnected) return false;
    const element = anchor.element;
    const currentTop = Math.max(0, finiteNumber(Number(element.scrollTop)) || 0);
    const maximum = Math.max(0, Number(element.scrollHeight) - Number(element.clientHeight));
    if (!Number.isFinite(maximum)) return false;
    const stillOwned = Math.abs(currentTop - anchor.expectedTop) <= 2
      || Math.abs(currentTop - maximum) <= 2;
    if (!stillOwned) return false;
    element.scrollTop = maximum;
    anchor.expectedTop = maximum;
    return true;
  }

  function renderPreservingBottom() {
    const anchor = captureBottomScrollAnchor(state.scrollDock && state.scrollDock.element);
    render();
    if (!anchor) return;
    alignBottomScrollAnchor(anchor);
    if (typeof runtime.requestAnimationFrame === "function") {
      runtime.requestAnimationFrame(() => runtime.requestAnimationFrame(() => {
        if (state.scrollDock && state.scrollDock.element === anchor.element) {
          alignBottomScrollAnchor(anchor);
        }
      }));
    }
  }

  function panelCss() {
    return `
      :host { all: initial; color-scheme: light dark; }
      * { box-sizing: border-box; }
      .quota-panel {
        --quota-panel-foreground: var(--color-token-foreground, var(--vscode-sideBar-foreground, CanvasText));
        --quota-healthy: color-mix(in oklab, var(--color-token-git-decoration-added-resource-foreground, #16855b) 78%, var(--quota-panel-foreground));
        --quota-warning: color-mix(in oklab, var(--color-token-editor-warning-foreground, #a26300) 82%, var(--quota-panel-foreground));
        --quota-critical: color-mix(in oklab, var(--color-token-error-foreground, #c2413b) 82%, var(--quota-panel-foreground));
        color: var(--quota-panel-foreground);
        background: color-mix(in srgb, var(--vscode-sideBar-background, Canvas) 96%, currentColor 4%);
        border: 1px solid var(--color-token-border, color-mix(in srgb, currentColor 11%, transparent));
        border-radius: 12px;
        font: 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 8px 6px 7px;
        padding: 10px 11px 11px;
        max-height: min(210px, 40vh);
        overflow: hidden;
        contain: layout paint style;
      }
      .quota-header, .quota-window-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-width: 0;
        gap: 10px;
      }
      .quota-header { min-height: 20px; }
      .quota-heading-group { display: flex; align-items: baseline; min-width: 0; overflow: hidden; gap: 5px; white-space: nowrap; }
      .quota-heading { flex: none; font-weight: 650; font-size: 12.5px; line-height: 1.35; letter-spacing: -.01em; white-space: nowrap; }
      .quota-plan { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--color-token-description-foreground, color-mix(in srgb, currentColor 62%, transparent)); font-size: 10.5px; font-weight: 600; line-height: 1.35; white-space: nowrap; }
      .quota-badge {
        flex: none;
        border-radius: 999px;
        padding: 2px 6px;
        font-size: 10px;
        line-height: 1.4;
        white-space: nowrap;
      }
      .quota-fresh { color: var(--quota-healthy); background: color-mix(in srgb, var(--quota-healthy) 10%, transparent); }
      .quota-stale { color: var(--quota-warning); background: color-mix(in srgb, var(--quota-warning) 10%, transparent); }
      .quota-loading { color: var(--color-token-description-foreground, currentColor); background: rgba(127,127,127,.08); }
      .quota-unavailable { color: color-mix(in srgb, currentColor 55%, transparent); background: rgba(127,127,127,.08); }
      .quota-list { margin-top: 9px; }
      .quota-windows, .quota-windows[data-window-count="2"] { display: grid; grid-template-columns: minmax(0, 1fr); }
      .quota-window { min-width: 0; }
      .quota-window + .quota-window { margin-top: 10px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, currentColor 9%, transparent); }
      .quota-window-line { min-height: 18px; align-items: baseline; }
      .quota-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-token-description-foreground, color-mix(in srgb, currentColor 62%, transparent)); font-size: 11.5px; }
      .quota-value { display: inline-flex; align-items: baseline; flex: none; gap: 4px; font-variant-numeric: tabular-nums; }
      .quota-value-prefix { color: var(--color-token-description-foreground, color-mix(in srgb, currentColor 58%, transparent)); font-size: 10.5px; font-weight: 500; }
      .quota-percent { font-size: 13px; line-height: 1.25; font-weight: 650; }
      .quota-progress { height: 5px; margin-top: 6px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, currentColor 10%, transparent); }
      .quota-progress-fill { display: block; height: 100%; min-width: 0; border-radius: inherit; background: var(--quota-healthy); }
      .quota-window[data-level="healthy"] .quota-progress-fill { background-color: var(--quota-healthy); }
      .quota-window[data-level="healthy"] .quota-percent { color: var(--quota-healthy); }
      .quota-window[data-level="warning"] .quota-progress-fill { background-color: var(--quota-warning); }
      .quota-window[data-level="warning"] .quota-percent { color: var(--quota-warning); }
      .quota-window[data-level="critical"] .quota-progress-fill { background-color: var(--quota-critical); }
      .quota-window[data-level="critical"] .quota-percent { color: var(--quota-critical); }
      .quota-reset, .quota-more, .quota-empty { color: var(--color-token-description-foreground, color-mix(in srgb, currentColor 55%, transparent)); font-variant-numeric: tabular-nums; }
      .quota-reset { margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; line-height: 1.4; }
      .quota-empty { margin-top: 9px; padding: 3px 0 2px; }
      @media (max-height: 620px) {
        .quota-panel { margin-block: 5px; padding: 8px 10px 9px; }
        .quota-list { margin-top: 7px; }
        .quota-window + .quota-window { margin-top: 8px; padding-top: 8px; }
        .quota-progress { height: 4px; margin-top: 5px; }
        .quota-reset { margin-top: 4px; }
      }
      @media (forced-colors: active) {
        .quota-panel { color: CanvasText; background: Canvas; border-color: CanvasText; }
        .quota-badge { border: 1px solid CanvasText; background: Canvas; color: CanvasText; }
        .quota-progress { background: Canvas; border: 1px solid CanvasText; }
        .quota-window .quota-progress-fill { background: Highlight; }
        .quota-window .quota-percent { color: CanvasText; }
      }
    `;
  }

  function readInlineStyle(element, property) {
    const style = element && element.style;
    if (!style) return { value: "", priority: "" };
    if (typeof style.getPropertyValue === "function") {
      return {
        value: style.getPropertyValue(property),
        priority: typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(property) : "",
      };
    }
    const camelName = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return { value: style[camelName] || "", priority: "" };
  }

  function writeInlineStyle(element, property, value, priority = "") {
    const style = element && element.style;
    if (!style) return;
    if (typeof style.setProperty === "function") {
      style.setProperty(property, value, priority);
      return;
    }
    const camelName = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    style[camelName] = value;
  }

  function restoreInlineStyle(element, property, snapshot) {
    const style = element && element.style;
    if (!style) return;
    if (snapshot && snapshot.value) {
      writeInlineStyle(element, property, snapshot.value, snapshot.priority || "");
      return;
    }
    if (typeof style.removeProperty === "function") {
      style.removeProperty(property);
      return;
    }
    const camelName = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    style[camelName] = "";
  }

  function restoreScrollDock() {
    const dock = state.scrollDock;
    state.scrollDock = null;
    if (!dock || !dock.element) return;
    const marginBottom = readInlineStyle(dock.element, "margin-bottom");
    const paddingBottom = readInlineStyle(dock.element, "padding-bottom");
    const footerEdge = readInlineStyle(dock.element, "--sidebar-scroll-footer-edge");
    if (marginBottom.value === "var(--sidebar-footer-height)" && marginBottom.priority === "important") {
      restoreInlineStyle(dock.element, "margin-bottom", dock.marginBottom);
    }
    if (paddingBottom.value === "var(--padding-row-x, 8px)" && paddingBottom.priority === "important") {
      restoreInlineStyle(dock.element, "padding-bottom", dock.paddingBottom);
    }
    if (footerEdge.value === "100%" && footerEdge.priority === "important") {
      restoreInlineStyle(dock.element, "--sidebar-scroll-footer-edge", dock.footerEdge);
    }
  }

  function applyScrollDock(scrollRegions) {
    restoreScrollDock();
    const candidates = (scrollRegions || []).filter((region) => region.primary === true);
    if (candidates.length !== 1) return null;
    const region = candidates[0];
    const element = region.element;
    if (!element || !element.isConnected) return null;
    const dock = {
      element,
      marginBottom: readInlineStyle(element, "margin-bottom"),
      paddingBottom: readInlineStyle(element, "padding-bottom"),
      footerEdge: readInlineStyle(element, "--sidebar-scroll-footer-edge"),
    };
    writeInlineStyle(element, "margin-bottom", "var(--sidebar-footer-height)", "important");
    writeInlineStyle(element, "padding-bottom", "var(--padding-row-x, 8px)", "important");
    // The scroller is physically docked above the panel, so its native fade
    // edge must use the shortened viewport instead of reserving the footer again.
    writeInlineStyle(element, "--sidebar-scroll-footer-edge", "100%", "important");
    const afterMaxScroll = Math.max(0, Number(element.scrollHeight) - Number(element.clientHeight));
    const beforeScrollTop = Math.max(0, finiteNumber(region.beforeScrollTop) || 0);
    element.scrollTop = region.beforeAtBottom
      ? afterMaxScroll
      : Math.min(beforeScrollTop, afterMaxScroll);
    dock.bottomAnchor = region.beforeAtBottom
      ? { element, expectedTop: Number(element.scrollTop) || 0 }
      : null;
    state.scrollDock = dock;
    return element;
  }

  function subtreeText(element) {
    if (!element) return "";
    const pieces = [element.innerText, element.textContent];
    try {
      for (const descendant of Array.from(element.querySelectorAll("*")).slice(0, 80)) {
        pieces.push(descendant.textContent);
      }
    } catch {
      // A candidate without an inspectable subtree is not hidden.
    }
    return pieces.filter((value) => typeof value === "string" && value).join(" ").slice(0, 2_000);
  }

  function nativeQuotaScore(element) {
    if (!element || element === state.host
      || (state.host && element.contains(state.host))
      || (state.anchor && element.contains(state.anchor))) return null;
    const tag = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute && element.getAttribute("role") || "").toLowerCase();
    if (tag === "nav" || role === "list" || role === "listitem" || role === "navigation") return null;
    if (element.hasAttribute && (element.hasAttribute("data-app-action-sidebar-scroll")
      || element.getAttribute("aria-hidden") === "true")) return null;

    let descendants = [];
    try { descendants = Array.from(element.querySelectorAll("*")).slice(0, 80); } catch { descendants = []; }
    const nodes = [element, ...descendants];
    if (nodes.some((node) => {
      const nodeTag = String(node.tagName || "").toLowerCase();
      const nodeRole = String(node.getAttribute && node.getAttribute("role") || "").toLowerCase();
      return nodeTag === "nav" || nodeRole === "list" || nodeRole === "listitem" || nodeRole === "navigation"
        || (node.hasAttribute && node.hasAttribute("data-app-action-sidebar-scroll"));
    })) return null;
    const attributes = nodes.map((node) => [
      node.id,
      node.getAttribute && node.getAttribute("data-testid"),
      node.getAttribute && node.getAttribute("data-slot"),
      node.getAttribute && node.getAttribute("aria-label"),
    ].filter(Boolean).join(" ")).join(" ");
    const text = subtreeText(element);
    const semanticPattern = /(?:usage\s+remaining|remaining\s+usage|rate\s*limits?|quota|剩余(?:额度|用量)|额度|限额|用量|剩餘(?:額度|用量)|額度|限額)/i;
    const attributeSignal = semanticPattern.test(attributes);
    const textSignal = semanticPattern.test(text);
    const percentSignal = /(?:^|\s)\d{1,3}(?:\.\d+)?\s*%/.test(text);
    const meterSignal = nodes.some((node) => {
      const nodeRole = String(node.getAttribute && node.getAttribute("role") || "").toLowerCase();
      return nodeRole === "progressbar" || nodeRole === "meter"
        || String(node.tagName || "").toLowerCase() === "progress";
    });
    const resetSignal = /(?:resets?|refresh|重置|刷新|重設|重新整理)/i.test(text);
    const signals = [attributeSignal, textSignal, percentSignal, meterSignal, resetSignal].filter(Boolean).length;
    if ((!attributeSignal && !textSignal) || signals < 2) return null;
    const score = (attributeSignal ? 55 : 0) + (textSignal ? 30 : 0)
      + (percentSignal ? 25 : 0) + (meterSignal ? 25 : 0) + (resetSignal ? 10 : 0);
    return score >= 55 ? score : null;
  }

  function findNativeQuotaCandidate(sidebar, anchor) {
    if (!sidebar || !anchor) return null;
    const scored = [];
    const parent = anchor.parentElement;
    if (!parent || !sidebar.contains(parent)) return null;
    const sidebarRect = rectFrom(sidebar);
    const anchorRect = rectFrom(anchor);
    for (const sibling of Array.from(parent.children || [])) {
      if (sibling === anchor) break;
      if (sibling === state.host) continue;
      const siblingRect = rectFrom(sibling);
      if (!sidebarRect || !anchorRect || !siblingRect || siblingRect.height <= 0) continue;
      if (siblingRect.height > Math.max(180, sidebarRect.height * 0.28)) continue;
      if (siblingRect.left < sidebarRect.left - 2 || siblingRect.right > sidebarRect.right + 2) continue;
      if (siblingRect.bottom > anchorRect.top + 2) continue;
      const score = nativeQuotaScore(sibling);
      if (score !== null) scored.push({ element: sibling, score });
    }
    scored.sort((left, right) => right.score - left.score);
    if (scored.length !== 1) return null;
    return scored[0].element;
  }

  function restoreNativeQuota(except = null) {
    let changed = false;
    for (const [element, snapshot] of state.nativeQuotaHidden) {
      if (element === except) continue;
      const markerOwned = element && element.getAttribute
        && element.getAttribute(NATIVE_HIDDEN_ATTR) === VERSION;
      const display = readInlineStyle(element, "display");
      if (markerOwned && display.value === "none" && display.priority === "important") {
        restoreInlineStyle(element, "display", snapshot.display);
      }
      if (markerOwned && element && typeof element.setAttribute === "function") {
        if (snapshot.markerPresent) element.setAttribute(NATIVE_HIDDEN_ATTR, snapshot.markerValue);
        else if (typeof element.removeAttribute === "function") element.removeAttribute(NATIVE_HIDDEN_ATTR);
      }
      state.nativeQuotaHidden.delete(element);
      changed = true;
    }
    return changed;
  }

  function syncNativeQuotaVisibility() {
    const generalBucket = selectGeneralBucket(state.snapshot ? state.snapshot.buckets : []);
    const currentFreshness = freshness(state.snapshot, now(), state.explicitlyUnavailable);
    const shouldHide = Boolean(state.host && state.host.isConnected && state.geometryValidated
      && generalBucket && currentFreshness !== "unavailable");
    if (!shouldHide) return restoreNativeQuota();

    const candidate = findNativeQuotaCandidate(state.sidebar, state.anchor);
    if (!candidate) return restoreNativeQuota();
    let changed = restoreNativeQuota(candidate);
    if (!state.nativeQuotaHidden.has(candidate)) {
      state.nativeQuotaHidden.set(candidate, {
        display: readInlineStyle(candidate, "display"),
        markerPresent: candidate.hasAttribute && candidate.hasAttribute(NATIVE_HIDDEN_ATTR),
        markerValue: candidate.getAttribute && candidate.getAttribute(NATIVE_HIDDEN_ATTR),
      });
      candidate.setAttribute(NATIVE_HIDDEN_ATTR, VERSION);
      writeInlineStyle(candidate, "display", "none", "important");
      changed = true;
    } else {
      const display = readInlineStyle(candidate, "display");
      if (candidate.getAttribute(NATIVE_HIDDEN_ATTR) !== VERSION) {
        candidate.setAttribute(NATIVE_HIDDEN_ATTR, VERSION);
        changed = true;
      }
      if (display.value !== "none" || display.priority !== "important") {
        writeInlineStyle(candidate, "display", "none", "important");
        changed = true;
      }
    }
    return changed;
  }

  function findScrollRegions(sidebar, anchor) {
    const regions = [];
    if (!sidebar || typeof sidebar.querySelectorAll !== "function") return regions;
    let elements = [];
    try {
      elements = Array.from(sidebar.querySelectorAll("*"));
    } catch {
      return regions;
    }
    const anchorRect = rectFrom(anchor);
    for (const element of elements) {
      if (element === anchor || (anchor && (anchor.contains(element) || element.contains(anchor)))) continue;
      const style = safeComputedStyle(element);
      const overflowY = String(style.overflowY || "").toLowerCase();
      if (overflowY !== "auto" && overflowY !== "scroll") continue;
      const rect = rectFrom(element);
      if (!rect || rect.height < 32) continue;
      if (anchorRect && rect.top >= anchorRect.top) continue;
      regions.push({
        element,
        primary: Boolean(element.hasAttribute && element.hasAttribute("data-app-action-sidebar-scroll")),
        beforeClientHeight: Number(element.clientHeight) || Math.round(rect.height),
        beforeScrollHeight: Number(element.scrollHeight) || Math.round(rect.height),
        beforeScrollTop: Math.max(0, Number(element.scrollTop) || 0),
        beforeMaxScroll: Math.max(0, (Number(element.scrollHeight) || Math.round(rect.height))
          - (Number(element.clientHeight) || Math.round(rect.height))),
        beforeAtBottom: Math.max(0, (Number(element.scrollHeight) || Math.round(rect.height))
          - (Number(element.clientHeight) || Math.round(rect.height)) - (Number(element.scrollTop) || 0)) <= 2,
        beforeOverflowY: overflowY,
        beforePaddingBottom: cssPixels(style.paddingBottom),
      });
    }
    return regions.slice(0, 8);
  }

  function validateLayout(sidebar, anchor, host, scrollRegions, panel, sidebarBaseline, options = {}) {
    if (!sidebar || !anchor || !host || !host.isConnected) return { ok: false, reason: "panel-disconnected" };
    if (host.parentElement !== anchor.parentElement || host.nextSibling !== anchor) {
      return { ok: false, reason: "panel-order-invalid" };
    }
    const sidebarRect = rectFrom(sidebar);
    const anchorRect = rectFrom(anchor);
    const hostRect = rectFrom(host);
    if (!sidebarRect || !anchorRect || !hostRect || hostRect.height <= 0 || hostRect.width <= 0) {
      return { ok: false, reason: "panel-geometry-invalid" };
    }
    const tolerance = 2;
    if (hostRect.left < sidebarRect.left - tolerance || hostRect.right > sidebarRect.right + tolerance) {
      return { ok: false, reason: "panel-horizontal-overflow" };
    }
    if (hostRect.top < sidebarRect.top - tolerance || hostRect.bottom > sidebarRect.bottom + tolerance) {
      return { ok: false, reason: "panel-vertical-overflow" };
    }
    if (anchorRect.top < sidebarRect.top - tolerance || anchorRect.bottom > sidebarRect.bottom + tolerance) {
      return { ok: false, reason: "account-footer-outside-sidebar" };
    }
    if (hostRect.bottom > anchorRect.top + tolerance) {
      return { ok: false, reason: "panel-overlaps-account-footer" };
    }
    const hostStyle = safeComputedStyle(host);
    const position = String(hostStyle.position || "static").toLowerCase();
    if (position !== "static") return { ok: false, reason: "panel-not-in-normal-flow" };
    const content = panel || (state.host === host ? state.panel : null);
    if (content) {
      const contentClientHeight = Number(content.clientHeight);
      const contentScrollHeight = Number(content.scrollHeight);
      const contentClientWidth = Number(content.clientWidth);
      const contentScrollWidth = Number(content.scrollWidth);
      if (contentClientHeight > 0 && contentScrollHeight > contentClientHeight + tolerance) {
        return { ok: false, reason: "panel-content-vertically-clipped" };
      }
      if (contentClientWidth > 0 && contentScrollWidth > contentClientWidth + tolerance) {
        return { ok: false, reason: "panel-content-horizontally-clipped" };
      }
    }
    const hostClientHeight = Number(host.clientHeight);
    const hostScrollHeight = Number(host.scrollHeight);
    if (hostClientHeight > 0 && hostScrollHeight > hostClientHeight + tolerance) {
      return { ok: false, reason: "panel-host-content-clipped" };
    }
    const afterHorizontalOverflow = Math.max(0, Number(sidebar.scrollWidth) - Number(sidebar.clientWidth));
    if (sidebarBaseline) {
      const beforeHorizontalOverflow = Math.max(
        0,
        Number(sidebarBaseline.scrollWidth) - Number(sidebarBaseline.clientWidth)
      );
      if (afterHorizontalOverflow > beforeHorizontalOverflow + tolerance) {
        return { ok: false, reason: "sidebar-horizontal-overflow-increased" };
      }
    } else if (afterHorizontalOverflow > tolerance) {
      return { ok: false, reason: "sidebar-horizontal-overflow" };
    }
    let pendingReservation = false;
    for (const region of scrollRegions || []) {
      if (!region.element || !region.element.isConnected) continue;
      const style = safeComputedStyle(region.element);
      const overflowY = String(style.overflowY || "").toLowerCase();
      const regionRect = rectFrom(region.element);
      const afterHeight = Number(region.element.clientHeight) || (regionRect || {}).height || 0;
      if ((region.beforeOverflowY === "auto" || region.beforeOverflowY === "scroll")
        && overflowY !== "auto" && overflowY !== "scroll") {
        return { ok: false, reason: "conversation-overflow-changed" };
      }
      if (region.beforeClientHeight >= 48 && afterHeight < 32) {
        return { ok: false, reason: "conversation-scroll-region-collapsed" };
      }
      if (options.enforceScrollRange && region.primary) {
        const afterMaxScroll = Math.max(0, Number(region.element.scrollHeight) - Number(region.element.clientHeight));
        const rangeGrowth = afterMaxScroll - region.beforeMaxScroll;
        if (rangeGrowth < -tolerance || rangeGrowth > hostRect.height + tolerance * 2) {
          return { ok: false, reason: "conversation-scroll-range-changed" };
        }
        if (region.beforeAtBottom && Math.abs(afterMaxScroll - Number(region.element.scrollTop)) > tolerance) {
          if (options.allowReservedBottomSettle) pendingReservation = true;
          else return { ok: false, reason: "conversation-bottom-position-changed" };
        }
      }
      if (regionRect) {
        const horizontalIntersection = Math.min(regionRect.right, hostRect.right) - Math.max(regionRect.left, hostRect.left);
        const reservedBottom = cssPixels(style.paddingBottom);
        const usableBottom = Math.max(regionRect.top, regionRect.bottom - reservedBottom);
        const verticalIntersection = Math.min(usableBottom, hostRect.bottom) - Math.max(regionRect.top, hostRect.top);
        if (horizontalIntersection > tolerance && verticalIntersection > tolerance) {
          const anchorWasInsideNativeReserve = region.beforePaddingBottom > 0
            && anchorRect.top >= regionRect.bottom - region.beforePaddingBottom - tolerance;
          const hostImmediatelyPrecedesAnchor = hostRect.bottom <= anchorRect.top + tolerance;
          if (options.allowReservedBottomSettle && anchorWasInsideNativeReserve && hostImmediatelyPrecedesAnchor) {
            pendingReservation = true;
            continue;
          }
          return { ok: false, reason: "panel-overlaps-conversation-scroll-region" };
        }
      }
    }
    const scrollDockElement = options.scrollDockElement
      || (state.host === host && state.scrollDock ? state.scrollDock.element : null);
    if (!scrollDockElement || !scrollDockElement.isConnected) {
      return { ok: false, reason: "conversation-scroll-dock-not-found" };
    }
    const scrollDockRect = rectFrom(scrollDockElement);
    if (!scrollDockRect) return { ok: false, reason: "conversation-scroll-dock-invalid" };
    if (scrollDockRect.bottom > hostRect.top + tolerance) {
      if (options.allowReservedBottomSettle && pendingReservation) {
        pendingReservation = true;
      } else {
        return { ok: false, reason: "conversation-scrollbar-overlaps-panel" };
      }
    }
    return {
      ok: true,
      reason: pendingReservation ? "layout-settling" : null,
      pending: pendingReservation,
    };
  }

  function detachPanel(reason) {
    stopResizeObserver();
    restoreNativeQuota();
    restoreScrollDock();
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    state.sidebar = null;
    state.anchor = null;
    state.host = null;
    state.shadow = null;
    state.panel = null;
    state.scrollRegions = null;
    state.scrollDock = null;
    state.sidebarBaseline = null;
    state.geometryValidated = false;
    state.mountedAtMs = null;
    state.anchorScore = null;
    state.reason = reason || "detached";
  }

  function stopMutationObserver() {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    state.observerTarget = null;
    if (state.reconcileTimer !== null) runtime.clearTimeout(state.reconcileTimer);
    state.reconcileTimer = null;
  }

  function stopResizeObserver() {
    if (state.resizeObserver) state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }

  function stopObservers() {
    stopMutationObserver();
    stopResizeObserver();
  }

  function scheduleReconcile() {
    if (state.reconcileTimer !== null || state.cleaned) return;
    state.reconcileTimer = runtime.setTimeout(() => {
      state.reconcileTimer = null;
      reconcile();
    }, RECONCILE_DEBOUNCE_MS);
  }

  function clearMountRetry() {
    if (state.mountRetryTimer !== null) runtime.clearTimeout(state.mountRetryTimer);
    state.mountRetryTimer = null;
    state.mountRetryAttempt = 0;
  }

  function scheduleMountRetry() {
    if (state.cleaned || state.mountRetryTimer !== null
      || state.mountRetryAttempt >= MOUNT_RETRY_DELAYS_MS.length
      || !runtime.location || runtime.location.protocol !== "app:") return;
    const delayMs = MOUNT_RETRY_DELAYS_MS[state.mountRetryAttempt];
    state.mountRetryAttempt += 1;
    state.mountRetryTimer = runtime.setTimeout(() => {
      state.mountRetryTimer = null;
      if (!state.cleaned) mount();
    }, delayMs);
  }

  function observeForRebuild(sidebar) {
    if (typeof runtime.MutationObserver !== "function") return;
    const target = (sidebar && sidebar.parentElement) || documentRef.documentElement || documentRef.body;
    if (!target || (state.observer && state.observerTarget === target)) return;
    stopMutationObserver();
    state.observer = new runtime.MutationObserver(scheduleReconcile);
    state.observer.observe(target, { childList: true, subtree: true });
    state.observerTarget = target;
    if (!state.host || !state.host.isConnected) scheduleMountRetry();
  }

  function observeForResize(sidebar, anchor, host, panel) {
    stopResizeObserver();
    if (typeof runtime.ResizeObserver !== "function") return;
    state.resizeObserver = new runtime.ResizeObserver(scheduleReconcile);
    for (const element of [sidebar, anchor, host, panel, state.scrollDock && state.scrollDock.element]) {
      if (element) state.resizeObserver.observe(element);
    }
  }

  function scheduleDomReadyMount() {
    if (!documentRef || state.domReadyHandler || documentRef.readyState !== "loading"
      || typeof documentRef.addEventListener !== "function") return;
    state.domReadyHandler = () => {
      state.domReadyHandler = null;
      if (!state.cleaned) mount();
    };
    documentRef.addEventListener("DOMContentLoaded", state.domReadyHandler, { once: true });
  }

  function clearDomReadyMount() {
    if (!state.domReadyHandler || !documentRef || typeof documentRef.removeEventListener !== "function") return;
    documentRef.removeEventListener("DOMContentLoaded", state.domReadyHandler);
    state.domReadyHandler = null;
  }

  function validateCurrentLayout() {
    return validateLayout(
      state.sidebar,
      state.anchor,
      state.host,
      state.scrollRegions,
      state.panel,
      state.sidebarBaseline,
      { scrollDockElement: state.scrollDock && state.scrollDock.element }
    );
  }

  function mount() {
    state.cleaned = false;
    ensureTimers();
    const shell = shellCheck();
    if (!shell.ok || !shell.sidebar.isConnected) {
      stopObservers();
      detachPanel(shell.ok ? "sidebar-not-connected" : shell.reason);
      if (runtime.location && runtime.location.protocol === "app:") {
        scheduleDomReadyMount();
        observeForRebuild(null);
      }
      return publicStatus();
    }
    clearDomReadyMount();
    const sidebar = shell.sidebar;

    if (state.host && state.host.isConnected && state.sidebar === sidebar && state.anchor && state.anchor.isConnected) {
      renderPreservingBottom();
      const validation = validateCurrentLayout();
      if (!validation.ok) {
        stopObservers();
        detachPanel(validation.reason);
        observeForRebuild(sidebar);
      } else if (syncNativeQuotaVisibility()) {
        scheduleReconcile();
      }
      return publicStatus();
    }

    // Do not observe our own insert/remove operations. Otherwise a failed
    // geometry probe could continuously remount itself on its own mutations.
    stopObservers();
    detachPanel("remounting");
    const anchorResult = findAnchor(sidebar);
    if (!anchorResult.candidate) {
      state.reason = anchorResult.reason;
      observeForRebuild(sidebar);
      return publicStatus();
    }

    const { anchor, parent, score } = anchorResult.candidate;
    if (!parent || anchor.parentElement !== parent) {
      state.reason = "anchor-detached";
      observeForRebuild(sidebar);
      return publicStatus();
    }

    const scrollRegions = findScrollRegions(sidebar, anchor);
    const sidebarBaseline = {
      clientWidth: Number(sidebar.clientWidth) || 0,
      scrollWidth: Number(sidebar.scrollWidth) || 0,
    };
    refreshLocale(false);
    const host = createElement("section");
    host.id = HOST_ID;
    host.setAttribute("aria-label", messagesFor(state.locale).heading);
    host.setAttribute("lang", state.locale);
    host.style.cssText = "display:block;position:static;flex:0 0 auto;align-self:stretch;inline-size:auto;max-inline-size:100%;min-inline-size:0;z-index:auto;pointer-events:none;overflow:hidden;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = createElement("style");
    style.textContent = panelCss();
    const panel = createElement("div", "quota-panel");
    shadow.appendChild(style);
    shadow.appendChild(panel);

    parent.insertBefore(host, anchor);
    state.sidebar = sidebar;
    state.anchor = anchor;
    state.host = host;
    state.shadow = shadow;
    state.panel = panel;
    state.scrollRegions = scrollRegions;
    state.sidebarBaseline = sidebarBaseline;
    state.anchorScore = score;
    state.mountedAtMs = now();
    state.reason = null;
    render();

    const scrollDockElement = applyScrollDock(scrollRegions);
    if (!scrollDockElement) {
      detachPanel("conversation-scroll-dock-not-found");
      observeForRebuild(sidebar);
      return publicStatus();
    }

    const validation = validateLayout(
      sidebar,
      anchor,
      host,
      scrollRegions,
      panel,
      sidebarBaseline,
      { allowReservedBottomSettle: true, enforceScrollRange: true, scrollDockElement }
    );
    if (!validation.ok) {
      detachPanel(validation.reason);
      observeForRebuild(sidebar);
      return publicStatus();
    }
    state.geometryValidated = !validation.pending;
    state.reason = validation.reason;
    clearMountRetry();
    observeForRebuild(sidebar);
    observeForResize(sidebar, anchor, host, panel);

    if (typeof runtime.requestAnimationFrame === "function") {
      runtime.requestAnimationFrame(() => runtime.requestAnimationFrame(() => {
        if (!state.host || state.host !== host) return;
        if (state.scrollDock && state.scrollDock.element === scrollDockElement) {
          alignBottomScrollAnchor(state.scrollDock.bottomAnchor);
        }
        const delayedValidation = validateLayout(
          sidebar,
          anchor,
          host,
          scrollRegions,
          panel,
          sidebarBaseline,
          { enforceScrollRange: true, scrollDockElement }
        );
        if (!delayedValidation.ok) {
          stopObservers();
          detachPanel(delayedValidation.reason);
          observeForRebuild(sidebar);
        }
        else {
          state.geometryValidated = true;
          state.reason = null;
          clearMountRetry();
          if (syncNativeQuotaVisibility()) scheduleReconcile();
        }
      }));
    }
    return publicStatus();
  }

  function reconcile() {
    if (state.cleaned || !documentRef) return publicStatus();
    const shell = shellCheck();
    if (!shell.ok) {
      stopObservers();
      detachPanel(shell.reason);
      if (runtime.location && runtime.location.protocol === "app:") {
        scheduleDomReadyMount();
        observeForRebuild(null);
      }
      return publicStatus();
    }
    const sidebar = shell.sidebar;
    const healthy = sidebar && sidebar === state.sidebar && state.host && state.host.isConnected
      && state.anchor && state.anchor.isConnected && state.host.nextSibling === state.anchor;
    if (!healthy) return mount();
    renderPreservingBottom();
    const validation = validateCurrentLayout();
    if (!validation.ok) {
      stopObservers();
      detachPanel(validation.reason);
      observeForRebuild(sidebar);
    } else {
      state.geometryValidated = true;
      clearMountRetry();
      if (syncNativeQuotaVisibility()) scheduleReconcile();
    }
    return publicStatus();
  }

  function update(value) {
    state.lastHeartbeatMs = now();
    const shell = shellCheck();
    if (!shell.ok) {
      stopObservers();
      detachPanel(shell.reason);
      if (runtime.location && runtime.location.protocol === "app:") {
        scheduleDomReadyMount();
        observeForRebuild(null);
      }
      return publicStatus();
    }
    let rawSnapshot = value;
    let explicitlyUnavailable = false;
    let cachedSnapshot = false;
    let reasonCode = null;
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "snapshot")) {
      rawSnapshot = value.snapshot;
      explicitlyUnavailable = value.availability === "unavailable";
      cachedSnapshot = value.availability === "cached";
      reasonCode = safeReasonCode(value.reasonCode);
    }
    const normalized = normalizeSnapshot(rawSnapshot);
    if (!normalized) {
      state.snapshot = null;
      state.explicitlyUnavailable = true;
      state.cachedSnapshot = false;
      state.unavailableReasonCode = reasonCode || "E_RATE_LIMIT_UNAVAILABLE";
    } else {
      state.snapshot = normalized;
      state.explicitlyUnavailable = explicitlyUnavailable;
      state.cachedSnapshot = cachedSnapshot && !explicitlyUnavailable;
      state.unavailableReasonCode = explicitlyUnavailable
        ? reasonCode || "E_RATE_LIMIT_UNAVAILABLE"
        : null;
    }
    return reconcile();
  }

  function unavailable(details) {
    state.lastHeartbeatMs = now();
    const shell = shellCheck();
    if (!shell.ok) {
      stopObservers();
      detachPanel(shell.reason);
      if (runtime.location && runtime.location.protocol === "app:") {
        scheduleDomReadyMount();
        observeForRebuild(null);
      }
      return publicStatus();
    }
    const reasonCode = typeof details === "string"
      ? safeReasonCode(details)
      : safeReasonCode(details && details.reasonCode);
    state.snapshot = null;
    state.explicitlyUnavailable = true;
    state.cachedSnapshot = false;
    state.unavailableReasonCode = reasonCode;
    return reconcile();
  }

  function heartbeat() {
    state.lastHeartbeatMs = now();
    if (state.cleaned) return mount();
    return reconcile();
  }

  function cleanup(reason = "manual-cleanup") {
    state.cleaned = true;
    clearMountRetry();
    detachPanel(reason);
    stopObservers();
    clearDomReadyMount();
    if (state.countdownTimer !== null) runtime.clearInterval(state.countdownTimer);
    if (state.heartbeatTimer !== null) runtime.clearInterval(state.heartbeatTimer);
    if (state.localeTimer !== null) runtime.clearInterval(state.localeTimer);
    if (state.languageChangeHandler && typeof runtime.removeEventListener === "function") {
      runtime.removeEventListener("languagechange", state.languageChangeHandler);
    }
    state.countdownTimer = null;
    state.heartbeatTimer = null;
    state.localeTimer = null;
    state.languageChangeHandler = null;
    return publicStatus();
  }

  function ensureTimers() {
    if (state.countdownTimer === null) {
      state.countdownTimer = runtime.setInterval(() => {
        if (state.host && state.host.isConnected) reconcile();
      }, 30 * 1000);
    }
    if (state.heartbeatTimer === null) {
      state.heartbeatTimer = runtime.setInterval(() => {
        if (!state.cleaned && now() - state.lastHeartbeatMs > HEARTBEAT_TIMEOUT_MS) {
          cleanup("heartbeat-timeout");
        }
      }, HEARTBEAT_CHECK_MS);
    }
    if (state.localeTimer === null) {
      state.localeTimer = runtime.setInterval(() => {
        if (!state.cleaned) refreshLocale(true);
      }, LOCALE_CHECK_MS);
    }
    if (!state.languageChangeHandler && typeof runtime.addEventListener === "function") {
      state.languageChangeHandler = () => {
        if (!state.cleaned) refreshLocale(true);
      };
      runtime.addEventListener("languagechange", state.languageChangeHandler);
    }
  }

  function publicStatus() {
    const currentFreshness = freshness(
      state.snapshot,
      now(),
      state.explicitlyUnavailable,
      state.cachedSnapshot
    );
    return {
      version: VERSION,
      locale: state.locale,
      formatLocale: state.formatLocale,
      localeSource: state.localeSource,
      mounted: Boolean(state.host && state.host.isConnected),
      freshness: currentFreshness,
      cached: state.cachedSnapshot,
      reason: state.reason,
      geometryValidated: state.geometryValidated,
      anchorScore: state.anchorScore,
      bucketCount: state.snapshot ? state.snapshot.buckets.length : 0,
      displayedBucketCount: currentFreshness !== "unavailable"
        && selectGeneralBucket(state.snapshot ? state.snapshot.buckets : []) ? 1 : 0,
      nativeQuotaHiddenCount: state.nativeQuotaHidden.size,
      scrollDocked: Boolean(state.scrollDock && state.scrollDock.element && state.scrollDock.element.isConnected),
      fetchedAtMs: state.snapshot ? state.snapshot.fetchedAtMs : null,
      lastHeartbeatMs: state.lastHeartbeatMs,
      sidebarConnected: Boolean(state.sidebar && state.sidebar.isConnected),
      cleaned: state.cleaned,
    };
  }

  const existing = runtime[GLOBAL_KEY];
  if (existing && existing.version === VERSION
    && typeof existing.mount === "function" && typeof existing.cleanup === "function") {
    existing.heartbeat();
    return existing.mount();
  }
  if (existing && typeof existing.cleanup === "function") {
    try { existing.cleanup("version-replaced"); } catch { /* Ignore an obsolete injector. */ }
  }

  const api = Object.freeze({
    version: VERSION,
    mount,
    update,
    unavailable,
    heartbeat,
    status: publicStatus,
    cleanup,
    __test: Object.freeze({
      clampPercent,
      normalizeSnapshot,
      canonicalIdentifier,
      isSparkBucket,
      formatPlanLabel,
      selectGeneralBucket,
      remainingTone,
      freshness,
      formatDuration,
      formatLimitLabel,
      formatCountdown,
      formatResetTime,
      codexReactIntlLocale,
      detectUiLocale,
      safeReasonCode,
      unavailableMessage,
      scoreAnchorMetrics,
      chooseUniqueScored,
      semanticSignals,
      captureBottomScrollAnchor,
      alignBottomScrollAnchor,
      validateLayout,
    }),
  });
  runtime[GLOBAL_KEY] = api;

  ensureTimers();
  return api.mount();
}());
