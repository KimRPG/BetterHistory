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

function loadWorker(history, tabErrors = {}, hooks = {}) {
  let messageListener = null;
  let detachListener = null;
  let createdListener = null;
  let removedListener = null;
  let settingsListener = null;
  const calls = [];
  const attachedTabs = new Set();
  const tabs = new Map((hooks.tabs ?? []).map((tab) => [tab.id, tab]));

  const session = new Map();
  // 팝업에서 설정을 바꾸는 것을 흉내 내려면 목이 읽는 값도 바뀌어야 합니다.
  const settings = { ...(hooks.settings ?? {}) };
  const chrome = {
    i18n: createI18n(),
    storage: {
      onChanged: {
        addListener(listener) {
          settingsListener = listener;
        }
      },
      sync: {
        async get(defaults) {
          return { ...defaults, ...settings };
        }
      },
      session: {
        async get(defaults) {
          const result = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (session.has(key)) result[key] = session.get(key);
          }
          return result;
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) {
            session.set(key, value);
          }
        }
      }
    },
    runtime: {
      id: "test-extension-id",
      getURL: (resource) => `chrome-extension://test/${resource}`,
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
      onCreated: {
        addListener(listener) {
          createdListener = listener;
        }
      },
      onRemoved: {
        addListener(listener) {
          removedListener = listener;
        }
      },
      async goBack(tabId) {
        calls.push({ method: "goBack", tabId });
        if (tabErrors.back) throw tabErrors.back;
      },
      async goForward(tabId) {
        calls.push({ method: "goForward", tabId });
        if (tabErrors.forward) throw tabErrors.forward;
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with given id ${tabId}`);
        return { ...tab };
      },
      async query({ windowId } = {}) {
        return [...tabs.values()]
          .filter((tab) => windowId === undefined || tab.windowId === windowId)
          .map((tab) => ({ ...tab }));
      },
      async update(tabId, properties) {
        calls.push({ method: "activate", tabId, properties });
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with given id ${tabId}`);
        return { ...tab };
      },
      async remove(tabId) {
        calls.push({ method: "remove", tabId });
        tabs.delete(tabId);
      }
    },
    windows: {
      async update(windowId, properties) {
        calls.push({ method: "focusWindow", windowId, properties });
      }
    }
  };

  // 언어를 직접 고르면 워커가 그 문구 파일을 읽습니다.
  const context = vm.createContext({
    chrome,
    console,
    async fetch(url) {
      const locale = String(url).split("/").at(-2);
      const file = path.join(__dirname, "..", "_locales", locale, "messages.json");
      if (!fs.existsSync(file)) return { ok: false };
      return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
    }
  });
  // 서비스 워커는 importScripts로 문구 조회 함수를 불러옵니다. 같은 컨텍스트에
  // 실행해야 worker.js가 globalThis에서 그 함수를 찾을 수 있습니다.
  context.importScripts = (...files) => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      new vm.Script(source, { filename: file }).runInContext(context);
    }
  };
  new vm.Script(workerSource, { filename: "worker.js" }).runInContext(context);

  return {
    calls,
    context,
    session,
    settings,
    tabs,
    getMessageListener: () => messageListener,
    getDetachListener: () => detachListener,
    getCreatedListener: () => createdListener,
    getRemovedListener: () => removedListener,
    getSettingsListener: () => settingsListener
  };
}

const NO_BACK_HISTORY = { currentIndex: 0, entries: [sampleEntry(30, "현재")] };
const MISSING_BACK_PAGE = {
  back: new Error("Cannot find a page to go back to")
};

function sampleEntry(id, title) {
  return { id, title, url: `https://example.com/${id}` };
}

// 링크로 열린 탭(7)과 그 탭을 연 탭(3)입니다.
function linkOpenedTabs({ openerWindowId = 1, forgetOpener = false } = {}) {
  return [
    {
      id: 7,
      windowId: 1,
      url: "https://example.com/opened",
      title: "새 탭",
      ...(forgetOpener ? {} : { openerTabId: 3 })
    },
    {
      id: 3,
      windowId: openerWindowId,
      url: "https://example.com/opener",
      title: "원래 보던 페이지"
    }
  ];
}

async function navigateOneStep(runtime, direction = "back") {
  let response = null;
  runtime.getMessageListener()(
    { type: "NAVIGATE_ONE_STEP", direction },
    { id: "test-extension-id", tab: { id: 7 } },
    (value) => {
      response = value;
    }
  );

  // 탭 닫기는 응답을 보낸 뒤에 이어지므로 한 번 더 흘려보냅니다.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return response;
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

test("한 항목이 걸러져도 개수 제한은 남은 항목 기준으로 적용한다", async () => {
  const entries = Array.from({ length: 26 }, (_, index) => ({
    id: index + 1,
    title: `페이지 ${index + 1}`,
    url: index === 3 ? "" : `https://example.com/${index + 1}`
  }));
  const runtime = loadWorker({ currentIndex: 25, entries });

  const history = await runtime.context.getTabHistory(7);
  assert.equal(history.length, 20);
  assert.equal(history.some((entry) => entry.url === ""), false);
});

test("돌아갈 기록이 없으면 이 탭을 연 탭으로 돌려보내고 현재 탭을 닫는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: linkOpenedTabs()
  });

  const response = await navigateOneStep(runtime);

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    navigated: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), [
    { method: "activate", tabId: 3, properties: { active: true } },
    { method: "remove", tabId: 7 }
  ]);
});

