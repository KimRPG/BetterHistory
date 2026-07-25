"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentFiles = [
  "shared/settings.js",
  "content/menu-styles.js",
  "content/history-client.js",
  "content/history-menu.js",
  "content/gesture-controller.js",
  "content/index.js"
];

function loadContentModules({ scrollingElement = null } = {}) {
  const listeners = [];
  const messages = [];
  const rootAttributes = new Set();
  const chrome = {
    runtime: {
      getURL(resourcePath) {
        const path = resourcePath.startsWith("/")
          ? resourcePath
          : `/${resourcePath}`;
        return `chrome-extension://test-extension-id${path}`;
      },
      async sendMessage(message) {
        messages.push(message);
        return message.type === "GET_TAB_HISTORY"
          ? { ok: true, entries: [] }
          : { ok: true };
      }
    },
    storage: {
      sync: {
        async get(defaults) {
          return defaults;
        }
      },
      onChanged: {
        addListener(listener) {
          listeners.push({ type: "storage", listener });
        }
      }
    }
  };
  const window = {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    }
  };
  const document = {
    scrollingElement,
    documentElement: {
      hasAttribute(name) {
        return rootAttributes.has(name);
      },
      removeAttribute(name) {
        rootAttributes.delete(name);
      },
      setAttribute(name) {
        rootAttributes.add(name);
      },
      toggleAttribute(name, force) {
        if (force) rootAttributes.add(name);
        else rootAttributes.delete(name);
      }
    }
  };
  const context = vm.createContext({
    chrome,
    clearTimeout,
    console,
    document,
    Element: class Element {},
    getComputedStyle(element) {
      return element.computedStyle ?? { overflowX: "visible" };
    },
    setTimeout,
    URL,
    WheelEvent: {
      DOM_DELTA_LINE: 1,
      DOM_DELTA_PAGE: 2
    },
    window
  });

  for (const file of contentFiles) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    new vm.Script(source, { filename: file }).runInContext(context);
  }

  return {
    chrome,
    Element: context.Element,
    listeners,
    messages,
    namespace: context.GestureBackHistory,
    rootAttributes
  };
}

test("Manifest 순서대로 콘텐츠 모듈을 조립하고 이벤트를 등록한다", () => {
  const runtime = loadContentModules();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
  );
  assert.deepEqual(manifest.content_scripts[0].js, contentFiles);
  assert.deepEqual(manifest.content_scripts[0].css, ["content/page-styles.css"]);
  assert.equal(manifest.permissions.includes("favicon"), true);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["_favicon/*"],
      matches: ["<all_urls>"],
      extension_ids: ["*"]
    }
  ]);
  assert.equal(typeof runtime.namespace.MENU_STYLES, "string");
  assert.equal(typeof runtime.namespace.historyClient.getEntries, "function");
  assert.equal(typeof runtime.namespace.HistoryMenu, "function");
  assert.equal(typeof runtime.namespace.GestureController, "function");
  assert.deepEqual(
    runtime.listeners.map(({ type }) => type),
    ["storage", "wheel", "keydown", "pointerdown"]
  );
});

test("favicon API를 지원하는 Chrome 버전을 최소 버전으로 선언한다", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
  );

  assert.equal(Number(manifest.minimum_chrome_version) >= 104, true);
  for (const size of ["16", "32", "48", "128"]) {
    const iconPath = manifest.icons[size];
    assert.equal(typeof iconPath, "string");
    assert.equal(manifest.action.default_icon[size], iconPath);
    assert.equal(fs.existsSync(path.join(__dirname, "..", iconPath)), true);
  }
});

