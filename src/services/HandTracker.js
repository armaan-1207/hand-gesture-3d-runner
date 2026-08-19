import { LandmarkSmoother3D, OneEuroFilter } from '../utils/OneEuroFilter.js';
import { gestureEstimator } from '../utils/gestures.js';

export class HandTracker {
  constructor(options = {}) {
    this.videoElement = options.videoElement || document.createElement('video');
    this.canvasElement = options.canvasElement || null;
    this.canvasCtx = this.canvasElement ? this.canvasElement.getContext('2d') : null;

    // Tracking Persistence State
    this.lockedTarget = null;
    this.lockTimeoutFrames = 12;
    this.framesSinceLastLock = 0;
    this.frameCount = 0;
    this.isGameOver = false;

    // Central ROI Anchor Zone (80% of the screen)
    this.roi = { minX: 0.10, minY: 0.10, maxX: 0.90, maxY: 0.90 };

    // Minimum Bounding Box Area ratio relative to largest hand in frame
    this.areaThresholdRatio = 0.45;

    // Landmark Smoother (One-Euro Filter tuned for low jitter)
    this.smoother = new LandmarkSmoother3D(21);
    
    // Centroid Filters — X stays stable for lane holding,
    // Y uses HIGH beta so fast downward swipes aren't smoothed away (less latency).
    this.centroidXFilter = new OneEuroFilter(30, 1.5, 0.05, 1.0); 
    this.centroidYFilter = new OneEuroFilter(30, 1.5, 0.05, 1.0);

    // Gesture State & Cooldown Timers
    this.lastHandPos = null;
    this.lastHandTime = 0;

    // SEPARATE cooldowns per action type:
    // - After JUMP: only 80ms lock so the user can immediately slide mid-air.
    //   main.js slide() already handles the jump→slide cancel correctly.
    // - After SLIDE: 280ms lock to absorb the return stroke of the swipe
    //   and prevent an instant double-slide.
    this.lastJumpTime  = 0;
    this.lastSlideTime = 0;
    this.jumpCooldownMs  = 80;
    this.slideCooldownMs = 280;

    // Rolling Y-position history — 3 frames (was 5) at 30fps = ~100ms window.
    // Shorter window = faster swipe detection with less added latency.
    this._handYHistory = [];
    this._handYHistorySize = 3;

    // FPS Throttling — 30fps (33ms) instead of 26fps (38ms).
    // Each extra fps = ~1.3ms less detection latency per frame.
    this.lastFrameSendTime = 0;
    this.frameIntervalMs = 33;

    // Event Callbacks
    this.onPrimaryHandUpdate = options.onPrimaryHandUpdate || null;
    this.onTrackingStateChange = options.onTrackingStateChange || null;
    this.onMoveLeft = options.onMoveLeft || null;
    this.onMoveRight = options.onMoveRight || null;
    this.onSetLane = options.onSetLane || null;
    this.onJump = options.onJump || null;
    this.onSlide = options.onSlide || null;
    this.onRestart = options.onRestart || null;

    // MediaPipe & Camera Instances
    this.hands = null;
    this.camera = null;
    this.isTracking = false;

    this.initMediaPipe();
  }

