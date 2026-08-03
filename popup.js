"use strict";

const {
  DEFAULT_SETTINGS,
  HOLD_STILL_CHOICES,
  LANGUAGE_CHOICES,
  localizeDocument,
  readMessages,
  sanitizeSettings,
  toSeconds,
  useMessages,
  t
} = globalThis.GestureBackHistory;

const enabledInput = document.querySelector("#enabled");
const directionInput = document.querySelector("#gesture-direction");
const languageInput = document.querySelector("#language");
const holdStillGroup = document.querySelector("#hold-still");
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
  fillSegments(holdStillGroup, HOLD_STILL_CHOICES);
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

// 세 선택지를 나란히 놓습니다. 이름만으로는 "짧게"가 얼마나 짧은지 알 수
// 없으므로 초를 함께 붙여, 펼치거나 고르지 않고도 값이 보이게 합니다.
function fillSegments(group, choices) {
  group.replaceChildren(
    ...choices.map(({ value, labelKey }) => {
      const segment = document.createElement("label");
      segment.className = "segment";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = group.id;
      input.value = String(value);
      // 저장된 값을 읽어 오기 전 한 칸도 켜지지 않은 상태로 그려지면 고장난
      // 것처럼 보입니다. 기본값을 먼저 켜 두고 applyValues가 고칩니다.
      input.checked = value === DEFAULT_SETTINGS.holdStillMs;

      const body = document.createElement("span");
      body.className = "segment-body";
      body.append(
        createSpan("segment-name", t(labelKey)),
        createSpan("segment-seconds", t("thresholdSeconds", [toSeconds(value)]))
      );

      segment.append(input, body);
      return segment;
    })
  );
}

function createSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function applyValues(settings) {
  enabledInput.checked = settings.enabled;
  directionInput.value = settings.gestureDirection;
  languageInput.value = settings.language;
  for (const input of holdStillGroup.querySelectorAll("input")) {
    input.checked = Number(input.value) === settings.holdStillMs;
  }
}

function currentSettings() {
  return sanitizeSettings({
    enabled: enabledInput.checked,
    gestureDirection: directionInput.value,
    holdStillMs: holdStillGroup.querySelector("input:checked")?.value,
    language: languageInput.value
  });
}

enabledInput.addEventListener("change", save);
directionInput.addEventListener("change", save);
holdStillGroup.addEventListener("change", save);

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
