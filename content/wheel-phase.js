(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};

  // 트랙패드에서 손가락을 떼도 macOS는 관성(momentum) wheel 이벤트를 1초 넘게
  // 계속 보냅니다. 이걸 걸러내지 않으면 짧게 튕긴 제스처가 길게 당긴 것과
  // 구분되지 않습니다.
  //
  // Chrome 151부터는 표준 WheelEvent.momentum이 관성 여부를 정확히 알려 주므로
  // 그대로 씁니다. 그 이전 버전에서는 감쇠 패턴으로 추정합니다. OS 관성은 표본마다
  // 거의 일정한 비율로 속도가 줄지만 사람 손가락은 그렇게 규칙적이지 않다는 점을
  // 이용합니다. (embla-carousel이 쓰는 wheel-gestures와 같은 방식)
  const EVENTS_PER_SAMPLE = 2;
  const SAMPLES_TO_CONFIRM = 3;
  const DECAY_MIN = 0.6;
  const DECAY_MAX = 0.96;
  // 조금이라도 느려지기 시작하면 곧바로 "잦아드는 중"으로 보고, 확정될 때까지
  // 이동 거리를 보류시킵니다. 확정을 기다리는 사이에 관성이 거리에 섞이면
  // 짧게 튕긴 제스처가 기준을 넘어 버립니다.
  const SETTLING_MAX = 0.99;
  // 표본 두 개를 모으기 전에도 값이 줄기 시작하면 곧바로 보류에 들어갑니다.
  // 보류는 거리를 버리는 게 아니라 붙잡아 두는 것뿐이라, 일찍 잡아도 손해가 없습니다.
  const SETTLING_HINT_EVENTS = 1;
  const RESUME_DELTA_RATIO = 2;
  const RESUME_DELTA_MIN = 2;

  const FINGER = "finger";
  const SETTLING = "settling";
  const MOMENTUM = "momentum";

  class WheelPhaseTracker {
    constructor() {
      this.reset();
    }

    reset() {
      this.momentum = false;
      this.settling = false;
      this.decayRun = 0;
      this.fallingRun = 0;
      this.lastMagnitude = 0;
      this.pendingDelta = 0;
      this.pendingTime = 0;
      this.pendingCount = 0;
      this.previousSample = null;
      this.previousVelocity = null;
    }

    // "finger"(손가락이 움직이는 중) / "settling"(느려지는 중, 판단 보류) /
    // "momentum"(손을 뗀 뒤의 관성) 중 하나를 돌려줍니다.
    update(event, delta) {
      if (typeof event.momentum === "boolean") {
        this.momentum = event.momentum;
        this.settling = false;
        return this.momentum ? MOMENTUM : FINGER;
      }

      const magnitude = Math.abs(delta);
      // 관성이 잦아드는 중에 큰 입력이 들어오면 손가락이 다시 닿은 것입니다.
      if (
        this.momentum &&
        magnitude > Math.max(RESUME_DELTA_MIN, this.lastMagnitude * RESUME_DELTA_RATIO)
      ) {
        this.reset();
      }
      if (magnitude < this.lastMagnitude) {
        this.fallingRun += 1;
        if (this.fallingRun >= SETTLING_HINT_EVENTS) this.settling = true;
      } else if (magnitude > this.lastMagnitude) {
        this.fallingRun = 0;
        this.settling = false;
      }
      this.lastMagnitude = magnitude;

      // 한 번 관성으로 판정하면 이벤트가 끊기거나 손가락이 다시 닿을 때까지
      // 유지합니다. 감쇠 값이 잠깐 흔들려도 판정이 뒤집히지 않게 합니다.
      if (this.momentum) return MOMENTUM;

      const sample = this.collectSample(event, delta);
      const factor = sample === null ? null : this.toDecayFactor(sample);

      if (factor !== null) {
        const steady = factor === 0 || (factor >= DECAY_MIN && factor <= DECAY_MAX);
        this.decayRun = steady ? this.decayRun + 1 : 0;
        this.settling = factor === 0 ||
          factor <= SETTLING_MAX ||
          this.fallingRun >= SETTLING_HINT_EVENTS;

        if (this.decayRun >= SAMPLES_TO_CONFIRM) {
          this.momentum = true;
          this.settling = false;
          return MOMENTUM;
        }
      }

      return this.settling ? SETTLING : FINGER;
    }

    // 이벤트 두 개를 묶어야 트랙패드 특유의 들쭉날쭉함이 가라앉습니다.
    collectSample(event, delta) {
      this.pendingDelta += delta;
      this.pendingTime += event.timeStamp;
      this.pendingCount += 1;
      if (this.pendingCount < EVENTS_PER_SAMPLE) return null;

      const sample = {
        delta: this.pendingDelta,
        at: this.pendingTime / this.pendingCount
      };
      this.pendingDelta = 0;
      this.pendingTime = 0;
      this.pendingCount = 0;
      return sample;
    }

    toDecayFactor(sample) {
      const previous = this.previousSample;
      this.previousSample = sample;
      if (!previous) return null;

      const elapsed = sample.at - previous.at;
      if (elapsed <= 0) return null;

      const velocity = sample.delta / elapsed;
      const previousVelocity = this.previousVelocity;
      this.previousVelocity = velocity;
      if (previousVelocity === null) return null;

      return velocity / (previousVelocity || 1);
    }
  }

  namespace.WheelPhaseTracker = WheelPhaseTracker;
})();
