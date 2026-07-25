(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gestureDirection: "right"
  });
  const NAVIGATION_BLOCK_ATTRIBUTE = "data-gesture-back-history-navigation";
  const GESTURE_HOLD_MS = 500;
  const GESTURE_IDLE_MS = 190;
  const GESTURE_RELEASE_MS = 460;
  const HORIZONTAL_RATIO = 1.25;
  const VERTICAL_SELECTION_STEP = 38;
  const DISMISS_GESTURE_THRESHOLD = 28;
  const DISMISS_GESTURE_MAX_DISTANCE = 72;

  class GestureController {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.gestureStartedAt = null;
      this.verticalDistance = 0;
      this.gestureTriggered = false;
      this.verticalSelectionUsed = false;
      this.gestureDirection = null;
      this.gestureIdleTimer = null;
      this.releaseTimer = null;
      this.dismissTimer = null;
      this.dismissDistance = 0;
      this.dismissGestureActive = false;
      this.dismissArmed = false;
      this.pendingReleaseSelection = false;
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

      const deltaX = toPixels(event.deltaX, event.deltaMode);
      const deltaY = toPixels(event.deltaY, event.deltaMode);
      const absoluteX = Math.abs(deltaX);
      const absoluteY = Math.abs(deltaY);
      const horizontal = absoluteX > absoluteY * HORIZONTAL_RATIO;
      const eventFromExtensionUi = this.menu.isEventFromUi(event);

      if (this.dismissGestureActive && this.menu.isOpen()) {
        this.updateDismissGesture(event, deltaX);
        return;
      }

      if (
        eventFromExtensionUi &&
        (!this.menu.isOpen() || !horizontal || getFingerDelta(event, deltaX) <= 0)
      ) {
        return;
      }

      if (this.gestureTriggered && this.menu.isOpen()) {
        if (!event.cancelable) return;
        event.preventDefault();

        if (absoluteY > 0.5 && absoluteY >= absoluteX * 0.55) {
          this.updateGestureSelection(event, deltaY);
        }

        this.scheduleGestureRelease();
        return;
      }

      if (!horizontal || absoluteX < 0.5) return;

      if (this.menu.isOpen() && getFingerDelta(event, deltaX) > 0) {
        this.updateDismissGesture(event, deltaX);
        return;
      }

      if (canScrollHorizontally(event.composedPath(), deltaX)) return;
      if (!event.cancelable) return;

      event.preventDefault();

      const direction = this.getHistoryDirection(deltaX);
      if (this.menu.isOpen()) {
        if (this.menu.isBusy()) return;
        this.closeMenu();
      }
      if (this.gestureDirection && this.gestureDirection !== direction) {
        this.resetGesture();
      }
      this.gestureDirection = direction;

      if (this.gestureStartedAt === null) {
        this.gestureStartedAt = event.timeStamp;
      }
      const gestureDuration = Math.max(0, event.timeStamp - this.gestureStartedAt);
      this.menu.showGestureIndicator(
        event.clientY,
        gestureDuration / GESTURE_HOLD_MS,
        direction
      );

      clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = setTimeout(
        () => this.finishShortGesture(),
        GESTURE_IDLE_MS
      );

      if (this.gestureTriggered || gestureDuration < GESTURE_HOLD_MS) {
        return;
      }

      this.gestureTriggered = true;
      clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = null;
      this.menu.hideGestureIndicator();
      this.pendingReleaseSelection = false;
      void this.openHistoryMenu(direction);
      this.scheduleGestureRelease();
    }

    finishShortGesture() {
      const direction = this.gestureDirection;
      const shouldNavigate = !this.gestureTriggered && direction !== null;
      this.endGestureCapture();
      if (shouldNavigate) void this.navigateOneStep(direction);
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

    updateGestureSelection(event, deltaY) {
      this.verticalDistance += getFingerDelta(event, deltaY);

      while (Math.abs(this.verticalDistance) >= VERTICAL_SELECTION_STEP) {
        const step = this.verticalDistance > 0 ? 1 : -1;
        this.verticalDistance -= step * VERTICAL_SELECTION_STEP;
        this.verticalSelectionUsed = true;
        this.menu.moveSelection(step);
      }
    }

    updateDismissGesture(event, deltaX) {
      if (!event.cancelable) return;
      event.preventDefault();

      this.dismissGestureActive = true;
      this.dismissDistance = Math.min(
        DISMISS_GESTURE_MAX_DISTANCE,
        Math.max(0, this.dismissDistance + getFingerDelta(event, deltaX))
      );
      this.dismissArmed = this.dismissDistance >= DISMISS_GESTURE_THRESHOLD;
      this.menu.setDismissPreview(
        this.dismissDistance,
        DISMISS_GESTURE_THRESHOLD,
        this.dismissArmed
      );

      clearTimeout(this.dismissTimer);
      this.dismissTimer = setTimeout(
        () => this.finishDismissGesture(),
        GESTURE_RELEASE_MS
      );
    }

    finishDismissGesture() {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;

      if (this.dismissArmed) {
        this.closeMenu();
        return;
      }

      this.cancelDismissGesture();
    }

    cancelDismissGesture({ restoreHelp = true } = {}) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
      this.dismissDistance = 0;
      this.dismissGestureActive = false;
      this.dismissArmed = false;
      this.menu.cancelDismissPreview({ restoreHelp });
    }

    scheduleGestureRelease() {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = setTimeout(
        () => this.finishGestureAfterRelease(),
        GESTURE_RELEASE_MS
      );
    }

    finishGestureAfterRelease() {
      const shouldNavigate = this.verticalSelectionUsed;
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;

      if (shouldNavigate && this.menu.isBusy()) {
        this.pendingReleaseSelection = true;
        this.endGestureCapture({ keepPendingSelection: true });
        return;
      }

      this.endGestureCapture();
      if (shouldNavigate) void this.navigateSelectedEntry();
    }

    async openHistoryMenu(direction) {
      await this.menu.open(direction);
      if (this.pendingReleaseSelection) void this.navigateSelectedEntry();
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

    handleKeydown(event) {
      this.menu.handleKeydown(event);
    }

    handleOutsidePointer(event) {
      if (this.menu.isOpen() && !this.menu.isEventFromUi(event)) {
        this.closeMenu();
      }
    }

    closeMenu() {
      this.cancelDismissGesture({ restoreHelp: false });
      this.menu.close();
      this.endGestureCapture();
    }

    resetGesture() {
      this.endGestureCapture();
    }

    endGestureCapture({ keepPendingSelection = false } = {}) {
      clearTimeout(this.gestureIdleTimer);
      clearTimeout(this.releaseTimer);
      this.gestureIdleTimer = null;
      this.releaseTimer = null;
      this.gestureStartedAt = null;
      this.verticalDistance = 0;
      this.gestureTriggered = false;
      this.verticalSelectionUsed = false;
      this.gestureDirection = null;
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
