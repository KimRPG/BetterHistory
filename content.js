(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gestureDirection: "right",
    threshold: 90
  });
  const GESTURE_IDLE_MS = 190;
  const GESTURE_RELEASE_MS = 460;
  const HORIZONTAL_RATIO = 1.25;
  const VERTICAL_SELECTION_STEP = 38;

  let settings = { ...DEFAULT_SETTINGS };
  let swipeDistance = 0;
  let verticalDistance = 0;
  let selectionOffset = 0;
  let gestureTriggered = false;
  let verticalSelectionUsed = false;
  let gestureDirection = null;
  let menuDirection = null;
  let gestureTimer = null;
  let releaseTimer = null;
  let pendingReleaseSelection = false;
  let requestInFlight = false;
  let currentEntries = [];
  let selectedIndex = -1;
  let host = null;
  let shadow = null;
  let indicator = null;
  let panel = null;
  let list = null;
  let heading = null;
  let eyebrow = null;
  let gestureHelp = null;

  loadSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) settings[key] = changes[key].newValue;
    }

    settings = sanitizeSettings(settings);
    if (!settings.enabled) {
      resetGesture();
      closeMenu();
    }
  });

  window.addEventListener("wheel", handleWheel, {
    capture: true,
    passive: false
  });
  window.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("pointerdown", handleOutsidePointer, true);

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = sanitizeSettings(stored);
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  function sanitizeSettings(candidate) {
    const threshold = Number(candidate?.threshold);
    return {
      enabled: candidate?.enabled !== false,
      gestureDirection: candidate?.gestureDirection === "left" ? "left" : "right",
      threshold: [60, 90, 130].includes(threshold) ? threshold : DEFAULT_SETTINGS.threshold
    };
  }

  function handleWheel(event) {
    if (!settings.enabled || !event.isTrusted || event.ctrlKey) return;
    if (host && event.target === host) return;

    const deltaX = toPixels(event.deltaX, event.deltaMode);
    const deltaY = toPixels(event.deltaY, event.deltaMode);
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);

    if (gestureTriggered && isMenuOpen()) {
      if (!event.cancelable) return;
      event.preventDefault();

      if (absoluteY > 0.5 && absoluteY >= absoluteX * 0.55) {
        updateGestureSelection(event, deltaY);
      }

      scheduleGestureRelease();
      return;
    }

    const horizontal = absoluteX > absoluteY * HORIZONTAL_RATIO;
    if (!horizontal || absoluteX < 0.5) return;

    if (canScrollHorizontally(event.composedPath(), deltaX)) return;
    if (!event.cancelable) return;

    event.preventDefault();

    const direction = getHistoryDirection(deltaX);
    if (isMenuOpen()) {
      if (requestInFlight) return;
      closeMenu();
    }
    if (gestureDirection && gestureDirection !== direction) resetGesture();
    gestureDirection = direction;

    swipeDistance += absoluteX;
    showGestureIndicator(
      event.clientY,
      swipeDistance / settings.threshold,
      direction
    );

    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(resetGesture, GESTURE_IDLE_MS);

    if (gestureTriggered || swipeDistance < settings.threshold) return;

    gestureTriggered = true;
    clearTimeout(gestureTimer);
    gestureTimer = null;
    hideGestureIndicator();
    openHistoryMenu(direction);
    scheduleGestureRelease();
  }

  function getHistoryDirection(deltaX) {
    const isBackDirection = settings.gestureDirection === "right"
      ? deltaX < 0
      : deltaX > 0;
    return isBackDirection ? "back" : "forward";
  }

  function updateGestureSelection(event, deltaY) {
    const hasDeviceDirection = "webkitDirectionInvertedFromDevice" in event;
    const directionIsInverted = hasDeviceDirection
      ? event.webkitDirectionInvertedFromDevice
      : true;
    const fingerDeltaY = directionIsInverted ? -deltaY : deltaY;
    verticalDistance += fingerDeltaY;

    while (Math.abs(verticalDistance) >= VERTICAL_SELECTION_STEP) {
      const step = verticalDistance > 0 ? 1 : -1;
      verticalDistance -= step * VERTICAL_SELECTION_STEP;
      verticalSelectionUsed = true;
      moveSelectedEntry(step, false);
    }
  }

  function moveSelectedEntry(step, focusEntry) {
    if (!currentEntries.length) {
      selectionOffset = Math.max(0, selectionOffset + step);
      return;
    }

    const startIndex = selectedIndex < 0 ? 0 : selectedIndex;
    selectedIndex = Math.min(
      currentEntries.length - 1,
      Math.max(0, startIndex + step)
    );
    selectionOffset = selectedIndex;
    updateSelectedEntry(focusEntry);
  }

  function updateSelectedEntry(focusEntry = false) {
    const buttons = [...shadow.querySelectorAll(".entry")];
    buttons.forEach((button, index) => {
      const selected = index === selectedIndex;
      button.classList.toggle("selected", selected);
      if (selected) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });

    const selectedButton = buttons[selectedIndex];
    if (!selectedButton) return;
    selectedButton.scrollIntoView({ block: "nearest" });
    if (focusEntry) selectedButton.focus({ preventScroll: true });
  }

  function scheduleGestureRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(finishGestureAfterRelease, GESTURE_RELEASE_MS);
  }

  function finishGestureAfterRelease() {
    const shouldNavigate = verticalSelectionUsed;
    clearTimeout(releaseTimer);
    releaseTimer = null;

    if (shouldNavigate && requestInFlight) {
      pendingReleaseSelection = true;
      endGestureCapture({ keepPendingSelection: true });
      return;
    }

    endGestureCapture();
    if (shouldNavigate) navigateSelectedEntry();
  }

  function navigateSelectedEntry() {
    const entry = currentEntries[selectedIndex];
    const button = shadow?.querySelectorAll(".entry")?.[selectedIndex];
    pendingReleaseSelection = false;
    if (!entry || !button) return false;

    navigate(entry.id, button, menuDirection);
    return true;
  }

  function toPixels(delta, deltaMode) {
    if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
    if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * window.innerWidth;
    return delta;
  }

  function canScrollHorizontally(path, deltaX) {
    for (const node of path) {
      if (!(node instanceof Element) || node === document.documentElement) continue;

      const style = getComputedStyle(node);
      if (!/(auto|scroll|overlay)/.test(style.overflowX)) continue;

      const maxScroll = node.scrollWidth - node.clientWidth;
      if (maxScroll <= 2) continue;

      if (deltaX < 0 && node.scrollLeft > 1) return true;
      if (deltaX > 0 && node.scrollLeft < maxScroll - 1) return true;
    }

    const root = document.scrollingElement;
    if (root && root.scrollWidth - root.clientWidth > 2) {
      const maxScroll = root.scrollWidth - root.clientWidth;
      if (deltaX < 0 && root.scrollLeft > 1) return true;
      if (deltaX > 0 && root.scrollLeft < maxScroll - 1) return true;
    }

    return false;
  }

  function ensureUi() {
    if (host?.isConnected) return true;
    if (!document.documentElement) return false;

    host = document.createElement("div");
    host.setAttribute("data-swipe-back-history", "");
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("pointer-events", "none", "important");
    document.documentElement.append(host);

    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { color-scheme: light dark; }
        * { box-sizing: border-box; }
        .indicator {
          --progress: 0;
          align-items: center;
          background: rgba(31, 35, 41, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 999px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
          color: white;
          display: none;
          height: 46px;
          justify-content: center;
          left: 14px;
          opacity: calc(0.42 + var(--progress) * 0.58);
          pointer-events: none;
          position: fixed;
          top: 50%;
          transform: translateY(-50%) scale(calc(0.82 + var(--progress) * 0.18));
          width: 46px;
        }
        .indicator.visible { display: flex; }
        .indicator svg { height: 22px; width: 22px; }
        .indicator.forward { left: auto; right: 14px; }
        .indicator.forward svg { transform: rotate(180deg); }
        .panel {
          animation: enter 150ms cubic-bezier(.2, .8, .2, 1);
          background: rgba(250, 250, 252, 0.96);
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 16px;
          box-shadow: 0 22px 70px rgba(15, 23, 42, 0.28), 0 3px 12px rgba(15, 23, 42, 0.12);
          color: #15171a;
          display: none;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          left: 18px;
          max-height: min(620px, calc(100vh - 36px));
          overflow: hidden;
          pointer-events: auto;
          position: fixed;
          top: 50%;
          transform: translateY(-50%);
          width: min(390px, calc(100vw - 36px));
        }
        .panel.open { display: block; }
        .panel.forward {
          animation-name: enter-forward;
          left: auto;
          right: 18px;
        }
        @keyframes enter {
          from { opacity: 0; transform: translate(-10px, -50%) scale(.98); }
          to { opacity: 1; transform: translate(0, -50%) scale(1); }
        }
        @keyframes enter-forward {
          from { opacity: 0; transform: translate(10px, -50%) scale(.98); }
          to { opacity: 1; transform: translate(0, -50%) scale(1); }
        }
        .header {
          align-items: center;
          border-bottom: 1px solid rgba(15, 23, 42, 0.08);
          display: flex;
          gap: 12px;
          padding: 15px 14px 13px 18px;
        }
        .heading { flex: 1; min-width: 0; }
        .eyebrow {
          color: #737982;
          font-size: 11px;
          font-weight: 650;
          letter-spacing: .08em;
          line-height: 1.2;
          margin-bottom: 3px;
          text-transform: uppercase;
        }
        h2 {
          font-size: 15px;
          font-weight: 680;
          line-height: 1.35;
          margin: 0;
        }
        .close {
          align-items: center;
          appearance: none;
          background: transparent;
          border: 0;
          border-radius: 8px;
          color: #626872;
          cursor: pointer;
          display: flex;
          font: inherit;
          height: 30px;
          justify-content: center;
          padding: 0;
          width: 30px;
        }
        .close:hover, .close:focus-visible { background: rgba(15, 23, 42, .07); outline: none; }
        .list {
          max-height: min(530px, calc(100vh - 128px));
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 7px;
        }
        .entry {
          align-items: center;
          appearance: none;
          background: transparent;
          border: 0;
          border-radius: 10px;
          color: inherit;
          cursor: pointer;
          display: flex;
          font: inherit;
          gap: 11px;
          min-height: 58px;
          padding: 8px 10px;
          text-align: left;
          width: 100%;
        }
        .entry:hover, .entry:focus-visible { background: rgba(37, 99, 235, .09); outline: none; }
        .entry.selected {
          background: rgba(37, 99, 235, .13);
          box-shadow: inset 3px 0 #2563eb;
          outline: none;
        }
        .panel.forward .entry.selected { box-shadow: inset -3px 0 #2563eb; }
        .entry.pending { opacity: .55; pointer-events: none; }
        .site-mark {
          align-items: center;
          background: #e6eaf0;
          border: 1px solid rgba(15, 23, 42, .06);
          border-radius: 10px;
          color: #4d5662;
          display: flex;
          flex: 0 0 auto;
          font-size: 14px;
          font-weight: 750;
          height: 36px;
          justify-content: center;
          text-transform: uppercase;
          width: 36px;
        }
        .entry-copy { flex: 1; min-width: 0; }
        .title {
          display: block;
          font-size: 13px;
          font-weight: 620;
          line-height: 1.35;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .url {
          color: #747b85;
          display: block;
          font-size: 11px;
          line-height: 1.35;
          margin-top: 3px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .distance {
          color: #8a9099;
          flex: 0 0 auto;
          font-size: 10px;
          font-variant-numeric: tabular-nums;
        }
        .state {
          color: #6d737c;
          font-size: 13px;
          line-height: 1.55;
          padding: 34px 24px 38px;
          text-align: center;
        }
        .spinner {
          animation: spin .8s linear infinite;
          border: 2px solid rgba(37, 99, 235, .18);
          border-radius: 50%;
          border-top-color: #2563eb;
          height: 24px;
          margin: 0 auto 12px;
          width: 24px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error { color: #b42318; }
        .gesture-help {
          align-items: center;
          background: rgba(37, 99, 235, .055);
          border-top: 1px solid rgba(15, 23, 42, .08);
          color: #66707d;
          display: flex;
          font-size: 10px;
          gap: 7px;
          justify-content: center;
          line-height: 1.4;
          min-height: 34px;
          padding: 7px 12px;
          text-align: center;
        }
        .gesture-help b { color: #2563eb; font-size: 14px; line-height: 1; }
        @media (prefers-color-scheme: dark) {
          .panel { background: rgba(34, 36, 40, .97); border-color: rgba(255,255,255,.12); color: #f5f6f7; }
          .header { border-bottom-color: rgba(255,255,255,.09); }
          .eyebrow, .url, .state, .distance { color: #aeb4bd; }
          .close { color: #b7bdc6; }
          .close:hover, .close:focus-visible { background: rgba(255,255,255,.08); }
          .entry:hover, .entry:focus-visible { background: rgba(96,165,250,.14); }
          .entry.selected { background: rgba(96,165,250,.2); box-shadow: inset 3px 0 #60a5fa; }
          .panel.forward .entry.selected { box-shadow: inset -3px 0 #60a5fa; }
          .site-mark { background: #454a52; border-color: rgba(255,255,255,.06); color: #e2e6eb; }
          .gesture-help { background: rgba(96,165,250,.07); border-top-color: rgba(255,255,255,.09); color: #aeb4bd; }
          .gesture-help b { color: #60a5fa; }
        }
        @media (prefers-reduced-motion: reduce) {
          .panel { animation: none; }
          .spinner { animation-duration: 1.6s; }
        }
      </style>
      <div class="indicator" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m10 7-5 5 5 5"/><path d="M5 12h9a5 5 0 0 1 5 5"/>
        </svg>
      </div>
      <section class="panel" role="dialog" aria-modal="false" aria-labelledby="sbh-title">
        <header class="header">
          <div class="heading">
            <div class="eyebrow">Tab history</div>
            <h2 id="sbh-title">뒤로 갈 페이지</h2>
          </div>
          <button class="close" type="button" aria-label="닫기">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </header>
        <div class="list" role="list"></div>
        <div class="gesture-help"><b aria-hidden="true">↕</b><span>당긴 채 위·아래로 선택하고 손을 떼면 이동</span></div>
      </section>
    `;

    indicator = shadow.querySelector(".indicator");
    panel = shadow.querySelector(".panel");
    list = shadow.querySelector(".list");
    heading = shadow.querySelector("h2");
    eyebrow = shadow.querySelector(".eyebrow");
    gestureHelp = shadow.querySelector(".gesture-help span");
    shadow.querySelector(".close").addEventListener("click", closeMenu);
    return true;
  }

  function showGestureIndicator(clientY, progress, direction) {
    if (!ensureUi()) return;
    const clampedProgress = Math.min(1, Math.max(0.08, progress));
    const y = Number.isFinite(clientY) && clientY > 0
      ? Math.min(window.innerHeight - 48, Math.max(48, clientY))
      : window.innerHeight / 2;
    indicator.style.setProperty("--progress", String(clampedProgress));
    indicator.style.top = `${y}px`;
    indicator.classList.toggle("forward", direction === "forward");
    indicator.classList.add("visible");
  }

  function hideGestureIndicator() {
    indicator?.classList.remove("visible");
  }

  async function openHistoryMenu(direction) {
    if (!ensureUi() || requestInFlight) return;

    menuDirection = direction;
    currentEntries = [];
    selectedIndex = -1;
    selectionOffset = 0;
    pendingReleaseSelection = false;
    requestInFlight = true;
    panel.classList.toggle("forward", direction === "forward");
    panel.classList.add("open");
    eyebrow.textContent = direction === "forward" ? "Forward history" : "Back history";
    heading.textContent = direction === "forward" ? "앞으로 갈 페이지" : "뒤로 갈 페이지";
    gestureHelp.textContent = "당긴 채 위·아래로 선택하고 손을 떼면 이동";
    list.innerHTML = `<div class="state"><div class="spinner"></div>이 탭의 기록을 불러오는 중…</div>`;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_TAB_HISTORY",
        direction
      });
      if (!isMenuOpen() || menuDirection !== direction) return;
      if (!response?.ok) throw new Error(response?.error || "탭 히스토리를 불러오지 못했습니다.");
      renderEntries(response.entries || []);
    } catch (error) {
      renderState(error instanceof Error ? error.message : String(error), true);
    } finally {
      requestInFlight = false;
      if (pendingReleaseSelection) navigateSelectedEntry();
    }
  }

  function renderEntries(entries) {
    list.replaceChildren();
    currentEntries = entries;

    if (!entries.length) {
      const message = menuDirection === "forward"
        ? "이 탭에는 앞으로 갈 페이지가 없습니다."
        : "이 탭에는 돌아갈 이전 페이지가 없습니다.";
      renderState(message);
      return;
    }

    for (const entry of entries) {
      const button = document.createElement("button");
      button.className = "entry";
      button.type = "button";
      button.setAttribute("role", "listitem");

      const mark = document.createElement("span");
      mark.className = "site-mark";
      mark.textContent = siteInitial(entry.url);

      const copy = document.createElement("span");
      copy.className = "entry-copy";

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = entry.title || entry.url;

      const url = document.createElement("span");
      url.className = "url";
      url.textContent = displayUrl(entry.url);

      const distance = document.createElement("span");
      distance.className = "distance";
      distance.textContent = menuDirection === "forward"
        ? (entry.distance === 1 ? "바로 다음" : `${entry.distance}단계 후`)
        : (entry.distance === 1 ? "직전" : `${entry.distance}단계 전`);

      copy.append(title, url);
      button.append(mark, copy, distance);
      button.addEventListener("click", () => navigate(entry.id, button, menuDirection));
      list.append(button);
    }

    selectedIndex = Math.min(entries.length - 1, Math.max(0, selectionOffset));
    updateSelectedEntry();
  }

  function renderState(message, isError = false) {
    currentEntries = [];
    selectedIndex = -1;
    list.replaceChildren();
    const state = document.createElement("div");
    state.className = `state${isError ? " error" : ""}`;
    state.textContent = message;
    list.append(state);
  }

  async function navigate(entryId, button, direction) {
    if (requestInFlight) return;

    requestInFlight = true;
    button.classList.add("pending");
    button.setAttribute("aria-busy", "true");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "NAVIGATE_HISTORY",
        entryId,
        direction
      });
      if (!response?.ok) throw new Error(response?.error || "페이지로 이동하지 못했습니다.");
      closeMenu();
    } catch (error) {
      button.classList.remove("pending");
      button.removeAttribute("aria-busy");
      renderState(error instanceof Error ? error.message : String(error), true);
    } finally {
      requestInFlight = false;
    }
  }

  function displayUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const path = parsed.pathname === "/" ? "" : parsed.pathname;
      return `${parsed.hostname || parsed.protocol}${path}${parsed.search}`;
    } catch {
      return rawUrl;
    }
  }

  function siteInitial(rawUrl) {
    try {
      const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
      return (hostname[0] || "↩").toLocaleUpperCase();
    } catch {
      return "↩";
    }
  }

  function handleKeydown(event) {
    if (!isMenuOpen()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();
      navigateSelectedEntry();
      return;
    }

    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (!currentEntries.length) return;

    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    moveSelectedEntry(direction, true);
  }

  function handleOutsidePointer(event) {
    if (isMenuOpen() && event.target !== host) closeMenu();
  }

  function isMenuOpen() {
    return Boolean(panel?.classList.contains("open"));
  }

  function closeMenu() {
    panel?.classList.remove("open", "forward");
    currentEntries = [];
    selectedIndex = -1;
    menuDirection = null;
    endGestureCapture();
  }

  function resetGesture() {
    endGestureCapture();
  }

  function endGestureCapture({ keepPendingSelection = false } = {}) {
    clearTimeout(gestureTimer);
    clearTimeout(releaseTimer);
    gestureTimer = null;
    releaseTimer = null;
    swipeDistance = 0;
    verticalDistance = 0;
    selectionOffset = 0;
    gestureTriggered = false;
    verticalSelectionUsed = false;
    gestureDirection = null;
    if (!keepPendingSelection) pendingReleaseSelection = false;
    hideGestureIndicator();
  }
})();
