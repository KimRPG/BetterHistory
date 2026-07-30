"use strict";

// 실제 GestureController를 그대로 돌리되, 페이지 이동과 메뉴 표시만 막고
// 판정 과정을 화면에 그립니다. 별도 판정 로직을 두면 연습 결과와 실제 동작이
// 어긋나므로 절대 복제하지 않습니다.

const namespace = globalThis.GestureBackHistory;
const {
  DEFAULT_SETTINGS,
  HORIZONTAL_RATIO,
  PULL_DISTANCE_CHOICES,
  sanitizeSettings
} = namespace;

const TRACK_RANGE_RATIO = 2;
const MAX_ATTEMPTS = 12;
const MAX_STREAM_TOKENS = 400;
const STREAM_NOTES = {
  native: "wheel 이벤트의 momentum 값을 그대로 붙입니다. 초록색이 관성입니다.",
  estimated: "이 Chrome은 momentum 값을 주지 않아, 감쇠 추정 결과를 기울임으로 붙입니다.",
  vertical: "가로로 인정되지 않는 입력은 옅게 표시합니다."
};
const ACTION_LABELS = { menu: "메뉴", navigate: "한 단계" };
const RELEASE_LABELS = {
  hold: "시간 도달",
  momentum: "관성 시작",
  stillness: "당긴 채 멈춤",
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
  attempts: document.querySelector("#attempts"),
  momentumLog: document.querySelector("#momentum-log"),
  streamNote: document.querySelector("#stream-note")
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

// 판정 결과가 아니라 브라우저가 준 값 자체를 보여 줍니다. 손가락 구간과 관성
// 꼬리의 경계가 어디인지 눈으로 바로 확인할 수 있습니다. controller.start()
// 뒤에 등록해야 같은 이벤트에 대한 감쇠 추정이 이미 갱신된 상태로 읽힙니다.
window.addEventListener("wheel", recordMomentum, { capture: true, passive: true });

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

// 판정선은 시간 트랙에만 있습니다. 거리 트랙은 얼마나 움직였는지만 보여 줍니다.
function renderTrack() {
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

function recordMomentum(event) {
  if (!event.isTrusted) return;

  // 151+는 이벤트마다 값을 직접 줍니다. 그 이전에는 줄 값이 없으므로 같은
  // 이벤트에 대한 감쇠 추정 결과를 대신 붙이고 기울임으로 구분합니다.
  const native = typeof event.momentum === "boolean";
  const momentum = native ? event.momentum : controller.wheelPhase.momentum;
  // 실제 판정과 같은 기준으로 가로 여부를 봅니다. 가로로 인정되지 않는
  // 이벤트는 이 화면의 대상이 아니므로 옅게 둡니다.
  const horizontal =
    Math.abs(event.deltaX) > Math.abs(event.deltaY) * HORIZONTAL_RATIO;

  const token = document.createElement("span");
  token.className =
    `${momentum ? "momentum" : "finger"}${horizontal ? "" : " vertical"}`;
  token.textContent = String(momentum);
  token.title = `deltaX ${event.deltaX.toFixed(1)} · deltaY ${event.deltaY.toFixed(1)}`;

  if (elements.momentumLog.querySelector(".stream-empty")) {
    elements.momentumLog.replaceChildren();
  }
  elements.momentumLog.classList.toggle("estimated", !native);
  elements.momentumLog.append(token);

  while (elements.momentumLog.childElementCount > MAX_STREAM_TOKENS) {
    elements.momentumLog.firstElementChild.remove();
  }
  elements.momentumLog.scrollTop = elements.momentumLog.scrollHeight;

  // 첫 이벤트에서 어느 방식인지 확정됩니다. 제스처를 끝내기 전에 알려 줍니다.
  elements.engine.textContent = native ? "WheelEvent.momentum" : "감쇠 추정";
  elements.streamNote.textContent =
    `${native ? STREAM_NOTES.native : STREAM_NOTES.estimated} ${STREAM_NOTES.vertical}`;
}

function clearMomentumLog() {
  const empty = document.createElement("span");
  empty.className = "stream-empty";
  empty.textContent = "두 손가락으로 움직여 보세요.";
  elements.momentumLog.replaceChildren(empty);
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
      mark.style.left = `${toTimePercent(entry.heldMs)}%`;
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
        ` · ${entry.heldMs}/${entry.holdThreshold}ms` +
        ` · ${entry.pulled}px · ${entry.peakSpeed}px/ms` +
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
  clearMomentumLog();
}
