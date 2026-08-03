(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  // 문구는 _locales/<언어>/messages.json에만 두고 여기로만 꺼냅니다.
  //
  // 기본값은 chrome.i18n이고, 이 함수는 동기라 기다릴 필요가 없습니다. 다만
  // chrome.i18n은 Chrome UI 언어로 고정이라 덮어쓸 수 없어서, 사용자가 언어를
  // 직접 고르면 같은 파일을 읽어 조회표로 씁니다. 표가 없으면 자동으로
  // 돌아가므로, 표를 불러오는 중에 부른 문구도 빈칸이 되지 않습니다.
  let overrides = null;

  // 없는 키는 빈 문자열이 아니라 키 이름을 그대로 돌려줍니다. 빈 문자열은
  // 화면에서 조용히 사라져 번역 누락을 못 알아채기 때문입니다.
  namespace.t = (key, substitutions) => {
    const message = overrides
      ? fromTable(overrides[key], substitutions)
      : fromChrome(key, substitutions);
    return message || key;
  };

  // 확장을 새로고침하면 이미 열려 있던 페이지의 옛 콘텐츠 스크립트에서는
  // chrome API가 전부 "Extension context invalidated"를 던집니다. 문구를
  // 꺼내다 실패한 것이 원래 알리려던 오류를 덮어써서는 안 됩니다 —
  // 컨텍스트가 끊겼다는 오류를 만들다가 다시 같은 오류가 나면, 조용히
  // 넘어가야 할 자리에서 처리되지 않은 예외가 됩니다.
  function fromChrome(key, substitutions) {
    try {
      return chrome.i18n.getMessage(key, substitutions);
    } catch {
      return "";
    }
  }

  namespace.useMessages = (table) => {
    overrides = table ?? null;
  };

  // 확장 페이지(팝업·연습)와 서비스 워커는 자기 리소스를 직접 읽을 수 있습니다.
  // 콘텐츠 스크립트는 읽을 수 없어 서비스 워커에 물어봅니다.
  namespace.readMessages = async (language) => {
    if (!language || language === "auto") return null;

    try {
      const response = await fetch(
        chrome.runtime.getURL(`_locales/${language}/messages.json`)
      );
      return response.ok ? await response.json() : null;
    } catch {
      // 없는 언어이거나 읽지 못했습니다. Chrome UI 언어로 둡니다.
      return null;
    }
  };

  // chrome.i18n이 하는 $이름$ 치환을 조회표에도 똑같이 적용합니다.
  function fromTable(entry, substitutions) {
    if (!entry?.message) return "";

    const values = Array.isArray(substitutions)
      ? substitutions
      : [substitutions];
    return Object.entries(entry.placeholders ?? {}).reduce(
      (text, [name, { content }]) => text.replaceAll(
        new RegExp(`\\$${name}\\$`, "gi"),
        values[Number(content.slice(1)) - 1] ?? ""
      ),
      entry.message
    );
  }

  // 마크업에는 문구를 넣지 않고 data-i18n으로 키만 적어 둡니다. HTML은
  // manifest처럼 __MSG_키__ 치환을 해 주지 않으므로 직접 채워야 합니다.
  namespace.localizeDocument = (root = document) => {
    // 마크업의 lang은 언어가 바뀌면 거짓말이 됩니다. 실제 UI 언어로 맞춥니다.
    if (root === document) {
      document.documentElement.lang = namespace.t("languageTag");
    }
    for (const element of root.querySelectorAll("[data-i18n]")) {
      element.textContent = namespace.t(element.dataset.i18n);
    }
    for (const element of root.querySelectorAll("[data-i18n-title]")) {
      element.title = namespace.t(element.dataset.i18nTitle);
    }
  };
})();
