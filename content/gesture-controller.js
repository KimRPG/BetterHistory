(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};
  const { DEFAULT_SETTINGS, sanitizeSettings } = namespace;
  const isReversedHoldDuration = namespace.usesReversedGestureOrder;
  const NAVIGATION_BLOCK_ATTRIBUTE = "data-gesture-back-history-navigation";
  const GESTURE_IDLE_MS = 190;
  const MENU_SELECTION_RELEASE_MS = 300;
  const GESTURE_SHIFT_SCALE = 0.42;
  const GESTURE_SHIFT_MAX = 40;
  const HORIZONTAL_RATIO = 1.25;
  const VERTICAL_SELECTION_STEP = 38;
  const SCROLL_OVERFLOW_TOLERANCE = 2;

  class GestureController {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.gestureStartedAt = null;
      this.gestureTriggered = false;
      this.gestureDirection = null;
      this.gestureIdleTimer = null;
      this.gestureShift = 0;
      this.scrollAreaCache = null;
      this.menuSelectionDistance = 0;
      this.menuSelectionUsed = false;
      this.menuSelectionTimer = null;
      this.pendingMenuSelection = false;
      this.waitingForDocumentRoot = false;

      this.menu = new namespace.HistoryMenu(namespace.historyClient, {
        onCloseRequest: () => this.closeMenu(),
        onSelect: (entry, button) => {
          void this.navigateEntry(entry, button);
        }
      });

      this.handleWheel = this.handleWheel.bind(this);
      this.handleKeydown = this.handleKeydown.bind(this);
      this.handleOutsidePointer = this.handleOutsidePointer.bind(this);
      this.handleStorageChange = this.handleStorageChange.bind(this);
      this.handleDocumentReady = this.handleDocumentReady.bind(this);
    }

    start() {
      void this.loadSettings();
      chrome.storage.onChanged.addListener(this.handleStorageChange);
      window.addEventListener("wheel", this.handleWheel, {
        capture: true,
        passive: false
      });
      window.addEventListener("keydown", this.handleKeydown, true);
      window.addEventListener("pointerdown", this.handleOutsidePointer, true);
    }

    async loadSettings() {
      try {
        const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
        this.settings = sanitizeSettings(stored);
      } catch {
        this.settings = { ...DEFAULT_SETTINGS };
      }

      this.updateNativeNavigationBlock();
    }

    handleStorageChange(changes, areaName) {
      if (areaName !== "sync") return;

      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[key]) this.settings[key] = changes[key].newValue;
      }

      this.settings = sanitizeSettings(this.settings);
      this.updateNativeNavigationBlock();
      if (!this.settings.enabled) this.closeMenu();
    }

    updateNativeNavigationBlock() {
      const root = document.documentElement;
      if (!root) {
        if (!this.waitingForDocumentRoot) {
          this.waitingForDocumentRoot = true;
          document.addEventListener(
            "DOMContentLoaded",
            this.handleDocumentReady,
            { once: true }
          );
        }
        return;
      }

      root.toggleAttribute(NAVIGATION_BLOCK_ATTRIBUTE, this.settings.enabled);
    }

    handleDocumentReady() {
      this.waitingForDocumentRoot = false;
      this.updateNativeNavigationBlock();
    }

    handleWheel(event) {
      if (!this.settings.enabled || !event.isTrusted || event.ctrlKey) return;

      const deltaX = toPixels(event.deltaX, event.deltaMode, "x");
      const deltaY = toPixels(event.deltaY, event.deltaMode, "y");
      const absoluteX = Math.abs(deltaX);
      const absoluteY = Math.abs(deltaY);
      const horizontal = absoluteX > absoluteY * HORIZONTAL_RATIO;
      const eventFromExtensionUi = this.menu.isEventFromUi(event);

      if (
        this.menu.isOpen() &&
        absoluteY > 0.5 &&
        absoluteY >= absoluteX * 0.55
      ) {
        this.updateMenuSelection(event, deltaY);
        return;
      }

      if (this.menu.isOpen()) {
        if (horizontal && event.cancelable) event.preventDefault();
        return;
      }

      if (eventFromExtensionUi) return;

      if (!horizontal || absoluteX < 0.5) return;

      if (this.isInHorizontalScrollArea(event, deltaX)) return;
      if (!event.cancelable) return;

      event.preventDefault();

      if (this.gestureTriggered) {
        clearTimeout(this.gestureIdleTimer);
        this.gestureIdleTimer = setTimeout(
          () => this.endGestureCapture(),
          GESTURE_IDLE_MS
        );
        return;
      }

      const direction = this.getHistoryDirection(deltaX);
      if (this.gestureDirection && this.gestureDirection !== direction) {
        this.resetGesture();
      }
      this.gestureDirection = direction;
      this.gestureShift = clamp(
        this.gestureShift + getFingerDelta(event, deltaX) * GESTURE_SHIFT_SCALE,
        GESTURE_SHIFT_MAX
      );

      if (this.gestureStartedAt === null) {
        this.gestureStartedAt = event.timeStamp;
      }
      const gestureDuration = Math.max(0, event.timeStamp - this.gestureStartedAt);
      this.menu.showGestureIndicator({
        clientY: event.clientY,
        progress: gestureDuration / this.settings.holdDurationMs,
        direction,
        shift: this.gestureShift
      });

      clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = setTimeout(
        () => this.finishShortGesture(),
        GESTURE_IDLE_MS
      );

      if (gestureDuration < this.settings.holdDurationMs) {
        return;
      }

      if (this.usesReversedGestureOrder()) {
        this.endGestureCapture();
        void this.openHistoryMenu(direction);
        return;
      }

      this.gestureTriggered = true;
      clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = setTimeout(
        () => this.endGestureCapture(),
        GESTURE_IDLE_MS
      );
      this.menu.hideGestureIndicator();
      void this.navigateOneStep(direction);
    }

    finishShortGesture() {
      const direction = this.gestureDirection;
      const shouldHandleGesture = !this.gestureTriggered && direction !== null;
      const shouldNavigate = shouldHandleGesture && this.usesReversedGestureOrder();
      this.endGestureCapture();
      if (!shouldHandleGesture) return;

      if (shouldNavigate) {
        void this.navigateOneStep(direction);
      } else {
        void this.openHistoryMenu(direction);
      }
    }

    usesReversedGestureOrder() {
      return isReversedHoldDuration(this.settings.holdDurationMs);
    }

    async navigateOneStep(direction) {
      try {
        await namespace.historyClient.navigateOneStep(direction);
      } catch (error) {
        console.warn("GestureBackHistory: 한 단계 이동에 실패했습니다.", error);
      }
    }

    getHistoryDirection(deltaX) {
      const isBackDirection = this.settings.gestureDirection === "right"
        ? deltaX < 0
        : deltaX > 0;
      return isBackDirection ? "back" : "forward";
    }

    // 휠 이벤트마다 합성 경로 전체의 계산된 스타일을 읽는 것은 비싸므로,
    // 같은 대상·같은 방향으로 이어지는 한 제스처 동안은 판정을 재사용합니다.
    isInHorizontalScrollArea(event, deltaX) {
      const sign = deltaX < 0 ? -1 : 1;
      const cache = this.scrollAreaCache;

      if (
        cache &&
        cache.target === event.target &&
        cache.sign === sign &&
        event.timeStamp - cache.at < GESTURE_IDLE_MS
      ) {
        cache.at = event.timeStamp;
        return cache.blocked;
      }

      const blocked = isHorizontalScrollArea(event.composedPath(), deltaX);
      this.scrollAreaCache = {
        target: event.target,
        sign,
        at: event.timeStamp,
        blocked
      };
      return blocked;
    }

    updateMenuSelection(event, deltaY) {
      if (!event.cancelable) return;
      event.preventDefault();

      this.menuSelectionDistance += getFingerDelta(event, deltaY);

      while (Math.abs(this.menuSelectionDistance) >= VERTICAL_SELECTION_STEP) {
        const step = this.menuSelectionDistance > 0 ? 1 : -1;
        this.menuSelectionDistance -= step * VERTICAL_SELECTION_STEP;
        this.menuSelectionUsed = true;
        this.menu.moveSelection(step);
      }

      clearTimeout(this.menuSelectionTimer);
      this.menuSelectionTimer = setTimeout(
        () => this.finishMenuSelection(),
        MENU_SELECTION_RELEASE_MS
      );
    }

    finishMenuSelection() {
      const shouldNavigate = this.menuSelectionUsed;
      clearTimeout(this.menuSelectionTimer);
      this.menuSelectionTimer = null;
      this.menuSelectionDistance = 0;
      this.menuSelectionUsed = false;

      if (!shouldNavigate) return;
      if (this.menu.isBusy()) {
        this.pendingMenuSelection = true;
        return;
      }

      void this.navigateSelectedEntry();
    }

    resetMenuSelection() {
      clearTimeout(this.menuSelectionTimer);
      this.menuSelectionTimer = null;
      this.menuSelectionDistance = 0;
      this.menuSelectionUsed = false;
      this.pendingMenuSelection = false;
    }

    async openHistoryMenu(direction) {
      const opened = await this.menu.open(direction);
      if (opened && this.pendingMenuSelection) {
        void this.navigateSelectedEntry();
      } else if (!opened) {
        this.pendingMenuSelection = false;
      }
    }

    async navigateSelectedEntry() {
      const selected = this.menu.getSelected();
      this.pendingMenuSelection = false;
      if (!selected) return false;
      return this.navigateEntry(selected.entry, selected.button);
    }

    async navigateEntry(entry, button) {
      const succeeded = await this.menu.navigate(entry, button);
      if (succeeded) this.closeMenu();
      return succeeded;
    }

    handleKeydown(event) {
      this.menu.handleKeydown(event);
    }

    handleOutsidePointer(event) {
      if (this.menu.isOpen() && !this.menu.isEventFromUi(event)) {
        this.closeMenu();
      }
    }

    closeMenu() {
      this.resetMenuSelection();
      this.menu.close();
      this.endGestureCapture();
    }

    resetGesture() {
      this.endGestureCapture();
    }

    endGestureCapture() {
      clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = null;
      this.gestureStartedAt = null;
      this.gestureTriggered = false;
      this.gestureDirection = null;
      this.gestureShift = 0;
      this.scrollAreaCache = null;
      this.menu.hideGestureIndicator();
    }
  }

  function clamp(value, limit) {
    return Math.min(limit, Math.max(-limit, value));
  }

  function getFingerDelta(event, wheelDelta) {
    const hasDeviceDirection = "webkitDirectionInvertedFromDevice" in event;
    const directionIsInverted = hasDeviceDirection
      ? event.webkitDirectionInvertedFromDevice
      : true;
    return directionIsInverted ? -wheelDelta : wheelDelta;
  }

  function toPixels(delta, deltaMode, axis) {
    if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
    if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return delta * (axis === "y" ? window.innerHeight : window.innerWidth);
    }
    return delta;
  }

  function isHorizontalScrollArea(path, deltaX) {
    for (const node of path) {
      if (!(node instanceof Element) || node === document.documentElement) continue;

      const style = getComputedStyle(node);
      if (!/(auto|scroll|overlay)/.test(style.overflowX)) continue;

      // 중첩 스크롤러는 끝에 도달했더라도 제스처를 넘기지 않습니다.
      if (node.scrollWidth - node.clientWidth > SCROLL_OVERFLOW_TOLERANCE) return true;
    }

    // 문서 자체는 이 방향으로 실제 더 스크롤될 때만 양보합니다. 그렇지 않으면
    // 몇 px만 가로로 넘치는 흔한 페이지에서 제스처가 통째로 죽습니다.
    const root = document.scrollingElement;
    return Boolean(root) && canScrollHorizontally(root, deltaX);
  }

  function canScrollHorizontally(element, deltaX) {
    const maxScrollLeft = element.scrollWidth - element.clientWidth;
    if (maxScrollLeft <= SCROLL_OVERFLOW_TOLERANCE) return false;

    return deltaX < 0
      ? element.scrollLeft > SCROLL_OVERFLOW_TOLERANCE
      : element.scrollLeft < maxScrollLeft - SCROLL_OVERFLOW_TOLERANCE;
  }

  namespace.GestureController = GestureController;
})();
