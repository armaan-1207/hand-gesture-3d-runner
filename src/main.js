import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import gsap from 'gsap';
import { TrackManager } from './components/TrackManager.js';
import { ObstacleManager } from './components/ObstacleManager.js';
import { HandTracker } from './services/HandTracker.js';

/**
 * Game Configuration Constants
 */
export const CONFIG = {
  LANES: [-3.5, 0, 3.5],
  CAMERA_OFFSET: new THREE.Vector3(0, 4.5, 8.5),
  CAMERA_LOOK_AHEAD: new THREE.Vector3(0, 1.5, -12),
  INITIAL_SPEED: 28,
  MAX_SPEED: 65,
  ACCELERATION: 0.35,
  JUMP_HEIGHT: 3.4,
  JUMP_DURATION: 0.55,
  SLIDE_DURATION: 0.65,
  TRACK_CHUNK_LENGTH: 60,
  VISIBLE_CHUNKS: 14 // 14 × 60m = 840m lookahead — smooth with pool recycling
};

class CyberRunnerGame {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.gameState = 'MENU'; // 'MENU' | 'PLAYING' | 'GAMEOVER'
    
    // Stats & Progress
    this.startZ = 0;
    this.distance = 0;
    this.coins = 0;
    this.speed = CONFIG.INITIAL_SPEED;
    this.currentAcceleration = CONFIG.ACCELERATION;
    this.highScore = parseInt(localStorage.getItem('cyberrunner_highscore') || '0', 10);

    // Movement & Lane State
    this.currentLane = 1; // 0: Left, 1: Center, 2: Right
    this.isJumping = false;
    this.isSliding = false;
    this.laneTween = null;
    this.jumpTimeline = null;
    this.slideTimeline = null;

    // Three.js Core components
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.clock = new THREE.Clock();

    // Animation System
    this.mixer = null;
    this.actions = {};
    this.currentAction = null;
    this.playerHoloMat = null;

    // Scene Managers & Entities
    this.obstacleManager = null;
    this.trackManager = null;
    this.playerGroup = null;
    this.xbotMesh = null;
    this.dirLight = null;
    this.matrixRain = null;

    // Vision Engine HandTracker Instance
    this.handTracker = null;

    // Scratch vector — reused every frame in camera follow (avoids GC pressure)
    this._lookAtTarget = new THREE.Vector3();

    // UI Elements
    this.hud = document.getElementById('hud');
    this.startScreen = document.getElementById('start-screen');
    this.gameOverScreen = document.getElementById('gameover-screen');
    this.scoreDisplay = document.getElementById('score-display');
    this.coinsDisplay = document.getElementById('coins-display');
    this.speedDisplay = document.getElementById('speed-display');
    this.highScoreStart = document.getElementById('high-score-start');
    this.finalScore = document.getElementById('final-score');
    this.finalCoins = document.getElementById('final-coins');
    this.finalHighScore = document.getElementById('final-highscore');
    this.webcamPip = document.getElementById('webcam-pip');
    this.pipBadge = document.getElementById('pip-status-badge');

