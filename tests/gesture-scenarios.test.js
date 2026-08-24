"use strict";

// 실제 트랙패드 입력 모양(가속 구간 + 손을 뗀 뒤의 관성 꼬리)을 재현해서
// 짧게 튕기기와 길게 당기기가 갈리는지 확인합니다. 단위 테스트만으로는
// "세게 튕기면 손가락도 멀리 움직여 기준을 넘어 버리는" 문제가 드러나지 않습니다.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const contentFiles = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8")
).content_scripts[0].js;


// 문구는 _locales에만 있습니다. 목이 실제 파일을 읽어야 키가 사라진 것을
// 테스트가 잡아냅니다. 기준 언어는 ko로 두어 단정문이 사람이 읽는 문구
// 그대로 남게 합니다.
function loadMessages(locale = "ko") {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "_locales", locale, "messages.json"),
    "utf8"
  ));
}

function createI18n(locale = "ko") {
  const messages = loadMessages(locale);
  return {
    getMessage(key, substitutions = []) {
      const entry = messages[key];
      if (!entry) return "";

      const list = Array.isArray(substitutions)
        ? substitutions
        : [substitutions];
      return Object.entries(entry.placeholders ?? {}).reduce(
        (text, [name, { content }]) => {
          const index = Number(content.slice(1)) - 1;
          return text.replaceAll(
            new RegExp(`\\$${name}\\$`, "gi"),
            list[index] ?? ""
          );
        },
        entry.message
      );
    }
  };
}

function createController({ historyLength = 2 } = {}) {
  const messages = [];
  const opened = [];
  const timers = new Map();
  let now = 0;
  let nextTimerId = 1;
  const context = vm.createContext({
    chrome: {
      i18n: createI18n(),
      runtime: {
        getURL: (resource) => `chrome-extension://test${resource}`,
        async sendMessage(message) {
          messages.push(message);
          return { ok: true };
        }
      },
      storage: {
        sync: { async get(defaults) { return defaults; } },
        onChanged: { addListener() {} }
      }
    },
    clearTimeout: (id) => timers.delete(id),
    console,
    document: {
      scrollingElement: null,
      documentElement: {
        hasAttribute: () => false,
        removeAttribute() {},
        setAttribute() {},
        toggleAttribute() {}
      }
    },
    Element: class Element {},
    getComputedStyle: () => ({ overflowX: "visible" }),
    setTimeout: (fn, delay) => {
      const id = nextTimerId += 1;
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    URL,
    WheelEvent: { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    window: {
      innerHeight: 800,
      innerWidth: 1200,
      addEventListener() {},
      history: { length: historyLength }
    }
  });

  for (const file of contentFiles) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    new vm.Script(source, { filename: file }).runInContext(context);
  }

  const controller = new context.BetterGesture.GestureController();
  // 실제 메뉴처럼 열린 뒤에는 isOpen()이 true가 됩니다. 이걸 흉내 내지 않으면
  // "메뉴가 열린 뒤" 경로가 테스트에서 통째로 빠집니다.
  let menuOpen = false;
  let selectedId = 0;
  const selectionMoves = [];
  const entryNavigations = [];

  controller.menu = {
    close() { menuOpen = false; },
    resetUi() {},
    getSelected: () => ({ entry: { id: selectedId }, button: {} }),
    hideGestureIndicator() {},
    isBusy: () => false,
    isEventFromUi: () => false,
    isOpen: () => menuOpen,
    moveSelection: (step) => {
      selectedId += step;
      selectionMoves.push(step);
    },
    navigate: (entry) => {
      entryNavigations.push(entry);
      menuOpen = false;
      return Promise.resolve(true);
    },
    open: (direction) => {
      opened.push(direction);
      menuOpen = true;
      return Promise.resolve(true);
    },
    showGestureIndicator() {},
    showToast() {}
  };

  // 가상 시계. 실제 대기 없이 idle/release 타이머를 정확한 시점에 돌립니다.
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, timer] of timers) {
        if (timer.due <= target && (next === null || timer.due < next[1].due)) {
          next = [id, timer];
        }
      }
      if (next === null) break;
      timers.delete(next[0]);
      now = next[1].due;
      next[1].fn();
    }
    now = target;
  }

  function wheel(deltaX, deltaY = 0, momentum = undefined) {
    controller.handleWheel(wheelEvent(now, deltaX, deltaY, momentum));
  }

  function outcome() {
    if (opened.length > 0) return "menu";
    return messages.some((message) => message.type === "NAVIGATE_ONE_STEP")
      ? "back"
      : "none";
  }

  return {
    controller,
    messages,
    opened,
    selectionMoves,
    entryNavigations,
    advance,
    wheel,
    outcome
  };
}

