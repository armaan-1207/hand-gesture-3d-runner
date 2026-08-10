# Cyber Runner 3D

Cyber Runner 3D is a high-performance, web-based 3D endless runner game built with **Three.js**, **MediaPipe Hands**, and **WebGL**. The application supports standard keyboard controls as well as real-time, gesture-based hand tracking using computer vision directly in the browser.

---

## Key Features

### Vision Engine & Primary Player Isolation
- **Crowd Robustness**: Dynamically isolates and tracks the primary player's hand while filtering out secondary hands, background movement, and ambient noise in crowded environments.
- **One-Euro Landmark Filtering**: Integrates a 3D One-Euro low-pass filter to smooth 21 hand landmarks, eliminating jitter while maintaining responsive control.
- **Real-Time Gesture Recognition**: Evaluates hand bounding volume, vertical velocity vectors, and normalized spatial coordinates for seamless steering, jumping, and sliding actions.

### 3D Rendering & Engine Performance
- **Object-Pool Track Management**: Utilizes an object-pool architecture for track chunk recycling, eliminating runtime garbage collection (GC) pauses and frame drops.
- **Optimized WebGL Pipeline**: Incorporates static shadow mapping, fixed draw-call budgeting, and frustum culling to sustain 60 FPS performance across desktop devices.
- **Rigged 3D Character**: Features a GLTF XBot character model integrated with state-blended skeletal animations (Run, Jump, Slide).

### Gameplay Mechanics
- **Dynamic Obstacles**:
  - **Hurdles**: Require jumping.
  - **Overhang Beams**: Require sliding/crouching.
  - **Blockades**: Require lane switching.
- **Collectibles & Persistence**: Spawns collectible energy coins and persists all-time high scores locally.
- **Hand-Controlled Restart**: Allows players to restart runs directly via hand tracking without requiring keyboard or mouse input.

---

## Controls

### Hand Tracking Gestures

| Action | Control Gesture | Description |
| :--- | :--- | :--- |
| **Steer / Move Lane** | Horizontal Hand Shift | Shift hand left or right relative to the camera viewport center. |
| **Jump** | Hand Raise / Upward Swipe | Position hand in upper 22% of frame or execute an upward swipe vector. |
| **Slide / Crouch** | Hand Drop / Downward Swipe | Position hand in lower 20% of frame or execute a downward swipe vector. |
| **Restart Run** | Hand Controlled Restart | Select restart option on the Game Over overlay using vision tracking. |

### Keyboard Shortcuts

| Key | Function |
| :--- | :--- |
| `A` / `Left Arrow` | Move Left |
| `D` / `Right Arrow` | Move Right |
| `W` / `Up Arrow` | Jump |
| `S` / `Down Arrow` | Slide / Crouch |
| `Space` | Start / Restart Game |

---

## Technology Stack

- **Graphics & Animation**: Three.js (WebGL), GSAP (Tweens & Timelines)
- **Computer Vision**: @mediapipe/hands, OpenCV pre-processing principles
- **Signal Processing**: Custom 3D One-Euro Low-Pass Filter (`OneEuroFilter.js`)
- **Build System & Tooling**: Vite, ES Modules

---

## Project Structure

```
├── index.html                 # DOM structure and UI modal overlays
├── package.json               # Package configuration and dependencies
├── public/
│   └── models/
│       └── Xbot.glb           # Rigged 3D character asset
└── src/
    ├── main.js                # Game loop, scene initialization, state machine
    ├── components/
    │   ├── ObstacleManager.js # Spawning logic and AABB collision detection
    │   └── TrackManager.js    # Object-pooled track chunk manager
    ├── services/
    │   └── HandTracker.js     # MediaPipe pipeline and gesture classification
    ├── utils/
    │   └── OneEuroFilter.js   # Adaptive signal smoothing algorithm
    └── style.css              # User interface styling and Matrix theme
```

---

## Getting Started

### Prerequisites

- Node.js (v16.0.0 or higher)
- WebGL-compatible browser with webcam permission support

### Installation & Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/paramnarayan/hand-gesture-3d-runner.git
   cd hand-gesture-3d-runner
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Launch dev server:
   ```bash
   npm run dev
   ```

4. Access application:
   Open browser at `http://localhost:3000`.

### Production Build

To assemble optimized static assets:

```bash
npm run build
```

Production output will be compiled into the `dist/` directory.

---

## License

Distributed under the [MIT License](LICENSE).
