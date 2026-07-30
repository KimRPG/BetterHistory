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
  "content/gesture-log.js",
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

function loadContentModules({ scrollingElement = null, historyLength = 2 } = {}) {
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
  const { DEFAULT_SETTINGS, LANGUAGE_CHOICES, PULL_DISTANCE_CHOICES, sanitizeSettings } =
    runtime.namespace;
  const popupHtml = fs.readFileSync(
    path.join(__dirname, "..", "popup.html"),
    "utf8"
  );

  assert.deepEqual(
    [...PULL_DISTANCE_CHOICES].map(({ value }) => value),
    [100, 150, 220]
  );
  assert.equal(popupHtml.includes('src="shared/settings.js"'), true);
  // 기준 거리 목록은 공유 정의에서만 만들고 마크업에 복제하지 않습니다.
  assert.equal(popupHtml.includes('<select id="pull-distance"></select>'), true);
  for (const { value } of PULL_DISTANCE_CHOICES) {
    assert.equal(popupHtml.includes(`value="${value}"`), false);
  }
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sanitizeSettings({
      enabled: false,
      gestureDirection: "left",
      pullDistancePx: "100"
    }))),
    {
      enabled: false,
      gestureDirection: "left",
      pullDistancePx: 100,
      pullHoldMs: 120,
      debugLogging: false,
      language: "auto"
    }
  );
  // 판정에 쓰는 기준 시간은 저장하지 않고 선택한 단계에서 함께 끌어옵니다.
  assert.equal(sanitizeSettings({ pullDistancePx: 220 }).pullHoldMs, 280);
  assert.equal(sanitizeSettings({ pullDistancePx: 999 }).pullHoldMs, 180);
  assert.equal(sanitizeSettings({ debugLogging: true }).debugLogging, true);
  assert.equal(sanitizeSettings({ pullDistancePx: 999 }).pullDistancePx, 150);
  // 예전 값(180px)은 더 이상 선택지가 아니므로 기본값으로 되돌아갑니다.
  assert.equal(sanitizeSettings({ pullDistancePx: 180 }).pullDistancePx, 150);

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

for (const [script, markup] of [
  ["popup.js", "popup.html"],
  ["practice.js", "practice.html"]
]) {
  test(`${script}가 찾는 요소가 ${markup}에 모두 있다`, () => {
    const source = fs.readFileSync(path.join(__dirname, "..", script), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "..", markup), "utf8");
    const ids = [...source.matchAll(/querySelector\("#([\w-]+)"\)/g)]
      .map(([, id]) => id);

    assert.equal(ids.length > 0, true);
    for (const id of ids) {
      assert.equal(html.includes(`id="${id}"`), true, `#${id}가 없습니다`);
    }
  });
}

// 연습 화면이 판정 상수를 복제하면 화면 표시와 실제 동작이 조용히 어긋납니다.
// 공유 정의에서 꺼내 쓰되, 내보내지 않은 이름을 꺼내면 undefined가 되어
// 비교가 통째로 무력화되므로 여기서 막습니다.
test("연습 화면이 공유 정의에서 꺼내는 값은 모두 내보내져 있다", () => {
  const runtime = loadContentModules();
  const source = fs.readFileSync(
    path.join(__dirname, "..", "practice.js"),
    "utf8"
  );
  const destructured = source.match(/const\s*\{([^}]+)\}\s*=\s*namespace;/);

  assert.notEqual(destructured, null);
  const names = destructured[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  assert.equal(names.includes("HORIZONTAL_RATIO"), true);
  assert.equal(runtime.namespace.HORIZONTAL_RATIO, 1.25);
  for (const name of names) {
    assert.notEqual(
      runtime.namespace[name],
      undefined,
      `${name}을 내보내지 않았습니다`
    );
  }
});

test("연습 페이지는 실제 판정 코드를 그대로 불러온다", () => {
  const practiceHtml = fs.readFileSync(
    path.join(__dirname, "..", "practice.html"),
    "utf8"
  );
  const loaded = [...practiceHtml.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map(([, src]) => src);

  // 연습 결과가 실제 동작과 어긋나면 안 되므로 판정 모듈을 복제하지 않고
  // 콘텐츠 스크립트를 그대로 씁니다.
  for (const file of ["shared/settings.js", "content/wheel-phase.js", "content/gesture-log.js", "content/gesture-controller.js"]) {
    assert.equal(loaded.includes(file), true, `${file}을 불러오지 않습니다`);
  }
  // index.js를 부르면 컨트롤러가 두 개 생깁니다.
  assert.equal(loaded.includes("content/index.js"), false);
  assert.equal(loaded.at(-1), "practice.js");

  for (const file of loaded) {
    assert.equal(
      fs.existsSync(path.join(__dirname, "..", file)),
      true,
      `${file}이 없습니다`
    );
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

test("설정한 기준 시간을 따른다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const openedDirections = [];

  controller.settings.pullHoldMs = 120;
  controller.menu = createGestureMenuStub({
    open: (direction) => {
      openedDirections.push(direction);
      return Promise.resolve(true);
    }
  });
  for (let index = 0; index < 8; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }
  assert.deepEqual(openedDirections, []);

  controller.handleWheel(createFingerEvent(8 * 16));
  assert.deepEqual(openedDirections, ["back"]);
  controller.endGestureCapture();
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

test("디버그 로그를 켜면 당긴 거리와 시간을 콘솔에 남긴다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();
  const logged = [];

  controller.settings.debugLogging = true;
  controller.log.enabled = true;
  controller.menu = createGestureMenuStub();
  controller.log.finish = new Proxy(controller.log.finish, {
    apply(target, thisArg, args) {
      const summary = Reflect.apply(target, thisArg, args);
      if (summary) logged.push(summary);
      return summary;
    }
  });

  for (let index = 0; index < 6; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }
  controller.finishShortGesture();

  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "menu");
  assert.equal(logged[0].release, "stillness");
  assert.equal(logged[0].direction, "back");
  assert.equal(logged[0].pulled, 120);
  assert.equal(logged[0].pullMs, 80);
  assert.equal(logged[0].heldMs, 80);
  assert.equal(logged[0].holdThreshold, 180);
  assert.deepEqual([...logged[0].samples], [20, 20, 20, 20, 20, 20]);

  // 콘솔에는 사람이 읽는 형태로 나갑니다.
  const summary = runtime.namespace.toGestureSummary(logged[0]);
  assert.equal(summary.동작, "기록 메뉴 열기");
  // 판정은 시간으로만 하므로 거리에는 기준을 붙이지 않습니다.
  assert.equal(summary.진행거리, "120px");
  assert.equal(summary.당긴시간, "80ms / 180ms (44%)");
  assert.equal(summary.손뗌판정, "당긴 채 멈춤 (손가락 유지)");

  // 페이지가 이동해도 남도록 서비스 워커로 보냅니다.
  const sent = runtime.messages.filter((m) => m.type === "LOG_GESTURE");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].entry.pulled, 120);
});

test("디버그 로그를 끄면 아무것도 기록하지 않는다", () => {
  const runtime = loadContentModules();
  const controller = new runtime.namespace.GestureController();

  controller.menu = createGestureMenuStub();
  for (let index = 0; index < 4; index += 1) {
    controller.handleWheel(createFingerEvent(index * 16));
  }

  assert.equal(controller.log.active, false);
  assert.equal(controller.log.counts.finger, 0);
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
