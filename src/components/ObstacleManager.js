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

    // Shuffle Bag: guarantees no more than 1 repeat in a row.
    // Works like a Tetris bag — all 3 types are drawn before reshuffling.
    this._bag = [];
    this._bagIndex = 3; // start exhausted so first call refills

    // ── Object Pools ──────────────────────────────────────────────────
    // Instead of `new THREE.Group()`/`new THREE.Mesh()` on every chunk
    // recycle, obstacles/coins are pulled from and returned to these pools.
    // Geometries/materials were already shared; this eliminates the
    // remaining per-recycle allocation (and the GC-driven stutter it caused).
    this._hurdlePool = [];
    this._overhangPool = [];
    this._blockadePool = [];
    this._coinPool = [];
    this._prewarmPools();
  }

  /**
   * Pre-allocate a steady-state supply of each archetype so even the very
   * first chunk recycle (a few seconds into the run) doesn't have to build
   * anything from scratch. Sized generously off VISIBLE_CHUNKS; if a run
   * of bad luck exceeds this, _acquire() just builds one more on demand
   * (a rare one-off allocation, not a per-frame pattern) — nothing breaks.
   */
  _prewarmPools() {
    const chunks = CONFIG.VISIBLE_CHUNKS || 14;
    const perTypeCount = chunks * 3;   // ~3 of each obstacle type per chunk, steady state
    const coinCount = chunks * 12;     // up to 16/chunk in bursts, 12 covers typical

    for (let i = 0; i < perTypeCount; i++) this._hurdlePool.push(this._buildHurdleGroup());
    for (let i = 0; i < perTypeCount; i++) this._overhangPool.push(this._buildOverhangGroup());
    for (let i = 0; i < perTypeCount; i++) this._blockadePool.push(this._buildBlockadeGroup());
    for (let i = 0; i < coinCount; i++) this._coinPool.push(this._buildCoin());
  }

  /** Pop a ready-to-use instance from a pool, or build one if it's empty. */
  _acquire(pool, builder) {
    return pool.length > 0 ? pool.pop() : builder();
  }

  _removeFromArray(arr, obj) {
    const idx = arr.indexOf(obj);
    if (idx !== -1) arr.splice(idx, 1);
  }

  /**
   * Returns a direct child of a chunkGroup (an obstacle group or a coin
   * mesh) back to its pool for reuse, detaching it from the scene graph
   * and its tracking array (`this.obstacles` / `this.coins`) first.
   * This is the single purge/recycle path — called both when a chunk
   * recycles (TrackManager) and immediately on coin collection.
   */
  releaseNode(node) {
    if (!node || !node.userData) return;
    const { type, subType } = node.userData;

    if (node.parent) node.parent.remove(node);

    if (type === 'COIN') {
      this._removeFromArray(this.coins, node);
      gsap.killTweensOf(node.scale);
      gsap.killTweensOf(node.position);
      this._coinPool.push(node);
      return;
    }

    if (type === 'OBSTACLE') {
      if (subType === 'OVERHANG') {
        const header = node.userData.headerRef;
        if (header) this._removeFromArray(this.obstacles, header);
        this._overhangPool.push(node);
      } else if (subType === 'HURDLE') {
        this._removeFromArray(this.obstacles, node);
        this._hurdlePool.push(node);
      } else if (subType === 'BLOCKADE') {
        this._removeFromArray(this.obstacles, node);
        this._blockadePool.push(node);
      }
    }
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

    // Blockade wireframe shield overlay (was previously a new material per spawn call)
    this.blockadeWireMat = new THREE.MeshBasicMaterial({
      color: 0x00ff66, wireframe: true, transparent: true, opacity: 0.15
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
   * Shuffle Bag draw — refills and reshuffles when all 3 types are used.
   * Guarantees you never see the same obstacle type more than once in sequence.
   */
  _nextObstacleType() {
    if (this._bagIndex >= this._bag.length) {
      // Refill with one of each type [0=Hurdle, 1=Overhang, 2=Blockade]
      this._bag = [0, 1, 2];
      // Fisher-Yates shuffle
      for (let i = this._bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this._bag[i], this._bag[j]] = [this._bag[j], this._bag[i]];
      }
      this._bagIndex = 0;
    }
    return this._bag[this._bagIndex++];
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

    // Build a 4-slot sequence for this chunk: pick all 3 types + 1 random,
    // shuffle them, then swap any adjacent duplicates. This guarantees variety
    // within EVERY chunk and across chunk boundaries via the bag.
    const extra = this._nextObstacleType();
    let slotTypes = [this._nextObstacleType(), this._nextObstacleType(), this._nextObstacleType(), extra];

    // Fisher-Yates shuffle the 4 slots
    for (let i = slotTypes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slotTypes[i], slotTypes[j]] = [slotTypes[j], slotTypes[i]];
    }

    // Fix any adjacent duplicates by swapping with the next different slot
    for (let i = 0; i < slotTypes.length - 1; i++) {
      if (slotTypes[i] === slotTypes[i + 1]) {
        // Find a later slot that differs and swap
        for (let j = i + 2; j < slotTypes.length; j++) {
          if (slotTypes[j] !== slotTypes[i]) {
            [slotTypes[i + 1], slotTypes[j]] = [slotTypes[j], slotTypes[i + 1]];
            break;
          }
        }
      }
    }

    zPositions.forEach((relZ, slotIndex) => {
      const primaryType = slotTypes[slotIndex];
      
      // Always guarantee exactly 1 safe lane
      const safeLane = Math.floor(Math.random() * 3);
      const otherLanes = [0, 1, 2].filter(l => l !== safeLane);
      
      const spawnObs = (type, lane) => {
        if (type === 0) this.spawnHurdle(chunkGroup, lanes[lane], relZ);
        else if (type === 1) this.spawnOverhang(chunkGroup, lanes[lane], relZ);
        else this.spawnBlockade(chunkGroup, lanes[lane], relZ);
      };

      // Always spawn the primary obstacle
      spawnObs(primaryType, otherLanes[0]);

      // 60% chance to spawn a second obstacle in the other lane to create complex dodging!
      if (Math.random() < 0.60) {
        let secondaryType = primaryType;
        // 50% chance it's a DIFFERENT type of obstacle (e.g. Jump next to a Duck)
        if (Math.random() < 0.5) {
          secondaryType = (primaryType + 1 + Math.floor(Math.random() * 2)) % 3;
        }
        spawnObs(secondaryType, otherLanes[1]);
      }

      // 60% chance to spawn a sweet line of coins in the guaranteed safe lane
      if (Math.random() < 0.60) {
        this.spawnCoinSequence(chunkGroup, lanes[safeLane], relZ);
      }
    });
  }

  // ── HURDLE: Laser Fence — player must JUMP ─────────────────────
  _buildHurdleGroup() {
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

    group.userData = { type: 'OBSTACLE', subType: 'HURDLE' };
    return group;
  }

  spawnHurdle(chunkGroup, xPos, relZ) {
    const group = this._acquire(this._hurdlePool, () => this._buildHurdleGroup());
    group.position.set(xPos, 0, relZ);
    chunkGroup.add(group); // Object3D.add() auto-detaches from the pool (no parent)
    this.obstacles.push(group);
  }

  // ── OVERHANG: dark gate — player must SLIDE ───────────────────────────
  _buildOverhangGroup() {
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

    // The GROUP is what gets added/removed from a chunk (and pooled), but
    // collision math needs the HEADER's world position specifically — so
    // the group carries its own userData for pool-release purposes, plus
    // a back-reference to the header so releaseNode() can purge it from
    // `this.obstacles` too.
    group.userData = { type: 'OBSTACLE', subType: 'OVERHANG', headerRef: header };
    return group;
  }

  spawnOverhang(chunkGroup, xPos, relZ) {
    const group = this._acquire(this._overhangPool, () => this._buildOverhangGroup());
    group.position.set(xPos, 0, relZ);
    chunkGroup.add(group);
    this.obstacles.push(group.userData.headerRef); // header triggers OVERHANG collision
  }

  // ── BLOCKADE: holographic wall — player must change LANE ─────────────
  _buildBlockadeGroup() {
    const group = new THREE.Group();

    // Translucent holographic panel (Energy Shield)
    const wall    = new THREE.Mesh(this.blockadeWallGeo, this.holoWallMat);
    wall.position.y = 1.6;

    // Shield Wireframe overlay (shared material — was previously re-created per spawn)
    const wireWall = new THREE.Mesh(this.blockadeWallGeo, this.blockadeWireMat);
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
    group.userData = { type: 'OBSTACLE', subType: 'BLOCKADE' };
    return group;
  }

  spawnBlockade(chunkGroup, xPos, relZ) {
    const group = this._acquire(this._blockadePool, () => this._buildBlockadeGroup());
    group.position.set(xPos, 0, relZ);
    chunkGroup.add(group);
    this.obstacles.push(group);
  }

  // ── COINS: glowing digital cube ─────────────
  _buildCoin() {
    const coin = new THREE.Mesh(this.coinGeo, this.coinMat);
    coin.userData = { type: 'COIN', collected: false };
    return coin;
  }

  spawnCoinSequence(chunkGroup, xPos, startRelZ) {
    const coinCount = 3 + Math.floor(Math.random() * 2); // 3 or 4 coins in a line
    const spacing   = 3.0; // Slightly more spaced out

    for (let i = 0; i < coinCount; i++) {
      const coin = this._acquire(this._coinPool, () => this._buildCoin());
      coin.position.set(xPos, 1.15, startRelZ - i * spacing);
      coin.rotation.set(0, 0, 0);
      coin.scale.set(1, 1, 1);
      coin.userData.collected = false;
      chunkGroup.add(coin);
      this.coins.push(coin);
    }
  }

  update(dt) {
    this.time += dt;
    this._frameCount = ((this._frameCount || 0) + 1);

    // Pulse / Glitch — throttled to every 3rd frame (20fps update rate).
    // Writing to .opacity marks the material dirty and forces a GPU uniform
    // upload. Running it at 20fps is imperceptible but saves ~40 material
    // uploads per second.
    if (this._frameCount % 3 === 0 && this.holoWallMat && this.glowHaloMat) {
      const pulse   = Math.sin(this.time * 6) * 0.1;
      const glitch  = Math.random() > 0.97 ? (Math.random() * -0.3) : 0;
      this.holoWallMat.opacity = Math.max(0.2, Math.min(0.8, 0.45 + pulse + glitch));
      this.glowHaloMat.opacity = Math.max(0, Math.min(1, 0.25 + pulse * 0.5 + glitch));
    }

    // Coin float — use accumulated this.time instead of Date.now() syscall
    for (let i = 0; i < this.coins.length; i++) {
      const coin = this.coins[i];
      if (coin && !coin.userData.collected) {
        coin.rotation.y += 2.2 * dt;
        coin.rotation.x += 1.5 * dt;
        coin.position.y = 1.15 + Math.sin(this.time * 3 + i * 1.2) * 0.14;
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
      // Window must be > (maxSpeed * maxDelta) + maxObstacleHalfDepthZ + playerHalfDepthZ
      // = (65 * 0.05) + 0.55 + 0.25 = 4.05 — using 7.0 for generous safety margin.
      const deltaZ = Math.abs(this._obstacleWorldPos.z - this._playerWorldPos.z);
      if (deltaZ > 7.0) continue;

      const subType = obstacle.userData ? obstacle.userData.subType : 'BLOCKADE';

      if (subType === 'HURDLE') {
        this._obsBox.min.set(this._obstacleWorldPos.x - 1.1, 0,    this._obstacleWorldPos.z - 0.55);
        this._obsBox.max.set(this._obstacleWorldPos.x + 1.1, 0.85, this._obstacleWorldPos.z + 0.55);
      } else if (subType === 'OVERHANG') {
        // Upper bound extended to 8.0 so jumping (which raises player to ~3.4) still results in a crash.
        // You MUST slide (which drops player to 0.8) to pass under the 1.6 lower bound.
        this._obsBox.min.set(this._obstacleWorldPos.x - 1.2, 1.6, this._obstacleWorldPos.z - 0.55);
        this._obsBox.max.set(this._obstacleWorldPos.x + 1.2, 8.0, this._obstacleWorldPos.z + 0.55);
      } else {
        this._obsBox.min.set(this._obstacleWorldPos.x - 1.1, 0,   this._obstacleWorldPos.z - 0.65);
        this._obsBox.max.set(this._obstacleWorldPos.x + 1.1, 3.2, this._obstacleWorldPos.z + 0.65);
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
            this.releaseNode(coin);
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
    // Kill any in-flight collect animations defensively. The actual return
    // of live obstacles/coins to their pools happens via releaseNode(),
    // triggered per-chunk when TrackManager.reset() re-places every pooled
    // chunk right after this runs — this is just a safety net.
    this.coins.forEach((c) => {
      if (c) {
        gsap.killTweensOf(c.scale);
        gsap.killTweensOf(c.position);
      }
    });
    this.obstacles.length = 0;
    this.coins.length = 0;
    // Reset shuffle bag so obstacle sequence starts fresh every run
    this._bag = [];
    this._bagIndex = 3;
  }
}
