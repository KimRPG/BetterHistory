"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workerSource = fs.readFileSync(
  path.join(__dirname, "..", "worker.js"),
  "utf8"
);

function loadWorker(history, tabErrors = {}, hooks = {}) {
  let messageListener = null;
  let detachListener = null;
  const calls = [];
  const attachedTabs = new Set();

  const chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    debugger: {
      onDetach: {
        addListener(listener) {
          detachListener = listener;
        }
      },
      async attach(target, version) {
        calls.push({ method: "attach", target, version });
        if (attachedTabs.has(target.tabId)) {
          throw new Error("Another debugger is already attached to the tab");
        }
        attachedTabs.add(target.tabId);
      },
      async sendCommand(target, method, params) {
        calls.push({ method, target, params });
        await hooks.beforeCommand?.({ target, method, detach: () => detachListener(target, "canceled_by_user") });
        if (method === "Page.getNavigationHistory") return history;
        if (method === "Page.navigateToHistoryEntry") return {};
        throw new Error(`Unexpected command: ${method}`);
      },
      async detach(target) {
        calls.push({ method: "detach", target });
        attachedTabs.delete(target.tabId);
      }
    },
    tabs: {
      async goBack(tabId) {
        calls.push({ method: "goBack", tabId });
        if (tabErrors.back) throw tabErrors.back;
      },
      async goForward(tabId) {
        calls.push({ method: "goForward", tabId });
        if (tabErrors.forward) throw tabErrors.forward;
      }
    }
  };

  const context = vm.createContext({ chrome, console });
  new vm.Script(workerSource, { filename: "worker.js" }).runInContext(context);

  return {
    calls,
    context,
    getMessageListener: () => messageListener,
    getDetachListener: () => detachListener
  };
}

const sampleHistory = {
  currentIndex: 2,
  entries: [
    { id: 10, title: "처음", url: "https://example.com/first" },
    { id: 20, title: "직전", url: "https://example.com/previous" },
    { id: 30, title: "현재", url: "https://example.com/current" },
    { id: 40, title: "앞으로", url: "https://example.com/forward" }
  ]
};

test("뒤로가기 기록은 현재 항목을 제외하고 최신순으로 반환한다", async () => {
  const runtime = loadWorker(sampleHistory);
  const entries = await runtime.context.getTabHistory(7);

  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      id: 20,
      title: "직전",
      url: "https://example.com/previous",
      distance: 1
    },
    {
      id: 10,
      title: "처음",
      url: "https://example.com/first",
      distance: 2
    }
  ]);
  assert.equal(runtime.calls[0].method, "attach");
  assert.equal(runtime.calls.at(-1).method, "detach");
});

test("앞으로가기 기록은 현재 항목 다음부터 가까운 순서로 반환한다", async () => {
  const runtime = loadWorker(sampleHistory);
  const entries = await runtime.context.getTabHistory(7, "forward");

  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      id: 40,
      title: "앞으로",
      url: "https://example.com/forward",
      distance: 1
    }
  ]);
  assert.equal(runtime.calls[0].method, "attach");
  assert.equal(runtime.calls.at(-1).method, "detach");
});

test("선택한 이전 항목으로 이동하고 디버거를 분리한다", async () => {
  const runtime = loadWorker(sampleHistory);
  await runtime.context.navigateToHistoryEntry(7, 10);

  const navigation = runtime.calls.find(
    (call) => call.method === "Page.navigateToHistoryEntry"
  );
  assert.deepEqual(JSON.parse(JSON.stringify(navigation.params)), { entryId: 10 });
  assert.equal(runtime.calls.at(-1).method, "detach");
});

test("선택한 다음 항목으로 이동하고 디버거를 분리한다", async () => {
  const runtime = loadWorker(sampleHistory);
  await runtime.context.navigateToHistoryEntry(7, 40, "forward");

  const navigation = runtime.calls.find(
    (call) => call.method === "Page.navigateToHistoryEntry"
  );
  assert.deepEqual(JSON.parse(JSON.stringify(navigation.params)), { entryId: 40 });
  assert.equal(runtime.calls.at(-1).method, "detach");
});

test("앞으로 가기 또는 사라진 항목으로는 이동하지 않는다", async () => {
  const runtime = loadWorker(sampleHistory);

  await assert.rejects(
    runtime.context.navigateToHistoryEntry(7, 40),
    /페이지 기록이 바뀌었습니다/
  );
  assert.equal(
    runtime.calls.some((call) => call.method === "Page.navigateToHistoryEntry"),
    false
  );
  assert.equal(runtime.calls.at(-1).method, "detach");
});

test("앞으로가기 요청으로 뒤로가기 항목을 선택할 수 없다", async () => {
  const runtime = loadWorker(sampleHistory);

  await assert.rejects(
    runtime.context.navigateToHistoryEntry(7, 20, "forward"),
    /페이지 기록이 바뀌었습니다/
  );
  assert.equal(
    runtime.calls.some((call) => call.method === "Page.navigateToHistoryEntry"),
    false
  );
  assert.equal(runtime.calls.at(-1).method, "detach");
});

