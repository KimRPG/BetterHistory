(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gestureDirection: "right",
    pullDistancePx: 150,
    pullHoldMs: 350,
    debugLogging: false
  });

  // 거리와 시간 중 하나만 넘으면 기록 메뉴가 열립니다. 빠르게 멀리 당기는
  // 사람과 천천히 오래 당기는 사람이 둘 다 있어서, 거리 하나로는 후자가
  // 1초 넘게 당겨야 열리는 문제가 생깁니다. 손가락이 실제로 움직인 구간만
  // 재므로 관성 꼬리는 어느 쪽에도 섞이지 않습니다.
  const PULL_DISTANCE_CHOICES = Object.freeze([
    Object.freeze({ value: 100, holdMs: 250, label: "짧게 · 살짝만 당겨도 열림" }),
    Object.freeze({ value: 150, holdMs: 350, label: "보통" }),
    Object.freeze({ value: 220, holdMs: 500, label: "길게 · 확실히 당겨야 열림" })
  ]);

  function findPullDistance(value) {
    const distance = Number(value);
    return PULL_DISTANCE_CHOICES.find((choice) => choice.value === distance);
  }

  function sanitizeSettings(candidate) {
    const choice = findPullDistance(candidate?.pullDistancePx)
      ?? findPullDistance(DEFAULT_SETTINGS.pullDistancePx);

    return {
      enabled: candidate?.enabled !== false,
      gestureDirection: candidate?.gestureDirection === "left" ? "left" : "right",
      pullDistancePx: choice.value,
      // 저장하지 않고 선택한 기준에서 함께 끌어옵니다.
      pullHoldMs: choice.holdMs,
      debugLogging: candidate?.debugLogging === true
    };
  }

  Object.assign(namespace, {
    DEFAULT_SETTINGS,
    PULL_DISTANCE_CHOICES,
    sanitizeSettings
  });
})();
