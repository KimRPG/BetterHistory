"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentFiles = [
  "shared/i18n.js",
  "shared/settings.js",
  "content/menu-styles.js",
  "content/wheel-phase.js",
  "content/history-client.js",
  "content/history-menu.js",
  "content/gesture-controller.js",
  "content/index.js"
];


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

function loadContentModules({
  scrollingElement = null,
  historyLength = 2,
  url = "https://example.com/docs"
} = {}) {
  const listeners = [];
  const messages = [];
  const rootAttributes = new Set();
  const chrome = {
    i18n: createI18n(),
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
    history: { length: historyLength },
    location: new URL(url),
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
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
    namespace: context.BetterGesture,
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
      use_dynamic_url: true
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
  const {
    DEFAULT_SETTINGS,
    HOLD_STILL_CHOICES,
    LANGUAGE_CHOICES,
    sanitizeSettings,
    toSeconds
  } = runtime.namespace;
  const popupHtml = fs.readFileSync(
    path.join(__dirname, "..", "popup.html"),
    "utf8"
  );

  // 사용자가 고르는 것은 멈춘 뒤 기다리는 시간뿐입니다. 당김 판정 시간과
  // 거리는 설정에 남아 있지 않습니다.
  //
  // 값 자체는 손에 맞춰 조정하는 것이라 고정하지 않고, 세그먼트가 왼쪽부터
  // 짧은 순으로 놓이는지와 가운데가 기본값인지만 봅니다.
  const holdValues = [...HOLD_STILL_CHOICES].map(({ value }) => value);
  assert.equal(holdValues.length, 3);
  assert.deepEqual([...holdValues].sort((a, b) => a - b), holdValues);
  assert.equal(holdValues[1], DEFAULT_SETTINGS.holdStillMs);
  for (const key of ["pullDistancePx", "pullHoldMs", "debugLogging", "enabled"]) {
    assert.equal(key in DEFAULT_SETTINGS, false, `${key}가 아직 설정에 있습니다`);
  }
  assert.equal(popupHtml.includes('src="shared/settings.js"'), true);
  // 선택지 목록은 공유 정의에서만 만들고 마크업에 복제하지 않습니다.
  assert.equal(popupHtml.includes('id="hold-still"'), true);
  for (const { value } of HOLD_STILL_CHOICES) {
    assert.equal(popupHtml.includes(`value="${value}"`), false);
  }
  // 접어 두지 않고 세 선택지를 그대로 보여 줍니다.
  assert.equal(popupHtml.includes("<details"), false);
  assert.equal(popupHtml.includes('role="radiogroup"'), true);

  // 전역 켜기/끄기 자리에 사이트별 토글이 들어갔습니다.
  assert.equal(popupHtml.includes('id="site-enabled"'), true);
  assert.equal(popupHtml.includes('id="enabled"'), false);

  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sanitizeSettings({
      enabled: false,
      gestureDirection: "left",
      holdStillMs: "300",
      disabledSites: ["news.example.com"]
    }))),
    {
      gestureDirection: "left",
      holdStillMs: 300,
      language: "auto",
      disabledSites: ["news.example.com"]
    }
  );
  // 목록에 있는 값은 그대로, 없는 값은 기본값으로 되돌아갑니다.
  for (const value of holdValues) {
    assert.equal(sanitizeSettings({ holdStillMs: value }).holdStillMs, value);
  }
  assert.equal(
    sanitizeSettings({ holdStillMs: 999 }).holdStillMs,
    DEFAULT_SETTINGS.holdStillMs
  );
  // 예전에 저장해 둔 당김 시간이 그대로 넘어오면 안 됩니다.
  assert.equal(
    sanitizeSettings({ holdStillMs: 180 }).holdStillMs,
    DEFAULT_SETTINGS.holdStillMs
  );

  // 라벨에 붙는 초는 항상 소수 둘째 자리까지입니다.
  assert.equal(toSeconds(300), "0.30");
  assert.equal(toSeconds(450), "0.45");
  assert.equal(toSeconds(3000), "3.00");

  // 언어는 목록에 있는 값만 받습니다. 없는 값이 들어오면 Chrome 설정을 따릅니다.
  assert.deepEqual(
    [...LANGUAGE_CHOICES].map(({ value }) => value),
    ["auto", "en", "ko", "ja", "zh_CN"]
  );
  assert.equal(sanitizeSettings({ language: "ja" }).language, "ja");
  assert.equal(sanitizeSettings({ language: "fr" }).language, "auto");
  assert.equal(sanitizeSettings(undefined).language, "auto");
  assert.equal(popupHtml.includes('<select id="language"></select>'), true);
  for (const { value } of LANGUAGE_CHOICES) {
    assert.equal(popupHtml.includes(`value="${value}"`), false);
  }
});