  initMediaPipe() {
    const HandsClass = window.Hands || (typeof Hands !== 'undefined' ? Hands : null);
    if (!HandsClass) {
      console.warn('MediaPipe Hands library not loaded yet');
      return;
    }

    this.hands = new HandsClass({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    this.hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 0, // 0 = LITE model (drastically reduces CPU spikes), 1 = FULL
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    this.hands.onResults((results) => this.processResults(results));
  }

  async startCamera() {
    if (this.isTracking) return true;

    if (!this.hands) {
      this.initMediaPipe();
    }

    this.videoElement.style.display = 'none';
    if (!this.videoElement.parentNode) {
      document.body.appendChild(this.videoElement);
    }

    const CameraClass = window.Camera || (typeof Camera !== 'undefined' ? Camera : null);

    try {
      if (CameraClass) {
        this.camera = new CameraClass(this.videoElement, {
          onFrame: async () => {
            const now = performance.now();
            if (this.isTracking && this.videoElement && this.hands) {
              if (now - this.lastFrameSendTime >= this.frameIntervalMs) {
                this.lastFrameSendTime = now;
                await this.hands.send({ image: this.videoElement });
              }
            }
          },
          width: 480,
          height: 360
        });
        await this.camera.start();
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 } });
        this.videoElement.srcObject = stream;
        await this.videoElement.play();

        const processFrame = async () => {
          const now = performance.now();
          if (this.isTracking && this.videoElement && this.hands) {
            if (now - this.lastFrameSendTime >= this.frameIntervalMs) {
              this.lastFrameSendTime = now;
              await this.hands.send({ image: this.videoElement });
            }
            requestAnimationFrame(processFrame);
          }
        };
        processFrame();
      }

      this.isTracking = true;
      if (this.onTrackingStateChange) this.onTrackingStateChange(true);
      return true;
    } catch (err) {
      console.error('Failed to start camera for hand tracking:', err);
      this.isTracking = false;
      if (this.onTrackingStateChange) this.onTrackingStateChange(false);
      return false;
    }
  }

  stopCamera() {
    if (this.camera) {
      this.camera.stop();
      this.camera = null;
    } else if (this.videoElement && this.videoElement.srcObject) {
      const tracks = this.videoElement.srcObject.getTracks();
      tracks.forEach((track) => track.stop());
      this.videoElement.srcObject = null;
    }

    this.isTracking = false;
    this.lockedTarget = null;
    this.smoother.reset();
    this._laneZone = undefined;
    this.anchorY = undefined;
    this.lastHandShape = undefined;
    this.lastJumpTime = 0;
    this.lastSlideTime = 0;
    if (this.onTrackingStateChange) this.onTrackingStateChange(false);
  }

  /**
   * Multi-stage Crowd Filtering & Target Persistence Pipeline
   */
  processResults(results) {
    this.frameCount++;
    const canvas = this.canvasElement;
    const ctx = this.canvasCtx;

    if (canvas && ctx) {
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = 'rgba(0, 255, 102, 0.3)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(
        this.roi.minX * canvas.width,
        this.roi.minY * canvas.height,
        (this.roi.maxX - this.roi.minX) * canvas.width,
        (this.roi.maxY - this.roi.minY) * canvas.height
      );
      ctx.restore();
    }

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      this.handleHandLoss();
      return;
    }

    // 1. Calculate Bounding Box Area & Centroid for each detected hand
    const candidateHands = results.multiHandLandmarks.map((landmarks, index) => {
      let minX = 1.0, minY = 1.0, maxX = 0.0, maxY = 0.0;
      landmarks.forEach((lm) => {
        minX = Math.min(minX, lm.x);
        minY = Math.min(minY, lm.y);
        maxX = Math.max(maxX, lm.x);
        maxY = Math.max(maxY, lm.y);
      });

      const width = maxX - minX;
      const height = maxY - minY;
      const area = width * height;
      
      // FIX: Use the middle knuckle (Landmark 9) instead of the bounding box center.
      // This prevents the "centroid" from instantly shifting down when you close your fist!
      const stablePoint = landmarks[9]; 
      const centroid = { x: stablePoint.x, y: stablePoint.y };
      const inROI =
        centroid.x >= this.roi.minX &&
        centroid.x <= this.roi.maxX &&
        centroid.y >= this.roi.minY &&
        centroid.y <= this.roi.maxY;

      return {
        index,
        landmarks,
        bbox: { minX, minY, maxX, maxY, width, height },
        area,
        centroid,
        inROI
      };
    });

    // 2. Determine Largest Hand Area
    const maxArea = Math.max(...candidateHands.map((h) => h.area));

    // 3. Filter out background hands (Area < 45% of largest hand)
    const validForegroundHands = candidateHands.filter(
      (h) => h.area >= maxArea * this.areaThresholdRatio
    );

    // 4. Primary Player Hand Lock (Target Persistence)
    let selectedHand = null;

    if (this.lockedTarget && this.framesSinceLastLock <= this.lockTimeoutFrames) {
      let minDistance = Infinity;
      let bestMatch = null;

      validForegroundHands.forEach((hand) => {
        const dist = Math.hypot(
          hand.centroid.x - this.lockedTarget.centroid.x,
          hand.centroid.y - this.lockedTarget.centroid.y
        );
        if (dist < 0.28 && dist < minDistance) {
          minDistance = dist;
          bestMatch = hand;
        }
      });

      if (bestMatch) {
        selectedHand = bestMatch;
        this.framesSinceLastLock = 0;
      }
    }

    if (!selectedHand) {
      const roiCandidates = validForegroundHands.filter((h) => h.inROI);
      const searchPool = roiCandidates.length > 0 ? roiCandidates : validForegroundHands;

      searchPool.sort((a, b) => b.area - a.area);
      selectedHand = searchPool[0];

      if (selectedHand) {
        this.framesSinceLastLock = 0;
        this.smoother.reset();
        this.centroidXFilter.reset();
        this.centroidYFilter.reset();
      }
    }

    if (selectedHand) {
      this.lockedTarget = {
        id: selectedHand.index,
        centroid: selectedHand.centroid,
        area: selectedHand.area,
        lastSeenFrame: this.frameCount
      };

      const now = performance.now();
      // Apply One-Euro Filter to Centroid for hyper-stable swiping
      selectedHand.centroid.x = this.centroidXFilter.filter(selectedHand.centroid.x, now);
      selectedHand.centroid.y = this.centroidYFilter.filter(selectedHand.centroid.y, now);

      // Apply One-Euro Filter Landmark Smoothing
      const smoothedLandmarks = this.smoother.smooth(selectedHand.landmarks);
      selectedHand.smoothedLandmarks = smoothedLandmarks;

      // Recognize & Dispatch Gesture Controls (using filtered centroid!)
      this.recognizeGestures(selectedHand);

      if (this.onPrimaryHandUpdate) {
        this.onPrimaryHandUpdate(selectedHand);
      }
    } else {
      this.handleHandLoss();
    }

    // 5. Debug Overlay Canvas Rendering
    // Skip heavy canvas drawing if PiP is hidden
    if (canvas && ctx && !this.canvasElement.parentElement.classList.contains('hidden')) {
      candidateHands.forEach((hand) => {
        const isPrimary = selectedHand && hand.index === selectedHand.index;
        const color = isPrimary ? '#00ff66' : '#ff3355';
        const label = isPrimary ? 'PRIMARY PLAYER' : 'REJECTED (BACKGROUND)';

        const b = hand.bbox;
        const x = (1 - b.maxX) * canvas.width;
        const y = b.minY * canvas.height;
        const w = b.width * canvas.width;
        const h = b.height * canvas.height;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = isPrimary ? 3 : 1.5;
        ctx.strokeRect(x, y, w, h);

        ctx.fillStyle = color;
        ctx.font = 'bold 11px Outfit, sans-serif';
        ctx.fillText(label, x + 4, y > 15 ? y - 6 : y + 14);

        if (isPrimary) {
          this.drawSkeleton(ctx, hand.smoothedLandmarks || hand.landmarks, canvas.width, canvas.height);
        }
        ctx.restore();
      });
    }
  }

  /**
   * Precise Gesture Recognition: Strict thresholds to eliminate sensitivity and double-triggers
   */
  recognizeGestures(hand) {
    const now = performance.now();
    const handX = 1.0 - hand.centroid.x; // Mirrored camera X
    const handY = hand.centroid.y;

    if (this.isGameOver) return;

    // ── 1. Continuous lane control ──────────────────────────────────
    // Lane follows hand position directly every frame. Hysteresis stops
    // flicker near lane boundaries.
    // ── 1. Continuous lane control ──────────────────────────────────
    if (this._laneZone === undefined) this._laneZone = 1;

    // Lane frozen during slide cooldown only (not jump cooldown — steering
    // should resume quickly after jumping).
    const inSlideCooldown = (now - this.lastSlideTime) < this.slideCooldownMs;

    if (!inSlideCooldown) {
      if (this._laneZone !== 0 && handX < 0.32) {
        this._laneZone = 0;
      } else if (this._laneZone !== 2 && handX > 0.68) {
        this._laneZone = 2;
      } else if (this._laneZone === 0 && handX > 0.38) {
        this._laneZone = 1;
      } else if (this._laneZone === 2 && handX < 0.62) {
        this._laneZone = 1;
      }
    }

    if (this.onSetLane) this.onSetLane(this._laneZone);

    // ── 2. Discrete gestures (slide / jump) ──────────────────────────
    if (this.anchorY === undefined) {
      this.anchorY = handY;
      return;
    }

    const inJumpCooldown = (now - this.lastJumpTime) < this.jumpCooldownMs;
    const slideBlocked   = inSlideCooldown;

    // dy always available — needed by both swipe detection and fist stillness check
    const dy = handY - this.anchorY;

    if (slideBlocked) {
      this.anchorY = handY;
      this._handYHistory = [];
    } else {
      // Push into rolling history
      this._handYHistory.push({ y: handY, t: now });
      if (this._handYHistory.length > this._handYHistorySize) {
        this._handYHistory.shift();
      }

      const SWIPE_THRESHOLD_Y = 0.13;

      // Single-frame instant bypass for blazing fast swipes
      const prevY     = this._handYHistory.length >= 2 ? this._handYHistory[this._handYHistory.length - 2].y : handY;
      const frameDt   = this._handYHistory.length >= 2 ? now - this._handYHistory[this._handYHistory.length - 2].t : 33;
      const instantVel = frameDt > 0 ? (handY - prevY) / frameDt : 0;
      const INSTANT_VEL_THRESHOLD = 0.0025;

      // Rolling window velocity (2-frame)
      let windowVelocity = 0;
      if (this._handYHistory.length >= 2) {
        const oldest = this._handYHistory[0];
        const newest = this._handYHistory[this._handYHistory.length - 1];
        const elapsed = newest.t - oldest.t;
        if (elapsed > 0) windowVelocity = (newest.y - oldest.y) / elapsed;
      }
      const SWIPE_VELOCITY_THRESHOLD = 0.0008;

      if (instantVel > INSTANT_VEL_THRESHOLD || windowVelocity > SWIPE_VELOCITY_THRESHOLD || dy > SWIPE_THRESHOLD_Y) {
        if (this.onSlide) this.onSlide();
        this.anchorY = handY;
        this._handYHistory = [];
        this.lastSlideTime = now;
        return;
      }
      if (dy < -SWIPE_THRESHOLD_Y) {
        this.anchorY = handY;
        this._handYHistory = [];
        this.lastSlideTime = now;
        return;
      }
    }

    // ── Shape Recognition via fingerpose ──────────────────────────────────
    const isHandStill = Math.abs(dy) < 0.08;

    // Do not allow jumping if we are in the middle of a slide cooldown
    if (isHandStill && !inJumpCooldown && !inSlideCooldown) {
      const lms = hand.smoothedLandmarks || hand.landmarks;
      const scaled = lms.map(lm => [lm.x * 640, lm.y * 480, (lm.z || 0) * 640]);

      const result = gestureEstimator.estimate(scaled, 7.5);
      const topGesture = result.gestures.length > 0
        ? result.gestures.reduce((a, b) => a.score > b.score ? a : b)
        : null;

      const currentShape = topGesture && topGesture.name === 'FIST' ? 'FIST' : 'NEUTRAL';
      const fistScore    = topGesture && topGesture.name === 'FIST' ? topGesture.score : 0;

      if (currentShape === 'FIST') {
        this._fistFrames = (this._fistFrames || 0) + 1;
        const frameRequired = fistScore >= 9.5 ? 1 : 2;
        if (this._fistFrames >= frameRequired && this.lastHandShape !== 'FIST') {
          if (this.onJump) this.onJump();
          this.lastJumpTime = now;
          this.anchorY = handY;
          this.lastHandShape = 'FIST';
        }
      } else {
        this._fistFrames = 0;
        this.lastHandShape = 'NEUTRAL';
      }
    } else if (!isHandStill) {
      this._fistFrames = 0;
    }

    // Slowly drift the Y anchor so resting doesn't accumulate a stale delta
    this.anchorY += (handY - this.anchorY) * 0.06;
  }

  drawSkeleton(ctx, landmarks, width, height) {
    const connections = window.HAND_CONNECTIONS || [
      [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
      [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
      [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
    ];

    connections.forEach(([i, j]) => {
      const p1 = landmarks[i];
      const p2 = landmarks[j];
      ctx.beginPath();
      ctx.moveTo((1 - p1.x) * width, p1.y * height);
      ctx.lineTo((1 - p2.x) * width, p2.y * height);
      ctx.strokeStyle = '#00ff66';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    landmarks.forEach((lm) => {
      ctx.beginPath();
      ctx.arc((1 - lm.x) * width, lm.y * height, 3, 0, 2 * Math.PI);
      ctx.fillStyle = '#a3e635';
      ctx.fill();
    });
  }

  handleHandLoss() {
    this.framesSinceLastLock++;
    if (this.framesSinceLastLock > this.lockTimeoutFrames) {
      this.lockedTarget = null;
      this.smoother.reset();
      this._laneZone = undefined;
      this.anchorY = undefined;
      this.lastHandShape = undefined;
    }
    if (this.onPrimaryHandUpdate) {
      this.onPrimaryHandUpdate(null);
    }
  }
}
