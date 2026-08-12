import * as THREE from 'three';
import gsap from 'gsap';
import { CONFIG } from '../main.js';

export class ObstacleManager {
  constructor(scene) {
    this.scene = scene;
    this.obstacles = [];
    this.coins = [];

    // Reusable Geometries & Materials
    this.initSharedResources();

    // Scratch vectors/boxes reused every frame in checkCollisions() —
    // avoids allocating a new Vector3 per obstacle/coin per frame (GC churn -> stutter)
    this._playerWorldPos = new THREE.Vector3();
    this._obstacleWorldPos = new THREE.Vector3();
    this._coinWorldPos = new THREE.Vector3();
    this._playerBoxMin = new THREE.Vector3();
    this._playerBoxMax = new THREE.Vector3();
    this._playerBox = new THREE.Box3(this._playerBoxMin, this._playerBoxMax);
    this._obsBox = new THREE.Box3();
    
    this.time = 0;
  }

  initSharedResources() {
    // ── Shared Matrix materials ─────────────────────────────────────────

    // Neon energy beam core (hurdle bar)
    this.energyBeamMat = new THREE.MeshStandardMaterial({
      color: 0x00ff66, emissive: 0x00ff66, emissiveIntensity: 4.0,
      transparent: true, opacity: 0.95, metalness: 0, roughness: 0,
      depthWrite: false,
    });

    // Dark server-rack metal (posts, pillars)
    this.metalFrameMat = new THREE.MeshStandardMaterial({
      color: 0x0a1a0f, emissive: 0x003311, emissiveIntensity: 0.4,
      metalness: 0.9, roughness: 0.25,
    });

    // Holographic blockade wall (glassy neon)
    this.holoWallMat = new THREE.MeshStandardMaterial({
      color: 0x00ff66, emissive: 0x00ff66, emissiveIntensity: 0.4,
      metalness: 0.9, roughness: 0.1,
      transparent: true, opacity: 0.85, depthWrite: false,
    });

    // Bright glowing frame edges
    this.glowFrameMat = new THREE.MeshStandardMaterial({
      color: 0x00ff66, emissive: 0x00ff66, emissiveIntensity: 5.0,
      metalness: 0, roughness: 0,
    });

    // Amber warning stripe on overhang bottom (signals DUCK)
    this.warnStripeMat = new THREE.MeshStandardMaterial({
      color: 0xff6600, emissive: 0xff4400, emissiveIntensity: 2.5,
      metalness: 0.2, roughness: 0.1,
    });

    // Soft outer halo (hurdle glow bloom)
    this.glowHaloMat = new THREE.MeshStandardMaterial({
      color: 0x00ff66, emissive: 0x00ff66, emissiveIntensity: 1.2,
      transparent: true, opacity: 0.35, depthWrite: false,
    });

    // Scan-line material (blockade interior lines)
    this.scanLineMat = new THREE.MeshStandardMaterial({
      color: 0x00ff66, emissive: 0x00ff66, emissiveIntensity: 3.0,
      transparent: true, opacity: 0.45, depthWrite: false,
    });

    // ── Coin: Glowing digital data cube ────────────────────────
    this.coinGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    this.coinMat = new THREE.MeshStandardMaterial({
      color: 0x00ffaa, emissive: 0x00ff66, emissiveIntensity: 2.0,
      metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.9,
    });

    // ── Shared Geometries ──────────────────────────────────────────
    this.hurdlePostGeo = new THREE.BoxGeometry(0.2, 1.0, 0.2);
    this.hurdleBeamGeo = new THREE.BoxGeometry(2.3, 0.05, 0.05);

    this.overhangPillarGeo = new THREE.BoxGeometry(0.22, 3.5, 0.3);
    this.overhangHeaderGeo = new THREE.BoxGeometry(3.0, 0.55, 0.4);
    this.overhangStripeGeo = new THREE.BoxGeometry(3.0, 0.07, 0.44);
    this.overhangCapGeo = new THREE.BoxGeometry(0.25, 0.07, 0.33);

    this.blockadeWallGeo = new THREE.BoxGeometry(2.4, 3.2, 0.1);
    this.blockadeFTopGeo = new THREE.BoxGeometry(2.5, 0.2, 0.2);
    this.blockadeFSideGeo = new THREE.BoxGeometry(0.2, 3.2, 0.2);
    this.blockadeScanGeo = new THREE.BoxGeometry(2.3, 0.05, 0.15);
  }

