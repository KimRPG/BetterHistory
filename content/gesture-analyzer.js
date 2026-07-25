(() => {
  "use strict";

  const namespace = globalThis.GestureBackHistory ??= {};
  const RECENT_INPUT_MS = 110;
  const SAMPLE_COUNT = 6;
  const IMPULSE_WINDOW_MS = 180;
  const IMPULSE_DISTANCE = 42;
  const IMPULSE_DELTA = 12;
  const DECAY_TOLERANCE = 1.15;
  const DECAY_RATIO = 1.25;

  class GestureAnalyzer {
    constructor() {
      this.reset();
    }

    reset() {
      this.startedAt = 0;
      this.lastEventWallAt = 0;
      this.totalDistance = 0;
      this.earlyDistance = 0;
      this.peakDelta = 0;
      this.samples = [];
    }

    begin(timeStamp) {
      this.reset();
      this.startedAt = timeStamp;
      this.lastEventWallAt = Date.now();
    }

    record(amount, timeStamp) {
      const elapsed = this.elapsed(timeStamp);
      this.lastEventWallAt = Date.now();
      this.totalDistance += amount;
      this.peakDelta = Math.max(this.peakDelta, amount);
      if (elapsed <= IMPULSE_WINDOW_MS) this.earlyDistance += amount;

      this.samples.push(amount);
      if (this.samples.length > SAMPLE_COUNT) this.samples.shift();
    }

    elapsed(timeStamp) {
      return Math.max(0, timeStamp - this.startedAt);
    }

    isHeldInput(minimumDistance, now = Date.now()) {
      const hasRecentInput = now - this.lastEventWallAt <= RECENT_INPUT_MS;
      return this.totalDistance >= minimumDistance
        && hasRecentInput
        && !this.isLikelyMomentum();
    }

    isLikelyMomentum() {
      const hasImpulse = this.peakDelta >= IMPULSE_DELTA
        || this.earlyDistance >= IMPULSE_DISTANCE;
      if (!hasImpulse) return false;
      if (this.samples.length < 4) return true;

      let decreasingPairs = 0;
      for (let index = 1; index < this.samples.length; index += 1) {
        if (this.samples[index] <= this.samples[index - 1] * DECAY_TOLERANCE) {
          decreasingPairs += 1;
        }
      }

      const first = this.samples[0];
      const last = this.samples.at(-1);
      const mostlyDecreasing = decreasingPairs >= this.samples.length - 2;
      return mostlyDecreasing && first >= last * DECAY_RATIO;
    }
  }

  namespace.GestureAnalyzer = GestureAnalyzer;
})();