test("팝업과 콘텐츠 스크립트가 같은 설정 정의를 공유한다", () => {
  const runtime = loadContentModules();
  const { DEFAULT_SETTINGS, HOLD_DURATION_CHOICES, sanitizeSettings } =
    runtime.namespace;
  const popupHtml = fs.readFileSync(
    path.join(__dirname, "..", "popup.html"),
    "utf8"
  );

  assert.deepEqual(
    [...HOLD_DURATION_CHOICES].map(({ value }) => value),
    [100, 200, 300, 500]
  );
  assert.equal(popupHtml.includes('src="shared/settings.js"'), true);
  // 기준 시간 목록은 공유 정의에서만 만들고 마크업에 복제하지 않습니다.
  assert.equal(popupHtml.includes('<select id="hold-duration"></select>'), true);
  for (const { value } of HOLD_DURATION_CHOICES) {
    assert.equal(popupHtml.includes(`value="${value}"`), false);
  }
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sanitizeSettings({
      enabled: false,
      gestureDirection: "left",
      holdDurationMs: "300"
    }))),
    { enabled: false, gestureDirection: "left", holdDurationMs: 300 }
  );
  assert.equal(sanitizeSettings({ holdDurationMs: 999 }).holdDurationMs, 500);
  assert.equal(runtime.namespace.usesReversedGestureOrder(100), true);
  assert.equal(runtime.namespace.usesReversedGestureOrder(500), false);
});

test("방문 기록 URL로 Chrome favicon 주소를 만든다", () => {
  const runtime = loadContentModules();
  const favicon = new URL(
    runtime.namespace.faviconUrl("https://example.com/docs?q=gesture")
  );

  assert.equal(favicon.protocol, "chrome-extension:");
  assert.equal(favicon.pathname, "/_favicon/");
  assert.equal(
    favicon.searchParams.get("pageUrl"),
    "https://example.com/docs?q=gesture"
  );
  assert.equal(favicon.searchParams.get("size"), "32");
});

test("활성 상태에 따라 Chrome 기본 가로 탐색을 차단한다", async () => {
  const runtime = loadContentModules();
  const attribute = "data-gesture-back-history-navigation";
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.rootAttributes.has(attribute), true);

  const storageListener = runtime.listeners.find(({ type }) => type === "storage");
  storageListener.listener({ enabled: { newValue: false } }, "sync");
  assert.equal(runtime.rootAttributes.has(attribute), false);

  storageListener.listener({ enabled: { newValue: true } }, "sync");
  assert.equal(runtime.rootAttributes.has(attribute), true);
});

test("히스토리 클라이언트가 방향과 항목 ID를 전달한다", async () => {
  const runtime = loadContentModules();

  await runtime.namespace.historyClient.getEntries("forward");
  await runtime.namespace.historyClient.navigate(42, "back");
  await runtime.namespace.historyClient.navigateOneStep("forward");

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages)), [
    { type: "GET_TAB_HISTORY", direction: "forward" },
    { type: "NAVIGATE_HISTORY", entryId: 42, direction: "back" },
    { type: "NAVIGATE_ONE_STEP", direction: "forward" }
  ]);
});

test("확장 연결이 끊긴 탭의 한 단계 이동은 조용히 무시한다", async () => {
  const runtime = loadContentModules();
  runtime.chrome.runtime = undefined;

  const navigated = await runtime.namespace.historyClient.navigateOneStep("back");
  assert.equal(navigated, false);
  await assert.rejects(
    runtime.namespace.historyClient.getEntries("back"),
    /페이지를 새로고침해 주세요/
  );
});

test("500ms 전에 끝난 가로 제스처는 히스토리 메뉴를 연다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  controller.handleWheel(createWheelEvent(0, -0.6));
  controller.handleWheel(createWheelEvent(300, -0.6));
  controller.finishShortGesture();

  assert.deepEqual(openedDirections, ["back"]);
});

