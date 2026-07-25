"use strict";

const { DEFAULT_SETTINGS, HOLD_DURATION_CHOICES, sanitizeSettings } =
  globalThis.GestureBackHistory;

const enabledInput = document.querySelector("#enabled");
const directionInput = document.querySelector("#gesture-direction");
const holdDurationInput = document.querySelector("#hold-duration");
const status = document.querySelector("#status");
let statusTimer = null;

buildHoldDurationOptions();
initialize();

function buildHoldDurationOptions() {
  holdDurationInput.replaceChildren(
    ...HOLD_DURATION_CHOICES.map(({ value, label }) => {
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
    holdDurationInput.value = String(settings.holdDurationMs);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

enabledInput.addEventListener("change", save);
directionInput.addEventListener("change", save);
holdDurationInput.addEventListener("change", save);

async function save() {
  try {
    await chrome.storage.sync.set(
      sanitizeSettings({
        enabled: enabledInput.checked,
        gestureDirection: directionInput.value,
        holdDurationMs: holdDurationInput.value
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
