import * as THREE from 'three';
import { CONFIG } from '../main.js';

/**
 * TrackManager — Chunk-based infinite runner track.
 *
 * Performance design:
 *  - All geometries & materials are shared (no per-chunk allocation).
 *  - Chunks are pre-pooled at startup: only position is set on recycle.
 *  - spawnChunk() is NEVER called mid-frame in update(); instead old chunks
 *    are repositioned ahead of the player (object pool pattern) so there is
 *    ZERO per-frame geometry/scene-graph mutation spike.
 *  - Shadow casting is disabled on boundary decor meshes — only the ground
 *    plane receives shadows, keeping the shadow-map tightly bounded.
 */
export class TrackManager {
  constructor(scene, obstacleManager) {
    this.scene = scene;
    this.obstacleManager = obstacleManager;
    this.chunkLength = CONFIG.TRACK_CHUNK_LENGTH;

    // Total live chunks = ahead chunks + 3 behind (never fully unloaded)
    this.numChunks = CONFIG.VISIBLE_CHUNKS || 14;

    // spawnZ starts AHEAD of player (player starts at z=0, runs negative)
    // Chunks span from spawnZ downward in steps of chunkLength.
    this.nextChunkZ = 20; // World-Z of the FRONT edge of the next chunk to assign

    // Shared geometries & materials
    this._initSharedResources();

    // Build the fixed pool of chunk groups once
    this._pool = [];
    for (let i = 0; i < this.numChunks; i++) {
      const chunkGroup = this._buildChunkGroup();
      this.scene.add(chunkGroup);
      this._pool.push(chunkGroup);
    }

    // Position all chunks sequentially starting from nextChunkZ
    // First 2 chunks are safe (~6s in AI mode, ~2.7s in Keyboard mode), rest have obstacles
    for (let i = 0; i < this._pool.length; i++) {
      const isFirst = (i < 2);
      this._placeChunk(this._pool[i], isFirst);
    }

    // Keep track of which chunk is "oldest" (farthest behind player)
    // using a circular head pointer instead of splice().
    this._head = 0; // index into this._pool of the oldest chunk
  }