test("콘텐츠 스크립트 메시지에 비동기로 응답한다", async () => {
  const runtime = loadWorker(sampleHistory);
  const listener = runtime.getMessageListener();
  let response = null;

  const keepChannelOpen = listener(
    { type: "GET_TAB_HISTORY" },
    { id: "test-extension-id", tab: { id: 7 } },
    (value) => {
      response = value;
    }
  );

  assert.equal(keepChannelOpen, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.ok, true);
  assert.equal(response.entries.length, 2);
});

test("앞으로가기 메시지의 방향을 서비스 워커에 전달한다", async () => {
  const runtime = loadWorker(sampleHistory);
  const listener = runtime.getMessageListener();
  let response = null;

  listener(
    { type: "GET_TAB_HISTORY", direction: "forward" },
    { id: "test-extension-id", tab: { id: 7 } },
    (value) => {
      response = value;
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.ok, true);
  assert.equal(response.entries.length, 1);
  assert.equal(response.entries[0].id, 40);
});

test("요청한 방향으로 한 단계 이동한다", async () => {
  const runtime = loadWorker(sampleHistory);
  const listener = runtime.getMessageListener();
  const responses = [];

  listener(
    { type: "NAVIGATE_ONE_STEP", direction: "back" },
    { id: "test-extension-id", tab: { id: 7 } },
    (value) => responses.push(value)
  );
  await new Promise((resolve) => setImmediate(resolve));

  listener(
    { type: "NAVIGATE_ONE_STEP", direction: "forward" },
    { id: "test-extension-id", tab: { id: 7 } },
    (value) => responses.push(value)
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    runtime.calls.filter(({ method }) =>
      method === "goBack" || method === "goForward"
    ),
    [
      { method: "goBack", tabId: 7 },
      { method: "goForward", tabId: 7 }
    ]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(responses)),
    [
      { ok: true, navigated: true },
      { ok: true, navigated: true }
    ]
  );
});

test("이동할 앞뒤 기록이 없으면 오류 없이 무시한다", async () => {
  const runtime = loadWorker(sampleHistory, {
    back: new Error("Cannot find a previous page in history."),
    forward: new Error("Cannot find a next page in history.")
  });
  const listener = runtime.getMessageListener();
  const responses = [];

  for (const direction of ["back", "forward"]) {
    listener(
      { type: "NAVIGATE_ONE_STEP", direction },
      { id: "test-extension-id", tab: { id: 7 } },
      (value) => responses.push(value)
    );
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(
    JSON.parse(JSON.stringify(responses)),
    [
      { ok: true, navigated: false },
      { ok: true, navigated: false }
    ]
  );
});

test("예상하지 못한 오류의 원문은 노출하지 않는다", async () => {
  const runtime = loadWorker(sampleHistory, {
    back: new Error("Unexpected internal tab failure")
  });
  const listener = runtime.getMessageListener();
  let response = null;

  listener(
    { type: "NAVIGATE_ONE_STEP", direction: "back" },
    { id: "test-extension-id", tab: { id: 7 } },
    (value) => {
      response = value;
    }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.ok, false);
  assert.equal(response.error.includes("Unexpected internal tab failure"), false);
  assert.match(response.error, /잠시 후 다시 시도해 주세요/);
});

test("알려진 오류는 안내 문구로 바꿔서 전달한다", async () => {
  const runtime = loadWorker(sampleHistory, {
    back: new Error("No tab with given id 7")
  });
  const listener = runtime.getMessageListener();
  let response = null;

  listener(
    { type: "NAVIGATE_ONE_STEP", direction: "back" },
    { id: "test-extension-id", tab: { id: 7 } },
    (value) => {
      response = value;
    }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: false,
    error: "탭이 닫혔거나 더 이상 사용할 수 없습니다."
  });
});

test("같은 탭의 디버거 작업은 겹치지 않게 한 줄로 실행한다", async () => {
  let releaseFirstCommand = null;
  const firstCommandStarted = new Promise((resolve) => {
    releaseFirstCommand = resolve;
  });
  const runtime = loadWorker(sampleHistory, {}, {
    async beforeCommand() {
      // 첫 명령을 잡아 두면 두 번째 요청이 겹쳐 들어옵니다.
      if (releaseFirstCommand) {
        const release = releaseFirstCommand;
        releaseFirstCommand = null;
        await new Promise((resolve) => setTimeout(resolve, 5));
        release();
      }
    }
  });

  const [first, second] = await Promise.all([
    runtime.context.getTabHistory(7),
    (async () => {
      await firstCommandStarted;
      return runtime.context.getTabHistory(7);
    })()
  ]);

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);

  // attach/detach가 짝을 이루어 순서대로 나타나야 합니다.
  const lifecycle = runtime.calls
    .filter(({ method }) => method === "attach" || method === "detach")
    .map(({ method }) => method);
  assert.deepEqual(lifecycle, ["attach", "detach", "attach", "detach"]);
});

test("작업 중 디버거가 끊기면 안내 문구로 알린다", async () => {
  const runtime = loadWorker(sampleHistory, {}, {
    async beforeCommand({ method, detach }) {
      if (method === "Page.getNavigationHistory") {
        detach();
        throw new Error("Detached while handling command");
      }
    }
  });

  await assert.rejects(
    runtime.context.getTabHistory(7),
    /디버거 연결이 해제되어/
  );
  // 이미 끊긴 연결에 detach를 다시 호출하지 않습니다.
  assert.equal(runtime.calls.some(({ method }) => method === "detach"), false);
});