  /**
   * Spawns obstacles and coins onto a track chunk.
   * 4 spawn slots per chunk, each guaranteed to have an obstacle OR a coin run.
   */
  populateChunk(chunkGroup, isFirstChunk) {
    if (isFirstChunk) return;

    const chunkLength = CONFIG.TRACK_CHUNK_LENGTH;
    const lanes = CONFIG.LANES;

    let zPositions = [
      -chunkLength * 0.38,
      -chunkLength * 0.13,
       chunkLength * 0.13,
       chunkLength * 0.38,
    ];

    zPositions.forEach((relZ) => {
      const obstacleType = Math.floor(Math.random() * 3);
      const blockedLanes = new Set();

      if (obstacleType === 0) {
        const lane = Math.floor(Math.random() * 3);
        blockedLanes.add(lane);
        this.spawnHurdle(chunkGroup, lanes[lane], relZ);
      } else if (obstacleType === 1) {
        const lane = Math.floor(Math.random() * 3);
        blockedLanes.add(lane);
        this.spawnOverhang(chunkGroup, lanes[lane], relZ);
      } else {
        const openLane = Math.floor(Math.random() * 3);
        for (let l = 0; l < 3; l++) {
          if (l !== openLane) {
            blockedLanes.add(l);
            this.spawnBlockade(chunkGroup, lanes[l], relZ);
          }
        }
      }

      const safeLanes = [0, 1, 2].filter((l) => !blockedLanes.has(l));
      if (safeLanes.length > 0) {
        const coinLane = safeLanes[Math.floor(Math.random() * safeLanes.length)];
        this.spawnCoinSequence(chunkGroup, lanes[coinLane], relZ);
      }
    });
  }

  // ── HURDLE: Laser Fence — player must JUMP ─────────────────────
  spawnHurdle(chunkGroup, xPos, relZ) {
    const group = new THREE.Group();

    // Sturdier vertical side posts (Monolith style)
    const postL   = new THREE.Mesh(this.hurdlePostGeo, this.metalFrameMat);
    const postR   = new THREE.Mesh(this.hurdlePostGeo, this.metalFrameMat);
    postL.position.set(-1.15, 0.5, 0);
    postR.position.set( 1.15, 0.5, 0);
    postL.castShadow = postR.castShadow = true;

    group.add(postL, postR);

    // Multiple thin laser beams
    for(let i=0; i<3; i++) {
      const beam = new THREE.Mesh(this.hurdleBeamGeo, this.energyBeamMat);
      beam.position.set(0, 0.6 + i*0.2, 0);
      
      const halo = new THREE.Mesh(this.hurdleBeamGeo, this.glowHaloMat);
      halo.scale.set(1, 4, 4);
      halo.position.copy(beam.position);
      
      group.add(beam, halo);
    }

    group.position.set(xPos, 0, relZ);
    group.userData = { type: 'OBSTACLE', subType: 'HURDLE' };
    chunkGroup.add(group);
    this.obstacles.push(group);
  }

  // ── OVERHANG: dark gate — player must SLIDE ───────────────────────────
  spawnOverhang(chunkGroup, xPos, relZ) {
    const group = new THREE.Group();

    // Tall side pillars
    const pillarL   = new THREE.Mesh(this.overhangPillarGeo, this.metalFrameMat);
    const pillarR   = new THREE.Mesh(this.overhangPillarGeo, this.metalFrameMat);
    pillarL.position.set(-1.35, 1.75, 0);
    pillarR.position.set( 1.35, 1.75, 0);
    pillarL.castShadow = pillarR.castShadow = true;

    // Heavy overhead header (the thing player hits if standing)
    const header    = new THREE.Mesh(this.overhangHeaderGeo, this.metalFrameMat);
    header.position.set(0, 3.28, 0);
    header.castShadow = true;
    header.userData   = { type: 'OBSTACLE', subType: 'OVERHANG' };

    // Amber warning stripe on bottom of header — signals DUCK
    const stripe    = new THREE.Mesh(this.overhangStripeGeo, this.warnStripeMat);
    stripe.position.set(0, 3.01, 0);

    // Green caps on top of each pillar
    const capL   = new THREE.Mesh(this.overhangCapGeo, this.glowFrameMat);
    const capR   = new THREE.Mesh(this.overhangCapGeo, this.glowFrameMat);
    capL.position.set(-1.35, 3.52, 0);
    capR.position.set( 1.35, 3.52, 0);

    group.add(pillarL, pillarR, header, stripe, capL, capR);
    group.position.set(xPos, 0, relZ);
    chunkGroup.add(group);
    this.obstacles.push(header); // header triggers OVERHANG collision
  }

