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
  }

  initSharedResources() {
    // 1. Low Hurdle (Require Jump) - High Contrast Crimson Red
    this.hurdleGeo = new THREE.BoxGeometry(2.4, 0.8, 0.4);
    this.hurdleMat = new THREE.MeshStandardMaterial({
      color: 0xff2244,
      emissive: 0xff1133,
      emissiveIntensity: 0.6,
      metalness: 0.8,
      roughness: 0.2
    });

    // 2. High Overhang (Require Slide) - Vibrant Cyber Amber Orange
    this.overhangTopGeo = new THREE.BoxGeometry(2.6, 1.0, 0.6);
    this.overhangPostGeo = new THREE.BoxGeometry(0.3, 3.2, 0.4);
    this.overhangMat = new THREE.MeshStandardMaterial({
      color: 0xff9900,
      emissive: 0xff7700,
      emissiveIntensity: 0.6,
      metalness: 0.9,
      roughness: 0.1
    });

    // 3. Full Blockade (Require Lane Change) - Electric Cyber Purple
    this.blockadeGeo = new THREE.BoxGeometry(2.4, 3.0, 0.8);
    this.blockadeMat = new THREE.MeshStandardMaterial({
      color: 0x9333ea,
      emissive: 0xa855f7,
      emissiveIntensity: 0.5,
      metalness: 0.8,
      roughness: 0.2
    });

    // 4. Gold Coins - Classic Shiny Pure Gold
    this.coinGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.12, 16);
    this.coinGeo.rotateX(Math.PI / 2); // Orient upright facing player
    this.coinMat = new THREE.MeshStandardMaterial({
      color: 0xffd700,
      emissive: 0xffaa00,
      emissiveIntensity: 0.7,
      metalness: 0.95,
      roughness: 0.1
    });
  }

  /**
   * Spawns obstacles and coins onto a track chunk.
   * 4 spawn slots per chunk, each guaranteed to have an obstacle OR a coin run.
   */
  populateChunk(chunkGroup, isFirstChunk) {
    if (isFirstChunk) return; // Keep starting area safe

    const chunkLength = CONFIG.TRACK_CHUNK_LENGTH;
    const lanes = CONFIG.LANES;

    // 4 evenly-spaced positions along the chunk
    const zPositions = [
      -chunkLength * 0.38,
      -chunkLength * 0.13,
       chunkLength * 0.13,
       chunkLength * 0.38
    ];

    zPositions.forEach((relZ) => {
      // 0=Hurdle, 1=Overhang, 2=Blockade — always pick one (no empty slot)
      const obstacleType = Math.floor(Math.random() * 3);
      const blockedLanes = new Set();

      if (obstacleType === 0) {
        const targetLane = Math.floor(Math.random() * 3);
        blockedLanes.add(targetLane);
        this.spawnHurdle(chunkGroup, lanes[targetLane], relZ);
      } else if (obstacleType === 1) {
        const targetLane = Math.floor(Math.random() * 3);
        blockedLanes.add(targetLane);
        this.spawnOverhang(chunkGroup, lanes[targetLane], relZ);
      } else {
        // Blockade: block 2 lanes, leave 1 open
        const openLane = Math.floor(Math.random() * 3);
        for (let l = 0; l < 3; l++) {
          if (l !== openLane) {
            blockedLanes.add(l);
            this.spawnBlockade(chunkGroup, lanes[l], relZ);
          }
        }
      }

      // Spawn gold coins in an open safe lane
      const safeLanes = [0, 1, 2].filter((l) => !blockedLanes.has(l));
      if (safeLanes.length > 0) {
        const coinLane = safeLanes[Math.floor(Math.random() * safeLanes.length)];
        this.spawnCoinSequence(chunkGroup, lanes[coinLane], relZ);
      }
    });
  }


  spawnHurdle(chunkGroup, xPos, relZ) {
    const hurdle = new THREE.Mesh(this.hurdleGeo, this.hurdleMat);
    hurdle.position.set(xPos, 0.4, relZ);
    hurdle.castShadow = true;
    hurdle.receiveShadow = true;

    hurdle.userData = { type: 'OBSTACLE', subType: 'HURDLE' };
    chunkGroup.add(hurdle);
    this.obstacles.push(hurdle);
  }

  spawnOverhang(chunkGroup, xPos, relZ) {
    const overhangGroup = new THREE.Group();
    overhangGroup.position.set(xPos, 0, relZ);

    const leftPost = new THREE.Mesh(this.overhangPostGeo, this.overhangMat);
    leftPost.position.set(-1.3, 1.6, 0);
    leftPost.castShadow = true;

    const rightPost = new THREE.Mesh(this.overhangPostGeo, this.overhangMat);
    rightPost.position.set(1.3, 1.6, 0);
    rightPost.castShadow = true;

    const topBar = new THREE.Mesh(this.overhangTopGeo, this.overhangMat);
    topBar.position.set(0, 2.7, 0);
    topBar.castShadow = true;
    topBar.userData = { type: 'OBSTACLE', subType: 'OVERHANG' };

    overhangGroup.add(leftPost);
    overhangGroup.add(rightPost);
    overhangGroup.add(topBar);

    chunkGroup.add(overhangGroup);
    this.obstacles.push(topBar);
  }

  spawnBlockade(chunkGroup, xPos, relZ) {
    const blockade = new THREE.Mesh(this.blockadeGeo, this.blockadeMat);
    blockade.position.set(xPos, 1.5, relZ);
    blockade.castShadow = true;
    blockade.receiveShadow = true;

    blockade.userData = { type: 'OBSTACLE', subType: 'BLOCKADE' };
    chunkGroup.add(blockade);
    this.obstacles.push(blockade);
  }

  spawnCoinSequence(chunkGroup, xPos, startRelZ) {
    const coinCount = 3 + Math.floor(Math.random() * 3);
    const spacing = 2.5;

    for (let i = 0; i < coinCount; i++) {
      const coin = new THREE.Mesh(this.coinGeo, this.coinMat);
      coin.position.set(xPos, 1.1, startRelZ - i * spacing);
      coin.castShadow = true;

      coin.userData = { type: 'COIN', collected: false };
      chunkGroup.add(coin);
      this.coins.push(coin);
    }
  }

  update(delta) {
    for (let i = 0; i < this.coins.length; i++) {
      const coin = this.coins[i];
      if (coin && !coin.userData.collected) {
        coin.rotation.y += 3.5 * delta;
      }
    }
  }

  /**
   * Tight AABB Collision Detection per Lane
   */
  checkCollisions(playerGroup, isJumping, isSliding, onCoinCollect, onObstacleHit) {
    const playerWorldPos = new THREE.Vector3();
    playerGroup.getWorldPosition(playerWorldPos);

    // Tight Player Bounding Box
    const halfWidth = 0.28;
    const halfDepth = 0.25;
    const minY = playerWorldPos.y;
    const maxY = playerWorldPos.y + (isSliding ? 0.8 : 2.2);

    const playerBox = new THREE.Box3(
      new THREE.Vector3(playerWorldPos.x - halfWidth, minY, playerWorldPos.z - halfDepth),
      new THREE.Vector3(playerWorldPos.x + halfWidth, maxY, playerWorldPos.z + halfDepth)
    );

    const obsBox = new THREE.Box3();

    // 1. Check Obstacle Collisions
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const obstacle = this.obstacles[i];
      if (!obstacle || !obstacle.parent) {
        this.obstacles.splice(i, 1);
        continue;
      }

      const obstacleWorldPos = new THREE.Vector3();
      obstacle.getWorldPosition(obstacleWorldPos);

      // Proximity pre-check: skip if far away in Z.
      // Window is wide enough that even at max speed (65 m/s, ~1m/frame)
      // the obstacle is detected multiple frames before the player reaches it.
      const deltaZ = Math.abs(obstacleWorldPos.z - playerWorldPos.z);
      if (deltaZ > 4.0) continue;

      const subType = obstacle.userData ? obstacle.userData.subType : 'BLOCKADE';

      if (subType === 'HURDLE') {
        // Low Hurdle: blocked Y 0 → 0.85. Must JUMP to clear.
        obsBox.min.set(obstacleWorldPos.x - 1.1, 0,    obstacleWorldPos.z - 0.3);
        obsBox.max.set(obstacleWorldPos.x + 1.1, 0.85, obstacleWorldPos.z + 0.3);
      } else if (subType === 'OVERHANG') {
        // Overhang beam spans Y 2.2→3.2 visually.
        // Player standing maxY = 2.2 — gap of only 0.05 vs old minY 2.25 caused no collision.
        // Set minY = 1.6 so standing player (maxY 2.2) clearly intersects.
        // Sliding player maxY = 0.8 < 1.6, so slide safely clears it. ✓
        obsBox.min.set(obstacleWorldPos.x - 1.2, 1.6, obstacleWorldPos.z - 0.4);
        obsBox.max.set(obstacleWorldPos.x + 1.2, 3.2, obstacleWorldPos.z + 0.4);
      } else {
        // Full Blockade: full height. Must change LANE.
        obsBox.min.set(obstacleWorldPos.x - 1.1, 0,   obstacleWorldPos.z - 0.5);
        obsBox.max.set(obstacleWorldPos.x + 1.1, 3.2, obstacleWorldPos.z + 0.5);
      }

      if (playerBox.intersectsBox(obsBox)) {
        onObstacleHit(obstacle);
        return;
      }
    }

    // 2. Check Coin Collisions
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const coin = this.coins[i];
      if (!coin || coin.userData.collected || !coin.parent) continue;

      const coinWorldPos = new THREE.Vector3();
      coin.getWorldPosition(coinWorldPos);

      if (Math.abs(coinWorldPos.z - playerWorldPos.z) > 1.8) continue;

      obsBox.min.set(coinWorldPos.x - 0.6, coinWorldPos.y - 0.6, coinWorldPos.z - 0.6);
      obsBox.max.set(coinWorldPos.x + 0.6, coinWorldPos.y + 0.6, coinWorldPos.z + 0.6);

      if (playerBox.intersectsBox(obsBox)) {
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
    // Clear arrays — chunk re-placement removes meshes from scene graph
    this.obstacles.length = 0;
    this.coins.length = 0;
  }
}
