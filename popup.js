"use strict";

const {
  DEFAULT_SETTINGS,
  HOLD_STILL_CHOICES,
  LANGUAGE_CHOICES,
  isSiteDisabled,
  localizeDocument,
  readMessages,
  sanitizeSettings,
  toSeconds,
  toSiteKey,
  useMessages,
  t
} = globalThis.GestureBackHistory;

const siteRow = document.querySelector("#site-row");
const siteHostLabel = document.querySelector("#site-host");
const siteEnabledInput = document.querySelector("#site-enabled");
const directionInput = document.querySelector("#gesture-direction");
const languageInput = document.querySelector("#language");
const holdStillGroup = document.querySelector("#hold-still");
const status = document.querySelector("#status");
let statusTimer = null;
// 제외 목록은 화면에 다 있지 않습니다. 지금 보고 있는 사이트 한 칸만
// 토글에 있으므로, 나머지는 읽어 둔 것을 그대로 들고 다시 씁니다.
let disabledSites = [];
let siteHost = "";

// 저장된 언어를 읽어 오기 전에 Chrome 언어로 먼저 채웁니다. 빈 라벨이 잠깐
// 보이는 것을 막고, 자동을 쓰는 대부분의 경우 그대로 유지됩니다.
renderLabels();
void initialize();

async function initialize() {
  try {
    const settings = sanitizeSettings(
      await chrome.storage.sync.get(DEFAULT_SETTINGS)
    );
    disabledSites = settings.disabledSites;
    siteHost = toSiteKey(await activeTabUrl());
    await applyLanguage(settings.language);
    renderLabels();
    applyValues(settings);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

// host_permissions에 <all_urls>가 있으므로 tabs 권한 없이도 주소를 읽을 수
// 있습니다. 권한을 하나 더 요구하면 설치 화면의 경고 문구가 늘어납니다.
async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? "";
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
  renderSite(settings);
  directionInput.value = settings.gestureDirection;
  languageInput.value = settings.language;
  for (const input of holdStillGroup.querySelectorAll("input")) {
    input.checked = Number(input.value) === settings.holdStillMs;
  }
}

// chrome:// 페이지나 새 탭, 웹 스토어에는 콘텐츠 스크립트가 아예 주입되지
// 않습니다. 끄고 말 것이 없으므로 토글을 잠그고 이유를 그 자리에 적습니다.
function renderSite(settings) {
  siteHostLabel.textContent = siteHost || t("popupSiteUnavailable");
  siteEnabledInput.disabled = siteHost === "";
  siteEnabledInput.checked = siteHost !== "" && !isSiteDisabled(settings, siteHost);
  siteRow.classList.toggle("unavailable", siteHost === "");
}

function currentSettings() {
  return sanitizeSettings({
    gestureDirection: directionInput.value,
    holdStillMs: holdStillGroup.querySelector("input:checked")?.value,
    language: languageInput.value,
    disabledSites: nextDisabledSites()
  });
}

// 이 사이트 한 칸만 넣고 뺍니다. 켜져 있으면 목록에서 빠지고, 꺼져 있으면
// 맨 뒤에 붙어 가장 최근에 끈 것이 됩니다.
function nextDisabledSites() {
  if (siteHost === "") return disabledSites;

  const others = disabledSites.filter((site) => site !== siteHost);
  return siteEnabledInput.checked ? others : [...others, siteHost];
}

siteEnabledInput.addEventListener("change", save);
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
    const settings = currentSettings();
    await chrome.storage.sync.set(settings);
    // 상한을 넘겨 잘려 나갔을 수 있으므로, 저장한 결과를 다음 기준으로 삼습니다.
    disabledSites = settings.disabledSites;
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