function wheelEvent(timeStamp, deltaX, deltaY, momentum) {
  const event = {
    cancelable: true,
    clientY: 400,
    composedPath: () => [],
    ctrlKey: false,
    deltaMode: 0,
    deltaX,
    deltaY,
    isTrusted: true,
    preventDefault() {},
    timeStamp,
    webkitDirectionInvertedFromDevice: true
  };
  // Chrome 151+ 만 관성 여부를 직접 알려 줍니다.
  if (momentum !== undefined) event.momentum = momentum;
  return event;
}

// 손가락 구간은 peak까지 가속하고, 손을 떼면 이벤트마다 decay 비율로 줄어듭니다.
function playGesture({ fingerSteps, peak, decay, interval, nativeMomentum }) {
  const harness = createController();

  for (let step = 1; step <= fingerSteps; step += 1) {
    harness.wheel(
      -(peak * step) / fingerSteps,
      0,
      nativeMomentum ? false : undefined
    );
    harness.advance(interval);
  }

  let magnitude = peak;
  for (let step = 0; step < 400; step += 1) {
    magnitude *= decay;
    if (magnitude < 0.5) break;
    harness.wheel(-magnitude, 0, nativeMomentum ? true : undefined);
    harness.advance(interval);
  }

  harness.advance(1200);
  return harness.outcome();
}

const scenarios = [
  ["약하게 튕기기", "back", { fingerSteps: 4, peak: 14, decay: 0.93, interval: 8.3 }],
  ["보통 세기로 튕기기", "back", { fingerSteps: 6, peak: 30, decay: 0.93, interval: 8.3 }],
  ["세게 튕기기", "back", { fingerSteps: 6, peak: 60, decay: 0.95, interval: 8.3 }],
  ["아주 세게 튕기기", "back", { fingerSteps: 7, peak: 90, decay: 0.96, interval: 8.3 }],
  ["60Hz 트랙패드로 튕기기", "back", { fingerSteps: 4, peak: 40, decay: 0.9, interval: 16.6 }],
  ["기준에 못 미치게 당기기", "back", { fingerSteps: 14, peak: 12, decay: 0.9, interval: 8.3 }],
  ["길게 당기기", "menu", { fingerSteps: 28, peak: 18, decay: 0.9, interval: 8.3 }],
  ["아주 길게 당기기", "menu", { fingerSteps: 40, peak: 16, decay: 0.9, interval: 8.3 }],
  ["살짝 스치기", "back", { fingerSteps: 2, peak: 8, decay: 0.85, interval: 8.3 }]
];

for (const nativeMomentum of [true, false]) {
  const engine = nativeMomentum
    ? "WheelEvent.momentum"
    : "감쇠 추정";

  for (const [name, expected, options] of scenarios) {
    test(`${engine}: ${name}`, () => {
      assert.equal(playGesture({ ...options, nativeMomentum }), expected);
    });
  }
}

test("세게 튕겨도 오래 당긴 것으로 오해하지 않는다", () => {
  // 손가락이 실제로 움직인 거리만 보면 센 튕김(210px)이 느린 당김(175px)보다
  // 멉니다. 진행 속도 상한이 없으면 여기서 갈리지 않습니다.
  const flick = playGesture({
    fingerSteps: 6,
    peak: 60,
    decay: 0.95,
    interval: 8.3,
    nativeMomentum: true
  });
  const pull = playGesture({
    fingerSteps: 28,
    peak: 18,
    decay: 0.9,
    interval: 8.3,
    nativeMomentum: true
  });

  assert.equal(flick, "back");
  assert.equal(pull, "menu");
});

// 손가락은 계속 닿아 있는데 입력만 잠시 끊기는 상황들. 여기서 "손을 뗐다"고
// 판정해 버리면 당기던 제스처가 중간에 뒤로가기로 끊깁니다.
const FRAME = 8.3;

function pull(harness, steps, magnitude = 12) {
  for (let step = 0; step < steps; step += 1) {
    harness.wheel(-magnitude, 0, false);
    harness.advance(FRAME);
  }
}

