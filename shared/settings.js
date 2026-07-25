(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gestureDirection: "right",
    holdDurationMs: 500
  });

  // 0.1·0.2초는 짧게 당기면 한 단계 이동, 길게 당기면 메뉴가 열리는 반대 순서입니다.
  const HOLD_DURATION_CHOICES = Object.freeze([
    Object.freeze({ value: 100, label: "0.1초 · 반대 동작 테스트", reversed: true }),
    Object.freeze({ value: 200, label: "0.2초 · 반대 동작 테스트", reversed: true }),
    Object.freeze({ value: 300, label: "0.3초", reversed: false }),
    Object.freeze({ value: 500, label: "0.5초", reversed: false })
  ]);

  function findHoldDuration(value) {
    const duration = Number(value);
    return HOLD_DURATION_CHOICES.find((choice) => choice.value === duration);
  }

  function sanitizeSettings(candidate) {
    return {
      enabled: candidate?.enabled !== false,
      gestureDirection: candidate?.gestureDirection === "left" ? "left" : "right",
      holdDurationMs: findHoldDuration(candidate?.holdDurationMs)?.value
        ?? DEFAULT_SETTINGS.holdDurationMs
    };
  }

  function usesReversedGestureOrder(holdDurationMs) {
    return findHoldDuration(holdDurationMs)?.reversed === true;
  }

  Object.assign(namespace, {
    DEFAULT_SETTINGS,
    HOLD_DURATION_CHOICES,
    sanitizeSettings,
    usesReversedGestureOrder
  });
})();
