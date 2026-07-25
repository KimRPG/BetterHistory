(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};
  const DEFAULT_GESTURE_HELP = "당긴 채 위·아래로 선택하고 손을 떼면 이동";
  const ERROR_AUTO_DISMISS_MS = 3600;
  const TOAST_DURATION_MS = 2600;

  class HistoryMenu {
    constructor(client, handlers = {}) {
      this.client = client;
      this.onCloseRequest = handlers.onCloseRequest || (() => {});
      this.onSelect = handlers.onSelect || (() => {});

      this.host = null;
      this.shadow = null;
      this.indicator = null;
      this.panel = null;
      this.list = null;
      this.heading = null;
      this.eyebrow = null;
      this.gestureHelp = null;
      this.toast = null;

      this.busy = false;
      this.direction = null;
      this.entries = [];
      this.selectedIndex = -1;
      this.selectionOffset = 0;
      this.dismissTimer = null;
      this.toastTimer = null;
    }

    ensure() {
      if (this.host?.isConnected) return true;
      if (!document.documentElement) return false;

      this.host = document.createElement("div");
      this.host.setAttribute("data-gesture-back-history", "");
      this.host.style.setProperty("all", "initial", "important");
      this.host.style.setProperty("position", "fixed", "important");
      this.host.style.setProperty("z-index", "2147483647", "important");
      this.host.style.setProperty("pointer-events", "none", "important");
      document.documentElement.append(this.host);

      this.shadow = this.host.attachShadow({ mode: "closed" });
      this.shadow.innerHTML = `
        <style>${namespace.MENU_STYLES}</style>
        <div class="indicator" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m10 7-5 5 5 5"/><path d="M5 12h9a5 5 0 0 1 5 5"/>
          </svg>
        </div>
        <section class="panel" role="dialog" aria-modal="false" aria-labelledby="gbh-title">
          <header class="header">
            <div class="heading">
              <div class="eyebrow">Tab history</div>
              <h2 id="gbh-title">뒤로 갈 페이지</h2>
            </div>
            <button class="close" type="button" aria-label="닫기">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
            </button>
          </header>
          <div class="list"></div>
          <div class="gesture-help"><b aria-hidden="true">↕</b><span>${DEFAULT_GESTURE_HELP}</span></div>
        </section>
        <div class="toast" role="status" aria-live="polite"></div>
      `;

      this.indicator = this.shadow.querySelector(".indicator");
      this.panel = this.shadow.querySelector(".panel");
      this.list = this.shadow.querySelector(".list");
      this.heading = this.shadow.querySelector("h2");
      this.eyebrow = this.shadow.querySelector(".eyebrow");
      this.gestureHelp = this.shadow.querySelector(".gesture-help span");
      this.toast = this.shadow.querySelector(".toast");
      this.shadow
        .querySelector(".close")
        .addEventListener("click", () => this.onCloseRequest());
      return true;
    }

    isOpen() {
      return Boolean(this.panel?.classList.contains("open"));
    }

    isBusy() {
      return this.busy;
    }

    isEventFromUi(event) {
      return Boolean(this.host && event.target === this.host);
    }

    showGestureIndicator({ clientY, progress, direction, shift = 0 }) {
      if (!this.ensure()) return;

      const clampedProgress = Math.min(1, Math.max(0.08, progress));
      const y = Number.isFinite(clientY) && clientY > 0
        ? Math.min(window.innerHeight - 48, Math.max(48, clientY))
        : window.innerHeight / 2;
      this.indicator.style.setProperty("--progress", String(clampedProgress));
      this.indicator.style.setProperty("--shift", `${shift.toFixed(2)}px`);
      this.indicator.style.top = `${y}px`;
      this.indicator.classList.toggle("forward", direction === "forward");
      this.indicator.classList.add("visible");
    }

    hideGestureIndicator() {
      this.indicator?.classList.remove("visible");
      this.indicator?.style.setProperty("--shift", "0px");
    }

    showToast(message) {
      if (!message || !this.ensure()) return;

      clearTimeout(this.toastTimer);
      this.toast.textContent = message;
      this.toast.classList.add("visible");
      this.toastTimer = setTimeout(() => {
        this.toastTimer = null;
        this.toast.classList.remove("visible");
        this.toast.textContent = "";
      }, TOAST_DURATION_MS);
    }

    async open(direction) {
      if (!this.ensure() || this.busy) return false;

      this.clearDismissTimer();
      this.direction = direction;
      this.entries = [];
      this.selectedIndex = -1;
      this.selectionOffset = 0;
      this.busy = true;
      this.panel.classList.toggle("forward", direction === "forward");
      this.panel.classList.add("open");
      this.eyebrow.textContent = direction === "forward"
        ? "Forward history"
        : "Back history";
      this.heading.textContent = direction === "forward"
        ? "앞으로 갈 페이지"
        : "뒤로 갈 페이지";
      this.gestureHelp.textContent = DEFAULT_GESTURE_HELP;
      this.list.innerHTML = `<div class="state"><div class="spinner"></div>이 탭의 기록을 불러오는 중…</div>`;

      try {
        const entries = await this.client.getEntries(direction);
        if (!this.isOpen() || this.direction !== direction) return false;
        this.renderEntries(entries);
        return true;
      } catch (error) {
        if (this.isOpen() && this.direction === direction) {
          this.renderState(toMessage(error), true);
        }
        return false;
      } finally {
        this.busy = false;
      }
    }

    close() {
      this.clearDismissTimer();
      this.panel?.classList.remove("open", "forward");
      this.entries = [];
      this.selectedIndex = -1;
      this.selectionOffset = 0;
      this.direction = null;
    }

    clearDismissTimer() {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }

    moveSelection(step, focusEntry = false) {
      if (!this.entries.length) {
        this.selectionOffset = Math.max(0, this.selectionOffset + step);
        return;
      }

      const startIndex = this.selectedIndex < 0 ? 0 : this.selectedIndex;
      this.selectedIndex = Math.min(
        this.entries.length - 1,
        Math.max(0, startIndex + step)
      );
      this.selectionOffset = this.selectedIndex;
      this.updateSelectedEntry(focusEntry);
    }

    getSelected() {
      const entry = this.entries[this.selectedIndex];
      const button = this.shadow?.querySelectorAll(".entry")?.[this.selectedIndex];
      return entry && button ? { entry, button } : null;
    }

    async navigate(entry, button) {
      if (this.busy) return false;

      this.busy = true;
      button.classList.add("pending");
      button.setAttribute("aria-busy", "true");

      try {
        await this.client.navigate(entry.id, this.direction);
        return true;
      } catch (error) {
        button.classList.remove("pending");
        button.removeAttribute("aria-busy");
        this.renderState(toMessage(error), true);
        return false;
      } finally {
        this.busy = false;
      }
    }

    handleKeydown(event) {
      if (!this.isOpen()) return false;

      if (event.key === "Escape") {
        event.preventDefault();
        this.onCloseRequest();
        return true;
      }

      if (event.key === "Enter" && this.selectedIndex >= 0) {
        event.preventDefault();
        const selected = this.getSelected();
        if (selected) this.onSelect(selected.entry, selected.button);
        return true;
      }

      if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !this.entries.length) {
        return false;
      }

      event.preventDefault();
      this.moveSelection(event.key === "ArrowDown" ? 1 : -1, true);
      return true;
    }

    renderEntries(entries) {
      this.clearDismissTimer();
      this.entries = entries;

      if (!entries.length) {
        const message = this.direction === "forward"
          ? "이 탭에는 앞으로 갈 페이지가 없습니다."
          : "이 탭에는 돌아갈 이전 페이지가 없습니다.";
        this.renderState(message);
        return;
      }

      const rows = document.createElement("div");
      rows.className = "rows";
      rows.setAttribute("role", "list");

      for (const entry of entries) {
        const button = this.createEntryButton(entry);
        button.addEventListener(
          "click",
          () => this.onSelect(entry, button)
        );

        const row = document.createElement("div");
        row.setAttribute("role", "listitem");
        row.append(button);
        rows.append(row);
      }

      this.list.replaceChildren(rows);
      this.selectedIndex = Math.min(
        entries.length - 1,
        Math.max(0, this.selectionOffset)
      );
      this.updateSelectedEntry();
    }

    createEntryButton(entry) {
      const button = document.createElement("button");
      button.className = "entry";
      button.type = "button";

      const mark = document.createElement("span");
      mark.className = "site-mark";

      const favicon = document.createElement("img");
      favicon.className = "favicon";
      favicon.alt = "";
      favicon.decoding = "async";
      favicon.draggable = false;
      favicon.src = faviconUrl(entry.url);
      favicon.addEventListener(
        "load",
        () => mark.classList.add("has-favicon"),
        { once: true }
      );
      favicon.addEventListener("error", () => favicon.remove(), { once: true });

      const fallback = document.createElement("span");
      fallback.className = "site-initial";
      fallback.setAttribute("aria-hidden", "true");
      fallback.textContent = siteInitial(entry.url);
      mark.append(favicon, fallback);

      const copy = document.createElement("span");
      copy.className = "entry-copy";

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = entry.title || entry.url;

      const url = document.createElement("span");
      url.className = "url";
      url.textContent = displayUrl(entry.url);

      const distance = document.createElement("span");
      distance.className = "distance";
      distance.textContent = this.direction === "forward"
        ? (entry.distance === 1 ? "바로 다음" : `${entry.distance}단계 후`)
        : (entry.distance === 1 ? "직전" : `${entry.distance}단계 전`);

      copy.append(title, url);
      button.append(mark, copy, distance);
      return button;
    }

    updateSelectedEntry(focusEntry = false) {
      const buttons = [...this.shadow.querySelectorAll(".entry")];
      buttons.forEach((button, index) => {
        const selected = index === this.selectedIndex;
        button.classList.toggle("selected", selected);
        if (selected) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      });

      const selectedButton = buttons[this.selectedIndex];
      if (!selectedButton) return;
      selectedButton.scrollIntoView({ block: "nearest" });
      if (focusEntry) selectedButton.focus({ preventScroll: true });
    }

    // 오류 패널을 그대로 두면 메뉴가 열린 상태로 남아 가로 제스처를 계속
    // 삼키므로, 사용자가 닫지 않아도 잠시 뒤 스스로 물러나게 합니다.
    renderState(message, isError = false) {
      this.entries = [];
      this.selectedIndex = -1;
      const state = document.createElement("div");
      state.className = `state${isError ? " error" : ""}`;
      state.textContent = message;
      this.list.replaceChildren(state);

      this.clearDismissTimer();
      if (!isError) return;
      this.dismissTimer = setTimeout(() => {
        this.dismissTimer = null;
        if (this.isOpen()) this.onCloseRequest();
      }, ERROR_AUTO_DISMISS_MS);
    }
  }

  function displayUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const path = parsed.pathname === "/" ? "" : parsed.pathname;
      return `${parsed.hostname || parsed.protocol}${path}${parsed.search}`;
    } catch {
      return rawUrl;
    }
  }

  function siteInitial(rawUrl) {
    try {
      const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
      return (hostname[0] || "↩").toLocaleUpperCase();
    } catch {
      return "↩";
    }
  }

  function faviconUrl(pageUrl) {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", "32");
    return url.toString();
  }

  function toMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  namespace.HistoryMenu = HistoryMenu;
  namespace.faviconUrl = faviconUrl;
})();