  // ── BLOCKADE: holographic wall — player must change LANE ─────────────
  spawnBlockade(chunkGroup, xPos, relZ) {
    const group = new THREE.Group();

    // Translucent holographic panel (Energy Shield)
    const wall    = new THREE.Mesh(this.blockadeWallGeo, this.holoWallMat);
    wall.position.y = 1.6;

    // Shield Wireframe overlay
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x00ff66, wireframe: true, transparent: true, opacity: 0.15 });
    const wireWall = new THREE.Mesh(this.blockadeWallGeo, wireMat);
    wireWall.position.copy(wall.position);
    wireWall.scale.set(1.01, 1.01, 1.01);

    // Sturdy Metallic Frame
    const frameTop = new THREE.Mesh(this.blockadeFTopGeo,  this.metalFrameMat);
    const frameBot = new THREE.Mesh(this.blockadeFTopGeo,  this.metalFrameMat);
    const frameL   = new THREE.Mesh(this.blockadeFSideGeo, this.metalFrameMat);
    const frameR   = new THREE.Mesh(this.blockadeFSideGeo, this.metalFrameMat);
    frameTop.position.set(0, 3.3, 0);
    frameBot.position.set(0,  0.0, 0);
    frameL.position.set(-1.25, 1.6, 0);
    frameR.position.set( 1.25, 1.6, 0);

    // Warning / Glitching scanlines
    const scan1   = new THREE.Mesh(this.blockadeScanGeo, this.glowFrameMat);
    const scan2   = new THREE.Mesh(this.blockadeScanGeo, this.glowFrameMat);
    scan1.position.set(0, 2.4, 0);
    scan2.position.set(0, 0.8, 0);

    group.add(wall, wireWall, frameTop, frameBot, frameL, frameR, scan1, scan2);
    group.position.set(xPos, 0, relZ);
    group.userData = { type: 'OBSTACLE', subType: 'BLOCKADE' };
    chunkGroup.add(group);
    this.obstacles.push(group);
  }

  // ── COINS: glowing digital cube ─────────────
  spawnCoinSequence(chunkGroup, xPos, startRelZ) {
    const coinCount = 3 + Math.floor(Math.random() * 3);
    const spacing   = 2.5;

    for (let i = 0; i < coinCount; i++) {
      const coin = new THREE.Mesh(this.coinGeo, this.coinMat);
      coin.position.set(xPos, 1.15, startRelZ - i * spacing);
      coin.userData = { type: 'COIN', collected: false, idx: i };
      chunkGroup.add(coin);
      this.coins.push(coin);
    }
  }

  update(dt) {
    this.time += dt;

    // Pulse / Glitch effect on the obstacle materials
    if (this.holoWallMat && this.glowHaloMat) {
      // Base pulse
      const pulse = Math.sin(this.time * 6) * 0.1;
      
      // Random glitch
      const glitch = Math.random() > 0.95 ? (Math.random() * -0.3) : 0;
      
      this.holoWallMat.opacity = Math.max(0.2, Math.min(0.8, 0.45 + pulse + glitch));
      this.glowHaloMat.opacity = Math.max(0, Math.min(1, 0.25 + pulse * 0.5 + glitch));
    }

    const t = Date.now() * 0.003;
    for (let i = 0; i < this.coins.length; i++) {
      const coin = this.coins[i];
      if (coin && !coin.userData.collected) {
        coin.rotation.y += 2.2 * dt;
        coin.rotation.x += 1.5 * dt;
        // Gentle float
        coin.position.y = 1.15 + Math.sin(t + i * 1.2) * 0.14;
      }
    }
  }


  /**
   * Tight AABB Collision Detection per Lane
   */
  checkCollisions(playerGroup, isJumping, isSliding, onCoinCollect, onObstacleHit) {
    playerGroup.getWorldPosition(this._playerWorldPos);

    // Tight Player Bounding Box
    const halfWidth = 0.28;
    const halfDepth = 0.25;
    const minY = this._playerWorldPos.y;
    const maxY = this._playerWorldPos.y + (isSliding ? 0.8 : 2.2);

    this._playerBoxMin.set(this._playerWorldPos.x - halfWidth, minY, this._playerWorldPos.z - halfDepth);
    this._playerBoxMax.set(this._playerWorldPos.x + halfWidth, maxY, this._playerWorldPos.z + halfDepth);
    this._playerBox.set(this._playerBoxMin, this._playerBoxMax);

    // 1. Check Obstacle Collisions
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const obstacle = this.obstacles[i];
      if (!obstacle || !obstacle.parent) {
        this.obstacles.splice(i, 1);
        continue;
      }

      obstacle.getWorldPosition(this._obstacleWorldPos);

      // Proximity pre-check: skip if far away in Z.
      const deltaZ = Math.abs(this._obstacleWorldPos.z - this._playerWorldPos.z);
      if (deltaZ > 4.0) continue;

      const subType = obstacle.userData ? obstacle.userData.subType : 'BLOCKADE';

      if (subType === 'HURDLE') {
        this._obsBox.min.set(this._obstacleWorldPos.x - 1.1, 0,    this._obstacleWorldPos.z - 0.3);
        this._obsBox.max.set(this._obstacleWorldPos.x + 1.1, 0.85, this._obstacleWorldPos.z + 0.3);
      } else if (subType === 'OVERHANG') {
        this._obsBox.min.set(this._obstacleWorldPos.x - 1.2, 1.6, this._obstacleWorldPos.z - 0.4);
        this._obsBox.max.set(this._obstacleWorldPos.x + 1.2, 3.2, this._obstacleWorldPos.z + 0.4);
      } else {
        this._obsBox.min.set(this._obstacleWorldPos.x - 1.1, 0,   this._obstacleWorldPos.z - 0.5);
        this._obsBox.max.set(this._obstacleWorldPos.x + 1.1, 3.2, this._obstacleWorldPos.z + 0.5);
      }

      if (this._playerBox.intersectsBox(this._obsBox)) {
        onObstacleHit(obstacle);
        return;
      }
    }

    // 2. Check Coin Collisions
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const coin = this.coins[i];
      if (!coin || coin.userData.collected || !coin.parent) continue;

      coin.getWorldPosition(this._coinWorldPos);

      if (Math.abs(this._coinWorldPos.z - this._playerWorldPos.z) > 1.8) continue;

      this._obsBox.min.set(this._coinWorldPos.x - 0.6, this._coinWorldPos.y - 0.6, this._coinWorldPos.z - 0.6);
      this._obsBox.max.set(this._coinWorldPos.x + 0.6, this._coinWorldPos.y + 0.6, this._coinWorldPos.z + 0.6);

      if (this._playerBox.intersectsBox(this._obsBox)) {
        coin.userData.collected = true;

        gsap.to(coin.scale, {
          x: 1.8,
          y: 1.8,
          z: 1.8,
          duration: 0.2,
          ease: 'power2.out',
          onComplete: () => {
            if (coin.parent) coin.parent.remove(coin);
          }
        });
        gsap.to(coin.position, {
          y: coin.position.y + 1.5,
          duration: 0.2
        });

        onCoinCollect(coin);
      }
    }
  }

  reset() {
    // Kill any in-flight collect animations before clearing — prevents ghost
    // scale/position tweens firing on recycled coin slots after restart.
    this.coins.forEach((c) => { if (c) gsap.killTweensOf(c); });
    this.obstacles.length = 0;
    this.coins.length = 0;
  }
}
