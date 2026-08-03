(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gestureDirection: "right",
    pullDistancePx: 150,
    pullHoldMs: 180,
    language: "auto"
  });

  // 언어 이름은 번역하지 않습니다. 지금 읽을 수 없는 언어로 적혀 있으면
  // 자기 언어를 찾을 수 없기 때문입니다. "자동"만 현재 언어로 보여 줍니다.
  const LANGUAGE_CHOICES = Object.freeze([
    Object.freeze({ value: "auto", labelKey: "languageAuto" }),
    Object.freeze({ value: "en", label: "English" }),
    Object.freeze({ value: "ko", label: "한국어" }),
    Object.freeze({ value: "ja", label: "日本語" }),
    Object.freeze({ value: "zh_CN", label: "简体中文" })
  ]);

  // 기록 메뉴는 손가락을 대고 있는 시간(holdMs)으로만 열립니다. 당긴 거리는
  // 판정에 쓰지 않고 인디케이터와 디버그 기록에만 씁니다. 거리를 함께 보면 크게
  // 당겼다 놓는 동작이 손 뗌과 무관한 두 번째 기준으로 갈리기 때문입니다.
  // value는 저장된 설정 키(pullDistancePx)와 인디케이터 눈금으로 남습니다.
  // 화면에 보일 이름은 labelKey로만 두고 _locales에서 꺼냅니다.
  // 250/350/500ms는 거리 기준을 보조하는 backstop이었습니다. 느리게 당기는
  // 사람만 구제하면 됐으니 길어도 괜찮았습니다. 단독 기준이 되면 실제 당김
  // 시간(대략 100~250ms)에 맞춰야 하므로 훨씬 짧아집니다.
  const PULL_DISTANCE_CHOICES = Object.freeze([
    Object.freeze({ value: 100, holdMs: 120, labelKey: "thresholdShort" }),
    Object.freeze({ value: 150, holdMs: 180, labelKey: "thresholdNormal" }),
    Object.freeze({ value: 220, holdMs: 280, labelKey: "thresholdLong" })
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
      language: LANGUAGE_CHOICES
        .some((option) => option.value === candidate?.language)
        ? candidate.language
        : "auto"
    };
  }

  Object.assign(namespace, {
    DEFAULT_SETTINGS,
    LANGUAGE_CHOICES,
    PULL_DISTANCE_CHOICES,
    sanitizeSettings
  });
})();