test("제외 목록은 호스트명만 남기고 콘텐츠 스크립트가 못 도는 곳은 걸러 낸다", () => {
  const { isSiteDisabled, sanitizeSettings, toSiteKey } = loadContentModules().namespace;

  // 스킴과 경로는 키에 넣지 않습니다. 넣으면 같은 사이트가 http와 https로,
  // /a와 /b로 갈라져 사용자가 끈 것과 실제로 꺼지는 곳이 어긋납니다.
  assert.equal(toSiteKey("https://www.handong.edu/handongin/"), "www.handong.edu");
  assert.equal(toSiteKey("http://WWW.Handong.EDU/x?y=1"), "www.handong.edu");
  // chrome://은 hostname이 그럴듯하게 나오지만 콘텐츠 스크립트가 돌지 않습니다.
  assert.equal(toSiteKey("chrome://extensions/"), "");
  assert.equal(toSiteKey("chrome://newtab/"), "");
  assert.equal(toSiteKey("file:///Users/me/page.html"), "");
  assert.equal(toSiteKey(""), "");
  assert.equal(toSiteKey(undefined), "");

  // 저장된 목록은 빈 값과 중복을 걸러 내고, 문자열이 아닌 것은 버립니다.
  assert.deepEqual(
    [...sanitizeSettings({
      disabledSites: ["A.com", "a.com", " b.com ", "", 7, null]
    }).disabledSites],
    ["a.com", "b.com"]
  );
  assert.deepEqual([...sanitizeSettings({ disabledSites: "a.com" }).disabledSites], []);

  // sync 저장소 한도를 넘기지 않도록 상한을 두고, 최근에 끈 것을 남깁니다.
  const many = Array.from({ length: 320 }, (_, index) => `s${index}.com`);
  const capped = sanitizeSettings({ disabledSites: many }).disabledSites;
  assert.equal(capped.length, 300);
  assert.equal(capped.at(-1), "s319.com");

  const settings = sanitizeSettings({ disabledSites: ["a.com"] });
  assert.equal(isSiteDisabled(settings, "a.com"), true);
  assert.equal(isSiteDisabled(settings, "b.com"), false);
  // 호스트명을 못 얻은 탭이 목록의 빈 항목과 우연히 맞아떨어지면 안 됩니다.
  assert.equal(isSiteDisabled(settings, ""), false);
  assert.equal(isSiteDisabled(sanitizeSettings({ disabledSites: [""] }), ""), false);
});

test("popup.js가 찾는 요소가 popup.html에 모두 있다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const ids = [...source.matchAll(/querySelector\("#([\w-]+)"\)/g)]
    .map(([, id]) => id);

  assert.equal(ids.length > 0, true);
  for (const id of ids) {
    assert.equal(html.includes(`id="${id}"`), true, `#${id}가 없습니다`);
  }
});

