(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gestureDirection: "right"
  });

  const ROOT_ACTIVE_ATTRIBUTE = "data-gesture-back-history-navigation";
  const PHASE = Object.freeze({
    IDLE: "idle",
    TRACKING: "tracking",
    MENU: "menu",
    COOLDOWN: "cooldown"
  });

  const HOLD_DURATION_MS = 500;
  const RELEASE_IDLE_MS = 140;
  const MENU_RELEASE_IDLE_MS = 220;
  const HORIZONTAL_RATIO = 1.25;
  const VERTICAL_RATIO = 0.55;
  const VERTICAL_SELECTION_STEP = 38;
  const MIN_GESTURE_DISTANCE = 24;

  class GestureController {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.phase = PHASE.IDLE;
      this.direction = null;
      this.analyzer = new namespace.GestureAnalyzer();
      this.verticalDistance = 0;
      this.verticalSelectionUsed = false;
      this.pendingReleaseSelection = false;
      this.holdTimer = null;
      this.releaseTimer = null;
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

      root.toggleAttribute(ROOT_ACTIVE_ATTRIBUTE, this.settings.enabled);
    }

    handleDocumentReady() {
      this.waitingForDocumentRoot = false;
      this.updateNativeNavigationBlock();
    }

    handleWheel(event) {
      if (!this.settings.enabled || !event.isTrusted || event.ctrlKey) return;

      const deltaX = toPixels(event.deltaX, event.deltaMode);
      const deltaY = toPixels(event.deltaY, event.deltaMode);
      const absoluteX = Math.abs(deltaX);
      const absoluteY = Math.abs(deltaY);

      if (this.phase === PHASE.COOLDOWN) {
        this.consume(event);
        this.scheduleCooldownEnd();
        return;
      }

      if (this.phase === PHASE.MENU) {
        this.handleMenuGesture(event, deltaX, deltaY);
        return;
      }

      const horizontal = absoluteX > absoluteY * HORIZONTAL_RATIO;
      if (!horizontal || absoluteX < 0.5) return;
      if (this.menu.isOpen() && this.menu.isEventFromUi(event)) return;
      if (canScrollHorizontally(event.composedPath(), deltaX)) return;
      if (!this.consume(event)) return;

      const direction = this.getHistoryDirection(deltaX);
      if (this.menu.isOpen()) this.closeMenu();

      if (this.phase === PHASE.TRACKING && this.direction !== direction) {
        this.resetGesture();
      }

      if (this.phase === PHASE.IDLE) {
        this.beginGesture(direction, event.timeStamp);
      }

      this.analyzer.record(absoluteX, event.timeStamp);
      this.menu.showGestureIndicator(
        event.clientY,
        this.analyzer.elapsed(event.timeStamp) / HOLD_DURATION_MS,
        direction
      );
      this.scheduleQuickRelease();
    }

    beginGesture(direction, timeStamp) {
      this.phase = PHASE.TRACKING;
      this.direction = direction;
      this.analyzer.begin(timeStamp);

      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(
        () => this.tryOpenHeldMenu(),
        HOLD_DURATION_MS
      );
    }

    scheduleQuickRelease() {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = setTimeout(
        () => this.commitQuickNavigation(),
        RELEASE_IDLE_MS
      );
    }

    tryOpenHeldMenu() {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
      if (this.phase !== PHASE.TRACKING) return false;

      if (!this.analyzer.isHeldInput(MIN_GESTURE_DISTANCE)) return false;

      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      this.phase = PHASE.MENU;
      this.verticalDistance = 0;
      this.verticalSelectionUsed = false;
      this.pendingReleaseSelection = false;
      this.menu.hideGestureIndicator();
      void this.openHistoryMenu(this.direction);
      this.scheduleMenuRelease();
      return true;
    }

    commitQuickNavigation() {
      if (this.phase !== PHASE.TRACKING) return false;

      const direction = this.direction;
      const shouldNavigate = this.analyzer.totalDistance >= MIN_GESTURE_DISTANCE;
      this.resetGesture();
      if (!shouldNavigate) return false;

      this.phase = PHASE.COOLDOWN;
      this.scheduleCooldownEnd();
      void this.navigateOneStep(direction);
      return true;
    }

    scheduleCooldownEnd() {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = setTimeout(
        () => this.resetGesture(),
        RELEASE_IDLE_MS
      );
    }

    handleMenuGesture(event, deltaX, deltaY) {
      if (!this.consume(event)) return;

      const absoluteX = Math.abs(deltaX);
      const absoluteY = Math.abs(deltaY);
      if (absoluteY > 0.5 && absoluteY >= absoluteX * VERTICAL_RATIO) {
        this.verticalDistance += getFingerDelta(event, deltaY);

        while (Math.abs(this.verticalDistance) >= VERTICAL_SELECTION_STEP) {
          const step = this.verticalDistance > 0 ? 1 : -1;
          this.verticalDistance -= step * VERTICAL_SELECTION_STEP;
          this.verticalSelectionUsed = true;
          this.menu.moveSelection(step);
        }
      }

      this.scheduleMenuRelease();
    }

    scheduleMenuRelease() {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = setTimeout(
        () => this.finishMenuGesture(),
        MENU_RELEASE_IDLE_MS
      );
    }

    finishMenuGesture() {
      const shouldNavigate = this.verticalSelectionUsed;
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;

      if (shouldNavigate && this.menu.isBusy()) {
        this.pendingReleaseSelection = true;
        this.resetGesture({ keepPendingSelection: true });
        return;
      }

      this.resetGesture();
      if (shouldNavigate) void this.navigateSelectedEntry();
    }

    async openHistoryMenu(direction) {
      await this.menu.open(direction);
      if (this.pendingReleaseSelection) void this.navigateSelectedEntry();
    }

    async navigateOneStep(direction) {
      try {
        await namespace.historyClient.navigateOneStep(direction);
      } catch (error) {
        console.warn("GestureBackHistory: 한 단계 이동에 실패했습니다.", error);
      }
    }

    async navigateSelectedEntry() {
      const selected = this.menu.getSelected();
      this.pendingReleaseSelection = false;
      if (!selected) return false;
      return this.navigateEntry(selected.entry, selected.button);
    }

    async navigateEntry(entry, button) {
      const succeeded = await this.menu.navigate(entry, button);
      if (succeeded) this.closeMenu();
      return succeeded;
    }

    consume(event) {
      if (!event.cancelable) return false;
      event.preventDefault();
      return true;
    }

    getHistoryDirection(deltaX) {
      const isBackDirection = this.settings.gestureDirection === "right"
        ? deltaX < 0
        : deltaX > 0;
      return isBackDirection ? "back" : "forward";
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
      this.menu.close();
      this.resetGesture();
    }

    resetGesture({ keepPendingSelection = false } = {}) {
      clearTimeout(this.holdTimer);
      clearTimeout(this.releaseTimer);
      this.holdTimer = null;
      this.releaseTimer = null;
      this.phase = PHASE.IDLE;
      this.direction = null;
      this.analyzer.reset();
      this.verticalDistance = 0;
      this.verticalSelectionUsed = false;
      if (!keepPendingSelection) this.pendingReleaseSelection = false;
      this.menu.hideGestureIndicator();
    }
  }

  function sanitizeSettings(candidate) {
    return {
      enabled: candidate?.enabled !== false,
      gestureDirection: candidate?.gestureDirection === "left" ? "left" : "right"
    };
  }

  function getFingerDelta(event, wheelDelta) {
    const hasDeviceDirection = "webkitDirectionInvertedFromDevice" in event;
    const directionIsInverted = hasDeviceDirection
      ? event.webkitDirectionInvertedFromDevice
      : true;
    return directionIsInverted ? -wheelDelta : wheelDelta;
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

  namespace.GestureController = GestureController;
})();