test("당기다 잠깐 쉬어도 제스처가 끊기지 않는다", () => {
  // 이미 상당히 당겨 둔 상태라면 1초 넘게 멈칫해도 이어집니다.
  for (const pauseMs of [120, 250, 400, 700, 1100]) {
    const harness = createController();
    pull(harness, 10);
    harness.advance(pauseMs);
    pull(harness, 14);
    harness.advance(1500);

    // 끊겼다면 멈칫한 시점에 뒤로가기가 한 번 실행됐을 것입니다.
    assert.deepEqual(
      [...harness.messages].map((message) => message.type),
      [],
      `${pauseMs}ms 쉬었을 때 뒤로가기가 끼어들었습니다`
    );
    assert.deepEqual([...harness.opened], ["back"], `${pauseMs}ms 쉬었을 때`);
  }
});

// 링크로 열린 탭에는 보여 줄 기록이 없습니다. 메뉴를 띄웠다 지우는 대신
// 곧바로 한 단계 이동을 보내 이 탭을 연 탭으로 돌아가게 합니다.
test("기록이 없는 탭에서는 길게 당겨도 메뉴를 열지 않는다", () => {
  const harness = createController({ historyLength: 1 });

  pull(harness, 30, 16);
  harness.advance(1200);

  assert.deepEqual([...harness.opened], []);
  assert.deepEqual(
    [...harness.messages].map((message) => message.type),
    ["NAVIGATE_ONE_STEP"]
  );
  assert.equal(harness.messages[0].direction, "back");
});

// --- 실수로 하는 제스처 ---------------------------------------------------
// 오작동의 가장 큰 원인은 세로로 스크롤하던 손가락이 잠깐 비스듬해지는 것입니다.
// 가로 판정 기준이 |dx| > |dy| x 1.25라 그 순간이 그대로 통과합니다.

test("세로로 스크롤하다 손가락이 비스듬해져도 뒤로 가지 않는다", () => {
  const harness = createController();

  for (let index = 0; index < 5; index += 1) {
    harness.wheel(0, -40, false);
    harness.advance(16);
  }
  // 스크롤하던 손가락이 마지막에 옆으로 쏠렸습니다.
  harness.wheel(-30, 0, false);
  harness.advance(1200);

  assert.equal(harness.outcome(), "none");
});

test("스크롤을 멈추고 나면 뒤로 제스처가 다시 동작한다", () => {
  const harness = createController();

  harness.wheel(0, -40, false);
  harness.advance(300);

  for (let index = 0; index < 3; index += 1) {
    harness.wheel(-30, 0, false);
    harness.advance(16);
  }
  harness.advance(1200);

  assert.equal(harness.outcome(), "back");
});

test("관성으로 흘러가는 세로 스크롤은 제스처를 잠그지 않는다", () => {
  const harness = createController();

  // 관성이라는 것은 이미 손을 뗐다는 뜻입니다. 그 뒤의 가로 입력은 새로 손을
  // 대고 하는 손짓이므로 잠글 이유가 없습니다.
  harness.wheel(0, -40, true);
  harness.advance(16);

  for (let index = 0; index < 3; index += 1) {
    harness.wheel(-30, 0, false);
    harness.advance(16);
  }
  harness.advance(1200);

  assert.equal(harness.outcome(), "back");
});

test("기록이 있는 탭에서는 길게 당기면 메뉴가 열린다", () => {
  const harness = createController({ historyLength: 2 });

  pull(harness, 30, 16);
  harness.advance(1200);

  assert.deepEqual([...harness.opened], ["back"]);
});

test("당기다 감속해도 관성으로 오해하지 않는다", () => {
  const harness = createController();
  let magnitude = 20;

  for (let step = 0; step < 40; step += 1) {
    harness.wheel(-magnitude, 0, false);
    harness.advance(FRAME);
    magnitude = Math.max(7, magnitude * 0.92);
  }
  harness.advance(1200);

  assert.equal(harness.outcome(), "menu");
});

test("세로로 흔들리며 당겨도 기준을 넘기면 메뉴가 열린다", () => {
  const harness = createController();

  for (let step = 0; step < 30; step += 1) {
    harness.wheel(-12, step % 4 === 0 ? -14 : -2, false);
    harness.advance(FRAME);
  }
  harness.advance(1200);

  assert.equal(harness.outcome(), "menu");
});

test("얼마 당기지 않고 입력이 멈추면 한 단계만 이동한다", () => {
  // 3회 = 36px는 기준의 24%. 홀드로 보기에는 모자랍니다.
  for (const steps of [1, 3]) {
    const harness = createController();

    pull(harness, steps);
    harness.advance(1200);

    // 가로 제스처로 인식된 이상 크기와 무관하게 한 단계 이동합니다.
    assert.equal(harness.outcome(), "back", `${steps}회 입력`);
  }
});

