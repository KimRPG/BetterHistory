(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  namespace.historyClient = {
    async getEntries(direction) {
      const response = await chrome.runtime.sendMessage({
        type: "GET_TAB_HISTORY",
        direction
      });

      if (!response?.ok) {
        throw new Error(response?.error || "탭 히스토리를 불러오지 못했습니다.");
      }

      return response.entries || [];
    },

    async navigate(entryId, direction) {
      const response = await chrome.runtime.sendMessage({
        type: "NAVIGATE_HISTORY",
        entryId,
        direction
      });

      if (!response?.ok) {
        throw new Error(response?.error || "페이지로 이동하지 못했습니다.");
      }
    },

    async navigateOneStep(direction) {
      const response = await chrome.runtime.sendMessage({
        type: "NAVIGATE_ONE_STEP",
        direction
      });

      if (!response?.ok) {
        throw new Error(response?.error || "페이지로 이동하지 못했습니다.");
      }
    }
  };
})();