// 진단용 화면과 디버그 로그는 배포판에서 뺐습니다. 참조가 하나라도 남으면
// 팝업이나 콘텐츠 스크립트가 없는 파일을 부르며 조용히 죽습니다.
test("연습 화면과 디버그 로그의 흔적이 남아 있지 않다", () => {
  for (const file of ["practice.html", "practice.js", "practice.css", "content/gesture-log.js"]) {
    assert.equal(
      fs.existsSync(path.join(__dirname, "..", file)),
      false,
      `${file}이 아직 있습니다`
    );
  }

  const shipped = [
    "manifest.json",
    "worker.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "shared/settings.js",
    "content/history-client.js",
    "content/gesture-controller.js"
  ];
  for (const file of shipped) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    for (const token of ["practice", "gesture-log", "GestureLog", "LOG_GESTURE", "gestureLogs", "debugLogging"]) {
      assert.equal(
        source.includes(token),
        false,
        `${file}에 ${token}이 남아 있습니다`
      );
    }
  }
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

// 제외한 사이트에서는 제스처를 무시하는 것으로 끝나지 않습니다. Chrome 기본
// 가로 탐색을 막아 두는 속성도 함께 풀어야, 껐을 때 브라우저 원래 스와이프가
// 돌아옵니다.
test("사이트를 제외하면 Chrome 기본 가로 탐색 차단도 함께 푼다", async () => {
  const runtime = loadContentModules({ url: "https://example.com/docs" });
  const attribute = "data-better-gesture-navigation";
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.rootAttributes.has(attribute), true);

  const storageListener = runtime.listeners.find(({ type }) => type === "storage");
  storageListener.listener(
    { disabledSites: { newValue: ["example.com"] } },
    "sync"
  );
  assert.equal(runtime.rootAttributes.has(attribute), false);

  storageListener.listener({ disabledSites: { newValue: [] } }, "sync");
  assert.equal(runtime.rootAttributes.has(attribute), true);
});

test("제외한 사이트에서는 제스처가 아무 일도 하지 않는다", () => {
  const runtime = loadContentModules({ url: "https://example.com/docs" });
  const controller = new runtime.namespace.GestureController();
  const opened = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      opened.push(direction);
      return Promise.resolve(true);
    }
  });
  controller.settings = runtime.namespace.sanitizeSettings({
    disabledSites: ["example.com"]
  });

  let prevented = false;
  for (let index = 0; index <= 12; index += 1) {
    const event = createFingerEvent(index * 16);
    event.preventDefault = () => {
      prevented = true;
    };
    controller.handleWheel(event);
  }

  assert.deepEqual(opened, []);
  assert.equal(runtime.messages.length, 0);
  // 페이지의 스크롤을 확장이 가로채지 않아야 Chrome 기본 동작이 그대로 돕니다.
  assert.equal(prevented, false);

  // 다른 사이트는 같은 설정에서도 평소대로 동작합니다.
  const elsewhere = loadContentModules({ url: "https://other.example/docs" });
  const active = new elsewhere.namespace.GestureController();
  active.menu = createGestureMenuStub({
    open: (direction) => {
      opened.push(direction);
      return Promise.resolve(true);
    }
  });
  active.settings = elsewhere.namespace.sanitizeSettings({
    disabledSites: ["example.com"]
  });
  for (let index = 0; index <= 12; index += 1) {
    active.handleWheel(createFingerEvent(index * 16));
  }
  assert.deepEqual(opened, ["back"]);
  active.endGestureCapture();
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

test("기준 시간을 넘게 당기면 손을 떼기 전에 메뉴가 열린다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });

  // 기본 기준은 180ms입니다. 12번(176ms)까지는 아직 열리지 않아야 합니다.
  for (let index = 0; index < 12; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }
  assert.deepEqual(openedDirections, []);

  controller.handleWheel(createFingerEvent(12 * 16));
  assert.deepEqual(openedDirections, ["back"]);
  controller.endGestureCapture();
});

test("얼마 당기지 않고 입력이 끊기면 한 단계만 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  // 40px = 기준의 27%. 홀드로 볼 만큼 당기지 않았습니다.
  for (let index = 0; index < 2; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }

  // 튕기지 않고 천천히 놓으면 관성이 없어 이벤트가 그냥 끊깁니다.
  controller.finishShortGesture();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedDirections, []);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
});

// 튕겼다면 반드시 관성이 옵니다. 관성 하나 없이 조용해졌다면 손가락이 아직
// 트랙패드에 닿아 있다는 뜻이라, 충분히 당겨 둔 상태면 홀드로 봅니다.
test("관성 없이 멈추면 충분히 당긴 제스처는 메뉴가 열린다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  // 80ms = 기준 시간의 44%. 기준(180ms)에는 못 미칩니다.
  for (let index = 0; index < 6; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }
  assert.deepEqual(openedDirections, []);

  controller.finishShortGesture();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedDirections, ["back"]);
  assert.equal(
    runtime.messages.some((message) => message.type === "NAVIGATE_ONE_STEP"),
    false
  );
});

