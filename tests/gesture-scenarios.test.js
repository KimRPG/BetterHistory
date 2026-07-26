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

function createController() {
  const messages = [];
  const opened = [];
  const timers = new Map();
  let now = 0;
  let nextTimerId = 1;
  const context = vm.createContext({
    chrome: {
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
    window: { innerHeight: 800, innerWidth: 1200, addEventListener() {} }
  });

  for (const file of contentFiles) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    new vm.Script(source, { filename: file }).runInContext(context);
  }

  const controller = new context.GestureBackHistory.GestureController();
  controller.menu = {
    getSelected: () => null,
    hideGestureIndicator() {},
    isBusy: () => false,
    isEventFromUi: () => false,
    isOpen: () => false,
    moveSelection() {},
    open: (direction) => {
      opened.push(direction);
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

  return { controller, messages, opened, advance, wheel, outcome };
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
  ["기준에 못 미치게 당기기", "back", { fingerSteps: 24, peak: 14, decay: 0.9, interval: 8.3 }],
  ["길게 당기기", "menu", { fingerSteps: 28, peak: 18, decay: 0.9, interval: 8.3 }],
  ["아주 길게 당기기", "menu", { fingerSteps: 40, peak: 16, decay: 0.9, interval: 8.3 }],
  ["살짝 스치기", "none", { fingerSteps: 2, peak: 8, decay: 0.85, interval: 8.3 }]
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
  for (const pauseMs of [120, 250, 400]) {
    const harness = createController();
    pull(harness, 10);
    harness.advance(pauseMs);
    pull(harness, 14);
    harness.advance(1200);

    assert.equal(harness.outcome(), "menu", `${pauseMs}ms 쉬었을 때`);
  }
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

test("기준에 못 미친 채 입력이 멈추면 한 단계만 이동한다", () => {
  const harness = createController();

  pull(harness, 8);
  harness.advance(1200);

  assert.equal(harness.outcome(), "back");
});
