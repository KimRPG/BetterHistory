(() => {
  "use strict";

  const namespace = globalThis.BetterGesture ??= {};
  const { t } = namespace;

  namespace.historyClient = {
    async getEntries(direction) {
      const response = await sendRuntimeMessage({
        type: "GET_TAB_HISTORY",
        direction
      });

      if (!response?.ok) {
        throw new Error(response?.error || t("errorHistoryLoad"));
      }

      return response.entries || [];
    },

    async navigate(entryId, direction) {
      const response = await sendRuntimeMessage({
        type: "NAVIGATE_HISTORY",
        entryId,
        direction
      });

      if (!response?.ok) {
        throw new Error(response?.error || t("errorNavigate"));
      }
    },

    async navigateOneStep(direction) {
      let response;

      try {
        response = await sendRuntimeMessage({
          type: "NAVIGATE_ONE_STEP",
          direction
        });
      } catch (error) {
        if (error instanceof ExtensionContextUnavailableError) return false;
        throw error;
      }

      if (!response?.ok) {
        throw new Error(response?.error || t("errorNavigate"));
      }

      return response.navigated !== false;
    },

    // 콘텐츠 스크립트는 _locales 파일을 직접 읽을 수 없어 서비스 워커에
    // 물어봅니다. 실패하면 Chrome UI 언어로 남습니다.
    async getMessages(language) {
      try {
        const response = await sendRuntimeMessage({
          type: "GET_MESSAGES",
          language
        });
        return response?.messages ?? null;
      } catch {
        return null;
      }
    }
  };

  class ExtensionContextUnavailableError extends Error {
    constructor() {
      super(t("errorContextInvalidated"));
      this.name = "ExtensionContextUnavailableError";
    }
  }

  async function sendRuntimeMessage(message) {
    const runtime = globalThis.chrome?.runtime;
    if (typeof runtime?.sendMessage !== "function") {
      throw new ExtensionContextUnavailableError();
    }

    try {
      return await runtime.sendMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /Extension context invalidated|Receiving end does not exist|message port closed/i
          .test(message)
      ) {
        throw new ExtensionContextUnavailableError();
      }
      throw error;
    }
  }
})();