test("관성 여부를 모르는 Chrome에서는 멈춤을 홀드로 보지 않는다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  // momentum 속성이 없는 이벤트입니다. 감쇠 추정은 짧은 튕김의 관성을 놓칠 수
  // 있어, 이 신호로 홀드를 판정하면 손을 뗀 제스처를 오해합니다.
  for (let index = 0; index < 4; index += 1) {
    controller.handleWheel(createWheelEvent(index * 16, -20));
  }

  controller.finishShortGesture();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedDirections, []);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
});

test("기록이 없는 탭에서는 멈춰도 메뉴 대신 한 단계 이동한다", async () => {
  const runtime = loadContentModules({ historyLength: 1 });
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  // 홀드로 볼 만큼(80ms) 당겼지만 보여 줄 기록이 없습니다.
  for (let index = 0; index < 6; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }

  controller.finishShortGesture();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedDirections, []);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
});

// 당김 판정 시간은 실제 당김 폭에 맞춘 값이라 설정에 두지 않았습니다. 사용자가
// 고른 멈춤 시간이 여기까지 새어 들어오면 두 기준이 다시 얽힙니다.
test("당김 판정 시간은 멈춤 설정과 무관하게 180ms로 고정이다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.settings.holdStillMs = runtime.namespace.HOLD_STILL_CHOICES.at(-1).value;
  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });

  // 176ms까지 당겨도 아직 메뉴가 아닙니다.
  for (let index = 0; index <= 11; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }
  assert.deepEqual(openedDirections, []);

  controller.handleWheel(createFingerEvent(12 * 16));
  assert.deepEqual(openedDirections, ["back"]);
  controller.endGestureCapture();
});

test("멈춘 뒤 기다리는 시간은 설정을 따른다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  // 관성을 정확히 아는 Chrome에서는 진행 정도와 무관하게 고른 시간입니다.
  controller.nativeMomentum = true;
  for (const { value } of runtime.namespace.HOLD_STILL_CHOICES) {
    controller.settings.holdStillMs = value;
    assert.equal(controller.toIdleDelay(0.1), value);
    assert.equal(controller.toIdleDelay(0.9), value);
  }

  // 감쇠 추정 경로에서 오래 참는 쪽은 고른 시간보다 짧아지지 않습니다.
  controller.nativeMomentum = false;
  controller.settings.holdStillMs = 300;
  assert.equal(controller.toIdleDelay(0.1), 300);
  assert.equal(controller.toIdleDelay(0.9), 1200);
  controller.settings.holdStillMs = 3000;
  assert.equal(controller.toIdleDelay(0.1), 3000);
  assert.equal(controller.toIdleDelay(0.9), 3000);
});

