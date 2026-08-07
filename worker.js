"use strict";

// 문구는 콘텐츠 스크립트와 같은 정의를 씁니다. 서비스 워커도 chrome.i18n을
// 그대로 쓸 수 있으므로 조회 함수를 복제하지 않습니다.
importScripts("shared/i18n.js");
const { readMessages, t, useMessages } = globalThis.BetterGesture;

const PROTOCOL_VERSION = "1.3";
const MAX_HISTORY_ENTRIES = 20;
const MAX_TRACKED_OPENERS = 300;
// 실제 히스토리 항목 id는 양수라서, 이 탭을 연 탭을 가리키는 가상 항목과
// 섞이지 않습니다.
const OPENER_ENTRY_ID = -1;

// 사용자에게 그대로 보여도 되는 오류입니다. 그 밖의 오류 원문은 노출하지 않습니다.
class HistoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "HistoryError";
  }
}

// 콘텐츠 스크립트는 확장 리소스를 직접 읽지 못하므로 문구표를 여기서 읽어
// 넘겨 줍니다. 워커 자신이 만드는 오류 문구도 같은 표를 씁니다.
let languagePromise = null;

function ensureLanguage() {
  languagePromise ??= applyLanguage();
  return languagePromise;
}

async function applyLanguage() {
  const stored = await chrome.storage.sync.get({ language: "auto" });
  useMessages(await readMessages(stored.language));
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.language) languagePromise = applyLanguage();
});

const attachedTabs = new Set();
const tabQueues = new Map();
let openerQueue = Promise.resolve();

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source?.tabId)) attachedTabs.delete(source.tabId);
});

// target="_blank" 링크로 열린 탭에는 돌아갈 기록이 없습니다. 그 탭을 연 탭을
// 기억해 두면 뒤로 제스처를 원래 보던 곳으로 돌려보낼 수 있습니다. Chrome도
// openerTabId를 들고 있지만 사용자가 탭을 손으로 옮겨 다니면 지워 버리므로,
// 관계가 확실한 열린 순간에 따로 적어 둡니다.
chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.openerTabId)) return;
  void rememberOpener(tab.id, tab.openerTabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (Number.isInteger(tabId)) void forgetOpener(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) {
    return undefined;
  }

  const tabId = sender.tab.id;

  if (message?.type === "GET_TAB_HISTORY") {
    const direction = normalizeDirection(message.direction);
    getTabHistory(tabId, direction)
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => sendResponse(toErrorResponse(error)));
    return true;
  }

  if (message?.type === "NAVIGATE_ONE_STEP") {
    const direction = normalizeDirection(message.direction);
    navigateOneStep(tabId, direction)
      .then((navigated) => sendResponse({ ok: true, navigated }))
      .catch((error) => sendResponse(toErrorResponse(error)));
    return true;
  }

  if (message?.type === "GET_MESSAGES") {
    readMessages(message.language)
      .then((messages) => sendResponse({ ok: true, messages }))
      .catch(() => sendResponse({ ok: true, messages: null }));
    return true;
  }

  if (message?.type === "NAVIGATE_HISTORY") {
    if (!Number.isInteger(message.entryId)) {
      sendResponse({ ok: false, error: t("errorInvalidEntry") });
      return undefined;
    }

    const direction = normalizeDirection(message.direction);
    navigateToHistoryEntry(tabId, message.entryId, direction)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse(toErrorResponse(error)));
    return true;
  }

  return undefined;
});

// 탭 관계 기록은 한 줄로 세워 씁니다. 탭이 연달아 열리고 닫히면 읽고 쓰는
// 사이에 서로의 결과를 덮어씁니다.
function queueOpenerWrite(update) {
  openerQueue = openerQueue.then(update, update);
  return openerQueue;
}

async function readOpeners() {
  const stored = await chrome.storage.session.get({ tabOpeners: {} });
  const openers = stored.tabOpeners;
  return openers && typeof openers === "object" ? openers : {};
}

function rememberOpener(tabId, openerTabId) {
  return queueOpenerWrite(async () => {
    const openers = { ...(await readOpeners()), [tabId]: openerTabId };
    await chrome.storage.session.set({ tabOpeners: limitOpeners(openers) });
  });
}