test("연 탭이 다른 창에 있으면 그 창도 앞으로 가져온다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: linkOpenedTabs({ openerWindowId: 2 })
  });

  await navigateOneStep(runtime);

  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), [
    { method: "activate", tabId: 3, properties: { active: true } },
    { method: "focusWindow", windowId: 2, properties: { focused: true } },
    { method: "remove", tabId: 7 }
  ]);
});

test("같은 창이면 창을 따로 앞으로 가져오지 않는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: linkOpenedTabs()
  });

  await navigateOneStep(runtime);

  assert.equal(
    runtime.calls.some(({ method }) => method === "focusWindow"),
    false
  );
});

test("Chrome이 opener를 잊어도 열린 순간에 기억해 둔 탭으로 돌아간다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: linkOpenedTabs({ forgetOpener: true })
  });

  runtime.getCreatedListener()({ id: 7, openerTabId: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.session.get("tabOpeners"))),
    { 7: 3 }
  );

  const response = await navigateOneStep(runtime);

  assert.equal(response.navigated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), [
    { method: "activate", tabId: 3, properties: { active: true } },
    { method: "remove", tabId: 7 }
  ]);
  // 닫은 탭의 관계는 함께 지웁니다.
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.session.get("tabOpeners"))),
    {}
  );
});

test("탭이 닫히면 그 탭을 가리키던 관계도 지운다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY);

  runtime.getCreatedListener()({ id: 7, openerTabId: 3 });
  runtime.getCreatedListener()({ id: 9, openerTabId: 5 });
  await new Promise((resolve) => setImmediate(resolve));

  runtime.getRemovedListener()(3);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.session.get("tabOpeners"))),
    { 9: 5 }
  );
});

// 돌아갈 기록이 없다는 것은 이 탭에서 볼 것이 끝났다는 뜻입니다. 링크로 열린
// 탭인지는 따지지 않습니다 — 주소를 직접 친 탭이든 아니든 뒤로 갈 곳이 없기는
// 마찬가지고, 사용자는 그 전에 보던 화면으로 돌아가려는 것입니다.
test("연 탭이 없어도 돌아갈 기록이 없으면 탭을 닫는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: [
      { id: 7, windowId: 1, url: "https://example.com/typed" },
      { id: 8, windowId: 1, url: "https://example.com/other" }
    ]
  });

  const response = await navigateOneStep(runtime);

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    navigated: true
  });
  // 어디로 갈지는 Chrome이 정합니다. 우리가 활성화할 탭을 고르지 않습니다.
  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), [
    { method: "remove", tabId: 7 }
  ]);
});

test("탭 닫기를 끄면 돌아갈 기록이 없어도 아무 일도 하지 않는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: [
      { id: 7, windowId: 1, url: "https://example.com/typed" },
      { id: 8, windowId: 1, url: "https://example.com/other" }
    ],
    settings: { closeOnDeadEnd: false }
  });

  const response = await navigateOneStep(runtime);

  // 아무 일도 할 수 없는 한 단계 제스처는 오류가 아니라 조용히 무시됩니다.
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    navigated: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), []);
});

test("탭 닫기를 끄면 연 탭이 있어도 제스처로는 닫지 않는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: [
      { id: 7, windowId: 1, openerTabId: 3 },
      { id: 3, windowId: 1, url: "https://example.com/list" }
    ],
    settings: { closeOnDeadEnd: false }
  });

  const response = await navigateOneStep(runtime);

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    navigated: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), []);
});

test("연 탭이 이미 닫혔어도 돌아갈 기록이 없으면 탭을 닫는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: [
      { id: 7, windowId: 1, openerTabId: 3 },
      { id: 8, windowId: 1 }
    ]
  });

  await navigateOneStep(runtime);

  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), [
    { method: "remove", tabId: 7 }
  ]);
});

// 마지막 탭을 닫으면 창이 통째로 사라집니다. 돌아갈 곳도 정해져 있지 않은데
// 뒤로가기 한 번으로 창을 없애면 시킨 일의 범위를 넘습니다.
test("연 탭도 없고 창에 탭이 하나뿐이면 아무것도 하지 않는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: [{ id: 7, windowId: 1, url: "https://example.com/only" }]
  });

  const response = await navigateOneStep(runtime);

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    navigated: false
  });
  assert.deepEqual(tabActions(runtime), []);
});

// 반대로 연 탭이 있으면 어디서 왔는지가 분명합니다. 창이 닫혀도 그쪽으로
// 이어지므로 마지막 탭이라도 닫습니다.
test("창에 하나뿐이어도 연 탭이 있으면 그쪽으로 보내고 닫는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, MISSING_BACK_PAGE, {
    tabs: linkOpenedTabs({ openerWindowId: 2 })
  });

  const response = await navigateOneStep(runtime);

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    navigated: true
  });
  assert.equal(
    runtime.calls.some(({ method, tabId }) => method === "remove" && tabId === 7),
    true
  );
});

