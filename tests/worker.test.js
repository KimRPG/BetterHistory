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

function loadWorker(history) {
  let messageListener = null;
  const calls = [];

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
      async attach(target, version) {
        calls.push({ method: "attach", target, version });
      },
      async sendCommand(target, method, params) {
        calls.push({ method, target, params });
        if (method === "Page.getNavigationHistory") return history;
        if (method === "Page.navigateToHistoryEntry") return {};
        throw new Error(`Unexpected command: ${method}`);
      },
      async detach(target) {
        calls.push({ method: "detach", target });
      }
    },
    tabs: {
      async goBack(tabId) {
        calls.push({ method: "goBack", tabId });
      },
      async goForward(tabId) {
        calls.push({ method: "goForward", tabId });
      }
    }
  };

  const context = vm.createContext({ chrome, console });
  new vm.Script(workerSource, { filename: "worker.js" }).runInContext(context);

  return { calls, context, getMessageListener: () => messageListener };
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

test("짧은 제스처 방향으로 한 단계 이동한다", async () => {
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
    [{ ok: true }, { ok: true }]
  );
});
