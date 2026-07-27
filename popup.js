"use strict";

const { DEFAULT_SETTINGS, PULL_DISTANCE_CHOICES, sanitizeSettings } =
  globalThis.GestureBackHistory;

const ACTION_LABELS = {
  menu: "메뉴",
  navigate: "한 단계"
};

const enabledInput = document.querySelector("#enabled");
const directionInput = document.querySelector("#gesture-direction");
const pullDistanceInput = document.querySelector("#pull-distance");
const debugLoggingInput = document.querySelector("#debug-logging");
const logPanel = document.querySelector("#log-panel");
const logList = document.querySelector("#log-list");
const status = document.querySelector("#status");
let statusTimer = null;

buildPullDistanceOptions();
initialize();

function buildPullDistanceOptions() {
  pullDistanceInput.replaceChildren(
    ...PULL_DISTANCE_CHOICES.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = label;
      return option;
    })
  );
}

async function initialize() {
  try {
    const settings = sanitizeSettings(
      await chrome.storage.sync.get(DEFAULT_SETTINGS)
    );
    enabledInput.checked = settings.enabled;
    directionInput.value = settings.gestureDirection;
    pullDistanceInput.value = String(settings.pullDistancePx);
    debugLoggingInput.checked = settings.debugLogging;
    await refreshLogs();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

enabledInput.addEventListener("change", save);
directionInput.addEventListener("change", save);
pullDistanceInput.addEventListener("change", save);
debugLoggingInput.addEventListener("change", async () => {
  await save();
  await refreshLogs();
});

document.querySelector("#open-practice").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("practice.html") });
});
document.querySelector("#copy-logs").addEventListener("click", copyLogs);
document.querySelector("#clear-logs").addEventListener("click", clearLogs);

async function save() {
  try {
    await chrome.storage.sync.set(
      sanitizeSettings({
        enabled: enabledInput.checked,
        gestureDirection: directionInput.value,
        pullDistancePx: pullDistanceInput.value,
        debugLogging: debugLoggingInput.checked
      })
    );
    showStatus("저장됨");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function readLogs() {
  const stored = await chrome.storage.session.get({ gestureLogs: [] });
  return Array.isArray(stored.gestureLogs) ? stored.gestureLogs : [];
}

// 페이지가 이동하면 그 탭의 콘솔은 지워지므로, 서비스 워커가 모아 둔 기록을
// 여기서 보여 줍니다.
async function refreshLogs() {
  logPanel.hidden = !debugLoggingInput.checked;
  if (logPanel.hidden) return;

  const logs = await readLogs();
  if (!logs.length) {
    const empty = document.createElement("li");
    empty.className = "log-empty";
    empty.textContent = "아직 기록이 없습니다. 제스처를 해 보세요.";
    logList.replaceChildren(empty);
    return;
  }

  logList.replaceChildren(
    ...logs.slice().reverse().map((entry) => {
      const item = document.createElement("li");
      const action = document.createElement("span");
      action.className = `log-action ${entry.action}`;
      action.textContent = ACTION_LABELS[entry.action] ?? entry.action;
      item.append(
        action,
        ` ${entry.direction === "forward" ? "앞으로" : "뒤로"}` +
        ` · ${entry.pulled}/${entry.threshold}px · ${entry.pullMs}ms` +
        ` · 지연 ${entry.decisionLagMs}ms`
      );
      return item;
    })
  );
}

async function copyLogs() {
  try {
    const logs = await readLogs();
    if (!logs.length) {
      showStatus("복사할 기록이 없습니다", true);
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
    showStatus(`${logs.length}건 복사됨`);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function clearLogs() {
  try {
    await chrome.storage.session.remove("gestureLogs");
    await refreshLogs();
    showStatus("기록을 지웠습니다");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.toggle("error", isError);
  statusTimer = setTimeout(() => {
    status.textContent = "";
    status.classList.remove("error");
  }, 1800);
}
