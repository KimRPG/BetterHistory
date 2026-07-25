"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  gestureDirection: "right",
  holdDurationMs: 500
};
const HOLD_DURATION_OPTIONS = [300, 500, 700, 1000];

const enabledInput = document.querySelector("#enabled");
const directionInput = document.querySelector("#gesture-direction");
const holdDurationInput = document.querySelector("#hold-duration");
const status = document.querySelector("#status");
let statusTimer = null;

initialize();

async function initialize() {
  try {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    enabledInput.checked = settings.enabled !== false;
    directionInput.value = settings.gestureDirection === "left" ? "left" : "right";
    holdDurationInput.value = normalizeHoldDuration(settings.holdDurationMs);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

enabledInput.addEventListener("change", save);
directionInput.addEventListener("change", save);
holdDurationInput.addEventListener("change", save);

async function save() {
  try {
    await chrome.storage.sync.set({
      enabled: enabledInput.checked,
      gestureDirection: directionInput.value,
      holdDurationMs: normalizeHoldDuration(holdDurationInput.value)
    });
    showStatus("저장됨");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function normalizeHoldDuration(value) {
  const duration = Number(value);
  return HOLD_DURATION_OPTIONS.includes(duration)
    ? duration
    : DEFAULT_SETTINGS.holdDurationMs;
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
