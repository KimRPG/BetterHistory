"use strict";

const { DEFAULT_SETTINGS, PULL_DISTANCE_CHOICES, sanitizeSettings } =
  globalThis.GestureBackHistory;

const enabledInput = document.querySelector("#enabled");
const directionInput = document.querySelector("#gesture-direction");
const pullDistanceInput = document.querySelector("#pull-distance");
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
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

enabledInput.addEventListener("change", save);
directionInput.addEventListener("change", save);
pullDistanceInput.addEventListener("change", save);

async function save() {
  try {
    await chrome.storage.sync.set(
      sanitizeSettings({
        enabled: enabledInput.checked,
        gestureDirection: directionInput.value,
        pullDistancePx: pullDistanceInput.value
      })
    );
    showStatus("저장됨");
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
