(() => {
  "use strict";

  const namespace = globalThis.BetterGesture ??= {};

  const DEFAULT_SETTINGS = Object.freeze({
    gestureDirection: "right",
    holdStillMs: 450,
    language: "auto",
    disabledSites: Object.freeze([])
  });

  // sync 저장소는 항목 하나가 8KB를 넘으면 통째로 거부합니다. 호스트명 하나가
  // 넉넉잡아 30바이트라 300개면 여유가 있고, 그보다 많이 끄는 사람은 확장을
  // 통째로 끄는 편이 낫습니다.
  const MAX_DISABLED_SITES = 300;

  // 언어 이름은 번역하지 않습니다. 지금 읽을 수 없는 언어로 적혀 있으면
  // 자기 언어를 찾을 수 없기 때문입니다. "자동"만 현재 언어로 보여 줍니다.
  const LANGUAGE_CHOICES = Object.freeze([
    Object.freeze({ value: "auto", labelKey: "languageAuto" }),
    Object.freeze({ value: "en", label: "English" }),
    Object.freeze({ value: "ko", label: "한국어" }),
    Object.freeze({ value: "ja", label: "日本語" }),
    Object.freeze({ value: "zh_CN", label: "简体中文" })
  ]);

  // 당긴 채 멈췄을 때 메뉴가 열리기까지 기다리는 시간입니다. 손가락을 대고
  // 가만히 있으면 wheel 이벤트가 오지 않아 "쉬는 중"과 "손을 뗀 뒤"가 똑같아
  // 보이므로, 얼마나 기다렸다 멈춤으로 볼지는 손버릇에 따라 다릅니다.
  // 짧게 잡으면 당기다 잠깐 멈칫한 것도 메뉴가 되고, 길게 잡으면 멈춘 뒤
  // 기다려야 합니다. 값 자체가 설정에 저장되고, 화면에 붙는 이름만 labelKey로
  // _locales에서 꺼냅니다.
  //
  // 당김 판정 시간(0.18초)은 실제 당김 폭에 맞춘 값이라 손버릇으로 갈리지
  // 않으므로 설정에 두지 않고 gesture-controller.js의 상수로 고정했습니다.
  const HOLD_STILL_CHOICES = Object.freeze([
    Object.freeze({ value: 300, labelKey: "thresholdShort" }),
    Object.freeze({ value: 450, labelKey: "thresholdNormal" }),
    Object.freeze({ value: 700, labelKey: "thresholdLong" })
  ]);

  // 0.12초처럼 사람이 읽는 초 단위로 보여 줍니다. 단위 문구는 언어마다
  // 달라지므로 여기서는 숫자만 만듭니다.
  function toSeconds(holdMs) {
    return (holdMs / 1000).toFixed(2);
  }

  // 제외 여부는 호스트명만 봅니다. 스킴이나 경로까지 따지면 같은 사이트가
  // http와 https로, /a와 /b로 갈라져 사용자가 끈 것과 실제로 꺼지는 곳이
  // 어긋납니다. chrome://이나 새 탭은 hostname이 그럴듯하게 나오지만
  // (chrome://extensions → "extensions") 콘텐츠 스크립트가 아예 돌지 않는
  // 곳이므로 스킴에서 걸러 빈 문자열로 돌려보냅니다.
  function toSiteKey(rawUrl) {
    try {
      const { protocol, hostname } = new URL(rawUrl);
      if (protocol !== "http:" && protocol !== "https:") return "";
      return hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function isSiteDisabled(settings, hostname) {
    const site = typeof hostname === "string"
      ? hostname.trim().toLowerCase()
      : "";
    return site !== "" && settings.disabledSites.includes(site);
  }

  function sanitizeSites(candidate) {
    if (!Array.isArray(candidate)) return [];

    const sites = new Set();
    for (const value of candidate) {
      const site = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (site) sites.add(site);
    }
    // 상한을 넘으면 오래 전에 끈 것부터 밀어냅니다. 최근에 끈 사이트가
    // 사용자가 기억하는 것입니다.
    return [...sites].slice(-MAX_DISABLED_SITES);
  }

  function sanitizeSettings(candidate) {
    const holdMs = Number(candidate?.holdStillMs);
    const choice = HOLD_STILL_CHOICES.some((option) => option.value === holdMs)
      ? holdMs
      : DEFAULT_SETTINGS.holdStillMs;

    return {
      gestureDirection: candidate?.gestureDirection === "left" ? "left" : "right",
      holdStillMs: choice,
      language: LANGUAGE_CHOICES
        .some((option) => option.value === candidate?.language)
        ? candidate.language
        : "auto",
      disabledSites: sanitizeSites(candidate?.disabledSites)
    };
  }

  Object.assign(namespace, {
    DEFAULT_SETTINGS,
    HOLD_STILL_CHOICES,
    LANGUAGE_CHOICES,
    isSiteDisabled,
    sanitizeSettings,
    toSeconds,
    toSiteKey
  });
})();