test("당긴 채 멈추면 손가락이 남아 있는 것으로 보고 메뉴를 연다", () => {
  const harness = createController();

  // 10회 = 75ms는 기준 시간(180ms)의 42%. 여기서 관성 하나 없이 조용해졌다면
  // 손가락이 아직 닿아 있다는 뜻입니다.
  pull(harness, 10);
  harness.advance(1200);

  assert.deepEqual([...harness.opened], ["back"]);
  assert.deepEqual([...harness.messages].map((message) => message.type), []);
});

test("관성 여부를 모르는 Chrome에서는 멈춰도 한 단계만 이동한다", () => {
  const harness = createController();

  // momentum 속성 없이 같은 크기로 10회. 감쇠 추정으로는 손을 뗀 것인지
  // 확신할 수 없으므로 안전하게 한 단계 이동입니다.
  for (let step = 0; step < 10; step += 1) {
    harness.wheel(-12);
    harness.advance(FRAME);
  }
  harness.advance(1200);

  assert.equal(harness.outcome(), "back");
});

test("비스듬히 당겨 메뉴가 열려도 선택이 저절로 움직이지 않는다", () => {
  const harness = createController();

  // 손가락이 정확히 수평으로 움직이는 일은 없습니다. 세로가 가로의 60%쯤
  // 섞인 대각선 당김은 흔한 입력입니다.
  for (let step = 0; step < 40; step += 1) {
    harness.wheel(-14, step % 2 === 0 ? -8 : -9, false);
    harness.advance(FRAME);
  }
  harness.advance(1200);

  assert.deepEqual([...harness.opened], ["back"]);
  assert.deepEqual([...harness.selectionMoves], []);
  assert.deepEqual([...harness.entryNavigations], []);
});

test("메뉴가 열린 뒤 위·아래로 움직이면 선택이 움직이고 놓으면 이동한다", () => {
  const harness = createController();

  pull(harness, 24, 14);
  assert.deepEqual([...harness.opened], ["back"]);

  // 이제는 가로 성분이 거의 없는 분명한 세로 움직임입니다.
  for (let step = 0; step < 8; step += 1) {
    harness.wheel(-1, -20, false);
    harness.advance(FRAME);
  }
  harness.advance(1200);

  assert.equal(harness.selectionMoves.length > 0, true);
  assert.equal(harness.entryNavigations.length, 1);
});

// 실제 사용자 로그에서 가져온 입력입니다. 손가락이 166px 움직였는데 예전에는
// 절반 가까이가 "관성 후보"로 붙잡혔다가 버려져 80px만 반영됐습니다.
const REAL_TRACKPAD_PULL = [1, 3, 4, 2, 5, 8, 11, 15, 14, 17, 17, 13, 11, 14, 13, 11, 7];

function replayRealPull(nativeMomentum) {
  const harness = createController();
  const step = 125 / (REAL_TRACKPAD_PULL.length - 1);

  for (const magnitude of REAL_TRACKPAD_PULL) {
    harness.wheel(-magnitude, 0, nativeMomentum ? false : undefined);
    harness.advance(step);
  }
  return {
    harness,
    pulled: Math.round(Math.abs(harness.controller.pullDistance))
  };
}

test("실제 트랙패드 당김의 이동 거리를 대부분 반영한다", () => {
  const travel = REAL_TRACKPAD_PULL.reduce((sum, value) => sum + value, 0);
  assert.equal(travel, 166);

  // WheelEvent.momentum이 있으면 추정이 필요 없어 거의 그대로 반영됩니다.
  const exact = replayRealPull(true);
  assert.equal(exact.pulled >= 150, true, `정확 모드에서 ${exact.pulled}px만 반영됨`);

  // 이 입력은 166px을 125ms에 당긴 것입니다. 판정을 시간으로만 하므로 기준
  // 시간(180ms)에 못 미쳐 메뉴가 열리지 않고, 여기서 손가락을 멈추면 열립니다.
  assert.deepEqual([...exact.harness.opened], []);
  exact.harness.advance(1200);
  assert.deepEqual([...exact.harness.opened], ["back"]);

  // 추정 모드에서도 예전(80px)보다는 훨씬 많이 반영돼야 합니다.
  const estimated = replayRealPull(false);
  assert.equal(estimated.pulled >= 100, true, `추정 모드에서 ${estimated.pulled}px만 반영됨`);
});

