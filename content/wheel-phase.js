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
  const SAMPLES_TO_CONFIRM = 5;
  const DECAY_MIN = 0.6;
  const DECAY_MAX = 0.96;
  const RESUME_DELTA_RATIO = 2;
  const RESUME_DELTA_MIN = 2;

  class WheelPhaseTracker {
    constructor() {
      this.reset();
    }

    reset() {
      this.momentum = false;
      this.lastMagnitude = 0;
      this.pendingDelta = 0;
      this.pendingTime = 0;
      this.pendingCount = 0;
      this.previousSample = null;
      this.previousVelocity = null;
      this.decayFactors = [];
    }

    // 이 이벤트가 손가락을 뗀 뒤의 관성이면 true.
    update(event, delta) {
      if (typeof event.momentum === "boolean") {
        this.momentum = event.momentum;
        return this.momentum;
      }

      const magnitude = Math.abs(delta);
      // 관성이 잦아드는 중에 큰 입력이 들어오면 손가락이 다시 닿은 것입니다.
      if (
        this.momentum &&
        magnitude > Math.max(RESUME_DELTA_MIN, this.lastMagnitude * RESUME_DELTA_RATIO)
      ) {
        this.reset();
      }
      this.lastMagnitude = magnitude;

      // 한 번 관성으로 판정하면 이벤트가 끊기거나 손가락이 다시 닿을 때까지
      // 유지합니다. 감쇠 값이 잠깐 흔들려도 판정이 뒤집히지 않게 합니다.
      if (this.momentum) return true;

      const sample = this.collectSample(event, delta);
      if (!sample) return false;

      const factor = this.toDecayFactor(sample);
      if (factor === null) return false;

      this.decayFactors.push(factor);
      if (this.decayFactors.length > SAMPLES_TO_CONFIRM) this.decayFactors.shift();
      if (this.decayFactors.length < SAMPLES_TO_CONFIRM) return false;

      this.momentum = this.decayFactors.every(
        (value) => value === 0 || (value >= DECAY_MIN && value <= DECAY_MAX)
      );
      return this.momentum;
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
