(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};
  const { DEFAULT_SETTINGS, sanitizeSettings } = namespace;
  const NAVIGATION_BLOCK_ATTRIBUTE = "data-gesture-back-history-navigation";
  const GESTURE_IDLE_MS = 190;
  // 관성이 없는 느린 릴리스는 입력이 끊긴 것으로만 알 수 있습니다. 그런데 당기다
  // 잠깐 쉬는 것도 똑같이 보이므로, 튕김을 관성으로 즉시 잡게 된 지금은 이쪽을
  // 넉넉히 기다려 주는 편이 낫습니다. 그래야 당기는 도중에 끊기지 않습니다.
  const GESTURE_RELEASE_MS = 450;
  const MENU_SELECTION_RELEASE_MS = 300;
  const GESTURE_SHIFT_SCALE = 0.42;
  const GESTURE_SHIFT_MAX = 40;
  // 세게 튕기면 손가락도 실제로 멀리 움직이기 때문에, 거리만 보면 오래 당긴
  // 것과 구분되지 않습니다. 진행 속도에 상한을 둬서 "빨리 튕겨 거리를 버는"
  // 경우를 막습니다. 기준 거리는 결국 최소 지속 시간으로도 작동합니다.
  const MAX_PULL_SPEED = 2;
  const MAX_STEP_MS = 50;
  // 관성 확정에는 길어야 몇 이벤트면 충분합니다. 그보다 오래 붙잡아 둔 거리는
  // 관성이었다면 이미 확정됐을 테니 손가락 입력으로 인정합니다. 무한정 쌓아
  // 두면 잠깐씩 느려지는 정상적인 당김의 절반이 통째로 버려집니다.
  const SETTLING_WINDOW_EVENTS = 6;
  const DEFAULT_STEP_MS = 16;
  const HORIZONTAL_RATIO = 1.25;
  const VERTICAL_SELECTION_STEP = 38;
  const SCROLL_OVERFLOW_TOLERANCE = 2;

  class GestureController {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.gestureTriggered = false;
      this.gestureDirection = null;
      this.gestureIdleTimer = null;
      this.pullDistance = 0;
      this.pendingPull = [];
      this.lastWheelAt = null;
      this.fingerStartedAt = null;
      this.lastFingerAt = 0;
      this.sawFingerInput = false;
      this.wheelPhase = new namespace.WheelPhaseTracker();
      this.log = new namespace.GestureLog((entry) => {
        void namespace.historyClient.logGesture(entry);
      });
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

      this.log.enabled = this.settings.debugLogging;
      this.updateNativeNavigationBlock();
    }

    handleStorageChange(changes, areaName) {
      if (areaName !== "sync") return;

      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[key]) this.settings[key] = changes[key].newValue;
      }

      this.settings = sanitizeSettings(this.settings);
      this.log.enabled = this.settings.debugLogging;
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

      // 세로 판정은 가로 판정과 대칭이어야 합니다. 기준이 느슨하면 비스듬히
      // 당기는 동작이 "당김"이면서 동시에 "선택"으로 잡혀, 메뉴가 열린 순간
      // 같은 손짓이 선택을 움직이고 엉뚱한 항목으로 이동해 버립니다.
      if (
        this.menu.isOpen() &&
        absoluteY > 0.5 &&
        absoluteY > absoluteX * HORIZONTAL_RATIO
      ) {
        this.updateMenuSelection(event, deltaY);
        return;
      }

      if (this.menu.isOpen()) {
        if (horizontal && event.cancelable) event.preventDefault();
        return;
      }

      if (this.menu.isEventFromUi(event)) return;

      if (!horizontal || absoluteX < 0.5) return;

      if (this.isInHorizontalScrollArea(event, deltaX)) return;
      if (!event.cancelable) return;

      event.preventDefault();

      if (this.gestureTriggered) {
        this.restartIdleTimer(() => this.endGestureCapture());
        return;
      }

      const direction = this.getHistoryDirection(deltaX);
      if (this.gestureDirection && this.gestureDirection !== direction) {
        this.endGestureCapture();
      }
      this.gestureDirection = direction;

      // 손가락이 실제로 움직인 만큼만 쌓습니다. 관성 구간은 이미 손을 뗀
      // 뒤라서 여기에 넣으면 짧게 튕긴 제스처가 길게 당긴 것처럼 보입니다.
      const phase = this.wheelPhase.update(event, deltaX);
      const fingerDelta = this.limitPullSpeed(event, getFingerDelta(event, deltaX));
      const momentum = phase === "momentum";

      this.log.start({
        direction,
        threshold: this.settings.pullDistancePx,
        holdThreshold: this.settings.pullHoldMs,
        at: event.timeStamp,
        nativeMomentum: typeof event.momentum === "boolean"
      });
      this.log.record({ phase, magnitude: absoluteX, at: event.timeStamp });

      if (phase !== "momentum") {
        // 손가락이 실제로 닿아 있던 구간만 시간으로 셉니다. 관성 꼬리는
        // 여기 들어오지 않으므로 "오래 당겼다"가 부풀지 않습니다.
        if (this.fingerStartedAt === null) this.fingerStartedAt = event.timeStamp;
        this.lastFingerAt = event.timeStamp;
      }

      if (phase === "finger") {
        this.sawFingerInput = true;
        this.pullDistance += this.drainPendingPull() + fingerDelta;
      } else if (phase === "settling") {
        // 느려지기 시작했지만 손을 뗀 것인지는 아직 모릅니다. 최근 몇 이벤트만
        // 붙잡아 두고, 그보다 오래된 것은 손가락 입력으로 확정합니다.
        this.pendingPull.push(fingerDelta);
        while (this.pendingPull.length > SETTLING_WINDOW_EVENTS) {
          this.pullDistance += this.pendingPull.shift();
        }
      } else {
        this.pendingPull.length = 0;
        if (!this.sawFingerInput) {
          // 직전 스크롤이 남긴 관성입니다. 이 제스처의 것이 아닙니다.
          return;
        }
      }

      const pulled = Math.abs(this.pullDistance);
      const heldMs = this.fingerStartedAt === null
        ? 0
        : this.lastFingerAt - this.fingerStartedAt;
      const reachedDistance = pulled >= this.settings.pullDistancePx;
      const reachedHold = heldMs >= this.settings.pullHoldMs;

      this.menu.showGestureIndicator({
        clientY: event.clientY,
        progress: Math.max(
          pulled / this.settings.pullDistancePx,
          heldMs / this.settings.pullHoldMs
        ),
        direction,
        shift: clamp(this.pullDistance * GESTURE_SHIFT_SCALE, GESTURE_SHIFT_MAX)
      });

      // 멀리 당기거나 오래 당기거나, 둘 중 하나만 넘으면 메뉴입니다.
      if (reachedDistance || reachedHold) {
        this.log.finish({
          action: "menu",
          release: reachedDistance ? "threshold" : "hold",
          pulled,
          heldMs,
          at: event.timeStamp
        });
        this.finishGesture(() => this.openHistoryMenu(direction));
        return;
      }

      // 관성이 시작됐다는 것은 손가락을 뗐다는 뜻입니다. 기준을 넘지 못했으니
      // 기다리지 않고 바로 한 단계만 이동합니다.
      if (momentum) {
        this.log.finish({
          action: "navigate",
          release: "momentum",
          pulled,
          heldMs,
          at: event.timeStamp
        });
        this.finishGesture(() => this.navigateOneStep(direction));
        return;
      }

      this.restartIdleTimer(
        () => this.finishShortGesture(),
        GESTURE_RELEASE_MS
      );
    }

    // 판정이 끝난 뒤에도 관성 이벤트가 한참 더 들어오므로, 입력이 잦아들 때까지
    // 삼키고 나서 상태를 정리합니다.
    finishGesture(action) {
      this.gestureTriggered = true;
      this.restartIdleTimer(() => this.endGestureCapture());
      this.menu.hideGestureIndicator();
      void action();
    }

    drainPendingPull() {
      const total = this.pendingPull.reduce((sum, value) => sum + value, 0);
      this.pendingPull.length = 0;
      return total;
    }

    // 한 이벤트가 기여할 수 있는 거리를 경과 시간에 비례해 제한합니다.
    // 트랙패드 보고 주기(60/120Hz)가 달라도 같은 속도 상한이 걸립니다.
    limitPullSpeed(event, fingerDelta) {
      const elapsed = this.lastWheelAt === null
        ? DEFAULT_STEP_MS
        : Math.min(MAX_STEP_MS, Math.max(1, event.timeStamp - this.lastWheelAt));
      this.lastWheelAt = event.timeStamp;

      const limit = MAX_PULL_SPEED * elapsed;
      return Math.sign(fingerDelta) * Math.min(Math.abs(fingerDelta), limit);
    }

    restartIdleTimer(onIdle, delay = GESTURE_IDLE_MS) {
      clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = setTimeout(onIdle, delay);
    }

    // 튕기지 않고 천천히 손을 떼면 관성이 없어서 이벤트가 그냥 끊깁니다.
    // 이때는 입력이 멈춘 것을 손을 뗀 것으로 봅니다.
    finishShortGesture() {
      const direction = this.gestureDirection;
      const pulled = Math.abs(this.pullDistance);
      const shouldNavigate = !this.gestureTriggered && direction !== null;
      this.log.finish({
        action: "navigate",
        release: "idle",
        pulled,
        heldMs: this.fingerStartedAt === null
          ? 0
          : this.lastFingerAt - this.fingerStartedAt
      });
      this.endGestureCapture();

      if (shouldNavigate) void this.navigateOneStep(direction);
    }

    async navigateOneStep(direction) {
      try {
        await namespace.historyClient.navigateOneStep(direction);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("GestureBackHistory: 한 단계 이동에 실패했습니다.", error);
        this.menu.showToast(message);
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

      // 메뉴를 연 제스처의 관성이 그대로 이어지면 선택이 저절로 움직입니다.
      if (this.wheelPhase.update(event, deltaY) === "momentum") return;

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

    endGestureCapture() {
      clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = null;
      this.gestureTriggered = false;
      this.gestureDirection = null;
      this.pullDistance = 0;
      this.pendingPull = [];
      this.lastWheelAt = null;
      this.fingerStartedAt = null;
      this.lastFingerAt = 0;
      this.sawFingerInput = false;
      this.wheelPhase.reset();
      this.log.reset();
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
