import { LandmarkSmoother3D } from '../utils/OneEuroFilter.js';

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

    // Central ROI Anchor Zone
    this.roi = { minX: 0.20, minY: 0.15, maxX: 0.80, maxY: 0.85 };

    // Minimum Bounding Box Area ratio relative to largest hand in frame
    this.areaThresholdRatio = 0.45;

    // Landmark Smoother (One-Euro Filter tuned for low jitter)
    this.smoother = new LandmarkSmoother3D(21);

    // Gesture State & Cooldown Timers
    this.lastHandPos = null;
    this.lastHandTime = 0;
    this.lastActionTime = 0;
    this.actionCooldownMs = 350; // Reduced from 600ms to allow faster double-swipes, but long enough for return stroke absorption

    // FPS Throttling for zero WebGL lag
    this.lastFrameSendTime = 0;
    this.frameIntervalMs = 38; // ~26 FPS for MediaPipe to save 50% GPU load

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
      maxNumHands: 4,
      modelComplexity: 0, // Lite Model: Fast inference, 0 WebGL lag
      minDetectionConfidence: 0.55,
      minTrackingConfidence: 0.55
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
          width: 640,
          height: 480
        });
        await this.camera.start();
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
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
      const centroid = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
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
      }
    }

    if (selectedHand) {
      this.lockedTarget = {
        id: selectedHand.index,
        centroid: selectedHand.centroid,
        area: selectedHand.area,
        lastSeenFrame: this.frameCount
      };

      // Apply One-Euro Filter Landmark Smoothing
      const smoothedLandmarks = this.smoother.smooth(selectedHand.landmarks);
      selectedHand.smoothedLandmarks = smoothedLandmarks;

      // Recognize & Dispatch Gesture Controls
      this.recognizeGestures(selectedHand);

      if (this.onPrimaryHandUpdate) {
        this.onPrimaryHandUpdate(selectedHand);
      }
    } else {
      this.handleHandLoss();
    }

    // 5. Debug Overlay Canvas Rendering
    if (canvas && ctx) {
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
    if (now - this.lastActionTime < this.actionCooldownMs) return;

    const wrist = hand.smoothedLandmarks[0];
    const handX = 1.0 - hand.centroid.x; // Mirrored camera X
    const handY = hand.centroid.y;

    if (this.isGameOver) {
      return;
    }

    if (!this.anchorPos) {
      this.anchorPos = { x: handX, y: handY };
      this.lastActionTime = now;
      return;
    }

    if (now - this.lastActionTime < this.actionCooldownMs) {
      // During cooldown, force the anchor to follow the hand immediately.
      // This completely absorbs the "return to center" stroke!
      this.anchorPos = { x: handX, y: handY };
      return;
    }

    const dy = handY - this.anchorPos.y;

    // Must move 18% of the screen relative to the anchor to trigger jump/slide
    const SWIPE_THRESHOLD_Y = 0.18;

    let yGestureTriggered = false;

    if (dy < -SWIPE_THRESHOLD_Y) {
      if (this.onJump) this.onJump();
      yGestureTriggered = true;
    } 
    else if (dy > SWIPE_THRESHOLD_Y) {
      if (this.onSlide) this.onSlide();
      yGestureTriggered = true;
    } 

    if (yGestureTriggered) {
      // Snap anchor to current position and start cooldown
      this.anchorPos = { x: handX, y: handY };
      this.lastActionTime = now;
    } else {
      // Slow drift for Y anchor
      this.anchorPos.y += (handY - this.anchorPos.y) * 0.08;
    }

    // Absolutely NO glitching on X Axis: The hand's position IS the character's lane!
    if (this.onSetLane) {
      if (handX < 0.35) {
        this.onSetLane(0); // Left Third of screen -> Left Lane
      } else if (handX > 0.65) {
        this.onSetLane(2); // Right Third of screen -> Right Lane
      } else {
        this.onSetLane(1); // Center of screen -> Center Lane
      }
    }
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
    }
    if (this.onPrimaryHandUpdate) {
      this.onPrimaryHandUpdate(null);
    }
  }
}
