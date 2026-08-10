/**
 * One-Euro Filter for Adaptive Signal Smoothing & Jitter Reduction
 * Reference: Casiez et al., "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
 */

class LowPassFilter {
  constructor(alpha = 1.0, initValue = 0) {
    this.alpha = alpha;
    this.s = initValue;
    this.initialized = false;
  }

  filter(value, alpha = this.alpha) {
    this.alpha = alpha;
    if (!this.initialized) {
      this.s = value;
      this.initialized = true;
    } else {
      this.s = alpha * value + (1.0 - alpha) * this.s;
    }
    return this.s;
  }

  reset() {
    this.initialized = false;
    this.s = 0;
  }
}

export class OneEuroFilter {
  constructor(freq = 30, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;

    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.lastTime = null;
  }

  alpha(cutoff) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    const te = 1.0 / this.freq;
    return 1.0 / (1.0 + tau / te);
  }

  filter(value, timestamp = performance.now()) {
    if (this.lastTime !== null) {
      const dt = (timestamp - this.lastTime) / 1000.0;
      if (dt > 0) this.freq = 1.0 / dt;
    }
    this.lastTime = timestamp;

    const dValue = this.dxFilter.initialized
      ? (value - this.xFilter.s) * this.freq
      : 0;
    const edValue = this.dxFilter.filter(dValue, this.alpha(this.dCutoff));

    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this.xFilter.filter(value, this.alpha(cutoff));
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
  }
}

export class LandmarkSmoother3D {
  constructor(numLandmarks = 21) {
    this.filters = [];
    for (let i = 0; i < numLandmarks; i++) {
      this.filters.push({
        x: new OneEuroFilter(30, 1.0, 0.007, 1.0),
        y: new OneEuroFilter(30, 1.0, 0.007, 1.0),
        z: new OneEuroFilter(30, 1.0, 0.007, 1.0)
      });
    }
  }

  smooth(landmarks) {
    const timestamp = performance.now();
    return landmarks.map((lm, i) => {
      if (!this.filters[i]) return lm;
      return {
        x: this.filters[i].x.filter(lm.x, timestamp),
        y: this.filters[i].y.filter(lm.y, timestamp),
        z: this.filters[i].z ? this.filters[i].z.filter(lm.z, timestamp) : lm.z
      };
    });
  }

  reset() {
    this.filters.forEach((f) => {
      f.x.reset();
      f.y.reset();
      f.z.reset();
    });
  }
}