test("앞으로 갈 기록이 없을 때는 연 탭으로 돌아가지 않는다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, {
    forward: new Error("Cannot find a next page in history.")
  }, { tabs: linkOpenedTabs() });

  const response = await navigateOneStep(runtime, "forward");

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    navigated: false
  });
  assert.deepEqual(tabActions(runtime), []);
});

test("뒤로 갈 기록이 없으면 기록 메뉴에 이 탭을 연 페이지를 보여 준다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, {}, { tabs: linkOpenedTabs() });

  const entries = await runtime.context.getTabHistory(7);

  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      id: -1,
      title: "원래 보던 페이지",
      url: "https://example.com/opener",
      distance: 1,
      opener: true
    }
  ]);
});

test("돌아갈 기록이 있으면 연 탭 항목은 넣지 않는다", async () => {
  const runtime = loadWorker(sampleHistory, {}, { tabs: linkOpenedTabs() });

  const entries = await runtime.context.getTabHistory(7);

  assert.equal(entries.length, 2);
  assert.equal(entries.some((entry) => entry.opener), false);
});

test("연 탭도 없으면 기록 메뉴는 비어 있다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, {}, { tabs: [] });

  const entries = await runtime.context.getTabHistory(7);

  assert.equal(entries.length, 0);
});

test("메뉴에서 고른 연 탭 항목은 디버거 없이 처리한다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, {}, { tabs: linkOpenedTabs() });

  await runtime.context.navigateToHistoryEntry(7, -1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.calls.some(({ method }) => method === "attach"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(tabActions(runtime))), [
    { method: "activate", tabId: 3, properties: { active: true } },
    { method: "remove", tabId: 7 }
  ]);
});

test("고른 사이에 연 탭이 닫혔으면 안내 문구로 알린다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY, {}, {
    tabs: [{ id: 7, windowId: 1, openerTabId: 3 }]
  });

  await assert.rejects(
    runtime.context.navigateToHistoryEntry(7, -1),
    /이 탭을 연 페이지로 돌아가지 못했습니다/
  );
  assert.deepEqual(tabActions(runtime), []);
});

test("보관하는 탭 관계 개수를 제한한다", async () => {
  const runtime = loadWorker(NO_BACK_HISTORY);
  const created = runtime.getCreatedListener();

  for (let index = 0; index < 320; index += 1) {
    created({ id: 1000 + index, openerTabId: index });
  }
  for (let tick = 0; tick < 330; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const openers = runtime.session.get("tabOpeners");
  assert.equal(Object.keys(openers).length, 300);
  // 탭 id는 증가하기만 하므로 작은 id가 먼저 밀려납니다.
  assert.equal(openers[1019], undefined);
  assert.equal(openers[1020], 20);
});

function tabActions(runtime) {
  return runtime.calls.filter(({ method }) =>
    method === "activate" || method === "remove" || method === "focusWindow"
  );
}

test("고른 언어의 문구표를 콘텐츠 스크립트에 내려 준다", async () => {
  const runtime = loadWorker(sampleHistory);
  const listener = runtime.getMessageListener();
  const responses = [];

  for (const language of ["ja", "auto", "fr"]) {
    listener(
      { type: "GET_MESSAGES", language },
      { id: "test-extension-id", tab: { id: 7 } },
      (value) => responses.push(value)
    );
    await new Promise((resolve) => setImmediate(resolve));
  }

  const japanese = loadMessages("ja");
  assert.equal(responses[0].messages.menuTitleBack.message,
    japanese.menuTitleBack.message);
  // 자동은 chrome.i18n이 이미 답이므로 내려 줄 표가 없습니다.
  assert.equal(responses[1].messages, null);
  // 없는 언어도 오류가 아니라 자동으로 돌아갑니다.
  assert.equal(responses[2].messages, null);
});

test("워커가 만드는 오류 문구도 고른 언어를 따른다", async () => {
  const runtime = loadWorker(sampleHistory, {}, { settings: { language: "en" } });

  await assert.rejects(
    runtime.context.navigateToHistoryEntry(7, 40),
    { message: loadMessages("en").errorHistoryChanged.message }
  );
});

test("언어 설정이 바뀌면 워커도 다시 읽는다", async () => {
  const runtime = loadWorker(sampleHistory, {}, { settings: { language: "en" } });

  await assert.rejects(
    runtime.context.navigateToHistoryEntry(7, 40),
    { message: loadMessages("en").errorHistoryChanged.message }
  );

  // 팝업에서 언어를 바꾸면 storage.onChanged로 알려 옵니다.
  runtime.settings.language = "ja";
  runtime.getSettingsListener()({ language: { newValue: "ja" } }, "sync");
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    runtime.context.navigateToHistoryEntry(7, 40),
    { message: loadMessages("ja").errorHistoryChanged.message }
  );
});