// 탭이 닫히면 그 탭의 기록과, 그 탭을 가리키던 기록을 함께 지웁니다.
function forgetOpener(tabId) {
  return queueOpenerWrite(async () => {
    const openers = await readOpeners();
    const remaining = Object.fromEntries(
      Object.entries(openers).filter(
        ([openedId, openerId]) => Number(openedId) !== tabId && openerId !== tabId
      )
    );

    if (Object.keys(remaining).length === Object.keys(openers).length) return;
    await chrome.storage.session.set({ tabOpeners: remaining });
  });
}

// 탭을 닫아도 onRemoved를 놓칠 수 있으므로(브라우저 종료, 서비스 워커 교체)
// 상한을 둡니다. 탭 id는 증가하기만 하므로 작은 id가 오래된 기록입니다.
function limitOpeners(openers) {
  const ids = Object.keys(openers);
  if (ids.length <= MAX_TRACKED_OPENERS) return openers;

  const recent = ids
    .sort((left, right) => Number(left) - Number(right))
    .slice(-MAX_TRACKED_OPENERS);
  return Object.fromEntries(recent.map((id) => [id, openers[id]]));
}

// 이 탭을 연 탭을 찾습니다. Chrome이 들고 있는 openerTabId가 가장 정확하고,
// 그것이 지워졌을 때만 기억해 둔 관계를 씁니다. 두 탭 모두 살아 있어야 합니다.
async function findOpener(tabId) {
  const tab = await getTab(tabId);
  const openerTabId = Number.isInteger(tab?.openerTabId)
    ? tab.openerTabId
    : (await readOpeners())[tabId];

  if (!Number.isInteger(openerTabId) || openerTabId === tabId) return null;

  const opener = await getTab(openerTabId);
  return opener ? { tab, opener } : null;
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    // 이미 닫힌 탭입니다.
    return null;
  }
}

async function returnToOpener(tabId) {
  const found = await findOpener(tabId);
  if (!found) return false;

  const { tab, opener } = found;
  await chrome.tabs.update(opener.id, { active: true });

  if (Number.isInteger(opener.windowId) && opener.windowId !== tab?.windowId) {
    try {
      await chrome.windows.update(opener.windowId, { focused: true });
    } catch {
      // 창을 앞으로 못 가져와도 탭 자체는 이미 활성화되어 있습니다.
    }
  }

  // 닫기를 기다리지 않고 응답합니다. 페이지의 beforeunload 확인창에 막히면
  // 여기서 멈춰 서서 이미 사라질 탭의 메뉴가 응답을 기다리게 됩니다.
  void closeReturnedTab(tabId);
  return true;
}

async function closeReturnedTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // 이미 닫혔거나 페이지가 닫기를 막았습니다. 연 탭은 이미 앞에 나와 있습니다.
  }
  await forgetOpener(tabId);
}

async function getOpenerEntry(tabId) {
  const found = await findOpener(tabId);
  if (!found) return null;

  const url = cleanText(found.opener.url);
  return {
    id: OPENER_ENTRY_ID,
    title: cleanText(found.opener.title) || url || t("openerPageTitle"),
    url,
    distance: 1,
    opener: true
  };
}

async function navigateOneStep(tabId, direction = "back") {
  await ensureLanguage();

  try {
    if (direction === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      await chrome.tabs.goBack(tabId);
    }
    return true;
  } catch (error) {
    if (!isUnavailableHistoryError(error)) throw error;

    // 링크로 새로 열린 탭에는 돌아갈 기록이 없습니다. 뒤로 제스처를 이 탭을
    // 연 탭으로 돌려보냅니다.
    return direction === "back" ? returnToOpener(tabId) : false;
  }
}

async function getTabHistory(tabId, direction = "back") {
  await ensureLanguage();

  const entries = await readNavigationHistory(tabId, direction);
  if (entries.length || direction !== "back") return entries;

  // 뒤로 갈 기록이 없는 탭이라도 링크로 열렸다면 돌아갈 곳이 있습니다.
  const openerEntry = await getOpenerEntry(tabId);
  return openerEntry ? [openerEntry] : [];
}

