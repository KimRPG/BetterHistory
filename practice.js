"use strict";

// 실제 GestureController를 그대로 돌리되, 페이지 이동과 메뉴 표시만 막고
// 판정 과정을 화면에 그립니다. 별도 판정 로직을 두면 연습 결과와 실제 동작이
// 어긋나므로 절대 복제하지 않습니다.

const namespace = globalThis.GestureBackHistory;
const { DEFAULT_SETTINGS, PULL_DISTANCE_CHOICES, sanitizeSettings } = namespace;

const TRACK_RANGE_RATIO = 2;
const MAX_ATTEMPTS = 12;
const ACTION_LABELS = { menu: "메뉴", navigate: "한 단계" };
const RELEASE_LABELS = {
  threshold: "거리 도달",
  hold: "시간 도달",
  momentum: "관성 시작",
  idle: "입력 멈춤"
};
const PHASE_LABELS = {
  finger: "손가락",
  settling: "보류",
  momentum: "관성"
};

const elements = {
  engine: document.querySelector("#engine"),
  direction: document.querySelector("#direction-label"),
  phase: document.querySelector("#live-phase"),
  fill: document.querySelector("#fill"),
  line: document.querySelector("#line"),
  lineLabel: document.querySelector("#line-label"),
  fillTime: document.querySelector("#fill-time"),
  lineTime: document.querySelector("#line-time"),
  lineTimeLabel: document.querySelector("#line-time-label"),
  scaleTimeMax: document.querySelector("#scale-time-max"),
  reason: document.querySelector("#v-reason"),
  marks: document.querySelector("#marks"),
  scaleMax: document.querySelector("#scale-max"),
  pulled: document.querySelector("#v-pulled"),
  travel: document.querySelector("#v-travel"),
  time: document.querySelector("#v-time"),
  speed: document.querySelector("#v-speed"),
  counts: document.querySelector("#v-counts"),
  lag: document.querySelector("#v-lag"),
  threshold: document.querySelector("#threshold"),
  reset: document.querySelector("#reset"),
  attempts: document.querySelector("#attempts")
};

const attempts = [];
let threshold = DEFAULT_SETTINGS.pullDistancePx;
let holdThreshold = DEFAULT_SETTINGS.pullHoldMs;

// 연습 페이지에서는 실제 이동 대신 결과만 기록합니다.
namespace.historyClient = {
  async getEntries() { return []; },
  async navigate() {},
  async navigateOneStep() { return true; },
  async logGesture(entry) { addAttempt(entry); }
};

const controller = new namespace.GestureController();

// 설정과 무관하게 항상 기록합니다. 이 페이지의 존재 이유입니다.
Object.defineProperty(controller.log, "enabled", {
  get: () => true,
  set: () => {}
});

controller.menu = {
  close() {},
  getSelected: () => null,
  hideGestureIndicator() {
    renderLive(null);
  },
  isBusy: () => false,
  isEventFromUi: () => false,
  isOpen: () => false,
  moveSelection() {},
  navigate: () => Promise.resolve(false),
  open: () => Promise.resolve(false),
  showGestureIndicator: (state) => renderLive(state),
  showToast() {}
};

buildThresholdOptions();
void loadThreshold();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.pullDistancePx) void loadThreshold();
});
elements.threshold.addEventListener("change", saveThreshold);
elements.reset.addEventListener("click", clearAttempts);
controller.start();

function buildThresholdOptions() {
  elements.threshold.replaceChildren(
    ...PULL_DISTANCE_CHOICES.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = label;
      return option;
    })
  );
}

async function loadThreshold() {
  const settings = sanitizeSettings(
    await chrome.storage.sync.get(DEFAULT_SETTINGS)
  );
  threshold = settings.pullDistancePx;
  holdThreshold = settings.pullHoldMs;
  elements.threshold.value = String(threshold);
  renderTrack();
}

async function saveThreshold() {
  await chrome.storage.sync.set({
    pullDistancePx: Number(elements.threshold.value)
  });
}

function trackRange() {
  return threshold * TRACK_RANGE_RATIO;
}

function toPercent(distance) {
  return Math.min(100, (distance / trackRange()) * 100);
}

function toTimePercent(ms) {
  return Math.min(100, (ms / (holdThreshold * TRACK_RANGE_RATIO)) * 100);
}

