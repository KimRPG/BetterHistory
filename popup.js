"use strict";

const {
  DEFAULT_SETTINGS,
  LANGUAGE_CHOICES,
  PULL_DISTANCE_CHOICES,
  localizeDocument,
  readMessages,
  sanitizeSettings,
  useMessages,
  t
} = globalThis.GestureBackHistory;

const ACTION_KEYS = {
  menu: "logActionMenu",
  navigate: "logActionNavigate"
};

const enabledInput = document.querySelector("#enabled");
const directionInput = document.querySelector("#gesture-direction");
const languageInput = document.querySelector("#language");
const pullDistanceInput = document.querySelector("#pull-distance");
const debugLoggingInput = document.querySelector("#debug-logging");
const advanced = document.querySelector("#advanced");
const logPanel = document.querySelector("#log-panel");
const logList = document.querySelector("#log-list");
const status = document.querySelector("#status");
let statusTimer = null;

// 저장된 언어를 읽어 오기 전에 Chrome 언어로 먼저 채웁니다. 빈 라벨이 잠깐
// 보이는 것을 막고, 자동을 쓰는 대부분의 경우 그대로 유지됩니다.
renderLabels();
void initialize();

async function initialize() {
  try {
    const settings = sanitizeSettings(
      await chrome.storage.sync.get(DEFAULT_SETTINGS)
    );
    await applyLanguage(settings.language);
    renderLabels();
    applyValues(settings);
    // 디버그 로그를 켜 둔 사람은 그걸 보려고 팝업을 엽니다. 접어 두지 않습니다.
    advanced.open = settings.debugLogging;
    await refreshLogs();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

// chrome.i18n은 Chrome UI 언어로 고정이라 덮어쓸 수 없습니다. 직접 고른
// 언어는 같은 메시지 파일을 읽어 조회표로 씁니다.
async function applyLanguage(language) {
  useMessages(await readMessages(language));
}

// 선택지 목록은 공유 정의에서만 만들고 마크업에 복제하지 않습니다. 언어가
// 바뀌면 라벨이 통째로 달라지므로 다시 그립니다.
function renderLabels() {
  localizeDocument();
  fillOptions(languageInput, LANGUAGE_CHOICES);
  fillOptions(pullDistanceInput, PULL_DISTANCE_CHOICES);
}

function fillOptions(select, choices) {
  select.replaceChildren(
    ...choices.map(({ value, label, labelKey }) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = labelKey ? t(labelKey) : label;
      return option;
    })
  );
}

function applyValues(settings) {
  enabledInput.checked = settings.enabled;
  directionInput.value = settings.gestureDirection;
  languageInput.value = settings.language;
  pullDistanceInput.value = String(settings.pullDistancePx);
  debugLoggingInput.checked = settings.debugLogging;
}

function currentSettings() {
  return sanitizeSettings({
    enabled: enabledInput.checked,
    gestureDirection: directionInput.value,
    pullDistancePx: pullDistanceInput.value,
    debugLogging: debugLoggingInput.checked,
    language: languageInput.value
  });
}

enabledInput.addEventListener("change", save);
directionInput.addEventListener("change", save);
pullDistanceInput.addEventListener("change", save);
debugLoggingInput.addEventListener("change", async () => {
  await save();
  await refreshLogs();
});

// 목록을 다시 그리면 선택값이 지워지므로, 바꾸기 전 상태를 들고 있어야 합니다.
languageInput.addEventListener("change", async () => {
  const settings = currentSettings();
  await save();
  await applyLanguage(settings.language);
  renderLabels();
  applyValues(settings);
  await refreshLogs();
});

document.querySelector("#open-practice").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("practice.html") });
});
document.querySelector("#copy-logs").addEventListener("click", copyLogs);
document.querySelector("#clear-logs").addEventListener("click", clearLogs);

async function save() {
  try {
    await chrome.storage.sync.set(currentSettings());
    showStatus(t("statusSaved"));
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
    empty.textContent = t("logEmpty");
    logList.replaceChildren(empty);
    return;
  }

  logList.replaceChildren(
    ...logs.slice().reverse().map((entry) => {
      const item = document.createElement("li");
      const action = document.createElement("span");
      action.className = `log-action ${entry.action}`;
      action.textContent = ACTION_KEYS[entry.action]
        ? t(ACTION_KEYS[entry.action])
        : entry.action;
      const direction = entry.direction === "forward"
        ? t("logDirectionForward")
        : t("logDirectionBack");
      item.append(
        action,
        ` ${direction}` +
        ` · ${entry.heldMs}/${entry.holdThreshold}ms · ${entry.pulled}px` +
        ` · ${t("logDelay")} ${entry.decisionLagMs}ms`
      );
      return item;
    })
  );
}

async function copyLogs() {
  try {
    const logs = await readLogs();
    if (!logs.length) {
      showStatus(t("statusNothingToCopy"), true);
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
    showStatus(t("statusCopied", [String(logs.length)]));
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function clearLogs() {
  try {
    await chrome.storage.session.remove("gestureLogs");
    await refreshLogs();
    showStatus(t("statusCleared"));
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
