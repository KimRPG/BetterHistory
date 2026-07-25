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
  "gesture-analyzer.js",
  "gesture-controller.js",
  "index.js"
];

function loadContentModules() {
  const listeners = [];
  const messages = [];
  const rootAttributes = new Set();
  const chrome = {
    runtime: {
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
    rootAttributes
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
  assert.equal(typeof runtime.namespace.MENU_STYLES, "string");
  assert.equal(typeof runtime.namespace.historyClient.getEntries, "function");
  assert.equal(typeof runtime.namespace.HistoryMenu, "function");
  assert.equal(typeof runtime.namespace.GestureAnalyzer, "function");
  assert.equal(typeof runtime.namespace.GestureController, "function");
  assert.deepEqual(
    runtime.listeners.map(({ type }) => type),
    ["storage", "wheel", "keydown", "pointerdown"]
  );
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

test("짧은 가로 제스처는 한 단계 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();
  controller.handleWheel(createWheelEvent(0, -16));
  controller.handleWheel(createWheelEvent(80, -12));
  controller.commitQuickNavigation();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.messages)).filter(
      ({ type }) => type === "NAVIGATE_ONE_STEP"
    ),
    [{ type: "NAVIGATE_ONE_STEP", direction: "back" }]
  );
  controller.resetGesture();
});

test("아주 작은 가로 흔들림은 페이지를 이동하지 않는다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();
  controller.handleWheel(createWheelEvent(0, -2));

  assert.equal(controller.commitQuickNavigation(), false);
  assert.equal(
    runtime.messages.some(({ type }) => type === "NAVIGATE_ONE_STEP"),
    false
  );
});

test("천천히 500ms 동안 유지한 제스처는 히스토리 메뉴를 연다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });

  for (const timeStamp of [0, 100, 200, 300, 400, 500]) {
    controller.handleWheel(createWheelEvent(timeStamp, -5));
  }
  const opened = controller.tryOpenHeldMenu();

  assert.equal(opened, true);
  assert.deepEqual(openedDirections, ["back"]);
  assert.equal(
    runtime.messages.some(({ type }) => type === "NAVIGATE_ONE_STEP"),
    false
  );
  controller.resetGesture();
});

test("빠르게 시작해 감소하는 관성 입력은 긴 제스처로 보지 않는다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });

  const momentum = [
    [0, -18],
    [50, -16],
    [100, -13],
    [180, -10],
    [280, -8],
    [390, -6],
    [500, -4]
  ];
  for (const [timeStamp, deltaX] of momentum) {
    controller.handleWheel(createWheelEvent(timeStamp, deltaX));
  }

  assert.equal(controller.tryOpenHeldMenu(), false);
  controller.commitQuickNavigation();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedDirections, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.messages)).filter(
      ({ type }) => type === "NAVIGATE_ONE_STEP"
    ),
    [{ type: "NAVIGATE_ONE_STEP", direction: "back" }]
  );
  controller.resetGesture();
});

test("열린 메뉴에서 세로로 움직이면 선택 항목을 이동한다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const moves = [];

  controller.menu = createGestureMenuStub({
    moveSelection(step) {
      moves.push(step);
    }
  });
  controller.phase = "menu";
  controller.handleWheel(createWheelEvent(600, 0, -40));

  assert.deepEqual(moves, [1]);
  controller.resetGesture();
});

test("메뉴에서 선택한 뒤 손을 떼면 해당 기록으로 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const navigatedEntries = [];
  const selected = { entry: { id: 20 }, button: {} };

  controller.menu = createGestureMenuStub({
    getSelected: () => selected,
    navigate(entry) {
      navigatedEntries.push(entry.id);
      return Promise.resolve(true);
    }
  });
  controller.phase = "menu";
  controller.handleWheel(createWheelEvent(600, 0, -40));
  controller.finishMenuGesture();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(navigatedEntries, [20]);
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
  let open = false;
  const customOpen = overrides.open;
  const customClose = overrides.close;
  const menu = {
    close() {
      open = false;
      customClose?.();
    },
    getSelected: () => null,
    handleKeydown() {},
    hideGestureIndicator() {},
    isBusy: () => false,
    isEventFromUi: () => false,
    isOpen: () => open,
    moveSelection() {},
    navigate: () => Promise.resolve(true),
    open(direction) {
      open = true;
      return customOpen?.(direction) ?? Promise.resolve(true);
    },
    showGestureIndicator() {},
    ...overrides
  };
  menu.open = (direction) => {
    open = true;
    return customOpen?.(direction) ?? Promise.resolve(true);
  };
  menu.close = () => {
    open = false;
    customClose?.();
  };
  return menu;
}