function renderTrack() {
  elements.lineLabel.textContent = `${threshold}px`;
  elements.line.style.left = `${toPercent(threshold)}%`;
  elements.scaleMax.textContent = `${trackRange()}px`;
  elements.lineTimeLabel.textContent = `${holdThreshold}ms`;
  elements.lineTime.style.left = "50%";
  elements.scaleTimeMax.textContent = `${holdThreshold * TRACK_RANGE_RATIO}ms`;
  renderMarks();
}

// 당기는 동안 매 이벤트마다 불립니다. 지금 어디쯤인지 실시간으로 보여 줍니다.
function renderLive(state) {
  if (!state) {
    elements.fill.style.width = "0%";
    elements.fillTime.style.width = "0%";
    elements.phase.textContent = "";
    elements.phase.className = "phase";
    return;
  }

  const pulled = Math.abs(controller.pullDistance);
  const held = controller.pendingPull.reduce(
    (sum, value) => sum + Math.abs(value),
    0
  );
  const phase = controller.wheelPhase.momentum
    ? "momentum"
    : controller.wheelPhase.settling ? "settling" : "finger";

  const heldMs = controller.fingerStartedAt === null
    ? 0
    : controller.lastFingerAt - controller.fingerStartedAt;

  elements.fill.style.width = `${toPercent(pulled)}%`;
  elements.fillTime.style.width = `${toTimePercent(heldMs)}%`;
  elements.direction.textContent =
    state.direction === "forward" ? "앞으로 가는 방향" : "뒤로 가는 방향";
  elements.phase.textContent = held > 0
    ? `${PHASE_LABELS[phase]} · 보류 ${Math.round(held)}px`
    : PHASE_LABELS[phase];
  elements.phase.className = `phase ${phase}`;
  elements.pulled.textContent = `${Math.round(pulled)}px`;
  elements.travel.textContent = `${Math.round(controller.log.fingerTravel)}px`;
  elements.time.textContent = `${Math.round(heldMs)}ms`;
  elements.speed.textContent = `${controller.log.peakSpeed.toFixed(2)}px/ms`;
  elements.counts.textContent = formatCounts(controller.log.counts);
  elements.lag.textContent = "-";
  elements.reason.textContent = "-";
}

function formatCounts(counts) {
  return `손 ${counts.finger} · 보류 ${counts.settling} · 관성 ${counts.momentum}`;
}

function addAttempt(entry) {
  attempts.unshift(entry);
  attempts.length = Math.min(attempts.length, MAX_ATTEMPTS);

  elements.engine.textContent = entry.engine;
  elements.pulled.textContent = `${entry.pulled}px`;
  elements.travel.textContent = `${entry.fingerTravel}px`;
  elements.time.textContent = `${entry.heldMs}ms`;
  elements.speed.textContent = `${entry.peakSpeed}px/ms`;
  elements.counts.textContent = formatCounts(entry.counts);
  elements.lag.textContent = `${entry.decisionLagMs}ms`;
  elements.reason.textContent = RELEASE_LABELS[entry.release] ?? entry.release;

  renderMarks();
  renderAttempts();
}

function renderMarks() {
  elements.marks.replaceChildren(
    ...attempts.map((entry, index) => {
      const mark = document.createElement("div");
      mark.className = `mark ${entry.action}${index === 0 ? " latest" : ""}`;
      mark.style.left = `${toPercent(entry.pulled)}%`;
      mark.style.opacity = String(Math.max(0.25, 1 - index * 0.08));
      return mark;
    })
  );
}

function renderAttempts() {
  if (!attempts.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "아직 시도가 없습니다.";
    elements.attempts.replaceChildren(empty);
    return;
  }

  elements.attempts.replaceChildren(
    ...attempts.map((entry) => {
      const item = document.createElement("li");
      const badge = document.createElement("span");
      badge.className = `badge ${entry.action}`;
      badge.textContent = ACTION_LABELS[entry.action] ?? entry.action;

      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent =
        `${entry.direction === "forward" ? "앞으로" : "뒤로"}` +
        ` · ${entry.pulled}/${entry.threshold}px` +
        ` · ${entry.heldMs}/${entry.holdThreshold}ms · ${entry.peakSpeed}px/ms` +
        ` · ${RELEASE_LABELS[entry.release] ?? entry.release}` +
        ` · ${formatCounts(entry.counts)}`;

      item.append(badge, detail);
      return item;
    })
  );
}

function clearAttempts() {
  attempts.length = 0;
  renderMarks();
  renderAttempts();
}