    this.initGame();
    this.initHandTracker();
    this.bindControls();
    this.bindUIEvents();
    this.animate();
  }

  initGame() {
    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x040704);
    // Reduced fog density: obstacles visible up to ~250m before blending into sky
    this.scene.fog = new THREE.FogExp2(0x040704, 0.003);

    // 2. Camera — far plane 500m ensures full 840m pool is rendered
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      500
    );
    this.camera.position.copy(CONFIG.CAMERA_OFFSET);

    // 3. WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    // 4. Lighting System
    this.setupLighting();

    // 5. Create Player Base Container
    this.playerGroup = new THREE.Group();
    this.playerGroup.position.set(CONFIG.LANES[this.currentLane], 0, 0);
    this.playerGroup.rotation.set(0, 0, 0);
    this.scene.add(this.playerGroup);

    // Setup holographic material
    this.playerHoloMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0x00ff66,
      emissiveIntensity: 0.5,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    });

    // 6. Load X-Bot Character & Setup AnimationMixer
    this.loadXBotCharacter();

    // 7. Obstacle & Track Managers Initialization
    this.obstacleManager = new ObstacleManager(this.scene);
    this.trackManager = new TrackManager(this.scene, this.obstacleManager);

    // 8. Matrix Start Gate
    this.createStartGate();

    // 9. Matrix rain particle system
    // this.createMatrixRain();

    // Update High Score Display
    if (this.highScoreStart) {
      this.highScoreStart.textContent = `${this.highScore}m`;
    }

    // Window Resize Event
    window.addEventListener('resize', () => this.onWindowResize());
  }

  createStartGate() {
    // Start gate removed to save 34MB model memory and clean up workspace
  }

  /**
   * Initializes Vision HandTracker with gesture event callbacks
   */
  initHandTracker() {
    const debugCanvas = document.getElementById('debug-canvas');
    if (!debugCanvas) return;

    this.handTracker = new HandTracker({
      canvasElement: debugCanvas,
      onPrimaryHandUpdate: (hand) => {
        if (hand && this.pipBadge) {
          this.pipBadge.textContent = 'PLAYER LOCKED';
          this.pipBadge.classList.add('locked');
        } else if (this.pipBadge) {
          this.pipBadge.textContent = 'SEARCHING';
          this.pipBadge.classList.remove('locked');
        }
      },
      onTrackingStateChange: (active) => {
        if (this.webcamPip) {
          if (active) this.webcamPip.classList.remove('hidden');
          else this.webcamPip.classList.add('hidden');
        }
      },
      onSetLane: (targetLane) => {
        if (this.gameState === 'PLAYING') this.setLane(targetLane);
      },
      onJump: () => {
        if (this.gameState === 'PLAYING') this.jump();
      },
      onSlide: () => {
        if (this.gameState === 'PLAYING') this.slide();
      },
      onRestart: () => {
        if (this.gameState === 'GAMEOVER') this.restartGame();
      }
    });
  }

  setupLighting() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));

    // Strong ambient light to reveal dark character textures
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.8);
    this.scene.add(ambientLight);

    // Static directional light
    this.dirLight = new THREE.DirectionalLight(0xffffff, 2.5); // boosted intensity
    this.dirLight.position.set(5, 35, 15);
    this.dirLight.castShadow = true;

    // Keep shadow frustum tight (80m) to maximise shadow-map texel density
    this.dirLight.shadow.mapSize.width = 1024;
    this.dirLight.shadow.mapSize.height = 1024;
    this.dirLight.shadow.camera.near = 0.5;
    this.dirLight.shadow.camera.far = 80;
    const d = 22;
    this.dirLight.shadow.camera.left   = -d;
    this.dirLight.shadow.camera.right  =  d;
    this.dirLight.shadow.camera.top    =  d;
    this.dirLight.shadow.camera.bottom = -d;

    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    // Rim accent lights (no shadows)
    const rimLight1 = new THREE.DirectionalLight(0x00ff66, 1.4);
    rimLight1.position.set(-10, 10, -30);
    this.scene.add(rimLight1);

    const rimLight2 = new THREE.DirectionalLight(0x10b981, 1.0);
    rimLight2.position.set(10, 10, -30);
    this.scene.add(rimLight2);
  }

  /**
   * Loads the player character.
   * Priority: neo_the_matrix.glb (original materials, auto-scaled) → Xbot.glb (coat override)
   */
  loadXBotCharacter() {
    // Invisible placeholder while model loads
    const placeholderGeo = new THREE.BoxGeometry(0.5, 1.8, 0.4);
    const placeholderMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0 });
    const placeholder = new THREE.Mesh(placeholderGeo, placeholderMat);
    placeholder.position.y = 0.9;
    this.playerGroup.add(placeholder);

    // Xbot fallback coat material (now given a faint neon edge so it's visible)
    const xbotCoatMat = new THREE.MeshStandardMaterial({
      color: 0x111111, 
      emissive: 0x00ff66, 
      emissiveIntensity: 0.15,
      metalness: 0.8, 
      roughness: 0.2,
    });
    const xbotSkinMat = new THREE.MeshStandardMaterial({
      color: 0x2a1a0e, metalness: 0.0, roughness: 0.95,
    });

    const finishSetup = (model, gltf) => {
      this.playerGroup.remove(placeholder);
      placeholder.geometry.dispose();
      placeholder.material.dispose();

      model.rotation.set(0, Math.PI, 0);
      model.position.set(0, 0, 0);

      // Neo model — auto-scale to ~1.8 m tall
      const box = new THREE.Box3().setFromObject(model);
      const h = box.max.y - box.min.y;
      const s = h > 0.05 ? (1.8 / h) : 1.0;
      model.scale.setScalar(s);
      
      const box2 = new THREE.Box3().setFromObject(model);
      model.position.y = -box2.min.y;
      
      model.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = true;
        child.receiveShadow = true;
        // Keep original materials from the GLB
      });

      this.xbotMesh = model;
      this.playerGroup.add(model);
      this.mixer = new THREE.AnimationMixer(model);

      if (gltf.animations && gltf.animations.length > 0) {
        gltf.animations.forEach((clip) => {
          this.actions[clip.name.toLowerCase()] = this.mixer.clipAction(clip);
        });
        
        // Find run and idle
        const runAction = this.actions['run'] || this.actions['walk'] || this.mixer.clipAction(gltf.animations[0]);
        const idleAction = this.actions['idle'] || this.actions['t-pose'] || null;

        if (runAction) this.actions.run = runAction;
        if (idleAction) this.actions.idle = idleAction;

        // Default to idle on start screen if available, else run
        const startAction = idleAction || runAction;
        if (startAction) {
          startAction.play();
          this.currentAction = startAction;
        }
      } else {
        this.createProceduralAnimationTracks(model);
      }
    };

    const loader = new FBXLoader();

    const loadFBX = (url) => {
      return new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });
    };

    Promise.all([
      loadFBX('/models/neo_idle_for_mixamo@Running_final.fbx'), // Skinned model (22.7MB)
      loadFBX('/models/neo_idle_for_mixamo@Standing Idle.fbx')  // Skinless animation (444KB)
    ]).then(([mainFbx, idleFbx]) => {
      
      const allAnimations = [];
      
      // Extract run from main skin model
      if (mainFbx.animations.length > 0) {
        const clip = mainFbx.animations[0];
        clip.name = 'run';
        allAnimations.push(clip);
      }

      // Extract idle (from skinless FBX)
      if (idleFbx.animations.length > 0) {
        const clip = idleFbx.animations[0];
        clip.name = 'idle';
        allAnimations.push(clip);
      }

      mainFbx.animations = allAnimations;
      finishSetup(mainFbx, mainFbx);

    }).catch(err => {
      console.warn('[Character] FBX failed to load:', err);
      this.createProceduralAnimationTracks(placeholder);
    });
  }

  createProceduralAnimationTracks(targetMesh) {
    this.mixer = new THREE.AnimationMixer(targetMesh);

    const times = [0, 0.25, 0.5, 0.75, 1.0];
    const values = [
      0, 1.0, 0, 0.05, 0,
      0, 1.08, 0, 0.04, 0,
      0, 1.0, 0, 0.05, 0,
      0, 1.08, 0, 0.04, 0,
      0, 1.0, 0, 0.05, 0
    ];

    const positionTrack = new THREE.VectorKeyframeTrack('.position', times, values);
    const runClip = new THREE.AnimationClip('procedural_run', 1.0, [positionTrack]);

    const runAction = this.mixer.clipAction(runClip);
    runAction.play();
    this.actions.run = runAction;
    this.currentAction = runAction;
  }

  bindControls() {
    window.addEventListener('keydown', (e) => {
      if (this.gameState !== 'PLAYING') return;

      switch (e.code) {
        case 'KeyA':
        case 'ArrowLeft':
          this.moveLane(-1);
          break;

        case 'KeyD':
        case 'ArrowRight':
          this.moveLane(1);
          break;

        case 'KeyW':
        case 'ArrowUp':
          this.jump();
          break;

        case 'KeyS':
        case 'ArrowDown':
          this.slide();
          break;
      }
    });

    let touchStartX = 0;
    let touchStartY = 0;

    window.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    window.addEventListener('touchend', (e) => {
      if (this.gameState !== 'PLAYING') return;

      const deltaX = e.changedTouches[0].clientX - touchStartX;
      const deltaY = e.changedTouches[0].clientY - touchStartY;
      const threshold = 30;

      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX > threshold) this.moveLane(1);
        else if (deltaX < -threshold) this.moveLane(-1);
      } else {
        if (deltaY < -threshold) this.jump();
        else if (deltaY > threshold) this.slide();
      }
    }, { passive: true });
  }

  moveLane(direction) {
    const targetLane = THREE.MathUtils.clamp(this.currentLane + direction, 0, 2);
    this.setLane(targetLane);
  }

  setLane(targetLane) {
    if (targetLane === this.currentLane) return;

    // Determine direction for character leaning
    const direction = targetLane > this.currentLane ? 1 : -1;
    this.currentLane = targetLane;
    const targetX = CONFIG.LANES[this.currentLane];

    if (this.laneTween) this.laneTween.kill();

    // Tilt character dynamically during move (exaggerated for smoothness)
    this.playerGroup.rotation.z = direction * -0.25; 

    // Bouncy, spring-like easing instead of a rigid snap
    this.laneTween = gsap.to(this.playerGroup.position, {
      x: targetX,
      duration: 0.35, 
      ease: 'back.out(1.2)', 
      onComplete: () => {
        // Softly settle the rotation back to 0
        gsap.to(this.playerGroup.rotation, { z: 0, duration: 0.2, ease: 'sine.inOut' });
      }
    });
  }

  jump() {
    if (this.isJumping) return;

    if (this.isSliding && this.slideTimeline) {
      this.slideTimeline.kill();
      this.isSliding = false;
      this.playerGroup.scale.set(1, 1, 1);
      this.playerGroup.rotation.set(0, 0, 0);
    }

    this.isJumping = true;

    this.jumpTimeline = gsap.timeline({
      onComplete: () => {
        this.isJumping = false;
        this.playerGroup.position.y = 0;
        this.playerGroup.scale.set(1, 1, 1);
        this.playerGroup.rotation.set(0, 0, 0);
      }
    });

    const jumpHeight = CONFIG.JUMP_HEIGHT;
    const duration = CONFIG.JUMP_DURATION;

    this.jumpTimeline
      .to(this.playerGroup.scale, { y: 0.8, x: 1.15, duration: 0.06, ease: 'power1.out' })
      .to(this.playerGroup.scale, { y: 1.1, x: 0.9, duration: 0.08, ease: 'power1.out' })
      .to(this.playerGroup.position, {
        y: jumpHeight,
        duration: duration * 0.45,
        ease: 'power1.out'
      }, '<')
      .to(this.playerGroup.position, {
        y: 0,
        duration: duration * 0.45,
        ease: 'power2.in'
      })
      .to(this.playerGroup.scale, { y: 0.85, x: 1.1, duration: 0.08, ease: 'power1.in' })
      .to(this.playerGroup.scale, { y: 1, x: 1, duration: 0.08, ease: 'power1.out' });
  }

  slide() {
    if (this.isJumping) {
      if (this.jumpTimeline) this.jumpTimeline.kill();
      this.isJumping = false;
      gsap.to(this.playerGroup.position, {
        y: 0,
        duration: 0.15,
        ease: 'power2.in',
        onComplete: () => this.triggerSlideAnimation()
      });
      return;
    }

    if (this.isSliding) return;
    this.triggerSlideAnimation();
  }

  triggerSlideAnimation() {
    this.isSliding = true;

    if (this.slideTimeline) this.slideTimeline.kill();

    this.slideTimeline = gsap.timeline({
      onComplete: () => {
        this.isSliding = false;
        this.playerGroup.scale.set(1, 1, 1);
        this.playerGroup.rotation.set(0, 0, 0);
      }
    });

    const duration = CONFIG.SLIDE_DURATION;

    // Procedural crouch (original logic: squish down and stretch out)
    this.slideTimeline
      .to(this.playerGroup.scale, {
        y: 0.45,
        z: 1.3,
        duration: 0.1,
        ease: 'power2.out'
      })
      .to({}, { duration: duration - 0.2 })
      .to(this.playerGroup.scale, {
        y: 1,
        z: 1,
        duration: 0.1,
        ease: 'power2.inOut'
      });
  }

  bindUIEvents() {
    const startBtn = document.getElementById('start-btn');
    const restartBtn = document.getElementById('restart-btn');
    const handRestartBtn = document.getElementById('hand-restart-btn');
    const cameraToggleBtn = document.getElementById('camera-toggle-btn');

    if (startBtn) {
      startBtn.addEventListener('click', () => this.startGame());
    }
    if (restartBtn) {
      restartBtn.addEventListener('click', () => this.restartGame());
    }
    if (handRestartBtn) {
      handRestartBtn.addEventListener('click', async () => {
        if (this.handTracker) {
          if (!this.handTracker.isTracking) {
            await this.handTracker.startCamera();
            if (cameraToggleBtn) cameraToggleBtn.classList.add('active');
          }
        }
        this.restartGame();
      });
    }
    if (cameraToggleBtn) {
      cameraToggleBtn.addEventListener('click', async () => {
        if (this.handTracker) {
          if (this.handTracker.isTracking) {
            this.handTracker.stopCamera();
            cameraToggleBtn.classList.remove('active');
          } else {
            await this.handTracker.startCamera();
            cameraToggleBtn.classList.add('active');
          }
        }
      });
    }
  }

  applySpeedSettings() {
    // Slower pacing for AI hand controls to allow player to adapt
    if (this.handTracker && this.handTracker.isTracking) {
      this.speed = 18; // Increased from 13 so it matches the running animation and doesn't look like moonwalking
      this.currentAcceleration = 0.18; 
    } else {
      this.speed = CONFIG.INITIAL_SPEED;
      this.currentAcceleration = CONFIG.ACCELERATION;
    }
  }

  startGame() {
    if (this.handTracker) this.handTracker.isGameOver = false;
    this.startZ = this.playerGroup.position.z;
    this.distance = 0;
    this.playerGroup.rotation.set(0, 0, 0);
    this.startScreen.classList.add('hidden');
    this.applySpeedSettings();
    this.playCinematicIntro();
  }

  restartGame() {
    this.gameState = 'PLAYING';
    if (this.handTracker) this.handTracker.isGameOver = false;

    this.gameOverScreen.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.distance = 0;
    this.coins = 0;

    this.applySpeedSettings();
    
    this.currentLane = 1;
    this.isJumping = false;
    this.isSliding = false;

    this.playerGroup.position.set(CONFIG.LANES[1], 0, 0);
    this.playerGroup.rotation.set(0, 0, 0);
    this.playerGroup.scale.set(1, 1, 1);
    this.startZ = 0;

    if (this.xbotMesh) {
      this.xbotMesh.rotation.set(0, Math.PI, 0);
    }

    if (this.coinsDisplay) this.coinsDisplay.textContent = '0';
    if (this.scoreDisplay) this.scoreDisplay.innerHTML = `0<small>m</small>`;

    if (this.obstacleManager) this.obstacleManager.reset();
    if (this.trackManager) this.trackManager.reset();

    // Properly cross-fade from Idle to Run when restarting
    if (this.actions && this.actions.run) {
      if (this.currentAction) this.currentAction.fadeOut(0.2);
      this.actions.run.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
      this.currentAction = this.actions.run;
    }

    this.clock.start();
  }

  onCollectCoin() {
    this.coins += 1;
    if (this.coinsDisplay) {
      this.coinsDisplay.textContent = this.coins;
    }

    const coinCard = document.querySelector('.coins-card');
    if (coinCard) {
      gsap.fromTo(coinCard, 
        { scale: 1.2 }, 
        { scale: 1, duration: 0.25, ease: 'back.out(2)' }
      );
    }
  }

  onHitObstacle() {
    if (this.gameState === 'GAMEOVER') return;

    this.gameState = 'GAMEOVER';
    if (this.handTracker) this.handTracker.isGameOver = true;

    if (this.jumpTimeline) this.jumpTimeline.kill();
    if (this.slideTimeline) this.slideTimeline.kill();
    if (this.laneTween) this.laneTween.kill();

    // Transition back to idle when game ends
    gsap.to(this.playerGroup.rotation, { x: 0, y: 0, z: 0, duration: 0.2 });
    gsap.to(this.playerGroup.position, { y: 0, z: this.playerGroup.position.z, duration: 0.2 });
    
    if (this.actions.idle) {
      if (this.currentAction && this.currentAction !== this.actions.idle) {
        this.currentAction.fadeOut(0.2);
      }
      this.actions.idle.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
      this.currentAction = this.actions.idle;
    }

    if (this.distance > this.highScore) {
      this.highScore = this.distance;
      localStorage.setItem('cyberrunner_highscore', this.highScore.toString());
    }

    if (this.finalScore) this.finalScore.textContent = `${this.distance}m`;
    if (this.finalCoins) this.finalCoins.textContent = `${this.coins}`;
    if (this.finalHighScore) this.finalHighScore.textContent = `${this.highScore}m`;

    setTimeout(() => {
      this.hud.classList.add('hidden');
      this.gameOverScreen.classList.remove('hidden');
    }, 600);
  }

  /**
   * Temple Run–style cinematic intro.
   * Camera starts at Neo's face level, then sweeps up and back to game position.
   * State is 'CINEMATIC' during this — physics are paused, camera follow is off.
   */
  playCinematicIntro() {
    this.gameState = 'CINEMATIC';

    // Camera starts at Neo's face level, close and in front
    const pz = this.playerGroup.position.z;
    this.camera.position.set(0, 2.0, pz + 3.8);
    this._lookAtTarget.set(0, 1.5, pz);
    this.camera.lookAt(this._lookAtTarget);

    const destZ = pz + CONFIG.CAMERA_OFFSET.z;
    const destY = CONFIG.CAMERA_OFFSET.y;

    const tl = gsap.timeline({
      onComplete: () => {
        this.gameState = 'PLAYING';
        if (this.actions.run) {
          if (this.currentAction) this.currentAction.fadeOut(0.2);
          this.actions.run.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
          this.currentAction = this.actions.run;
        }

        this.hud.classList.remove('hidden');
        this.clock.start();
      },
    });

    // Act 1 — Hold close-up on Neo (1.2 s)
    tl.to({}, { duration: 1.2 });

    // Act 2 — Temple Run swoop: camera arcs UP and BACK (2.0 s)
    tl.to(this.camera.position, {
      y: destY,
      z: destZ,
      duration: 2.0,
      ease: 'power2.inOut',
      onUpdate: () => {
        this._lookAtTarget.set(0, 1.5, this.playerGroup.position.z - 5);
        this.camera.lookAt(this._lookAtTarget);
      },
    });

    // Act 3 — Settle (0.5 s)
    tl.to({}, { duration: 0.5 });
  }

  createMatrixRain() {
    // Reduced from 2000 down to 400 to completely eliminate CPU lag loop
    const count = 400;
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 100;
      positions[i * 3 + 1] = Math.random() * 40;
      positions[i * 3 + 2] = -(Math.random() * 200);
      speeds[i] = 10 + Math.random() * 15;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0x00ff66,
      size: 0.35, // increased size to make up for fewer particles
      transparent: true,
      opacity: 0.7,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.matrixRain = new THREE.Points(geo, mat);
    this.matrixRain.userData.speeds = speeds;
    this.scene.add(this.matrixRain);
  }

  /**
   * Updates the rain particles every frame.
   * Respawns each particle at the top when it hits y = -1,
   * scattered ahead of the player along Z.
   */
  updateMatrixRain(delta) {
    if (!this.matrixRain || !this.playerGroup) return;
    const pos    = this.matrixRain.geometry.attributes.position;
    const speeds = this.matrixRain.userData.speeds;
    const pz     = this.playerGroup.position.z;

    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) - speeds[i] * delta;
      if (ny < -1) {
        pos.setY(i, 28 + Math.random() * 14);
        pos.setX(i, (Math.random() - 0.5) * 80);
        pos.setZ(i, pz - Math.random() * 260);
      } else {
        pos.setY(i, ny);
      }
    }
    pos.needsUpdate = true;
  }

  /**
   * Main Render & Physics Loop
   */
  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = Math.min(this.clock.getDelta(), 0.1);

    if (this.mixer) {
      // Clamp animation speed to 0.8x minimum so it never looks like slow-motion lag
      const animMultiplier = Math.max(0.8, this.speed / CONFIG.INITIAL_SPEED);
      this.mixer.update(delta * animMultiplier);
    }

    // Matrix rain falls at all times except the menu
    // if (this.gameState !== 'MENU') {
    //   this.updateMatrixRain(delta);
    // }

    if (this.gameState === 'PLAYING') {
      if (!this.isSliding) {
        this.playerGroup.rotation.set(0, 0, 0);
      }

      // 1. Forward continuous acceleration
      if (this.speed < CONFIG.MAX_SPEED) {
        this.speed += this.currentAcceleration * delta;
      }

      // 2. Player forward motion along Z
      this.playerGroup.position.z -= this.speed * delta;

      // 3. Accurate continuous running distance meter calculation
      this.distance = Math.floor(Math.abs(this.playerGroup.position.z - this.startZ));
      if (this.scoreDisplay) {
        this.scoreDisplay.innerHTML = `${this.distance}<small>m</small>`;
      }
      if (this.speedDisplay) {
        const speedMultiplier = (this.speed / CONFIG.INITIAL_SPEED).toFixed(1);
        this.speedDisplay.innerHTML = `${speedMultiplier}<small>x</small>`;
      }

      // 4. Track Generation Update
      if (this.trackManager) {
        this.trackManager.update(this.playerGroup.position.z);
      }

      // 6. Obstacles & Coins Rotation
      if (this.obstacleManager) {
        this.obstacleManager.update(delta);

        // 7. AABB Collisions
        this.obstacleManager.checkCollisions(
          this.playerGroup,
          this.isJumping,
          this.isSliding,
          () => this.onCollectCoin(),
          (obstacle) => this.onHitObstacle(obstacle)
        );
      }
    }

    // 7. Butter-smooth, zero-jitter camera follow system (paused during cinematic)
    if (this.playerGroup && this.camera && this.gameState !== 'CINEMATIC') {
      const targetX = this.playerGroup.position.x * 0.35;
      const targetY = CONFIG.CAMERA_OFFSET.y + Math.max(0, this.playerGroup.position.y * 0.4);
      const targetZ = this.playerGroup.position.z + CONFIG.CAMERA_OFFSET.z;

      const dampingX = 1 - Math.exp(-12 * delta);
      const dampingY = 1 - Math.exp(-8 * delta);
      const dampingZ = 1 - Math.exp(-15 * delta); // New Z-damping for buttery smooth forward motion

      this.camera.position.x += (targetX - this.camera.position.x) * dampingX;
      this.camera.position.y += (targetY - this.camera.position.y) * dampingY;
      
      // Smoothly interpolate Z to absorb any delta-time micro-stutters
      if (!this.camera.position.z) this.camera.position.z = targetZ;
      this.camera.position.z += (targetZ - this.camera.position.z) * dampingZ;

      // Reuse scratch vector — avoids per-frame heap allocation
      this._lookAtTarget.set(
        this.camera.position.x * 0.3,
        1.5 + Math.max(0, this.playerGroup.position.y * 0.2),
        this.playerGroup.position.z - 12
      );
      this.camera.lookAt(this._lookAtTarget);

      // dirLight is static — no per-frame update needed (avoids shadow re-render spike)
    }

    // Animate character holographic material pulsating
    if (this.playerHoloMat) {
      this.playerHoloMat.emissiveIntensity = 0.5 + Math.sin(Date.now() * 0.005) * 0.4;
    }

    this.renderer.render(this.scene, this.camera);
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

// Bootstrap Game on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
  new CyberRunnerGame();
});
