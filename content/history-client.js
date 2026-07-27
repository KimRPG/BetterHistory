(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};
  const CONTEXT_UNAVAILABLE_MESSAGE =
    "확장 프로그램이 업데이트되었습니다. 이 페이지를 새로고침해 주세요.";

  namespace.historyClient = {
    async getEntries(direction) {
      const response = await sendRuntimeMessage({
        type: "GET_TAB_HISTORY",
        direction
      });

      if (!response?.ok) {
        throw new Error(response?.error || "탭 히스토리를 불러오지 못했습니다.");
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
        throw new Error(response?.error || "페이지로 이동하지 못했습니다.");
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
        throw new Error(response?.error || "페이지로 이동하지 못했습니다.");
      }

      return response.navigated !== false;
    },

    async logGesture(entry) {
      try {
        await sendRuntimeMessage({ type: "LOG_GESTURE", entry });
      } catch {
        // 디버그 로그가 실패해도 제스처 동작에는 영향을 주지 않습니다.
      }
    }
  };

  class ExtensionContextUnavailableError extends Error {
    constructor() {
      super(CONTEXT_UNAVAILABLE_MESSAGE);
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
