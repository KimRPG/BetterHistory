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

const enabledInput = document.querySelector("#enabled");
const directionInput = document.querySelector("#gesture-direction");
const languageInput = document.querySelector("#language");
const pullDistanceInput = document.querySelector("#pull-distance");
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
}

function currentSettings() {
  return sanitizeSettings({
    enabled: enabledInput.checked,
    gestureDirection: directionInput.value,
    pullDistancePx: pullDistanceInput.value,
    language: languageInput.value
  });
}

enabledInput.addEventListener("change", save);
directionInput.addEventListener("change", save);
pullDistanceInput.addEventListener("change", save);

// 목록을 다시 그리면 선택값이 지워지므로, 바꾸기 전 상태를 들고 있어야 합니다.
languageInput.addEventListener("change", async () => {
  const settings = currentSettings();
  await save();
  await applyLanguage(settings.language);
  renderLabels();
  applyValues(settings);
});

async function save() {
  try {
    await chrome.storage.sync.set(currentSettings());
    showStatus(t("statusSaved"));
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
