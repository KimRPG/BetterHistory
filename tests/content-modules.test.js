"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentFiles = [
  "menu-styles.js",
  "history-client.js",
  "history-menu.js",
  "gesture-controller.js",
  "index.js"
];

function loadContentModules() {
  const listeners = [];
  const messages = [];
  const rootAttributes = new Set();
  const rootStyles = new Map();
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
      style: {
        removeProperty(name) {
          rootStyles.delete(name);
        },
        setProperty(name, value) {
          rootStyles.set(name, value);
        }
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
    setTimeout,
    URL,
    WheelEvent: {
      DOM_DELTA_LINE: 1,
      DOM_DELTA_PAGE: 2
    },
    window
  });

  for (const file of contentFiles) {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "content", file),
      "utf8"
    );
    new vm.Script(source, { filename: file }).runInContext(context);
  }

  return {
    listeners,
    messages,
    namespace: context.GestureBackHistory,
    rootAttributes,
    rootStyles
  };
}

test("Manifest 순서대로 콘텐츠 모듈을 조립하고 이벤트를 등록한다", () => {
  const runtime = loadContentModules();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
  );
  const declaredFiles = manifest.content_scripts[0].js.map((file) =>
    path.basename(file)
  );

  assert.deepEqual(declaredFiles, contentFiles);
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
  controller.clearPageMotion();
});

test("가로 제스처를 따라 페이지가 움직이고 끝나면 원위치로 돌아온다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const motionAttribute = "data-gesture-back-history-page-motion";
  const shiftProperty = "--gesture-back-history-page-shift";

  controller.menu = createGestureMenuStub();
  controller.handleWheel(createWheelEvent(0, -20));

  assert.equal(runtime.rootAttributes.has(motionAttribute), true);
  assert.equal(parseFloat(runtime.rootStyles.get(shiftProperty)) > 0, true);

  controller.finishShortGesture();
  assert.equal(runtime.rootStyles.get(shiftProperty), "0px");
  controller.clearPageMotion();
  assert.equal(runtime.rootAttributes.has(motionAttribute), false);
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
  controller.clearPageMotion();
});

test("설정한 기준 시간이 지나야 한 단계 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.settings.holdDurationMs = 200;
  controller.menu = createGestureMenuStub();

  for (const timeStamp of [0, 100, 199]) {
    controller.handleWheel(createWheelEvent(timeStamp));
  }
  assert.equal(runtime.messages.length, 0);

  controller.handleWheel(createWheelEvent(200));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
  controller.endGestureCapture();
  controller.clearPageMotion();
});

test("0.1초 설정에서는 짧은 제스처로 한 단계 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.settings.holdDurationMs = 100;
  controller.menu = createGestureMenuStub();
  controller.handleWheel(createWheelEvent(0, -0.6));
  controller.handleWheel(createWheelEvent(90, -0.6));
  controller.finishShortGesture();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
  controller.clearPageMotion();
});

test("0.1초 설정에서는 길게 당기면 히스토리 메뉴를 연다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.settings.holdDurationMs = 100;
  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });

  controller.handleWheel(createWheelEvent(0));
  controller.handleWheel(createWheelEvent(99));
  assert.deepEqual(openedDirections, []);

  controller.handleWheel(createWheelEvent(100));
  assert.deepEqual(openedDirections, ["back"]);
  controller.clearPageMotion();
});

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
  assert.equal(
    runtime.rootAttributes.has("data-gesture-back-history-page-motion"),
    false
  );
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
    hideGestureIndicator() {},
    isBusy: () => false,
    isEventFromUi: () => false,
    isOpen: () => false,
    moveSelection() {},
    open: () => Promise.resolve(true),
    showGestureIndicator() {},
    ...overrides
  };
}
