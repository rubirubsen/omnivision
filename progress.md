# WorldView — OmniVision OSINT Dashboard
## Progress & Status  |  Stand: 2026-03-14

---

## ✅ Was bisher erreicht wurde

### Stack & Architektur
- Vanilla JS + Three.js r128 (Globus) + Leaflet 1.9 (2D Map)
- Node.js Proxy auf VPS (kein CORS, Keys bleiben serverseitig)
- PM2 als Prozessmanager
- nginx als Reverse Proxy vor dem Node-Proxy
- Fonts: Space Mono + Syne

---

### Proxy (proxy.js — v3.1)
- **Background-Cache-System**: Flüge, Satelliten werden serverseitig im Intervall geprefetcht
  - Flights alle 15s, CelesTrak stündlich
  - Browser bekommt gecachte Daten in <5ms — kein Warten beim Seitenaufruf
- **Flight-Fallback-Kette** (auto-failover):
  1. airplanes.live (6 regionale parallele bbox-Queries, dedupliziert)
  2. adsb.lol (regional)
  3. OpenSky OAuth2 (letzter Ausweg, rate-limitiert)
- **Map-Tile-Cache**: CartoDB Dark Matter Tiles auf Disk gecacht
  - `pipe()`-basiert (binary-safe, kein Encoding-Bug)
  - TTL 30 Tage, konfigurierbarer Max-Zoom
  - `seed-tiles.js` zum Vorab-Befüllen (Z0–7 empfohlen, ~80MB)
- **AISstream** Server-Side WebSocket — läuft stabil, reconnect bei Verbindungsverlust ✅
  - `/api/ships` Endpoint liefert gecachtes Array aller aktiven Schiffe
  - Prune-Intervall: Schiffe die >10min nicht gesehen wurden werden entfernt
- **CelesTrak** TLE-Fallback-Kette + Disk-Cache ✅
- **OpenAIP** Airspace — vollständig funktional ✅
  - 7 Weltregionen, paginiertes Fetching, 24h TTL, Disk-Cache
  - Liefert Daten korrekt, X-Airspace Header wird gesetzt
- **Windy** Webcams passthrough ✅
- **Windy** Forecast passthrough ✅
- **OpenWeatherMap** Tile-Proxy ✅
- **RainViewer** passthrough ✅

---

### 3D Globus (globe.js)
- Three.js ShaderMaterial Points für Flüge (kein DOM overhead)
- Sprites für Schiffe + Satelliten
- Dirty-Flags: `_updateFlightPoints()` nur wenn Daten sich ändern
- Render-on-demand: `renderer.render()` wird bei Idle übersprungen
- Dead Reckoning: Flugzeuge extrapolieren Position zwischen API-Polls
- Jamming-Pulse: animiert via `mesh.scale` + `opacity`
- Zoom-Scale-Guard: Sprite-Rescaling nur bei Delta > 0.02

---

### 2D Map (map.js)
- **Flight Canvas Layer**: alle ~8.000 Flugzeuge auf einem einzigen `<canvas>` gezeichnet
  - Zero DOM-Nodes für Flüge
  - Flugzeug-Silhouette mit Heading-Rotation per Canvas API
  - Pixel-based Culling
  - Canvas auf `map.getContainer()` gemountet (kein overlayPane-Clipping)
- **Ships + Satellites**: `L.canvas()` Renderer
- **syncPositions**: throttled auf ein `requestAnimationFrame`
- **Webcam-Layer**: DivIcon-Marker mit Live-Thumbnail im Popup
- **Weather Overlay**: RainViewer Radar + Satellite, OWM Kacheln
- **3-Wege-Toggle** für Jamming + No-Fly:
  - `mode 0` = aus / `mode 1` = Dot / `mode 2` = Dot + Radius-Ring
- **Airspace Layer** (OpenAIP): FIR, TMA, CTR, Danger, Restricted als Polygone ✅

---

### App-Logik (app.js)
- `_syncMapLayers()`: saubere Zustandssynchronisation beim Map-Init
- `zoneMode` State (0/1/2) getrennt von binären `layerState` booleans
- Webcams + Airspace als 2D-only markiert

---

### HUD / UI
- 3-State Toggle Indicator: `off` / `on` / `mode2` CSS-Klassen
- Toggle-Label `●` / `◎` neben Zone-Layers
- Airspace Layer-Eintrag im Panel

---

## 🐛 Bekannte Bugs / Offene Issues

