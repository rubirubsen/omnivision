# 🌍 Omnivision (WorldView)

A high-performance, browser-based OSINT (Open Source Intelligence) dashboard. Omnivision visualizes live global intelligence data—including flights, ships, satellites, GPS jamming zones, and no-fly zones—on an interactive 3D globe and a 2D map.

## ✨ Features

* **Dual Visualization Modes:** Seamlessly auto-switches from a stunning 3D Globe (Three.js) to a detailed 2D Map (Leaflet) when zooming in past a certain threshold.
* **Live Flight Tracking:** Pulls real-time flight data via the OpenSky API, rendering up to 12,000 planes in a single draw call using custom WebGL shaders (`THREE.Points`).
* **Real-time Satellites:** Integrates CelesTrak data to calculate and propagate satellite positions using the SGP4 model in real-time.
* **Global Weather Integration:** Uses the Windy API for point forecasts, webcams, and embeddable weather maps (silently disabled if no API key is provided).
* **Static OSINT Data:** Displays GPS jamming zones, no-fly zones, and simulated ship anchor drift mechanisms.

## 🏗 Architecture

The application consists of a **static frontend** (HTML/JS/CSS) and a lightweight **Node.js proxy sidecar**. 

The frontend uses an IIFE module pattern loaded in strict dependency order. No build steps (like Webpack or Vite) are required. The Node.js proxy handles secure token storage and bypasses CORS for the OpenSky API.

## 🚀 Getting Started

### 1. Configuration (`.env`)
To use live data, create a `.env` file in the root directory (see `.env.example` if available) and add your API credentials:

```ini
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
WINDY_API_KEY=your_windy_key
PORT=3001
```

2. Running the App

You have a few options depending on what data you need to test:

**Option A**:

**Frontend Only (Static Data Only)**

If you just want to work on the UI and don't need live flight data, you can serve the directory statically:

```Bash

npx serve .
# OR
python -m http.server 8080
```

**Option B**: 

**Full Live App (Local Development)**

To enable live OpenSky flight data, run the Node.js proxy. Note: You will need a local server like Nginx to route /api/ requests to http://localhost:3001.

```Bash
node proxy.js
```

**Option C**: 

**Production**

For keeping the proxy alive in a production environment, use pm2:

```Bash

pm2 start proxy.js --name worldview-proxy
```

🧩 Module Structure

The frontend relies on specific script loading order in index.html. Here is a breakdown of the core modules:

- Module	Global Object	Responsibility
- data.js	Data	Static reference data (jamming zones, no-fly zones). Drives ship drift logic.
- api.js	API	Live data fetching (OpenSky via proxy, CelesTrak satellites).
- globe.js	Globe	Three.js (r128) 3D renderer. Uses ShaderMaterial for high-performance flight rendering.
- map.js	Map2D	Leaflet 2D tile map, lazy-loaded on the first view switch.
- hud.js	HUD	DOM manipulation (stats panels, tooltips, flight details).
- weather.js	Weather	Windy API integration. Fetches key via backend on load.
- app.js	App	The main orchestrator. Owns data arrays, runs the requestAnimationFrame loop, and wires everything together.
- proxy.js	(Backend)	Node.js HTTP server for OAuth2 handling and CORS proxying.
  
🔄 View Switching Logic

- Default View: 3D Globe (canvas-container).

- Auto-Switching: Zooming in past the 1.45 threshold triggers a switch to the 2D Map (map-container).

- Layer states are strictly managed by the App orchestrator to ensure the 3D and 2D renderers remain perfectly in sync.