// 화면 녹화에서 확인한 실제 사용 습관입니다. 아주 천천히(0.45~0.58px/ms) 오래
// 당기는 분이라, 거리만 기준으로 삼으면 150px을 채우는 데 1초가 넘게 걸렸고
// 그 사이 잠깐 멈칫하면 "입력 멈춤"으로 끊겨 한 단계 이동이 돼 버렸습니다.
function slowPull(harness, { totalMs, speed }) {
  const steps = Math.round(totalMs / FRAME);
  for (let step = 0; step < steps; step += 1) {
    harness.wheel(-speed * FRAME, 0, false);
    harness.advance(FRAME);
  }
}

// 튕겨서 손을 떼면 관성 꼬리가 따라옵니다. 이게 없는 입력은 튕김이 아니라
// 손가락을 그대로 대고 있는 것입니다.
function release(harness, magnitude = 4) {
  for (let step = 0; step < 60; step += 1) {
    magnitude *= 0.93;
    if (magnitude < 0.5) break;
    harness.wheel(-magnitude, 0, true);
    harness.advance(FRAME);
  }
}

test("천천히 오래 당기면 거리가 모자라도 메뉴가 열린다", () => {
  const harness = createController();

  // 0.5px/ms로 400ms = 200px지만, 실제로는 감속·보류로 훨씬 적게 잡힙니다.
  slowPull(harness, { totalMs: 400, speed: 0.5 });
  harness.advance(1200);

  assert.deepEqual([...harness.opened], ["back"]);
});

test("빠르게 튕기는 짧은 제스처는 시간 기준에 걸리지 않는다", () => {
  for (const totalMs of [44, 117]) {
    const harness = createController();

    slowPull(harness, { totalMs, speed: 0.5 });
    release(harness);
    harness.advance(1200);

    assert.deepEqual([...harness.opened], [], `${totalMs}ms 제스처`);
    assert.equal(harness.outcome(), "back", `${totalMs}ms 제스처`);
  }
});

// 시간만으로 판정하는 한 피할 수 없는 지점입니다. 아래 두 입력은 지속 시간이
// 거의 같은데(214ms / 224ms) 손가락 이동은 89px 대 465px로 5배 차이입니다.
// 거리를 함께 보던 예전에는 갈렸지만, 지금은 둘 다 메뉴로 처리됩니다.
test("느리게 오래 당긴 것과 빠르게 오래 당긴 것은 구분하지 않는다", () => {
  const slow = createController();
  slowPull(slow, { totalMs: 214, speed: 0.5 });
  release(slow);
  slow.advance(1200);

  const fast = createController();
  pull(fast, 28, 18);
  fast.advance(1200);

  assert.deepEqual([...slow.opened], ["back"]);
  assert.deepEqual([...fast.opened], ["back"]);
});

test("기준 시간은 손가락 구간만 세고 관성 꼬리는 빼놓는다", () => {
  const harness = createController();

  // 손가락은 120ms만 움직이고, 관성이 1초 넘게 이어집니다.
  slowPull(harness, { totalMs: 120, speed: 0.6 });
  let magnitude = 5;
  for (let step = 0; step < 120; step += 1) {
    magnitude *= 0.97;
    if (magnitude < 0.5) break;
    harness.wheel(-magnitude, 0, true);
    harness.advance(FRAME);
  }
  harness.advance(1200);

  // 관성이 아무리 길어도 "오래 당겼다"가 되면 안 됩니다.
  assert.deepEqual([...harness.opened], []);
  assert.equal(harness.outcome(), "back");
});

test("이제 막 시작한 작은 제스처는 오래 기다리지 않는다", () => {
  const harness = createController();

  // 진행이 얼마 안 된 상태에서 조용해지면 곧바로 정리해야 반응이 굼뜨지 않습니다.
  harness.wheel(-6, 0, false);
  harness.advance(FRAME);
  harness.advance(500);

  assert.equal(harness.outcome(), "back");
});

test("멈칫한 시간도 당긴 시간에 포함돼 다시 움직이면 메뉴가 열린다", () => {
  const harness = createController();

  // 91ms 당기고 → 300ms 멈칫 → 다시 움직이는 순간 기준 시간(180ms)을 넘습니다.
  // 멈춤이 0.45초를 넘으면 홀드로 잡히므로, 그보다 짧게 쉬는 경우입니다.
  pull(harness, 12, 5);
  assert.deepEqual([...harness.opened], []);

  harness.advance(300);
  pull(harness, 2, 5);
  harness.advance(1500);

  assert.deepEqual([...harness.opened], ["back"]);
});