  _initSharedResources() {
    // 1. Solid black base floor (so we can't see through the world)
    this.baseGroundGeo = new THREE.PlaneGeometry(12, this.chunkLength);
    this.baseGroundMat = new THREE.MeshBasicMaterial({ color: 0x020502 });

    // 2. Glowing wireframe grid on top of the base floor
    this.gridGroundGeo = new THREE.PlaneGeometry(12, this.chunkLength, 12, Math.floor(this.chunkLength));
    this.gridGroundMat = new THREE.MeshBasicMaterial({
      color: 0x00ff66,
      wireframe: true,
      transparent: true,
      opacity: 0.15
    });

    // Lane dividers
    this.lineGeo = new THREE.PlaneGeometry(0.14, this.chunkLength);
    this.lineMatGreen = new THREE.MeshBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.8 });
    this.lineMatLime  = new THREE.MeshBasicMaterial({ color: 0xa3e635, transparent: true, opacity: 0.8 });

    // Side curbs
    this.curbGeo = new THREE.BoxGeometry(0.4, 0.4, this.chunkLength);
    this.curbMat = new THREE.MeshStandardMaterial({
      color: 0x00ff66, emissive: 0x00ff66, emissiveIntensity: 0.6, metalness: 0.8
    });

    // Boundary obelisk towers (shadow cast OFF — only emissive glow matters)
    this.towerGeo = new THREE.BoxGeometry(0.8, 8.0, 0.8);
    this.towerMat = new THREE.MeshStandardMaterial({
      color: 0x081c0d, emissive: 0x00ff66, emissiveIntensity: 0.45, metalness: 0.8, roughness: 0.2
    });

    // Tower top globe (MeshBasicMaterial = free, no lighting calc)
    this.lightGlobeGeo = new THREE.SphereGeometry(0.4, 8, 8); // reduced segments for perf
    this.lightGlobeMat = new THREE.MeshBasicMaterial({ color: 0x00ff66 });



    // Arch
    this.archTopGeo  = new THREE.BoxGeometry(13.6, 0.6, 0.8);
    this.archSideGeo = new THREE.BoxGeometry(0.6, 6.5, 0.8);
    this.archMat = new THREE.MeshStandardMaterial({
      color: 0x052e16, emissive: 0x00ff66, emissiveIntensity: 0.65, metalness: 0.9
    });

    // Pillar
    this.pillarGeo = new THREE.CylinderGeometry(0.35, 0.35, 8, 8); // reduced segments
    this.pillarMat = new THREE.MeshStandardMaterial({
      color: 0x10b981, emissive: 0x10b981, emissiveIntensity: 0.55, metalness: 0.8
    });
  }

  /**
   * Build a single reusable chunk group (called once per pool slot at startup).
   * All children are always present; obstacle children are added/removed by
   * obstacleManager.populateChunk per recycle.
   */
  _buildChunkGroup() {
    const group = new THREE.Group();
    group.userData.isFirstChunk = false;

    // Base black ground
    const baseGround = new THREE.Mesh(this.baseGroundGeo, this.baseGroundMat);
    baseGround.rotation.x = -Math.PI / 2;
    baseGround.receiveShadow = true;
    group.add(baseGround);

    // Wireframe grid
    const gridGround = new THREE.Mesh(this.gridGroundGeo, this.gridGroundMat);
    gridGround.rotation.x = -Math.PI / 2;
    gridGround.position.y = 0.01; // slightly above base to prevent z-fighting
    group.add(gridGround);

    // Left Lane line
    const lineL = new THREE.Mesh(this.lineGeo, this.lineMatGreen);
    lineL.rotation.x = -Math.PI / 2;
    lineL.position.set(-1.75, 0.01, 0);
    group.add(lineL);

    const lineR = new THREE.Mesh(this.lineGeo, this.lineMatLime);
    lineR.rotation.x = -Math.PI / 2;
    lineR.position.set(1.75, 0.01, 0);
    group.add(lineR);

    // Curbs
    const curbL = new THREE.Mesh(this.curbGeo, this.curbMat);
    curbL.position.set(-6, 0.2, 0);
    group.add(curbL);

    const curbR = new THREE.Mesh(this.curbGeo, this.curbMat);
    curbR.position.set(6, 0.2, 0);
    group.add(curbR);

    // 3 boundary tower groups along chunk length
    const zOffsets = [-this.chunkLength * 0.35, 0, this.chunkLength * 0.35];
    zOffsets.forEach((relZ) => {
      const tL = new THREE.Mesh(this.towerGeo, this.towerMat);
      tL.position.set(-7.5, 4.0, relZ);

      const gL = new THREE.Mesh(this.lightGlobeGeo, this.lightGlobeMat);
      gL.position.set(-7.5, 8.2, relZ);

      const tR = new THREE.Mesh(this.towerGeo, this.towerMat);
      tR.position.set(7.5, 4.0, relZ);

      const gR = new THREE.Mesh(this.lightGlobeGeo, this.lightGlobeMat);
      gR.position.set(7.5, 8.2, relZ);

      group.add(tL, gL, tR, gR);
    });

    // Arch decoration group (always built, shown/hidden by opacity toggle)
    const archGroup = new THREE.Group();
    archGroup.name = 'archGroup';

    const archTop  = new THREE.Mesh(this.archTopGeo, this.archMat);
    archTop.position.set(0, 6.2, 0);
    const archL = new THREE.Mesh(this.archSideGeo, this.archMat);
    archL.position.set(-6.5, 3.25, 0);
    const archR = new THREE.Mesh(this.archSideGeo, this.archMat);
    archR.position.set(6.5, 3.25, 0);
    archGroup.add(archTop, archL, archR);
    archGroup.visible = false;
    group.add(archGroup);

    // Pillar decoration group
    const pillarGroup = new THREE.Group();
    pillarGroup.name = 'pillarGroup';
    const pilL = new THREE.Mesh(this.pillarGeo, this.pillarMat);
    pilL.position.set(-6.8, 4.0, 0);
    const pilR = new THREE.Mesh(this.pillarGeo, this.pillarMat);
    pilR.position.set(6.8, 4.0, 0);
    pillarGroup.add(pilL, pilR);
    pillarGroup.visible = false;
    group.add(pillarGroup);

    return group;
  }

  /**
   * Position an existing chunk group at the next sequential Z slot,
   * randomise decoration, and repopulate obstacles.
   */
  _placeChunk(chunkGroup, isFirstChunk = false) {
    chunkGroup.userData.isFirstChunk = isFirstChunk;

    // Center the chunk group at (nextChunkZ - half chunk length)
    chunkGroup.position.z = this.nextChunkZ - this.chunkLength / 2;
    this.nextChunkZ -= this.chunkLength;

    // Decoration variant
    const archGroup   = chunkGroup.getObjectByName('archGroup');
    const pillarGroup = chunkGroup.getObjectByName('pillarGroup');
    if (archGroup)   archGroup.visible   = false;
    if (pillarGroup) pillarGroup.visible = false;

    if (!isFirstChunk) {
      // All decorations (arches, inner pillars) have been removed based on user feedback
      // so the track remains visually clear.
    }

    // ── Purge stale obstacle & coin references back to their pools ──
    if (this.obstacleManager) {
      const toRelease = [];
      for (let i = chunkGroup.children.length - 1; i >= 0; i--) {
        const child = chunkGroup.children[i];
        if (child && child.userData && (child.userData.type === 'OBSTACLE' || child.userData.type === 'COIN')) {
          toRelease.push(child);
        }
      }
      toRelease.forEach((node) => this.obstacleManager.releaseNode(node));
    }

    // Populate fresh obstacles & coins
    if (this.obstacleManager) {
      this.obstacleManager.populateChunk(chunkGroup, isFirstChunk);
    }
  }

  /**
   * Called every frame. Recycles chunks that are behind the player
   * by MOVING them (not creating new ones), zero GC pressure.
   */
  update(playerZ) {
    // Player moves in -Z. Recycle a chunk when its centre Z is
    // more than 1 chunk-length BEHIND (i.e., more positive Z than) the player.
    const recycleThreshold = playerZ + this.chunkLength;

    // Use while so multiple stale chunks are caught up after a frame spike,
    // not just one-per-frame (bug fix from code review).
    let oldest = this._pool[this._head];
    while (oldest && oldest.position.z > recycleThreshold) {
      this._placeChunk(oldest, false);
      this._head = (this._head + 1) % this._pool.length;
      oldest = this._pool[this._head];
    }
  }

  reset() {
    // Reset forward spawn position to start
    this.nextChunkZ = 20;
    this._head = 0;

    // Re-place all pool chunks from scratch — first 2 are safe
    for (let i = 0; i < this._pool.length; i++) {
      this._placeChunk(this._pool[i], i < 2);
    }
  }
}
