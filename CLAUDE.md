# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**WorldView** — a browser-based OSINT dashboard visualizing live global intelligence data (flights, ships, satellites, GPS jamming zones, no-fly zones) on a 3D globe and 2D map.

## Running the App

This is a static frontend with a Node.js proxy sidecar. No build step required.

**Frontend only (no live flights):**
Open `index.html` directly in a browser, or serve with any static server:
```
npx serve .
# or
python -m http.server 8080
```

**With live OpenSky flight data:**
```
node proxy.js
```
The proxy runs on port 3001. Nginx (or similar) must route `/api/` to `http://localhost:3001`.

**With pm2 (production):**
```
pm2 start proxy.js --name worldview-proxy
```

## Credentials

Secrets are stored in `.env` (not committed — see `.env.example` for the required keys):

```
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
WINDY_API_KEY=...
PORT=3001
```

`proxy.js` loads them via `dotenv`. The Windy key is served to the browser at runtime via `GET /api/config` — `weather.js` fetches it on load. When running without the proxy (static-only), weather features are silently disabled.

## Architecture

The app is structured as **IIFE modules** loaded in dependency order via `<script>` tags in `index.html`. All modules expose a public API on a global variable. **Script load order matters:**

```
data.js → globe.js → map.js → weather.js → hud.js → api.js → app.js
```

### Module Responsibilities

| Module | Global | Role |
|--------|--------|------|
| `js/data.js` | `Data` | Static reference data: jamming zones, no-fly zones, ship anchors. `Data.tick()` drives ship drift. |
| `js/api.js` | `API` | Live data fetching. OpenSky (flights, every 15s via proxy), CelesTrak (satellites, SGP4 propagation every 10s, TLEs refreshed hourly). |
| `js/globe.js` | `Globe` | Three.js r128 3D renderer. Flights use a `ShaderMaterial` Points mesh (single draw call for up to 12,000 planes). Ships/satellites use individual Sprites. |
| `js/map.js` | `Map2D` | Leaflet 2D tile map, lazy-loaded on first switch to map view. SVG icons for all entities. |
| `js/hud.js` | `HUD` | DOM manipulation only — stats panel, tooltip, flight detail panel, weather panel open/close. |
| `js/weather.js` | `Weather` | Windy API integration: point forecast, webcams, and Windy map embed. |
| `js/app.js` | `App` | Orchestrator. Owns the data arrays, runs the `requestAnimationFrame` loop, wires API callbacks to Globe/Map2D/HUD, handles layer toggles and view switching. |
| `proxy.js` | — | Node.js HTTP server. Holds the OpenSky OAuth2 token in memory, proxies `/api/opensky-states` to bypass CORS. |

### Data Flow

```
API.init() → _fetchFlights() → App._onLiveFlights() → Globe.populateLayer() + Map2D.populateLayer()
           → _fetchAndPropagate() → App._onLiveSatellites() → Globe.populateLayer() + Map2D.populateLayer()

App._loop() [rAF] → Data.tick(ships) → Globe.syncPositions() + Map2D.syncPositions() → Globe.render()
```

### View Switching

- Default view: **3D Globe** (`canvas-container`)
- 2D Map (`map-container`) is initialized lazily on first switch
- Auto-switch trigger: zooming in past threshold (zoom < 1.45) fires `Globe.onMaxZoom()` → `App._autoSwitchToMap()`
- Layer state (`layerState` in `App`) is authoritative; both renderers must be kept in sync on switch

### Flight Rendering (Performance)

Flights use `THREE.Points` with a custom `ShaderMaterial` that rotates each point sprite by its heading attribute in the fragment shader. Up to `MAX_FLIGHTS = 12000` points in a single draw call. Selected flight is highlighted via the `selectedIdx` uniform.

### Satellite SGP4 Pipeline

1. Fetch CelesTrak GP JSON (visual group ~150 sats, fallback to stations group)
2. Convert OMM JSON → TLE line strings → `satellite.js` satrec via `_omm2satrec()`
3. Propagate all satrecs every 10s → geodetic lat/lon/alt
4. Pass results to `App._onLiveSatellites()`

### CSS Structure

| File | Scope |
|------|-------|
| `css/base.css` | Reset, body, scanlines overlay, corner decorations, dragging cursor |
| `css/hud.css` | Topbar, bottom bar, tooltip, flight detail panel, view toggle buttons |
| `css/panels.css` | Left/right stat panels, layer controls, weather panel and all its sub-components |
