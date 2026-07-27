(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gestureDirection: "right",
    pullDistancePx: 180,
    debugLogging: false
  });

  // 브라우저는 트랙패드에서 손가락을 뗀 순간을 알려 주지 않으므로, 시간 대신
  // 손가락이 실제로 움직인 거리로 두 동작을 구분합니다. 이 거리를 넘기면
  // 기록 메뉴가 열리고, 그 전에 놓으면 한 단계만 이동합니다.
  const PULL_DISTANCE_CHOICES = Object.freeze([
    Object.freeze({ value: 120, label: "짧게 · 살짝만 당겨도 열림" }),
    Object.freeze({ value: 180, label: "보통" }),
    Object.freeze({ value: 260, label: "길게 · 확실히 당겨야 열림" })
  ]);

  function findPullDistance(value) {
    const distance = Number(value);
    return PULL_DISTANCE_CHOICES.find((choice) => choice.value === distance);
  }

  function sanitizeSettings(candidate) {
    return {
      enabled: candidate?.enabled !== false,
      gestureDirection: candidate?.gestureDirection === "left" ? "left" : "right",
      pullDistancePx: findPullDistance(candidate?.pullDistancePx)?.value
        ?? DEFAULT_SETTINGS.pullDistancePx,
      debugLogging: candidate?.debugLogging === true
    };
  }

  Object.assign(namespace, {
    DEFAULT_SETTINGS,
    PULL_DISTANCE_CHOICES,
    sanitizeSettings
  });
})();
