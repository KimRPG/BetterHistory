(() => {
  "use strict";

  const namespace = globalThis.BetterGesture ??= {};
  const { DEFAULT_SETTINGS, isSiteDisabled, sanitizeSettings, toSiteKey } =
    namespace;
  const NAVIGATION_BLOCK_ATTRIBUTE = "data-better-gesture-navigation";
  const GESTURE_IDLE_MS = 190;
  // 손가락을 계속 움직여 이 시간을 넘기면 메뉴입니다. 실제 당김 폭(대략
  // 100~250ms) 한가운데라 손버릇에 따라 갈리지 않으므로 설정에 두지 않습니다.
  // 사용자가 고르는 것은 "멈춘 뒤 얼마나 기다릴지"(settings.holdStillMs)입니다.
  const PULL_HOLD_MS = 180;
  // 손을 뗐다는 확실한 신호는 관성뿐입니다. 관성 없이 입력만 끊긴 것은 "천천히
  // 놓았다"와 "아직 대고 있다"를 구분할 수 없으므로 기다리는 수밖에 없습니다.
  // 이미 상당히 당겨 둔 제스처라면 이어질 가능성이 높으니 오래 참고, 이제 막
  // 시작한 작은 제스처는 빨리 정리해 반응이 굼떠지지 않게 합니다.
  const GESTURE_PAUSE_MS = 1200;
  const PATIENT_PROGRESS = 0.4;
  // WheelEvent.momentum이 있으면 "관성 없이 조용해짐"이 곧 "손가락이 아직 닿아
  // 있음"입니다. 기준 시간의 이만큼을 당긴 뒤 멈췄다면 메뉴를 여는 홀드로 봅니다.
  // 살짝 스치고 멈춘 것까지 메뉴가 되지 않게 하는 최소선이며, 기다리는
  // 시간(PATIENT_PROGRESS)과는 별개로 조절할 수 있게 따로 둡니다.
  const HOLD_MENU_PROGRESS = 0.4;
  const MENU_SELECTION_RELEASE_MS = 300;
  const GESTURE_SHIFT_SCALE = 0.42;
  const GESTURE_SHIFT_MAX = 40;
  // 당긴 거리는 판정에 쓰지 않고 인디케이터를 미는 데에만 씁니다. 세게 튕기면
  // 손가락도 실제로 멀리 움직이므로, 진행 속도에 상한을 둬서 표시가 손가락
  // 이동에 가깝게 유지되도록 합니다.
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
  // 확대하지 않았을 때의 배율은 1입니다. 사용자가 실제로 벌린 것과 계산 과정에서
  // 1을 아주 조금 넘긴 값을 가르기 위해 여유를 둡니다.
  const MIN_PINCH_SCALE = 1.01;
  // 세로로 스크롤하던 손가락이 잠깐 비스듬해지는 것만으로 가로 제스처가
  // 시작되어서는 안 됩니다. 세로 입력 직후 이 시간 동안은 새 제스처를 받지
  // 않습니다. 이미 시작된 제스처는 건드리지 않습니다 — 막는 것은 시작뿐입니다.
  const AXIS_LOCK_MS = 250;
  // 탭이 닫히는 제스처만 손가락으로 이만큼 끌어야 실행됩니다. 뒤로 한 단계는
  // 앞으로 가면 그만이지만 닫힌 탭은 그렇지 않으므로, 되돌리기 어려운 쪽에만
  // 문턱을 둡니다. 여기서 거리를 쓰는 것은 "메뉴냐 한 단계냐"를 가르는 것이
  // 아니라 동작 하나에 문턱을 두는 것이라, 시간으로만 가른다는 규칙과 부딪히지
  // 않습니다.
  const CLOSE_PULL_PX = 64;

  class GestureController {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      // 이 문서의 호스트명은 바뀌지 않습니다. 다른 사이트로 이동하면 문서가
      // 새로 만들어지고 콘텐츠 스크립트도 다시 실행되므로, 한 번만 읽습니다.
      this.site = toSiteKey(window.location?.href ?? "");
      this.gestureTriggered = false;
      this.gestureDirection = null;
      // 마지막으로 세로 입력을 본 시각입니다. 제스처가 끝나도 지우지 않습니다
      // — 스크롤과 제스처는 별개라, 제스처 하나가 끝났다고 스크롤하던 사실이
      // 없어지지는 않습니다.
      this.lastVerticalAt = null;
      this.gestureIdleTimer = null;
      this.pullDistance = 0;
      this.pendingPull = [];
      this.lastWheelAt = null;
      this.fingerStartedAt = null;
      this.lastFingerAt = 0;
      this.sawFingerInput = false;
      // 브라우저 지원 여부이므로 제스처가 끝나도 되돌리지 않습니다.
      this.nativeMomentum = false;
      this.wheelPhase = new namespace.WheelPhaseTracker();
      this.scrollAreaCache = null;
      this.menuSelectionDistance = 0;
      this.menuSelectionUsed = false;
      this.menuSelectionTimer = null;
      this.pendingMenuSelection = false;
      this.waitingForDocumentRoot = false;
      this.appliedLanguage = null;

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
      // 캡처가 아니라 버블 단계입니다. 지도처럼 두 손가락 입력을 직접 쓰는
      // 영역은 휠 이벤트의 전파를 끊거나 기본 동작을 막는데, 캡처 단계에서
      // 먼저 받아 버리면 그 표시를 볼 수 없습니다. 페이지 처리기가 먼저 돌게
      // 두면 그런 영역의 이벤트는 여기까지 오지 않거나 defaultPrevented가
      // 찍혀서 옵니다. 기본 동작인 가로 스크롤은 전파가 다 끝난 뒤에
      // 일어나므로, 버블 단계에서 막아도 늦지 않습니다.
      window.addEventListener("wheel", this.handleWheel, { passive: false });
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
      await this.applyLanguage();
    }

    // 문구는 메뉴를 열 때에야 필요하므로, 표를 받아 오는 동안 제스처가
    // 막히지 않습니다. 아직 못 받았으면 Chrome UI 언어로 나갑니다.
    async applyLanguage() {
      const language = this.settings.language;
      if (language === this.appliedLanguage) return;

      this.appliedLanguage = language;
      namespace.useMessages(
        language === "auto"
          ? null
          : await namespace.historyClient.getMessages(language)
      );
      this.menu.resetUi();
    }

    handleStorageChange(changes, areaName) {
      if (areaName !== "sync") return;

      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[key]) this.settings[key] = changes[key].newValue;
      }

      this.settings = sanitizeSettings(this.settings);
      this.updateNativeNavigationBlock();
      void this.applyLanguage();
      if (!this.isActiveHere()) this.closeMenu();
    }

    // 이 사이트가 제외 목록에 있으면 확장은 아무것도 하지 않습니다. 제스처를
    // 무시하는 데에서 그치지 않고 Chrome 기본 가로 탐색 차단도 함께 풀어야
    // 합니다. 안 그러면 껐는데 브라우저 원래 스와이프까지 죽습니다.
    isActiveHere() {
      return !isSiteDisabled(this.settings, this.site);
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

      root.toggleAttribute(NAVIGATION_BLOCK_ATTRIBUTE, this.isActiveHere());
    }

    handleDocumentReady() {
      this.waitingForDocumentRoot = false;
      this.updateNativeNavigationBlock();
    }

    handleWheel(event) {
      if (!this.isActiveHere() || !event.isTrusted || event.ctrlKey) return;

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

      // 지도나 화이트보드처럼 두 손가락 입력을 직접 쓰는 영역은 휠을 자기 것으로
      // 가져갑니다. 사이트가 아니라 영역 단위로 물러나야 지도 밖에서는 제스처가
      // 그대로 동작합니다. 시작해 둔 제스처가 있으면 판정까지 가지 않고 접습니다
      // — 페이지가 가져간 입력으로 페이지를 옮겨 버리면 안 됩니다.
      if (event.defaultPrevented) {
        if (this.gestureDirection !== null) this.endGestureCapture();
        return;
      }

      // 세로로 움직인 입력을 적어 둡니다. 아래에서 가로 제스처의 시작을
      // 잠그는 데 씁니다. 관성 꼬리는 이미 손을 뗀 뒤라 잠그지 않습니다 —
      // 그때부터 오는 가로 입력은 새로 손을 대고 하는 손짓입니다. 관성인지
      // 알 수 없는 브라우저에서는 잠그는 쪽으로 둡니다.
      if (absoluteY > 0.5 && absoluteY > absoluteX * HORIZONTAL_RATIO) {
        if (event.momentum !== true) this.lastVerticalAt = event.timeStamp;
      }

      if (!horizontal || absoluteX < 0.5) return;

      // 트랙패드로 확대해 둔 뒤에 옆으로 당기는 것은 확대된 화면을 미는
      // 동작입니다. 이때 움직이는 것은 시각 뷰포트라서 문서의 스크롤 위치는
      // 그대로이고, 아래의 가로 스크롤 판정에는 걸리지 않습니다. 다만 문서
      // 스크롤과 같은 규칙으로, 그 방향으로 실제 더 밀 수 있을 때에만
      // 양보합니다 — 끝까지 밀어 놓고 더 당기는 것은 화면을 미는 동작이
      // 아니므로 제스처로 받습니다.
      if (isPinchPanArea(deltaX)) {
        if (this.gestureDirection !== null) this.endGestureCapture();
        return;
      }

      // 세로로 스크롤한 직후입니다. 손가락이 잠깐 비스듬해진 것을 제스처로
      // 받으면 스크롤하다 뒤로 가 버립니다. 기본 동작을 막지 않고 그대로
      // 흘려보내 페이지가 계속 스크롤되게 합니다.
      if (this.gestureDirection === null && this.isAxisLocked(event.timeStamp)) {
        return;
      }

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

      // 브라우저가 관성 여부를 직접 알려 주는지는 한 번 확인하면 계속 같습니다.
      if (typeof event.momentum === "boolean") this.nativeMomentum = true;

      // 손가락이 실제로 움직인 만큼만 쌓습니다. 관성 구간은 이미 손을 뗀
      // 뒤라서 여기에 넣으면 짧게 튕긴 제스처가 길게 당긴 것처럼 보입니다.
      const phase = this.wheelPhase.update(event, deltaX);
      const fingerDelta = this.limitPullSpeed(event, getFingerDelta(event, deltaX));
      const momentum = phase === "momentum";

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

      const heldMs = this.fingerStartedAt === null
        ? 0
        : this.lastFingerAt - this.fingerStartedAt;
      const progress = this.toProgress(heldMs);

      // 탭이 닫히는 제스처는 표시도 판정도 끌어당긴 거리를 따릅니다. 표시가
      // 가득 차는 순간이 곧 실행되는 지점이라, 무엇이 일어날지 보고 나서 손을
      // 되돌려 취소할 수 있습니다.
      const closing = this.willCloseTab(direction);
      this.menu.showGestureIndicator({
        clientY: event.clientY,
        progress: closing ? this.toClosePullProgress() : progress,
        direction,
        closing,
        shift: this.getIndicatorShift(direction)
      });

      if (closing) {
        if (Math.abs(this.pullDistance) >= CLOSE_PULL_PX) {
          this.finishGesture(() => this.navigateOneStep(direction));
        } else {
          // 아직 덜 끌었습니다. 제스처를 살려 두어 계속 끌 수 있게 하고,
          // 여기서 손을 떼면 아무 일도 일어나지 않습니다.
          this.restartIdleTimer(
            () => this.endGestureCapture(),
            this.toIdleDelay(this.toClosePullProgress())
          );
        }
        return;
      }

      // 판정은 시간으로만 합니다. 손가락을 계속 대고 있는 시간이 기준을 넘으면
      // 메뉴입니다. 얼마나 멀리 갔는지는 보지 않습니다 — 거리를 함께 보면 크게
      // 당겼다 놓는 동작이 "메뉴"와 "한 단계"로 갈려서, 손을 뗐는지 여부와
      // 무관한 두 번째 기준을 사용자가 감으로 익혀야 합니다.
      if (heldMs >= PULL_HOLD_MS) {
        const opensMenu = this.hasTabHistory();
        this.finishGesture(() => opensMenu
          ? this.openHistoryMenu(direction)
          : this.navigateOneStep(direction));
        return;
      }

      // 관성이 시작됐다는 것은 손가락을 뗐다는 뜻입니다. 기준을 넘지 못했으니
      // 기다리지 않고 바로 한 단계만 이동합니다.
      if (momentum) {
        this.finishGesture(() => this.navigateOneStep(direction));
        return;
      }

      this.restartIdleTimer(() => this.finishShortGesture(), this.toIdleDelay(progress));
    }

    toProgress(heldMs) {
      return heldMs / PULL_HOLD_MS;
    }

    // 관성으로 손 뗌을 정확히 알 수 있으면 "이어질까" 참을 이유가 없습니다.
    // 관성 없이 조용해진 것 자체가 손가락이 아직 닿아 있다는 신호이므로,
    // 오래 붙잡아 두지 않고 사용자가 고른 시간만 기다렸다 판정합니다.
    //
    // 감쇠 추정 경로에서 오래 참는 쪽은 사용자가 고른 시간보다 짧아지면
    // 안 됩니다. 기다리겠다고 고른 시간을 확장이 먼저 끊어 버리는 셈입니다.
    toIdleDelay(progress) {
      const chosen = this.settings.holdStillMs;
      if (this.nativeMomentum || progress < PATIENT_PROGRESS) return chosen;
      return Math.max(GESTURE_PAUSE_MS, chosen);
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

    isAxisLocked(timeStamp) {
      return this.lastVerticalAt !== null &&
        timeStamp - this.lastVerticalAt < AXIS_LOCK_MS;
    }

    // 뒤로 갈 기록이 없는 탭에서의 뒤로 제스처는 이 탭을 닫습니다. 워커에
    // 물어보지 않고도 여기서 알 수 있습니다 — 메뉴를 열지 말지 가르는 값과
    // 같은 값입니다. 기록이 앞쪽에만 남은 드문 경우는 여기서 걸러지지 않고
    // 예전처럼 워커가 처리합니다.
    willCloseTab(direction) {
      return direction === "back" && !this.hasTabHistory();
    }

    // 탭 닫기 표시는 당긴 시간이 아니라 끌어당긴 거리를 보여 줍니다. 가득
    // 차는 순간이 곧 실행되는 지점이라, 실행 전에 무엇이 일어날지 보입니다.
    toClosePullProgress() {
      return Math.min(1, Math.abs(this.pullDistance) / CLOSE_PULL_PX);
    }

    // 표시는 뒤로가기면 왼쪽, 앞으로면 오른쪽 가장자리에 붙습니다. 밀려 나오는
    // 부호를 정하는 것은 손가락이 아니라 그 가장자리입니다 — 왼쪽에서는
    // 오른쪽으로(+), 오른쪽에서는 왼쪽으로(-) 나옵니다. 손가락이 움직인 부호를
    // 그대로 쓰면 뒤로가기 방향을 뒤집은 사람에게서 둘이 반대가 되어, 당긴
    // 시간은 밀어내는데 당긴 거리는 끌어당겨 표시가 나왔다 들어갔다 합니다.
    // 한 제스처 안에서는 손가락 방향이 바뀌지 않으므로(바뀌면 제스처가 끊깁니다)
    // 크기만 취하면 그대로 "얼마나 나왔는지"가 됩니다.
    getIndicatorShift(direction) {
      const outward = direction === "back" ? 1 : -1;
      const pulled = Math.abs(this.pullDistance) * GESTURE_SHIFT_SCALE;
      return clamp(outward * pulled, GESTURE_SHIFT_MAX);
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
    //
    // 단, 관성 여부를 정확히 알 수 있는 Chrome(151+)에서는 이야기가 다릅니다.
    // 튕겼다면 반드시 관성이 오므로, 관성 하나 없이 조용해진 것은 손가락이
    // 아직 닿아 있다는 뜻입니다. 충분히 당겨 둔 상태라면 이걸 "당긴 채 멈춤"
    // 으로 보고 메뉴를 엽니다. 그대로 위·아래로 고르고 손을 떼면 이동합니다.
    finishShortGesture() {
      const direction = this.gestureDirection;
      const heldMs = this.fingerStartedAt === null
        ? 0
        : this.lastFingerAt - this.fingerStartedAt;
      const shouldAct = !this.gestureTriggered && direction !== null;
      const opensMenu = this.isHoldingStill(heldMs) && this.hasTabHistory();

      this.endGestureCapture();

      if (!shouldAct) return;
      // 탭이 닫히는 제스처는 거리로만 판정합니다. 문턱을 넘겼다면 handleWheel
      // 에서 이미 실행됐으므로, 여기까지 왔다는 것은 덜 끌고 손을 뗐다는
      // 뜻입니다.
      if (this.willCloseTab(direction)) return;
      if (opensMenu) void this.openHistoryMenu(direction);
      else void this.navigateOneStep(direction);
    }

    // 관성이 한 번도 오지 않은 채 입력이 끊겼다는 판정은 WheelEvent.momentum이
    // 있을 때만 믿을 수 있습니다. 감쇠 추정은 짧은 튕김의 관성을 놓칠 수 있어,
    // 손을 뗀 제스처를 홀드로 오해하게 됩니다.
    isHoldingStill(heldMs) {
      return this.nativeMomentum && this.toProgress(heldMs) >= HOLD_MENU_PROGRESS;
    }

    // 이 탭의 기록이 하나뿐이면 메뉴에 보여 줄 것이 없습니다. 서비스 워커에
    // 물어보고 나서야 알면 빈 메뉴가 떴다 사라지므로, 왕복 없이 여기서 먼저
    // 거릅니다. 링크로 열린 탭이라면 한 단계 이동이 이 탭을 연 탭으로
    // 돌려보내고, 그마저 없으면 아무 일도 일어나지 않습니다.
    hasTabHistory() {
      const length = window.history?.length;
      return !Number.isInteger(length) || length > 1;
    }

    async navigateOneStep(direction) {
      try {
        await namespace.historyClient.navigateOneStep(direction);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("Better Gesture: 한 단계 이동에 실패했습니다.", error);
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

  // 확대해 둔 화면에서 시각 뷰포트를 이 방향으로 더 밀 수 있는지 봅니다.
  // offsetLeft는 레이아웃 뷰포트 왼쪽 끝에서 시각 뷰포트 왼쪽 끝까지의
  // 거리이므로, 밀 수 있는 최대치는 두 뷰포트 너비의 차이입니다.
  function isPinchPanArea(deltaX) {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport || !root || viewport.scale <= MIN_PINCH_SCALE) return false;

    const maxOffsetLeft = root.clientWidth - viewport.width;
    if (maxOffsetLeft <= SCROLL_OVERFLOW_TOLERANCE) return false;

    return deltaX < 0
      ? viewport.offsetLeft > SCROLL_OVERFLOW_TOLERANCE
      : viewport.offsetLeft < maxOffsetLeft - SCROLL_OVERFLOW_TOLERANCE;
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
