(() => {
  "use strict";

  const namespace = globalThis.BetterGesture;
  const controller = new namespace.GestureController();
  controller.start();
})();