test("페이지 본문에는 어떤 변환도 걸지 않는다", () => {
  const pageStyles = fs
    .readFileSync(path.join(__dirname, "..", "content", "page-styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // body에 translate를 걸면 position: fixed 자손의 containing block이 되어
  // 고정 헤더가 튀므로, 이 파일은 오버스크롤 차단만 담당해야 합니다.
  assert.equal(/translate|transform|will-change|overflow-x: clip/.test(pageStyles), false);
  assert.equal(pageStyles.includes("overscroll-behavior-x: none"), true);
});

test("가로 제스처를 따라 인디케이터가 손가락 방향으로 움직인다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const shifts = [];

  controller.menu = createGestureMenuStub({
    showGestureIndicator: ({ shift }) => shifts.push(shift)
  });
  controller.handleWheel(createWheelEvent(0, -20));
  controller.handleWheel(createWheelEvent(60, -20));

  assert.equal(shifts.length, 2);
  assert.equal(shifts[0] > 0, true);
  assert.equal(shifts[1] > shifts[0], true);

  controller.endGestureCapture();
  assert.equal(controller.gestureShift, 0);
});

test("인디케이터 이동량은 상한을 넘지 않는다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const shifts = [];

  controller.menu = createGestureMenuStub({
    showGestureIndicator: ({ shift }) => shifts.push(shift)
  });
  for (const timeStamp of [0, 20, 40, 60, 80, 100]) {
    controller.handleWheel(createWheelEvent(timeStamp, -400));
  }

  assert.equal(shifts.at(-1) <= 40, true);
  controller.endGestureCapture();
});

test("가로 스크롤 영역에서는 끝에 도달해도 기록 제스처를 시작하지 않는다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const horizontalScroller = new runtime.Element();
  let prevented = false;

  horizontalScroller.clientWidth = 200;
  horizontalScroller.scrollWidth = 600;
  horizontalScroller.scrollLeft = 400;
  horizontalScroller.computedStyle = { overflowX: "auto" };
  controller.menu = createGestureMenuStub();

  const event = createWheelEvent(0, -20);
  event.composedPath = () => [horizontalScroller];
  event.preventDefault = () => {
    prevented = true;
  };
  controller.handleWheel(event);

  assert.equal(prevented, false);
  assert.equal(runtime.messages.length, 0);
});

test("문서가 그 방향으로 더 스크롤될 때만 제스처를 양보한다", () => {
  const root = { clientWidth: 1200, scrollWidth: 1206, scrollLeft: 0 };
  const runtime = loadContentModules({ scrollingElement: root });
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });

  // 왼쪽 끝이라 뒤로가기 방향으로는 더 스크롤될 여지가 없습니다.
  controller.handleWheel(createWheelEvent(0, -20));
  controller.finishShortGesture();
  assert.deepEqual(openedDirections, ["back"]);

  // 오른쪽으로는 아직 스크롤이 남아 있으므로 페이지에 양보합니다.
  let prevented = false;
  const event = createWheelEvent(1000, 20);
  event.preventDefault = () => {
    prevented = true;
  };
  controller.handleWheel(event);
  assert.equal(prevented, false);
  assert.deepEqual(openedDirections, ["back"]);
});

test("같은 제스처 안에서는 스크롤 영역 판정을 다시 계산하지 않는다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const scroller = new runtime.Element();
  let styleReads = 0;

  Object.defineProperty(scroller, "computedStyle", {
    get() {
      styleReads += 1;
      return { overflowX: "visible" };
    }
  });
  controller.menu = createGestureMenuStub();

  const target = {};
  for (const timeStamp of [0, 40, 80, 120]) {
    const event = createWheelEvent(timeStamp, -20);
    event.target = target;
    event.composedPath = () => [scroller];
    controller.handleWheel(event);
  }

  assert.equal(styleReads, 1);
  controller.endGestureCapture();
});

test("페이지 단위 휠 값은 축에 맞는 크기로 환산한다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const selectionSteps = [];

  controller.menu = createGestureMenuStub({
    isOpen: () => true,
    moveSelection: (step) => selectionSteps.push(step)
  });

  // deltaMode=DOM_DELTA_PAGE인 세로 값은 innerHeight(800)로 환산돼야 합니다.
  const event = createWheelEvent(0, 0, -1);
  event.deltaMode = 2;
  controller.handleWheel(event);

  // 800px / 38px 단계 = 21단계. innerWidth(1200)로 환산되면 31단계가 됩니다.
  assert.equal(selectionSteps.length, 21);
  controller.resetMenuSelection();
});

test("가로 제스처가 500ms 이어지면 한 단계 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();

  for (const timeStamp of [0, 250, 499]) {
    controller.handleWheel(createWheelEvent(timeStamp));
  }
  assert.equal(runtime.messages.length, 0);

  controller.handleWheel(createWheelEvent(500));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
  controller.endGestureCapture();
});

