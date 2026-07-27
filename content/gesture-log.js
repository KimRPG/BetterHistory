(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  // 제스처 하나가 끝날 때마다 판정 근거를 남깁니다. 기준 거리를 손에 맞게
  // 맞추거나 "왜 이렇게 판정됐지"를 확인할 때 씁니다. 뒤로 가면 페이지 콘솔은
  // 지워지므로, 같은 기록을 서비스 워커로도 보내 보존합니다.
  const BADGE_STYLE =
    "background:#3355dd;color:#fff;padding:1px 6px;border-radius:3px;font-weight:600";
  const MAX_SAMPLES = 80;

  const ACTION_LABELS = {
    menu: "기록 메뉴 열기",
    navigate: "한 단계 이동"
  };
  const RELEASE_LABELS = {
    threshold: "기준 거리 도달 (당기는 중 바로)",
    hold: "기준 시간 도달 (당기는 중 바로)",
    momentum: "관성 시작 = 손 뗌",
    idle: "입력이 멈춤"
  };

  class GestureLog {
    constructor(onRecord) {
      this.enabled = false;
      this.onRecord = onRecord || (() => {});
      this.reset();
    }

    reset() {
      this.active = false;
      this.direction = null;
      this.threshold = 0;
      this.holdThreshold = 0;
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

    start({ direction, threshold, holdThreshold, at, nativeMomentum }) {
      if (!this.enabled || this.active) return;

      this.reset();
      this.active = true;
      this.direction = direction;
      this.threshold = threshold;
      this.holdThreshold = holdThreshold;
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

    finish({ action, release, pulled, heldMs, at }) {
      if (!this.active) return null;

      const decidedAt = at ?? this.lastAt;
      const entry = {
        action,
        release,
        direction: this.direction,
        pulled: Math.round(pulled),
        threshold: this.threshold,
        heldMs: Math.round(heldMs ?? 0),
        holdThreshold: this.holdThreshold,
        pullMs: Math.round(this.lastFingerAt - this.startedAt),
        fingerTravel: Math.round(this.fingerTravel),
        momentumTravel: Math.round(this.momentumTravel),
        peakSpeed: Number(this.peakSpeed.toFixed(2)),
        decisionLagMs: Math.round(decidedAt - this.lastFingerAt),
        counts: { ...this.counts },
        engine: this.engine,
        samples: this.samples
      };

      const summary = toSummary(entry);
      console.log(
        `%cGestureBackHistory%c ${summary.방향} · ${summary.동작} · ${summary.진행거리}`,
        BADGE_STYLE,
        "",
        summary
      );
      this.reset();
      this.onRecord(entry);
      return entry;
    }
  }

  function toSummary(entry) {
    const summary = {
      동작: ACTION_LABELS[entry.action] ?? entry.action,
      방향: entry.direction === "forward" ? "앞으로" : "뒤로",
      진행거리: `${entry.pulled}px / ${entry.threshold}px` +
        ` (${Math.round((entry.pulled / entry.threshold) * 100)}%)`,
      당긴시간: `${entry.heldMs}ms / ${entry.holdThreshold}ms` +
        ` (${Math.round((entry.heldMs / entry.holdThreshold) * 100)}%)`,
      손가락이동: `${entry.fingerTravel}px`,
      최고속도: `${entry.peakSpeed}px/ms`,
      손뗌판정: RELEASE_LABELS[entry.release] ?? entry.release,
      판정지연: `${entry.decisionLagMs}ms`,
      이벤트: `손가락 ${entry.counts.finger} · 보류 ${entry.counts.settling}` +
        ` · 관성 ${entry.counts.momentum}`,
      버려진관성: `${entry.momentumTravel}px`,
      관성판정: entry.engine,
      입력크기: entry.samples
    };

    // 속도 상한 때문에 실제 손가락 이동보다 적게 반영됐다면 짚어 줍니다.
    if (entry.fingerTravel - entry.pulled > 20) {
      summary.속도상한 =
        `실제 ${entry.fingerTravel}px 중 ${entry.pulled}px만 반영`;
    }
    return summary;
  }

  namespace.GestureLog = GestureLog;
  namespace.toGestureSummary = toSummary;
})();