### KRITISCH
| # | Problem | Datei | Status |
|---|---------|-------|--------|
| 1 | **airplanes.live + adsb.lol schlagen beide fehl** — Proxy fällt bei jedem 15s-Cycle auf OpenSky (Last Resort) durch. Logs zeigen durchgehend `[Cache] Flights: loaded from OpenSky (Last Resort)`. Ursache unklar: API-Block, bbox-Format, Rate-Limit oder Netzwerk auf VPS | proxy.js | ⚠️ Aktiv |

### MITTEL
| # | Problem | Datei | Status |
|---|---------|-------|--------|
| 2 | **OpenSky als dauerhafter Flight-Source** — funktioniert, aber rate-limitiert (1000 API-Credits/Tag). Kein Problem solange keine anderen User, aber langfristig nicht skalierbar | proxy.js | 🔶 Bekannt |
| 3 | **Tile-Cache seed noch nicht gelaufen** nach letztem `rm -rf .tile-cache/` — Tiles kommen noch von CartoDB direkt | seed-tiles.js | 🔶 Offen |
| 4 | **Ships-Counter** — zeigt statische Dekor-Schiffe bis erster AIS-Batch kommt | app.js | 🔷 Klein |

### KLEIN
| # | Problem | Datei | Status |
|---|---------|-------|--------|
| 5 | **No-Fly + GPS Zones im Globus** nur binary toggle, kein 3-Wege-Modus | globe.js | 🔷 Offen |
| 6 | **Airspace re-fetch** triggert bei jedem `moveend` — sollte erst ab größerem Viewport-Wechsel (>30% Bewegung) | map.js | 🔷 Klein |

---

## 📋 Noch geplant / Roadmap

### Kurzfristig (nächste Session)
- [ ] **airplanes.live Debug** — direkt vom VPS `curl` testen ob API antwortet / HTTP Status prüfen
  - Kandidat: VPS-IP geblockt? API-Key nötig? bbox-Parameter geändert?
- [ ] **adsb.lol Debug** — gleiche Prozedur
- [ ] seed-tiles.js nochmal durchlaufen lassen (Z0–7)

### Mittelfristig
- [ ] **Flightradar24 API** als Flight-Source — Tier "Basic" (~$60/mo) für Near-Realtime
- [ ] **Eigene AIS-Relay** auf VPS — Key bleibt serverseitig (aktuell schon so ✅)
- [ ] **GPS Jammer Daten** von gpsjam.org scrapen/API statt statische Test-Daten
- [ ] **NOTAM Layer** — aktive NOTAMs als Marker/Zonen auf 2D Map
- [ ] **Flight History** — Klick auf Flugzeug zeigt Flugroute (Trail)
- [ ] **Search** — Callsign/ICAO Suche mit Kamera-Fly-To

### Langfristig / Vision
- [ ] **PostgreSQL + PostGIS** Backend für historische Daten
- [ ] **TimescaleDB** für Zeitreihen (Flugdichte, Jamming-Verlauf)
- [ ] **GDELT** News-Events Layer (geopolitische Ereignisse)
- [ ] **NASA FIRMS** Feuer/Hitzepunkte Layer
- [ ] **Sentinel Hub** Satellite-Imagery on demand
- [ ] **Shodan** exposed Infrastructure Layer
- [ ] **MapLibre GL / Deck.gl** für High-Density Rendering wenn >50k Objekte
- [ ] **Multi-User** mit geteilten Annotationen (Cowork-style)

---

## 📁 Datei-Übersicht

| Datei | Stand | Wichtige Änderungen |
|-------|-------|---------------------|
| `proxy.js` | v3.1 | Background-Cache, Tile-Cache, Airspace-Route, AIS Server-Side WS, Unified Flight Fallback |
| `map.js` | v3 | Canvas-Layer, 3-Way-Toggle, Airspace-Render, Binding-Fix, Pixel-Culling |
| `app.js` | v2 | `_syncMapLayers()`, `zoneMode` State, 2D-only Layer-Guard |
| `hud.js` | v2 | 3-State Toggle, Airspace-Row opacity |
| `index.html` | v2 | Airspace Layer-Item, mode2 CSS, toggle-label |
| `globe.js` | v2 | Dirty-Flags, Render-on-demand, Jamming-Pulse-Fix |
| `api.js` | v2 | Multi-Source Fallback, Dead Reckoning, AIS über `/api/ships` |
| `seed-tiles.js` | v1 | CartoDB Tile Pre-Seeder, Z0–9 konfigurierbar |