test("설정한 기준 시간이 지나야 한 단계 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.settings.holdDurationMs = 300;
  controller.menu = createGestureMenuStub();

  for (const timeStamp of [0, 150, 299]) {
    controller.handleWheel(createWheelEvent(timeStamp));
  }
  assert.equal(runtime.messages.length, 0);

  controller.handleWheel(createWheelEvent(300));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
  controller.endGestureCapture();
});

for (const holdDurationMs of [100, 200]) {
  const durationLabel = `${holdDurationMs / 1000}초`;

  test(`${durationLabel} 설정에서는 짧은 제스처로 한 단계 이동한다`, async () => {
    const runtime = loadContentModules();
    const controller = new runtime.namespace.GestureController();

    controller.settings.holdDurationMs = holdDurationMs;
    controller.menu = createGestureMenuStub();
    controller.handleWheel(createWheelEvent(0, -0.6));
    controller.handleWheel(createWheelEvent(holdDurationMs - 10, -0.6));
    controller.finishShortGesture();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
      type: "NAVIGATE_ONE_STEP",
      direction: "back"
    });
  });

  test(`${durationLabel} 설정에서는 길게 당기면 히스토리 메뉴를 연다`, () => {
    const runtime = loadContentModules();
    const controller = new runtime.namespace.GestureController();
    const openedDirections = [];

    controller.settings.holdDurationMs = holdDurationMs;
    controller.menu = createGestureMenuStub({
      open: (direction) => {
        openedDirections.push(direction);
        return Promise.resolve(true);
      }
    });

    controller.handleWheel(createWheelEvent(0));
    controller.handleWheel(createWheelEvent(holdDurationMs - 1));
    assert.deepEqual(openedDirections, []);

    controller.handleWheel(createWheelEvent(holdDurationMs));
    assert.deepEqual(openedDirections, ["back"]);
  });
}

test("열린 메뉴에서 세로 제스처로 항목을 선택하고 손을 떼면 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const selectionSteps = [];
  let prevented = false;
  let navigationCount = 0;

  controller.menu = createGestureMenuStub({
    isOpen: () => true,
    moveSelection: (step) => selectionSteps.push(step)
  });
  controller.navigateSelectedEntry = async () => {
    navigationCount += 1;
    return true;
  };

  const event = createWheelEvent(0, 0, -40);
  event.preventDefault = () => {
    prevented = true;
  };
  controller.handleWheel(event);

  assert.equal(prevented, true);
  assert.deepEqual(selectionSteps, [1]);

  controller.finishMenuSelection();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigationCount, 1);
});

test("열린 메뉴에서는 가로 제스처를 무시한다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  let prevented = false;

  controller.menu = createGestureMenuStub({ isOpen: () => true });
  const event = createWheelEvent(0, -30);
  event.preventDefault = () => {
    prevented = true;
  };
  controller.handleWheel(event);

  assert.equal(prevented, true);
  assert.equal(runtime.messages.length, 0);
});

test("한 단계 이동이 실패하면 토스트로 알린다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const toasts = [];

  controller.menu = createGestureMenuStub({
    showToast: (message) => toasts.push(message)
  });
  runtime.chrome.runtime.sendMessage = async () => ({
    ok: false,
    error: "탭이 닫혔거나 더 이상 사용할 수 없습니다."
  });

  await controller.navigateOneStep("back");
  assert.deepEqual(toasts, ["탭이 닫혔거나 더 이상 사용할 수 없습니다."]);
});

function createWheelEvent(timeStamp, deltaX = -8, deltaY = 0) {
  return {
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
}

function createGestureMenuStub(overrides = {}) {
  return {
    getSelected: () => null,
    hideGestureIndicator() {},
    isBusy: () => false,
    isEventFromUi: () => false,
    isOpen: () => false,
    moveSelection() {},
    open: () => Promise.resolve(true),
    showGestureIndicator() {},
    showToast() {},
    ...overrides
  };
}
