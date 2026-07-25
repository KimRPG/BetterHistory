"use strict";

const PROTOCOL_VERSION = "1.3";
const MAX_HISTORY_ENTRIES = 20;
const GENERIC_ERROR_MESSAGE =
  "히스토리를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";

// 사용자에게 그대로 보여도 되는 오류입니다. 그 밖의 오류 원문은 노출하지 않습니다.
class HistoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "HistoryError";
  }
}

const attachedTabs = new Set();
const tabQueues = new Map();

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source?.tabId)) attachedTabs.delete(source.tabId);
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

  if (message?.type === "NAVIGATE_HISTORY") {
    if (!Number.isInteger(message.entryId)) {
      sendResponse({ ok: false, error: "잘못된 히스토리 항목입니다." });
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

async function navigateOneStep(tabId, direction = "back") {
  try {
    if (direction === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      await chrome.tabs.goBack(tabId);
    }
    return true;
  } catch (error) {
    if (isUnavailableHistoryError(error)) return false;
    throw error;
  }
}

async function getTabHistory(tabId, direction = "back") {
  return withDebugger(tabId, async (target) => {
    const history = await chrome.debugger.sendCommand(
      target,
      "Page.getNavigationHistory"
    );

    if (!history || !Array.isArray(history.entries)) {
      throw new HistoryError("탭 히스토리를 읽지 못했습니다.");
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
        title: cleanText(entry.title) || cleanText(entry.url) || "제목 없는 페이지",
        url: cleanText(entry.url),
        distance: index + 1
      }))
      .filter((entry) => Number.isInteger(entry.id) && entry.url)
      .slice(0, MAX_HISTORY_ENTRIES);
  });
}

async function navigateToHistoryEntry(tabId, entryId, direction = "back") {
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
      throw new HistoryError("페이지 기록이 바뀌었습니다. 메뉴를 다시 열어 주세요.");
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
      throw new HistoryError("디버거 연결이 해제되어 히스토리를 읽지 못했습니다.");
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
    console.warn("GestureBackHistory: 처리하지 못한 오류입니다.", error);
  }

  return { ok: false, error: message || GENERIC_ERROR_MESSAGE };
}

function toFriendlyMessage(rawMessage) {
  if (/Another debugger|already attached|Cannot attach/i.test(rawMessage)) {
    return "이 탭에 DevTools 또는 다른 디버거가 연결되어 있습니다. 닫은 뒤 다시 시도해 주세요.";
  }
  if (/Cannot access|not allowed|restricted/i.test(rawMessage)) {
    return "Chrome이 보호하는 페이지에서는 히스토리를 열 수 없습니다.";
  }
  if (/No tab with given id|target closed/i.test(rawMessage)) {
    return "탭이 닫혔거나 더 이상 사용할 수 없습니다.";
  }
  return "";
}