test("아주 짧은 제스처도 한 단계 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();
  controller.handleWheel(createFingerEvent(0, -10));
  controller.finishShortGesture();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
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
  assert.equal(controller.pullDistance, 0);
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

  controller.menu = createGestureMenuStub();

  // 왼쪽 끝이라 뒤로가기 방향으로는 더 스크롤될 여지가 없습니다.
  let capturedBack = false;
  const back = createFingerEvent(0, -20);
  back.preventDefault = () => {
    capturedBack = true;
  };
  controller.handleWheel(back);
  assert.equal(capturedBack, true);
  controller.endGestureCapture();

  // 오른쪽으로는 아직 스크롤이 남아 있으므로 페이지에 양보합니다.
  let capturedForward = false;
  const forward = createFingerEvent(1000, 20);
  forward.preventDefault = () => {
    capturedForward = true;
  };
  controller.handleWheel(forward);
  assert.equal(capturedForward, false);
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

// 캡처 단계에서 먼저 받아 버리면 페이지가 그 이벤트를 쓸 생각이었는지 알 수
// 없습니다. 지도 영역을 알아보는 것이 전부 이 등록 순서에 걸려 있습니다.
test("휠은 캡처가 아니라 버블 단계에서 듣는다", () => {
  const runtime = loadContentModules();
  const wheel = runtime.listeners.find(({ type }) => type === "wheel");

  assert.equal(wheel.options.capture ?? false, false);
  assert.equal(wheel.options.passive, false);
});

test("지도처럼 페이지가 가져가는 영역에서만 물러나고 그 밖에서는 그대로 동작한다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  let preventedOverMap = false;
  let preventedOutside = false;

  controller.menu = createGestureMenuStub();

  // 지도 위. 지도가 이미 기본 동작을 막아 둔 이벤트입니다.
  const overMap = createFingerEvent(0, -20);
  overMap.defaultPrevented = true;
  overMap.preventDefault = () => {
    preventedOverMap = true;
  };
  controller.handleWheel(overMap);

  assert.equal(preventedOverMap, false);
  assert.equal(controller.gestureDirection, null);

  // 같은 페이지의 지도 밖. 아무도 가져가지 않았으므로 그대로 제스처입니다.
  const outside = createFingerEvent(1000, -20);
  outside.preventDefault = () => {
    preventedOutside = true;
  };
  controller.handleWheel(outside);

  assert.equal(preventedOutside, true);
  assert.equal(controller.gestureDirection, "back");
  controller.endGestureCapture();
});

test("제스처 도중 페이지가 입력을 가져가면 이동하지 않고 접는다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();
  controller.handleWheel(createFingerEvent(0, -20));
  assert.equal(controller.gestureDirection, "back");

  const owned = createFingerEvent(20, -20);
  owned.defaultPrevented = true;
  controller.handleWheel(owned);

  assert.equal(controller.gestureDirection, null);
  assert.equal(controller.gestureIdleTimer, null);
  assert.equal(runtime.messages.length, 0);
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

test("관성 이벤트는 당긴 거리에 넣지 않는다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });

  // 손가락으로는 60px만 당겼습니다.
  for (let index = 0; index < 3; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }
  // 손을 뗀 뒤 관성이 400px를 더 흘려보내도 기준(180px)을 넘으면 안 됩니다.
  for (let index = 0; index < 20; index += 1) {
    controller.handleWheel(createMomentumEvent(48 + index * 16));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedDirections, []);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
  // 관성이 아무리 길어도 이동은 한 번뿐입니다.
  assert.equal(runtime.messages.length, 1);
});

test("관성이 시작되면 기다리지 않고 바로 한 단계 이동한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();
  for (let index = 0; index < 3; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }
  assert.equal(runtime.messages.length, 0);

  // idle 타이머를 기다리지 않고 첫 관성 이벤트에서 판정합니다.
  controller.handleWheel(createMomentumEvent(48));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
  controller.endGestureCapture();
});

test("WheelEvent.momentum이 없으면 감쇠 패턴으로 관성을 알아낸다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();

  // momentum 속성이 없는 구형 Chrome. 손가락 구간은 점점 빨라지고, 손을 떼면
  // 표본마다 거의 일정한 비율로 줄어듭니다. 그 패턴이 이어지면 관성입니다.
  for (let index = 1; index <= 6; index += 1) {
    controller.handleWheel(createWheelEvent((index - 1) * 16, -5 * index));
  }
  assert.equal(controller.wheelPhase.momentum, false);

  let delta = -30;
  for (let index = 0; index < 12; index += 1) {
    delta *= 0.9;
    controller.handleWheel(createWheelEvent((6 + index) * 16, delta));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.wheelPhase.momentum, true);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.messages.at(-1))), {
    type: "NAVIGATE_ONE_STEP",
    direction: "back"
  });
  controller.endGestureCapture();
});

test("일정한 속도로 계속 당기는 동안은 관성으로 보지 않는다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  for (let index = 0; index < 13; index += 1) {
    controller.handleWheel(createWheelEvent(index * 16, -20));
  }

  assert.equal(controller.wheelPhase.momentum, false);
  assert.deepEqual(openedDirections, ["back"]);
  controller.endGestureCapture();
});

test("직전 스크롤이 남긴 관성으로는 제스처를 시작하지 않는다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  for (let index = 0; index < 20; index += 1) {
    controller.handleWheel(createMomentumEvent(index * 16));
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedDirections, []);
  assert.equal(runtime.messages.length, 0);
});

