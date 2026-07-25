(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  namespace.MENU_STYLES = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    .indicator {
      --progress: 0;
      align-items: center;
      background: rgba(31, 35, 41, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
      color: white;
      display: none;
      height: 46px;
      justify-content: center;
      left: 14px;
      opacity: calc(0.42 + var(--progress) * 0.58);
      pointer-events: none;
      position: fixed;
      top: 50%;
      transform: translateY(-50%) scale(calc(0.82 + var(--progress) * 0.18));
      width: 46px;
    }
    .indicator.visible { display: flex; }
    .indicator svg { height: 22px; width: 22px; }
    .indicator.forward { left: auto; right: 14px; }
    .indicator.forward svg { transform: rotate(180deg); }
    .panel {
      animation: enter 150ms cubic-bezier(.2, .8, .2, 1);
      background: rgba(250, 250, 252, 0.96);
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 16px;
      box-shadow: 0 22px 70px rgba(15, 23, 42, 0.28), 0 3px 12px rgba(15, 23, 42, 0.12);
      color: #15171a;
      display: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      left: 18px;
      max-height: min(620px, calc(100vh - 36px));
      overflow: hidden;
      pointer-events: auto;
      position: fixed;
      top: 50%;
      transform: translateY(-50%);
      width: min(390px, calc(100vw - 36px));
    }
    .panel.open { display: block; }
    .panel.dismissing {
      transform: translate(var(--dismiss-x, 0), -50%);
      transition: transform 70ms linear, opacity 70ms linear;
    }
    .panel.forward {
      animation-name: enter-forward;
      left: auto;
      right: 18px;
    }
    @keyframes enter {
      from { opacity: 0; transform: translate(-10px, -50%) scale(.98); }
      to { opacity: 1; transform: translate(0, -50%) scale(1); }
    }
    @keyframes enter-forward {
      from { opacity: 0; transform: translate(10px, -50%) scale(.98); }
      to { opacity: 1; transform: translate(0, -50%) scale(1); }
    }
    .header {
      align-items: center;
      border-bottom: 1px solid rgba(15, 23, 42, 0.08);
      display: flex;
      gap: 12px;
      padding: 15px 14px 13px 18px;
    }
    .heading { flex: 1; min-width: 0; }
    .eyebrow {
      color: #737982;
      font-size: 11px;
      font-weight: 650;
      letter-spacing: .08em;
      line-height: 1.2;
      margin-bottom: 3px;
      text-transform: uppercase;
    }
    h2 {
      font-size: 15px;
      font-weight: 680;
      line-height: 1.35;
      margin: 0;
    }
    .close {
      align-items: center;
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 8px;
      color: #626872;
      cursor: pointer;
      display: flex;
      font: inherit;
      height: 30px;
      justify-content: center;
      padding: 0;
      width: 30px;
    }
    .close:hover, .close:focus-visible { background: rgba(15, 23, 42, .07); outline: none; }
    .list {
      max-height: min(530px, calc(100vh - 128px));
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 7px;
    }
    .entry {
      align-items: center;
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 10px;
      color: inherit;
      cursor: pointer;
      display: flex;
      font: inherit;
      gap: 11px;
      min-height: 58px;
      padding: 8px 10px;
      text-align: left;
      width: 100%;
    }
    .entry:hover, .entry:focus-visible { background: rgba(37, 99, 235, .09); outline: none; }
    .entry.selected {
      background: rgba(37, 99, 235, .13);
      box-shadow: inset 3px 0 #2563eb;
      outline: none;
    }
    .panel.forward .entry.selected { box-shadow: inset -3px 0 #2563eb; }
    .entry.pending { opacity: .55; pointer-events: none; }
    .site-mark {
      align-items: center;
      background: #e6eaf0;
      border: 1px solid rgba(15, 23, 42, .06);
      border-radius: 10px;
      color: #4d5662;
      display: flex;
      flex: 0 0 auto;
      font-size: 14px;
      font-weight: 750;
      height: 36px;
      justify-content: center;
      text-transform: uppercase;
      width: 36px;
    }
    .entry-copy { flex: 1; min-width: 0; }
    .title {
      display: block;
      font-size: 13px;
      font-weight: 620;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .url {
      color: #747b85;
      display: block;
      font-size: 11px;
      line-height: 1.35;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .distance {
      color: #8a9099;
      flex: 0 0 auto;
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .state {
      color: #6d737c;
      font-size: 13px;
      line-height: 1.55;
      padding: 34px 24px 38px;
      text-align: center;
    }
    .spinner {
      animation: spin .8s linear infinite;
      border: 2px solid rgba(37, 99, 235, .18);
      border-radius: 50%;
      border-top-color: #2563eb;
      height: 24px;
      margin: 0 auto 12px;
      width: 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { color: #b42318; }
    .gesture-help {
      align-items: center;
      background: rgba(37, 99, 235, .055);
      border-top: 1px solid rgba(15, 23, 42, .08);
      color: #66707d;
      display: flex;
      font-size: 10px;
      gap: 7px;
      justify-content: center;
      line-height: 1.4;
      min-height: 34px;
      padding: 7px 12px;
      text-align: center;
    }
    .gesture-help b { color: #2563eb; font-size: 14px; line-height: 1; }
    @media (prefers-color-scheme: dark) {
      .panel { background: rgba(34, 36, 40, .97); border-color: rgba(255,255,255,.12); color: #f5f6f7; }
      .header { border-bottom-color: rgba(255,255,255,.09); }
      .eyebrow, .url, .state, .distance { color: #aeb4bd; }
      .close { color: #b7bdc6; }
      .close:hover, .close:focus-visible { background: rgba(255,255,255,.08); }
      .entry:hover, .entry:focus-visible { background: rgba(96,165,250,.14); }
      .entry.selected { background: rgba(96,165,250,.2); box-shadow: inset 3px 0 #60a5fa; }
      .panel.forward .entry.selected { box-shadow: inset -3px 0 #60a5fa; }
      .site-mark { background: #454a52; border-color: rgba(255,255,255,.06); color: #e2e6eb; }
      .gesture-help { background: rgba(96,165,250,.07); border-top-color: rgba(255,255,255,.09); color: #aeb4bd; }
      .gesture-help b { color: #60a5fa; }
    }
    @media (prefers-reduced-motion: reduce) {
      .panel { animation: none; }
      .spinner { animation-duration: 1.6s; }
    }
  `;
})();
