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
  const context = vm.createContext({
    chrome,
    clearTimeout,
    console,
    document: {},
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
    namespace: context.GestureBackHistory
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
  assert.equal(typeof runtime.namespace.MENU_STYLES, "string");
  assert.equal(typeof runtime.namespace.historyClient.getEntries, "function");
  assert.equal(typeof runtime.namespace.HistoryMenu, "function");
  assert.equal(typeof runtime.namespace.GestureController, "function");
  assert.deepEqual(
    runtime.listeners.map(({ type }) => type),
    ["storage", "wheel", "keydown", "pointerdown"]
  );
});

test("히스토리 클라이언트가 방향과 항목 ID를 전달한다", async () => {
  const runtime = loadContentModules();

  await runtime.namespace.historyClient.getEntries("forward");
  await runtime.namespace.historyClient.navigate(42, "back");

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages)), [
    { type: "GET_TAB_HISTORY", direction: "forward" },
    { type: "NAVIGATE_HISTORY", entryId: 42, direction: "back" }
  ]);
});

test("가로 제스처가 500ms 이어진 뒤 히스토리 메뉴를 연다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = {
    hideGestureIndicator() {},
    isBusy: () => false,
    isEventFromUi: () => false,
    isOpen: () => false,
    open(direction) {
      openedDirections.push(direction);
      return Promise.resolve(true);
    },
    showGestureIndicator() {}
  };

  for (const timeStamp of [0, 250, 499]) {
    controller.handleWheel(createWheelEvent(timeStamp));
  }
  assert.deepEqual(openedDirections, []);

  controller.handleWheel(createWheelEvent(500));
  assert.deepEqual(openedDirections, ["back"]);
  controller.endGestureCapture();
});

test("오른쪽 밀기가 임계값을 넘으면 손 떼기 닫기 상태가 된다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const previews = [];

  controller.menu = {
    cancelDismissPreview() {},
    setDismissPreview(distance, threshold, armed) {
      previews.push({ distance, threshold, armed });
    }
  };

  controller.updateDismissGesture(
    {
      cancelable: true,
      preventDefault() {},
      webkitDirectionInvertedFromDevice: true
    },
    -30
  );

  assert.equal(controller.dismissArmed, true);
  assert.deepEqual(previews, [
    { distance: 30, threshold: 28, armed: true }
  ]);
  controller.cancelDismissGesture();
});

function createWheelEvent(timeStamp) {
  return {
    cancelable: true,
    clientY: 400,
    composedPath: () => [],
    ctrlKey: false,
    deltaMode: 0,
    deltaX: -8,
    deltaY: 0,
    isTrusted: true,
    preventDefault() {},
    timeStamp,
    webkitDirectionInvertedFromDevice: true
  };
}