async function readNavigationHistory(tabId, direction) {
  return withDebugger(tabId, async (target) => {
    const history = await chrome.debugger.sendCommand(
      target,
      "Page.getNavigationHistory"
    );

    if (!history || !Array.isArray(history.entries)) {
      throw new HistoryError(t("errorHistoryRead"));
    }

    const currentIndex = Number.isInteger(history.currentIndex)
      ? history.currentIndex
      : 0;

    const entries = direction === "forward"
      ? history.entries.slice(currentIndex + 1)
      : history.entries.slice(0, currentIndex).reverse();

    // distance는 실제 히스토리 거리라서 걸러내기 전 순서로 계산하고,
    // 개수 제한은 걸러낸 뒤에 적용해야 20개보다 적게 남지 않습니다.
    return entries
      .map((entry, index) => ({
        id: entry.id,
        title: cleanText(entry.title) || cleanText(entry.url) || t("untitledPage"),
        url: cleanText(entry.url),
        distance: index + 1
      }))
      .filter((entry) => Number.isInteger(entry.id) && entry.url)
      .slice(0, MAX_HISTORY_ENTRIES);
  });
}

async function navigateToHistoryEntry(tabId, entryId, direction = "back") {
  await ensureLanguage();

  if (entryId === OPENER_ENTRY_ID) {
    if (direction === "back" && await returnToOpener(tabId)) return;
    throw new HistoryError(t("errorOpenerGone"));
  }

  return withDebugger(tabId, async (target) => {
    const history = await chrome.debugger.sendCommand(
      target,
      "Page.getNavigationHistory"
    );

    const currentIndex = Number.isInteger(history?.currentIndex)
      ? history.currentIndex
      : 0;
    const validEntries = (direction === "forward"
      ? history?.entries?.slice(currentIndex + 1)
      : history?.entries?.slice(0, currentIndex)) ?? [];
    const validEntry = validEntries
      .some((entry) => entry.id === entryId);

    if (!validEntry) {
      throw new HistoryError(t("errorHistoryChanged"));
    }

    await chrome.debugger.sendCommand(
      target,
      "Page.navigateToHistoryEntry",
      { entryId }
    );
  });
}

// 같은 탭에 디버거를 겹쳐 붙이면 두 번째 attach가 실패하고, 먼저 끝난 작업이
// 아직 쓰이는 연결을 떼어 버립니다. 탭 단위로 한 줄로 세워서 실행합니다.
function withDebugger(tabId, operation) {
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  const result = previous.then(
    () => attachAndRun(tabId, operation),
    () => attachAndRun(tabId, operation)
  );
  const tail = result.then(() => {}, () => {});

  tabQueues.set(tabId, tail);
  void tail.then(() => {
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  });

  return result;
}

async function attachAndRun(tabId, operation) {
  const target = { tabId };

  await chrome.debugger.attach(target, PROTOCOL_VERSION);
  attachedTabs.add(tabId);

  try {
    return await operation(target);
  } catch (error) {
    // 디버거 안내 배너의 "취소"나 DevTools 연결로 끊긴 경우입니다.
    if (!attachedTabs.has(tabId)) {
      throw new HistoryError(t("errorDebuggerDetached"));
    }
    throw error;
  } finally {
    if (attachedTabs.delete(tabId)) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        // The tab can close or navigate while detaching. There is nothing left to clean up.
      }
    }
  }
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().slice(0, 2048) : "";
}

function normalizeDirection(value) {
  return value === "forward" ? "forward" : "back";
}

function isUnavailableHistoryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot find (?:a )?(?:next|previous) page in history/i.test(message) ||
    /Cannot find a page to go (?:back|forward) to/i.test(message);
}

function toErrorResponse(error) {
  if (error instanceof HistoryError) {
    return { ok: false, error: error.message };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = toFriendlyMessage(rawMessage);
  if (!message) {
    console.warn("Better Gesture: 처리하지 못한 오류입니다.", error);
  }

  return { ok: false, error: message || t("errorGeneric") };
}

function toFriendlyMessage(rawMessage) {
  if (/Another debugger|already attached|Cannot attach/i.test(rawMessage)) {
    return t("errorDebuggerBusy");
  }
  if (/Cannot access|not allowed|restricted/i.test(rawMessage)) {
    return t("errorProtectedPage");
  }
  if (/No tab with given id|target closed/i.test(rawMessage)) {
    return t("errorTabGone");
  }
  return "";
}
