(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  // 제스처 하나가 끝날 때마다 판정 근거를 페이지 콘솔에 남깁니다. 기준 거리를
  // 손에 맞게 맞추거나 "왜 이렇게 판정됐지"를 확인할 때 씁니다.
  const BADGE_STYLE =
    "background:#3355dd;color:#fff;padding:1px 6px;border-radius:3px;font-weight:600";
  const MAX_SAMPLES = 80;

  const ACTION_LABELS = {
    menu: "기록 메뉴 열기",
    navigate: "한 단계 이동",
    ignored: "무시 (기준 미달)"
  };
  const RELEASE_LABELS = {
    threshold: "기준 거리 도달 (당기는 중 바로)",
    momentum: "관성 시작 = 손 뗌",
    idle: "입력이 멈춤"
  };

  class GestureLog {
    constructor() {
      this.enabled = false;
      this.reset();
    }

    reset() {
      this.active = false;
      this.direction = null;
      this.threshold = 0;
      this.engine = "";
      this.startedAt = 0;
      this.lastFingerAt = 0;
      this.lastAt = 0;
      this.fingerTravel = 0;
      this.momentumTravel = 0;
      this.peakSpeed = 0;
      this.counts = { finger: 0, settling: 0, momentum: 0 };
      this.samples = [];
    }

    start({ direction, threshold, at, nativeMomentum }) {
      if (!this.enabled || this.active) return;

      this.reset();
      this.active = true;
      this.direction = direction;
      this.threshold = threshold;
      this.engine = nativeMomentum ? "WheelEvent.momentum" : "감쇠 추정";
      this.startedAt = at;
      this.lastFingerAt = at;
      this.lastAt = at;
    }

    record({ phase, magnitude, at }) {
      if (!this.active) return;

      // 첫 이벤트는 경과 시간을 알 수 없어 속도를 계산하지 않습니다.
      const elapsed = at - this.lastAt;
      if (elapsed > 0) {
        this.peakSpeed = Math.max(this.peakSpeed, magnitude / elapsed);
      }
      this.counts[phase] += 1;
      this.lastAt = at;

      if (phase === "momentum") {
        this.momentumTravel += magnitude;
      } else {
        this.fingerTravel += magnitude;
        this.lastFingerAt = at;
      }

      if (this.samples.length < MAX_SAMPLES) {
        this.samples.push(Number(magnitude.toFixed(1)));
      }
    }

    finish({ action, release, pulled, at }) {
      if (!this.active) return;

      const decidedAt = at ?? this.lastAt;
      const pulledDistance = Math.round(pulled);
      const summary = {
        동작: ACTION_LABELS[action] ?? action,
        방향: this.direction === "forward" ? "앞으로" : "뒤로",
        진행거리: `${pulledDistance}px / ${this.threshold}px` +
          ` (${Math.round((pulledDistance / this.threshold) * 100)}%)`,
        당긴시간: `${Math.round(this.lastFingerAt - this.startedAt)}ms`,
        손가락이동: `${Math.round(this.fingerTravel)}px`,
        최고속도: `${this.peakSpeed.toFixed(2)}px/ms`,
        손뗌판정: RELEASE_LABELS[release] ?? release,
        판정지연: `${Math.round(decidedAt - this.lastFingerAt)}ms`,
        이벤트: `손가락 ${this.counts.finger} · 보류 ${this.counts.settling}` +
          ` · 관성 ${this.counts.momentum}`,
        버려진관성: `${Math.round(this.momentumTravel)}px`,
        관성판정: this.engine,
        입력크기: this.samples
      };

      // 속도 상한 때문에 실제 손가락 이동보다 적게 반영됐다면 짚어 줍니다.
      if (this.fingerTravel - pulledDistance > 20) {
        summary.속도상한 =
          `실제 ${Math.round(this.fingerTravel)}px 중 ${pulledDistance}px만 반영`;
      }

      console.log(
        `%cGestureBackHistory%c ${summary.방향} · ${summary.동작} · ${summary.진행거리}`,
        BADGE_STYLE,
        "",
        summary
      );
      this.reset();
      return summary;
    }
  }

  namespace.GestureLog = GestureLog;
})();