test("WheelEvent.momentum이 있으면 추정하지 않고 그대로 따른다", () => {
  const runtime = loadContentModules();
  const tracker = new runtime.namespace.WheelPhaseTracker();

  assert.equal(tracker.update(createMomentumEvent(0), -20), "momentum");
  assert.equal(tracker.update(createFingerEvent(16), -20), "finger");
});

test("잦아들던 관성 중에 손가락이 다시 닿으면 판정이 풀린다", () => {
  const runtime = loadContentModules();
  const tracker = new runtime.namespace.WheelPhaseTracker();

  let delta = -8;
  for (let index = 0; index < 16; index += 1) {
    tracker.update(createWheelEvent(index * 16, delta), delta);
    delta *= 0.9;
  }
  assert.equal(tracker.momentum, true);

  // 잦아들던 중 훨씬 큰 입력이 들어오면 손가락이 다시 닿은 것입니다.
  assert.equal(tracker.update(createWheelEvent(300, -40), -40), "finger");
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
    defaultPrevented: false,
    deltaMode: 0,
    deltaX,
    deltaY,
    isTrusted: true,
    preventDefault() {},
    timeStamp,
    webkitDirectionInvertedFromDevice: true
  };
}

// Chrome 151+는 관성 여부를 WheelEvent.momentum으로 알려 줍니다.
function createFingerEvent(timeStamp, deltaX = -20) {
  return { ...createWheelEvent(timeStamp, deltaX), momentum: false };
}

function createMomentumEvent(timeStamp, deltaX = -20) {
  return { ...createWheelEvent(timeStamp, deltaX), momentum: true };
}

function createGestureMenuStub(overrides = {}) {
  return {
    getSelected: () => null,
    resetUi() {},
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

// 언어를 바꾸면 이미 만들어 둔 메뉴 DOM에 옛 문구가 박혀 있습니다.
test("언어를 바꾸면 문구표를 받아 오고 메뉴를 다시 만들게 한다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  let resets = 0;

  controller.menu = createGestureMenuStub({ resetUi: () => { resets += 1; } });
  controller.settings.language = "ja";
  await controller.applyLanguage();

  const asked = runtime.messages.filter((m) => m.type === "GET_MESSAGES");
  assert.deepEqual(JSON.parse(JSON.stringify(asked)), [
    { type: "GET_MESSAGES", language: "ja" }
  ]);
  assert.equal(resets, 1);

  // 같은 언어로 다시 부르면 왕복하지 않습니다.
  await controller.applyLanguage();
  assert.equal(runtime.messages.filter((m) => m.type === "GET_MESSAGES").length, 1);
});

test("자동이면 서비스 워커에 문구를 물어보지 않는다", async () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();
  await controller.applyLanguage();

  // chrome.i18n이 이미 Chrome UI 언어로 답합니다.
  assert.equal(
    runtime.messages.some((message) => message.type === "GET_MESSAGES"),
    false
  );
  assert.equal(runtime.namespace.t("menuTitleBack"), "뒤로 갈 페이지");
});

// 확장을 새로고침하면 이미 열려 있던 탭의 옛 콘텐츠 스크립트에서는 chrome
// API가 전부 던집니다. 문구를 꺼내다 실패한 것이 원래 알리려던 오류를
// 덮어쓰면, 조용히 넘어가야 할 자리에서 처리되지 않은 예외가 됩니다.
test("컨텍스트가 끊겨도 문구 조회가 던지지 않는다", async () => {
  const runtime = loadContentModules();
  const { t, historyClient } = runtime.namespace;

  runtime.chrome.i18n.getMessage = () => {
    throw new Error("Extension context invalidated.");
  };
  runtime.chrome.runtime.sendMessage = () => {
    throw new Error("Extension context invalidated.");
  };

  assert.equal(t("menuTitleBack"), "menuTitleBack");
  // 한 단계 이동은 오류를 띄우지 않고 조용히 넘어갑니다.
  assert.equal(await historyClient.navigateOneStep("back"), false);
});
