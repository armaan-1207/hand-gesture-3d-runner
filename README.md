# 🏃‍♂️ Cyber Runner 3D — Hand-Gesture Controlled Endless Runner

A high-performance, futuristic 3D endless runner game powered by **Three.js**, **MediaPipe Hands**, and **OpenCV / WebGL**. Play using standard keyboard controls or control your character hands-free in real-time using webcam gesture tracking!

---

## 🌟 Key Features

- **🎮 Dual Control Modes**:
  - **Keyboard Controls**: Responsive `A`/`D` (or Left/Right arrows) for lane changes, `W` / Up Arrow for jumping, and `S` / Down Arrow for sliding.
  - **Vision-Based Hand Tracking**: Hands-free gameplay using real-time webcam video processing via MediaPipe Hands & OpenCV principles.
- **🛡️ Crowd Robustness & Primary Player Isolation**:
  - Automatically identifies and locks onto the **primary player's hand** using bounding box volume, center distance, and temporal confidence tracking.
  - Ignores background people, ambient movements, and secondary hands in crowded environments.
- **⚡ Zero-Jitter Landmark Smoothing**:
  - Integrated 3D **One-Euro Filter** signal processing to eliminate camera jitter and noise without introduced latency.
- **🚀 High-Performance Object-Pool Engine**:
  - Zero mid-frame garbage collection (GC) spikes via track chunk object-pooling.
  - Pre-rendered 840m horizon lookahead with smooth environment recycling.
  - Static shadow-mapping and optimized WebGL draw calls for steady 60 FPS gameplay.
- **💥 Dynamic Obstacles & Collectibles**:
  - **Hurdles**: Low obstacles requiring a **Jump**.
  - **Overhang Beams**: High obstacles requiring a **Slide / Crouch**.
  - **Full Blockades**: Wide barriers requiring a **Lane Change**.
  - **Gold Energy Coins**: Collectible coins with persistent high score tracking (`localStorage`).
- **🤖 Animated 3D Character**:
  - Rigged XBot GLTF model with dynamic animation blending (Running, Jumping, Sliding).

---

## 🕹️ Controls Guide

### 🖐️ Hand Gesture Controls

| Gesture | Action | Description |
| :--- | :--- | :--- |
| **Move Hand Left / Right** | `Steer / Change Lane` | Translate your hand across the camera frame to shift lanes. |
| **Raise Hand High / Swipe Up** | `Jump` | Raise your hand into the upper 22% of the webcam frame or execute a quick upward swipe to jump over hurdles. |
| **Drop Hand Low / Swipe Down** | `Slide / Crouch` | Lower your hand into the bottom 20% of the frame or execute a quick downward swipe to slide under overhang beams. |
| **Hand Controlled Restart** | `Restart Run` | Click **Hand Controlled Restart** on the Game Over modal to restart directly using vision tracking. |

### ⌨️ Keyboard Controls

- **Left Arrow / `A`**: Move Left
- **Right Arrow / `D`**: Move Right
- **Up Arrow / `W`**: Jump
- **Down Arrow / `S`**: Slide / Crouch
- **Space**: Start / Restart Game

---

## 🛠️ Tech Stack & Architecture

- **Frontend Engine**: HTML5, Vanilla CSS3 (Matrix Dark Emerald Theme), JavaScript (ES Modules)
- **3D Graphics & Rendering**: [Three.js](https://threejs.org/) (WebGL, GLTFLoader, GSAP Animations)
- **Computer Vision**: [@mediapipe/hands](https://github.com/google/mediapipe) (3D Hand Landmark Detection)
- **Signal Processing**: Custom **One-Euro Filter** implementation (`OneEuroFilter.js`) for signal smoothing
- **Bundler & Dev Server**: [Vite](https://vitejs.dev/)

---

## 📁 Repository Structure

```
├── index.html                 # Main application HTML layout & overlays
├── package.json               # Dependencies & scripts
├── public/
│   └── models/
│       └── Xbot.glb           # 3D Animated Character Model
└── src/
    ├── main.js                # Core game loop, Three.js setup, scene management
    ├── components/
    │   ├── ObstacleManager.js # Obstacle/Coin spawning & AABB collision detection
    │   └── TrackManager.js    # Object-pool chunk-based infinite track generator
    ├── services/
    │   └── HandTracker.js     # MediaPipe vision processing & gesture classification
    ├── utils/
    │   └── OneEuroFilter.js   # Adaptive low-pass filter for landmark smoothing
    └── style.css              # Cyberpunk / Matrix visual styling & overlays
```

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- Web Browser with WebGL and Webcam support (Chrome, Edge, Brave, Firefox, Safari)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/paramnarayan/hand-gesture-3d-runner.git
   cd hand-gesture-3d-runner
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the local development server**:
   ```bash
   npm run dev
   ```

4. **Open in browser**:
   Navigate to `http://localhost:3000` (or the URL provided in your terminal).

---

## ⚙️ Building for Production

To generate a minified, production-ready build:

```bash
npm run build
```

The output will be generated inside the `dist/` directory.

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
