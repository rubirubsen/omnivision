/* =====================================================
   MAP — Leaflet 2D  (v2 — performance optimized)

   Performance fixes vs v1:
   ─────────────────────────────────────────────────
   1. Flights → custom Canvas layer (L.CanvasLayer)
      Zero DOM nodes for flights. All 10k+ aircraft
      drawn in a single canvas.drawImage() pass.
      Redraws only on map move/zoom or data update.

   2. Ships → custom Canvas layer (ShipCanvasLayer)
      Same as flights — ship silhouettes on one <canvas>,
      colored by vessel type, rotated by heading.
      Satellites → L.circleMarker with canvasRenderer.

   3. syncPositions throttled — position updates
      batched and applied max once per animation frame,
      not on every rAF from app.js.

   4. populateLayer for flights only redraws canvas,
      no marker create/destroy cycle.

   5. Zones (jamming) unchanged — static,
      low count, no perf issue.
===================================================== */

var Map2D = (() => {

  let leafletMap     = null;
  let leafletReady   = false;
  let _overlayLayer  = null;
  let _canvasRenderer = null;   // shared Leaflet canvas renderer for ships/sats

  // ---- Flight canvas layer state ----
  let _flightCanvas  = null;
  let _flightData    = [];
  let _flightVisible = true;

  // ---- Ship canvas layer state ----
  let _shipCanvas    = null;
  let _shipData      = [];
  let _shipVisible   = true;

  // ---- Marker stores for satellites ----
  const _satMarkers  = new Map();   // id → L.circleMarker

  const SHIP_COLORS = {
    Cargo: '#4488ff', Tanker: '#ff8844', Passenger: '#44ffaa',
    Fishing: '#ffdd44', Sailing: '#cc88ff', Tug: '#ff4488',
    SAR: '#ff4488', Pilot: '#ff9900', Vessel: '#8899aa',
  };

  // ---- Layer visibility flags (ships/flights use canvas layers instead) ----
  const layerGroups = {
    flights      : null,  // canvas layer — see _flightCanvas
    ships        : null,  // canvas layer — see _shipCanvas
    satellites   : null,
    jamming_dot  : null,   // mode 1+2: center dot/marker
    jamming_ring : null,   // mode 2 only: filled radius circle
    webcams      : null,
    airspace     : null,
  };

  // 3-way toggle state: 0=off, 1=dot, 2=dot+radius
  const _zoneMode = { jamming: 0 };

  // Airspace toggle
  let _airspaceVisible = false;
  let _airspaceLoaded  = false;
  let _airspaceCache   = null;   // last fetched data for re-render on filter change

  // Airspace sub-filters: which groups are shown
  const AIRSPACE_GROUPS = {
    DANGER: 'restr', RESTRICTED: 'restr', PROHIBITED: 'restr',
    CTR: 'ctrl', TMA: 'ctrl',
    FIR: 'fir',  UIR: 'fir',
    CLASS_A: 'class', CLASS_B: 'class', CLASS_C: 'class',
    CLASS_D: 'class', CLASS_E: 'class', CLASS_F: 'class', CLASS_G: 'class',
  };
  const _airspaceFilter = { restr: true, ctrl: true, fir: true, class: true };

  let _webcamFetchTimer = null;

  // ---- Sync throttle ----
  let _syncPending = false;
  let _pendingFlights = null, _pendingShips = null, _pendingSats = null;

  const COLORS = {
    flights   : '#00ffe0',
    ships     : '#4488ff',
    satellites: '#ffd700',
    jamming   : '#ff4444',

    webcams   : '#ff69b4',
    // Airspace by class/type
    airspace  : {
      DANGER      : '#ff2222',
      RESTRICTED  : '#ff6600',
      PROHIBITED  : '#cc0000',
      CTR         : '#44aaff',
      TMA         : '#2266cc',
      FIR         : '#6644aa',
      UIR         : '#8855bb',
      CLASS_A     : '#ff4444',
      CLASS_B     : '#ff8800',
      CLASS_C     : '#ffcc00',
      CLASS_D     : '#44aaff',
      CLASS_E     : '#22cc44',
      DEFAULT     : '#8888aa',
    },
  };

  const POPUP_STYLE = `
    .leaflet-popup-content-wrapper {
      background: rgba(2,10,20,0.95) !important;
      border: 1px solid rgba(0,255,224,0.25) !important;
      color: #c8d8e8 !important;
      border-radius: 0 !important;
      font-family: 'Space Mono', monospace !important;
      font-size: 11px !important;
      box-shadow: 0 0 20px rgba(0,255,224,0.1) !important;
    }
    .leaflet-popup-tip-container { display: none !important; }
    .leaflet-popup-close-button  { color: #4a6070 !important; }
  `;

  // ============================================================
  //  FLIGHT CANVAS LAYER
  //  Custom L.Layer that draws all aircraft on one <canvas>.
  //  Redraws on Leaflet's 'moveend', 'zoomend', and when
  //  _flightData changes. No DOM per flight.
  // ============================================================

  const FlightCanvasLayer = L.Layer.extend({

    onAdd(map) {
      this._map    = map;
      this._canvas = document.createElement('canvas');
      // Mount directly on map container — NOT overlayPane.
      // overlayPane gets CSS-transformed during pan which causes clipping.
      this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none';
      (map.getPane('flightCanvas') || map.getContainer()).appendChild(this._canvas);
      this._resize();

      // Arrow functions keep `this` — avoids Leaflet context binding issues
      this._boundRedraw = () => this._redraw();
      this._boundResize = () => { this._resize(); this._redraw(); };

      map.on('moveend zoomend', this._boundRedraw);
      map.on('resize', this._boundResize);
      window.addEventListener('resize', this._boundResize);

      this._redraw();
    },

    onRemove(map) {
      (map.getPane('flightCanvas') || map.getContainer()).removeChild(this._canvas);
      map.off('moveend zoomend', this._boundRedraw);
      map.off('resize', this._boundResize);
      window.removeEventListener('resize', this._boundResize);
    },

    _resize() {
      const size          = this._map.getSize();
      this._canvas.width  = size.x;
      this._canvas.height = size.y;
    },

    _redraw() {
      if (!this._map || !this._canvas) return;

      const ctx  = this._canvas.getContext('2d');
      const size = this._map.getSize();

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);

      if (!_flightVisible || !_flightData.length) return;

      const zoom      = this._map.getZoom();
      const iconSize  = zoom >= 8 ? 14 : zoom >= 6 ? 11 : zoom >= 4 ? 8 : 5;
      const showLabel = zoom >= 9;
      const pad       = 40; // pixel buffer outside canvas edge

      for (let i = 0; i < _flightData.length; i++) {
        const f = _flightData[i];
        if (f.lat == null || f.lon == null) continue;

        // containerPoint = pixels from map container top-left — reliable after any pan
        const pt = this._map.latLngToContainerPoint([f.lat, f.lon]);

        // Cull by pixel position — always accurate, no stale bounds issue
        if (pt.x < -pad || pt.x > size.x + pad) continue;
        if (pt.y < -pad || pt.y > size.y + pad) continue;

        const hdg = (f.heading || 0) * Math.PI / 180;

        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(hdg);

        // Plane silhouette — scaled to iconSize
        const s = iconSize;
        ctx.fillStyle    = f._selected ? '#ff4444' : COLORS.flights;
        ctx.globalAlpha  = 0.92;
        ctx.shadowBlur   = zoom >= 6 ? 4 : 0;
        ctx.shadowColor  = COLORS.flights;

        ctx.beginPath();
        // Fuselage
        ctx.ellipse(0, 0, s * 0.2, s * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        // Wings
        ctx.beginPath();
        ctx.moveTo(-s * 0.15, -s * 0.1);
        ctx.lineTo(-s * 0.85,  s * 0.25);
        ctx.lineTo(-s * 0.65,  s * 0.4);
        ctx.lineTo( 0,          s * 0.15);
        ctx.lineTo( s * 0.65,  s * 0.4);
        ctx.lineTo( s * 0.85,  s * 0.25);
        ctx.lineTo( s * 0.15, -s * 0.1);
        ctx.closePath();
        ctx.fill();
        // Tail
        ctx.beginPath();
        ctx.moveTo(-s * 0.15, s * 0.45);
        ctx.lineTo(-s * 0.4,  s * 0.75);
        ctx.lineTo(-s * 0.15, s * 0.7);
        ctx.lineTo( 0,         s * 0.6);
        ctx.lineTo( s * 0.15, s * 0.7);
        ctx.lineTo( s * 0.4,  s * 0.75);
        ctx.lineTo( s * 0.15, s * 0.45);
        ctx.closePath();
        ctx.fill();

        ctx.restore();

        // Callsign label — drawn in screen space (no rotation transform)
        if (showLabel && f.callsign) {
          ctx.fillStyle   = 'rgba(0,255,224,0.7)';
          ctx.font        = '9px monospace';
          ctx.shadowBlur  = 0;
          ctx.globalAlpha = 0.8;
          ctx.fillText(f.callsign, pt.x + iconSize + 2, pt.y + 3);
        }
      }
    },

    // Called externally when flight data changes
    setData(flights) {
      _flightData = flights;
      this._redraw();
    },

    // Mouse hit-test — called from map click/mousemove
    getFlightAt(latlng) {
      const pt   = this._map.latLngToContainerPoint(latlng);
      const zoom = this._map.getZoom();
      const hitR = zoom >= 6 ? 14 : 10;

      let best = null, bestDist = hitR * hitR;
      for (let i = 0; i < _flightData.length; i++) {
        const f  = _flightData[i];
        if (f.lat == null) continue;
        const fp = this._map.latLngToContainerPoint([f.lat, f.lon]);
        const dx = pt.x - fp.x, dy = pt.y - fp.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; best = f; }
      }
      return best;
    },
  });

  // ============================================================
  //  SHIP CANVAS LAYER
  //  Same pattern as FlightCanvasLayer — one <canvas> for all ships,
  //  ship silhouette rotated by heading, colored by vessel type.
  // ============================================================

  const ShipCanvasLayer = L.Layer.extend({

    onAdd(map) {
      this._map    = map;
      this._canvas = document.createElement('canvas');
      this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none';
      (map.getPane('shipCanvas') || map.getContainer()).appendChild(this._canvas);
      this._resize();

      this._boundRedraw = () => this._redraw();
      this._boundResize = () => { this._resize(); this._redraw(); };

      // moveend/zoomend → redraw only (size unchanged)
      // resize (from invalidateSize) → resize canvas THEN redraw
      map.on('moveend zoomend', this._boundRedraw);
      map.on('resize', this._boundResize);
      window.addEventListener('resize', this._boundResize);

      this._redraw();
    },

    onRemove(map) {
      (map.getPane('shipCanvas') || map.getContainer()).removeChild(this._canvas);
      map.off('moveend zoomend', this._boundRedraw);
      map.off('resize', this._boundResize);
      window.removeEventListener('resize', this._boundResize);
    },

    _resize() {
      const size          = this._map.getSize();
      this._canvas.width  = size.x;
      this._canvas.height = size.y;
    },

    _redraw() {
      if (!this._map || !this._canvas) return;
      const ctx  = this._canvas.getContext('2d');
      const size = this._map.getSize();

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);

      if (!_shipVisible || !_shipData.length) return;

      const zoom      = this._map.getZoom();
      const iconSize  = zoom >= 8 ? 12 : zoom >= 6 ? 9 : zoom >= 4 ? 7 : 4;
      const useDot    = zoom < 4;   // at world zoom, silhouettes are sub-pixel — use glowing dots
      const showLabel = zoom >= 10;
      const pad       = 40;

      for (let i = 0; i < _shipData.length; i++) {
        const s = _shipData[i];
        if (s.lat == null || s.lon == null || isNaN(s.lat) || isNaN(s.lon)) continue;

        const pt = this._map.latLngToContainerPoint([s.lat, s.lon]);
        if (pt.x < -pad || pt.x > size.x + pad) continue;
        if (pt.y < -pad || pt.y > size.y + pad) continue;

        // Type → color (exact match first, then fallback)
        const color = SHIP_COLORS[s.type] || SHIP_COLORS.Vessel;

        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.shadowBlur  = useDot ? 6 : 5;
        ctx.shadowColor = color;
        ctx.fillStyle   = color;

        if (useDot) {
          // Simple glowing dot — visible at world zoom
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const hdg = ((s.heading != null && s.heading !== 511 ? s.heading : s.course) || 0) * Math.PI / 180;
          ctx.translate(pt.x, pt.y);
          ctx.rotate(hdg);

          const sz = iconSize;
          // Ship silhouette — top-down view, bow pointing up (north before rotation)
          ctx.beginPath();
          ctx.moveTo(0,        -sz * 0.9);   // bow tip
          ctx.lineTo( sz * 0.35, -sz * 0.4); // bow starboard shoulder
          ctx.lineTo( sz * 0.4,   sz * 0.5); // stern starboard
          ctx.lineTo( sz * 0.2,   sz * 0.9); // stern starboard corner
          ctx.lineTo(-sz * 0.2,   sz * 0.9); // stern port corner
          ctx.lineTo(-sz * 0.4,   sz * 0.5); // stern port
          ctx.lineTo(-sz * 0.35, -sz * 0.4); // bow port shoulder
          ctx.closePath();
          ctx.fill();
        }

        ctx.restore();

        if (showLabel && s.name) {
          ctx.fillStyle   = color;
          ctx.font        = '9px monospace';
          ctx.shadowBlur  = 0;
          ctx.globalAlpha = 0.75;
          ctx.fillText(s.name, pt.x + iconSize + 2, pt.y + 3);
        }
      }
    },

    setData(ships) {
      _shipData = ships;
      this._redraw();
    },

    // Mouse hit-test
    getShipAt(latlng) {
      const pt   = this._map.latLngToContainerPoint(latlng);
      const zoom = this._map.getZoom();
      const hitR = zoom >= 6 ? 12 : 8;

      let best = null, bestDist = hitR * hitR;
      for (let i = 0; i < _shipData.length; i++) {
        const s = _shipData[i];
        if (s.lat == null) continue;
        const sp = this._map.latLngToContainerPoint([s.lat, s.lon]);
        const dx = pt.x - sp.x, dy = pt.y - sp.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; best = s; }
      }
      return best;
    },
  });

  // ============================================================
  //  INIT
  // ============================================================

  function init(container, lat, lon, zoomLevel) {
    if (leafletReady) {
      if (lat !== undefined && leafletMap) leafletMap.setView([lat, lon], zoomLevel || 6);
      return;
    }

    const centerLat  = lat       !== undefined ? lat  : 20;
    const centerLon  = lon       !== undefined ? lon  : 10;
    const centerZoom = zoomLevel !== undefined ? zoomLevel : 3;

    leafletMap = L.map('windy', {
      center          : [centerLat, centerLon],
      zoom            : centerZoom,
      zoomControl     : false,
      attributionControl: false,
      preferCanvas    : true,   // tells Leaflet to prefer canvas for vector layers
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom   : 19,
    }).addTo(leafletMap);

    // Shared canvas renderer for ships + satellites (one <canvas> for all)
    _canvasRenderer = L.canvas({ padding: 0.3 });

    const style = document.createElement('style');
    style.textContent = POPUP_STYLE;
    document.head.appendChild(style);

    // Zone layers — split into dot + ring for 3-way toggle
    // None added by default; toggleLayer() adds on first use
    layerGroups.jamming_dot   = L.layerGroup();
    layerGroups.jamming_ring  = L.layerGroup();

    layerGroups.webcams       = L.layerGroup();
    layerGroups.airspace      = L.layerGroup();

    // Satellites use LayerGroup with canvas-rendered markers
    layerGroups.satellites = L.layerGroup().addTo(leafletMap);

    // Canvas panes — direct children of container (not mapPane), so they don't
    // get the Leaflet pan/zoom CSS transform. z-index sits between tile-pane (200)
    // and overlay-pane (400) for ships, above overlay-pane for flights.
    leafletMap.createPane('shipCanvas', leafletMap.getContainer());
    leafletMap.getPane('shipCanvas').style.cssText += ';z-index:390;pointer-events:none';

    leafletMap.createPane('flightCanvas', leafletMap.getContainer());
    leafletMap.getPane('flightCanvas').style.cssText += ';z-index:401;pointer-events:none';

    // Flights: custom canvas layer (z-index managed by flightCanvas pane)
    _flightCanvas = new FlightCanvasLayer();
    _flightCanvas.addTo(leafletMap);

    // Ships: custom canvas layer (z-index managed by shipCanvas pane, below flights)
    _shipCanvas = new ShipCanvasLayer();
    _shipCanvas.addTo(leafletMap);

    leafletReady = true;

    // Click — flights first (higher z-index), then ships
    leafletMap.on('click', (e) => {
      if (_flightVisible) {
        const f = _flightCanvas.getFlightAt(e.latlng);
        if (f) { _showFlightPopup(f, e.latlng); return; }
      }
      if (_shipVisible) {
        const s = _shipCanvas.getShipAt(e.latlng);
        if (s) _showShipPopup(s, e.latlng);
      }
    });

    // Mousemove — flights tooltip takes priority
    leafletMap.on('mousemove', (e) => {
      if (_flightVisible) {
        const f = _flightCanvas.getFlightAt(e.latlng);
        if (f) { _updateCursorTooltip(f, e.containerPoint); return; }
      }
      HUD.hideTooltip();
    });

    leafletMap.on('moveend zoomend', () => {
      if (layerGroups.webcams && leafletMap.hasLayer(layerGroups.webcams)) {
        clearTimeout(_webcamFetchTimer);
        _webcamFetchTimer = setTimeout(_fetchWebcams, 600);
      }
    });

    _hint.init();

    // Mouse coordinates display
    const coordEl = document.getElementById('coords-display');
    if (coordEl) {
      leafletMap.on('mousemove', e => {
        const { lat, lng } = e.latlng;
        const la = Math.abs(lat).toFixed(4) + '° ' + (lat >= 0 ? 'N' : 'S');
        const lo = Math.abs(lng).toFixed(4) + '° ' + (lng >= 0 ? 'E' : 'W');
        coordEl.textContent = la + '  ' + lo;
      });
      leafletMap.on('mouseout', () => { coordEl.textContent = '—'; });
    }
  }

  // ---- Lightweight cursor tooltip (reuses existing HUD tooltip) ----
  function _updateCursorTooltip(flight, pt) {
    if (!flight) { HUD.hideTooltip(); return; }
    HUD.showTooltip(pt.x, pt.y, { type: 'flight', data: flight });
  }

  function _showShipPopup(s, latlng) {
    const color = SHIP_COLORS[s.type] || SHIP_COLORS.Vessel;
    L.popup({ className: 'ship-popup', offset: [0, -8] })
      .setLatLng(latlng)
      .setContent(`
        <div style="color:${color};font-weight:700;font-size:13px;margin-bottom:6px">${s.name || 'Vessel'}</div>
        <div style="color:#4a6070">Type &nbsp;<span style="color:#c8d8e8">${s.type || 'Vessel'}</span></div>
        <div style="color:#4a6070">Speed <span style="color:#c8d8e8">${Math.round(s.speed || 0)} kts</span></div>
        <div style="color:#4a6070">Dest &nbsp;<span style="color:#c8d8e8">${s.dest || '—'}</span></div>
        <div style="color:#4a6070">MMSI &nbsp;<span style="color:#c8d8e8">${s.mmsi || s.id || '—'}</span></div>
        <div style="color:#4a6070">Src &nbsp;&nbsp;<span style="color:#c8d8e8">AISstream</span></div>
      `)
      .openOn(leafletMap);
  }

  function _showFlightPopup(f, latlng) {
    L.popup({ className: 'flight-popup', offset: [0, -8] })
      .setLatLng(latlng)
      .setContent(`
        <div style="color:#00ffe0;font-weight:700;font-size:13px;margin-bottom:6px">${f.callsign || f.id}</div>
        <div style="color:#4a6070">Speed &nbsp;<span style="color:#c8d8e8">${Math.round(f.speed || 0)} kts</span></div>
        <div style="color:#4a6070">Alt &nbsp;&nbsp;&nbsp;<span style="color:#c8d8e8">${(f.alt || 0).toLocaleString()} ft</span></div>
        <div style="color:#4a6070">Origin <span style="color:#c8d8e8">${f.origin || '—'}</span></div>
      `)
      .openOn(leafletMap);
  }

  // ============================================================
  //  POPULATE
  // ============================================================

  function populate(flights, ships, satellites, jammingZones) {
    _populateFlights(flights);
    _populateShips(ships);
    _populateSatellites(satellites);
    _populateJamming(jammingZones);
  }

  function _populateFlights(flights) {
    if (!leafletReady) return;
    _flightData = flights;
    if (_flightCanvas) _flightCanvas.setData(flights);
  }

  // Ships — canvas layer (no DOM nodes per ship)
  function _populateShips(ships) {
    if (!leafletReady) return;
    _shipData = ships;
    if (_shipCanvas) _shipCanvas.setData(ships);
  }

  // Satellites — canvas circle markers with label
  function _populateSatellites(sats) {
    if (!leafletReady) return;

    const incoming = new Set(sats.map(s => String(s.id)));

    _satMarkers.forEach((marker, id) => {
      if (!incoming.has(id)) { layerGroups.satellites.removeLayer(marker); _satMarkers.delete(id); }
    });

    sats.forEach(s => {
      if (s.currentLat === undefined) return;
      const id = String(s.id);

      if (_satMarkers.has(id)) {
        _satMarkers.get(id).setLatLng([s.currentLat, s.currentLon]);
      } else {
        const m = L.circleMarker([s.currentLat, s.currentLon], {
          renderer   : _canvasRenderer,
          radius     : 3,
          color      : COLORS.satellites,
          fillColor  : COLORS.satellites,
          fillOpacity: 0.9,
          weight     : 1,
        });
        m.bindPopup(`
          <div style="color:#ffd700;font-weight:700;font-size:13px;margin-bottom:6px">${s.name}</div>
          <div style="color:#4a6070">Alt &nbsp;<span style="color:#c8d8e8">${s.altKm || '—'} km</span></div>
          <div style="color:#4a6070">Src &nbsp;<span style="color:#c8d8e8">NORAD TLE</span></div>
        `);
        layerGroups.satellites.addLayer(m);
        _satMarkers.set(id, m);
        s._mapMarker = m;
      }
    });
  }

  function _populateJamming(zones) {
    layerGroups.jamming_dot.clearLayers();
    layerGroups.jamming_ring.clearLayers();
    zones.forEach(z => {
      const popup = `<div style="color:#ff4444;font-weight:700;font-size:13px;margin-bottom:4px">⚡ GPS Jamming</div>
        <div style="color:#4a6070">Location &nbsp;<span style="color:#c8d8e8">${z.label}</span></div>
        <div style="color:#4a6070">Radius &nbsp;&nbsp;&nbsp;<span style="color:#c8d8e8">${z.radius} km</span></div>
        <div style="color:#4a6070">Intensity <span style="color:#ff4444">${Math.round(z.intensity * 100)}%</span></div>`;

      // Dot marker (mode 1+2)
      L.circleMarker([z.lat, z.lon], {
        renderer   : _canvasRenderer,
        radius     : 6,
        color      : COLORS.jamming,
        fillColor  : COLORS.jamming,
        fillOpacity: 1,
        weight     : 2,
      }).bindPopup(popup).addTo(layerGroups.jamming_dot);

      // Radius ring (mode 2 only)
      L.circle([z.lat, z.lon], {
        renderer   : _canvasRenderer,
        radius     : z.radius * 1000,
        color      : COLORS.jamming,
        fillColor  : COLORS.jamming,
        fillOpacity: 0.07,
        weight     : 1.5,
        opacity    : 0.7,
        dashArray  : '5 5',
      }).bindPopup(popup).addTo(layerGroups.jamming_ring);
    });
    // Re-apply current mode visibility
    _applyZoneMode('jamming');
  }


  // ============================================================
  //  SYNC POSITIONS — throttled to one rAF per call batch
  //  No dead reckoning in 2D — positions shown as-is from server.
  //  Dead reckoning causes visible drift on flat map.
  // ============================================================

  function syncPositions(flights, ships, satellites) {
    if (!leafletReady) return;

    _pendingFlights = flights;
    _pendingShips   = ships;
    _pendingSats    = satellites;

    if (_syncPending) return;
    _syncPending = true;

    requestAnimationFrame(() => {
      _syncPending = false;

      // Flights — redraw canvas with latest positions (no extrapolation)
      if (_pendingFlights) {
        _flightData = _pendingFlights;
        if (_flightCanvas) _flightCanvas.setData(_flightData);
      }

      // Ships — redraw canvas with latest positions
      if (_pendingShips) {
        _shipData = _pendingShips;
        if (_shipCanvas) _shipCanvas.setData(_shipData);
      }

      // Satellites — move existing markers
      if (_pendingSats) {
        _pendingSats.forEach(s => {
          if (s.currentLat === undefined) return;
          const m = _satMarkers.get(String(s.id));
          if (m) m.setLatLng([s.currentLat, s.currentLon]);
        });
      }
    });
  }

  // ============================================================
  //  LAYER TOGGLING
  // ============================================================

  function populateLayer(name, data) {
    if (!leafletReady) return;
    if      (name === 'flights')    _populateFlights(data);
    else if (name === 'ships')      _populateShips(data);
    else if (name === 'satellites') _populateSatellites(data);
    else if (name === 'jamming')    _populateJamming(data); // <-- DIESE ZEILE NEU
  }

  // Apply dot/ring visibility based on current _zoneMode
  function _applyZoneMode(type) {
    if (!leafletMap) return;
    const mode    = _zoneMode[type];
    const dotGrp  = layerGroups[type + '_dot'];
    const ringGrp = layerGroups[type + '_ring'];

    // Dot: visible in mode 1 + 2
    if (mode >= 1) { if (!leafletMap.hasLayer(dotGrp))  leafletMap.addLayer(dotGrp); }
    else           { if (leafletMap.hasLayer(dotGrp))   leafletMap.removeLayer(dotGrp); }

    // Ring: visible in mode 2 only
    if (mode === 2) { if (!leafletMap.hasLayer(ringGrp)) leafletMap.addLayer(ringGrp); }
    else            { if (leafletMap.hasLayer(ringGrp))  leafletMap.removeLayer(ringGrp); }
  }

  // Returns new mode (0/1/2) for UI to update toggle indicator
  function toggleLayer(name) {
    if (!leafletReady) return 0;

    // ---- Flights (binary) ----
    if (name === 'flights') {
      _flightVisible = !_flightVisible;
      if (_flightCanvas) {
        if (_flightVisible) { _flightCanvas.addTo(leafletMap); _flightCanvas._redraw(); }
        else                { leafletMap.removeLayer(_flightCanvas); }
      }
      return _flightVisible ? 1 : 0;
    }

    // ---- Ships (binary, canvas layer) ----
    if (name === 'ships') {
      _shipVisible = !_shipVisible;
      if (_shipCanvas) {
        if (_shipVisible) { _shipCanvas.addTo(leafletMap); _shipCanvas._redraw(); }
        else              { leafletMap.removeLayer(_shipCanvas); }
      }
      return _shipVisible ? 1 : 0;
    }

    // ---- 3-way zone toggles ----
    if (name === 'jamming') {
      _zoneMode[name] = (_zoneMode[name] + 1) % 3;
      _applyZoneMode(name);
      return _zoneMode[name]; // 0, 1, or 2
    }

    // ---- Airspace ----
    if (name === 'airspace') {
      _airspaceVisible = !_airspaceVisible;
      if (_airspaceVisible) {
        leafletMap.addLayer(layerGroups.airspace);
        if (!_airspaceLoaded) _fetchAirspace();
      } else {
        leafletMap.removeLayer(layerGroups.airspace);
        const nameEl = document.getElementById('airspace-region-label');
        const rowEl  = document.getElementById('pc-airspace-row');
        if (nameEl) nameEl.textContent = '';
        if (rowEl)  rowEl.style.display = 'none';
        _currentAirspaceRegion = null;
      }
      return _airspaceVisible ? 1 : 0;
    }

    // ---- Binary layers (ships, satellites, webcams) ----
    const group = layerGroups[name];
    if (!group) return 0;
    if (leafletMap.hasLayer(group)) {
      leafletMap.removeLayer(group);
      return 0;
    } else {
      leafletMap.addLayer(group);
      if (name === 'webcams') _fetchWebcams();
      return 1;
    }
  }

  // ---- Airspace fetch from proxy → OpenAIP ----
  // ---- Airspace fetch — region-based, browser HTTP cache does the rest ----
  // Proxy serves fixed regions (europe/asia/etc) from its 24h background cache.
  // Browser sends only map center → proxy finds region → always from cache.
  // Multiple users hit the same cached region: zero extra OpenAIP API calls.
  let _currentAirspaceRegion = null;

  async function _fetchAirspace() {
    _airspaceLoaded = true;
    const center    = leafletMap.getCenter();
    const url       = `/api/airspace?lat=${center.lat.toFixed(2)}&lon=${center.lng.toFixed(2)}`;
    const layerEl   = document.getElementById('layer-airspace');
    if (layerEl) layerEl.classList.add('loading');

    try {
      const res      = await fetch(url);
      const cacheHdr = res.headers.get('X-Airspace') || '?';
      const data     = await res.json();
      if (layerEl) layerEl.classList.remove('loading');
      console.log(`[Airspace] ${cacheHdr}`);

      if (!Array.isArray(data) || data.length === 0) {
        _airspaceLoaded = false;
        return;
      }

      // Extract region id from header e.g. "1722 zones (europe, 0h)"
      const regionMatch = cacheHdr.match(/\((\S+),/);
      const regionId    = regionMatch ? regionMatch[1] : null;

      // Only re-render if region actually changed
      if (regionId !== _currentAirspaceRegion) {
        _currentAirspaceRegion = regionId;
        _renderAirspace(data);
      }

      // Update coords panel airspace row
      const nameEl = document.getElementById('airspace-region-label');
      const rowEl  = document.getElementById('pc-airspace-row');
      if (nameEl) nameEl.textContent = regionId ? regionId.toUpperCase().replace(/-/g, '\u00A0') : '';
      if (rowEl)  rowEl.style.display = regionId ? '' : 'none';

      // Re-check region when user pans (browser cache makes same-region free)
      leafletMap.once('moveend', () => {
        if (_airspaceVisible) { _airspaceLoaded = false; _fetchAirspace(); }
      });
    } catch (e) {
      console.error('[Airspace] Fetch failed:', e.message);
      _airspaceLoaded = false;
      const layerEl = document.getElementById('layer-airspace');
      if (layerEl) layerEl.classList.remove('loading');
    }
  }

  function _renderAirspace(features) {
    _airspaceCache = features;
    layerGroups.airspace.clearLayers();
    if (!features || !features.length) return;

    const typeCounts = {};
    let rendered = 0, skipped = 0;

    features.forEach(f => {
      const type  = (f.type || f.airspaceClass || 'DEFAULT').toUpperCase();
      const group = AIRSPACE_GROUPS[type] || 'other';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      if (!_airspaceFilter[group] && group !== 'other') { skipped++; return; }
      const color = COLORS.airspace[type] || COLORS.airspace.DEFAULT;
      const name    = f.name || type;
      const lowerFt = f.lowerLimit != null ? f.lowerLimit + ' ft' : 'GND';
      const upperFt = f.upperLimit != null ? f.upperLimit + ' ft' : '—';

      const popup = `
        <div style="color:${color};font-weight:700;font-size:13px;margin-bottom:4px">${name}</div>
        <div style="color:#4a6070">Type &nbsp;&nbsp;<span style="color:#c8d8e8">${type}</span></div>
        <div style="color:#4a6070">Floor &nbsp;<span style="color:#c8d8e8">${lowerFt}</span></div>
        <div style="color:#4a6070">Ceiling <span style="color:#c8d8e8">${upperFt}</span></div>
      `;

      // GeoJSON geometry (polygon/multipolygon from OpenAIP)
      if (f.geometry && f.geometry.coordinates) {
        L.geoJSON(f.geometry, {
          renderer   : _canvasRenderer,
          style      : {
            color      : color,
            fillColor  : color,
            fillOpacity: type === 'DANGER' || type === 'PROHIBITED' ? 0.12 : 0.05,
            weight     : type === 'FIR' || type === 'UIR' ? 1 : 1.5,
            opacity    : 0.8,
            dashArray  : type === 'FIR' || type === 'UIR' ? '6 4' : null,
          },
        }).bindPopup(popup).addTo(layerGroups.airspace);
        rendered++;
      } else if (f.bbox) {
        // Fallback: simple rectangle from bbox [w, s, e, n]
        const [w, s, e, n] = f.bbox;
        L.rectangle([[s, w], [n, e]], {
          renderer   : _canvasRenderer,
          color      : color,
          fillColor  : color,
          fillOpacity: 0.05,
          weight     : 1.5,
          opacity    : 0.7,
          dashArray  : '6 3',
        }).bindPopup(popup).addTo(layerGroups.airspace);
        rendered++;
      } else {
        skipped++;
      }
    });
    console.log(`[Airspace] Drew ${rendered} polygons, skipped ${skipped} (no geometry) | Types:`, typeCounts);
  }

  // ============================================================
  //  WEATHER OVERLAY
  // ============================================================

  const OWM_LAYERS = { wind: 'wind_new', temp: 'temp_new', clouds: 'clouds_new', pressure: 'pressure_new' };

  async function setOverlay(name) {
    if (_overlayLayer) { leafletMap.removeLayer(_overlayLayer); _overlayLayer = null; }
    if (!name || !leafletReady) return;

    if (name === 'rain' || name === 'clouds') {
      try {
        const data   = await fetch('/api/rainviewer').then(r => r.json());
        let path;
        if (name === 'rain') {
          const latest = (data.radar && data.radar.past || []).slice(-1)[0];
          if (!latest) throw new Error('no radar');
          path = latest.path + '/256/{z}/{x}/{y}/6/1_1.png';
        } else {
          const ir     = data.satellite && (data.satellite.infrared || data.satellite.ir);
          const latest = (ir || []).slice(-1)[0];
          if (!latest) throw new Error('no satellite');
          path = latest.path + '/256/{z}/{x}/{y}/0/0_0.png';
        }
        _overlayLayer = L.tileLayer('https://tilecache.rainviewer.com' + path, { opacity: 0.55, maxZoom: 18 }).addTo(leafletMap);
      } catch (e) { console.warn('[Map2D] RainViewer:', e.message); }
      return;
    }

    const owmLayer = OWM_LAYERS[name];
    if (!owmLayer) return;
    _overlayLayer = L.tileLayer('/api/owm-tiles/' + owmLayer + '/{z}/{x}/{y}', { opacity: 0.55, maxZoom: 18 }).addTo(leafletMap);
  }

  // ============================================================
  //  WEBCAMS (unchanged — low count, infrequent)
  // ============================================================

  const _hint = {
    el    : null,
    textEl: null,
    btnEl : null,
    init() {
      this.el     = document.getElementById('map-hint');
      this.textEl = document.getElementById('map-hint-text');
      this.btnEl  = document.getElementById('map-hint-action');
    },
    show(text, btnLabel, btnCb) {
      if (!this.el) return;
      this.textEl.textContent = text;
      if (btnLabel && btnCb) {
        this.btnEl.textContent = btnLabel;
        this.btnEl.onclick     = btnCb;
        this.btnEl.style.display = 'inline-block';
      } else {
        this.btnEl.style.display = 'none';
      }
      this.el.style.display = 'flex';
    },
    hide() { if (this.el) this.el.style.display = 'none'; },
  };

  function _fetchWebcams(global) {
    if (!leafletReady || !layerGroups.webcams) return;
    const zoom = leafletMap.getZoom();

    if (!global && zoom < 7) {
      _hint.show(
        'Drag + zoom to find cameras near you',
        'Load global (50)',
        () => { _hint.hide(); _fetchWebcams(true); }
      );
      _renderWebcams([]);
      return;
    }

    _hint.hide();
    const params = global
      ? { limit: 50 }
      : (() => {
          const b = leafletMap.getBounds();
          return { n: b.getNorth().toFixed(4), s: b.getSouth().toFixed(4),
                   e: b.getEast().toFixed(4),  w: b.getWest().toFixed(4), limit: 50 };
        })();

    fetch('/api/windy-webcams?' + new URLSearchParams(params))
      .then(r => r.json())
      .then(data => _renderWebcams(data.webcams || []))
      .catch(() => {});
  }

  // Camera icon — drawn once, reused for all webcam markers
  const _webcamIcon = (() => {
    const S = 22, cx = S / 2, cy = S / 2;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');

    // Glow
    x.shadowColor = '#ff69b4';
    x.shadowBlur  = 5;

    // Camera body
    x.fillStyle = '#ff69b4';
    x.beginPath();
    x.roundRect(3, 6, 16, 11, 2);
    x.fill();

    // Viewfinder bump
    x.beginPath();
    x.roundRect(8, 3, 6, 4, 1);
    x.fill();

    // Lens (dark circle + inner ring)
    x.shadowBlur = 0;
    x.fillStyle  = '#1a0a12';
    x.beginPath();
    x.arc(cx, cy + 2, 4, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = 'rgba(255,105,180,0.6)';
    x.lineWidth   = 1;
    x.beginPath();
    x.arc(cx, cy + 2, 2.5, 0, Math.PI * 2);
    x.stroke();

    return L.icon({
      iconUrl    : c.toDataURL(),
      iconSize   : [S, S],
      iconAnchor : [cx, cy + 2],
      popupAnchor: [0, -cy],
    });
  })();

  function _renderWebcams(cams) {
    if (!layerGroups.webcams) return;
    layerGroups.webcams.clearLayers();
    cams.forEach(cam => {
      const loc   = cam.location;
      const thumb = cam.images && cam.images.current && cam.images.current.preview;
      const live  = cam.images && cam.images.current && cam.images.current.medium;
      if (!loc || !loc.latitude || !loc.longitude) return;

      const icon = _webcamIcon;
      L.marker([loc.latitude, loc.longitude], { icon })
        .bindPopup(`
          <div style="color:#ff69b4;font-weight:700;font-size:12px;margin-bottom:6px">${cam.title || 'Webcam'}</div>
          ${(live || thumb) ? `<img src="${live || thumb}" style="width:220px;height:124px;object-fit:cover;border:1px solid rgba(255,105,180,0.3);display:block;margin-bottom:6px">` : ''}
          <div style="color:#4a6070;font-size:11px;margin-bottom:4px">${[loc.city, loc.country].filter(Boolean).join(' · ')}</div>
          <div style="display:flex;gap:8px">
            ${cam.urls && cam.urls.detail  ? `<a href="${cam.urls.detail}"  target="_blank" style="color:#ff69b4;font-size:11px">🔗 Live</a>` : ''}
            ${cam.urls && cam.urls.website ? `<a href="${cam.urls.website}" target="_blank" style="color:#4a6070;font-size:11px">↗ Web</a>` : ''}
          </div>
        `, { maxWidth: 240 })
        .addTo(layerGroups.webcams);
    });
  }

  // ============================================================
  //  UTILS
  // ============================================================

  function invalidate() { if (leafletMap) leafletMap.invalidateSize(); }
  function getCenter()  { return leafletMap ? leafletMap.getCenter() : null; }

  function getZoneMode(name) { return _zoneMode[name] ?? 0; }

  // Called by app.js on map init to sync state without toggling
  function setZoneMode(name, mode) {
    if (!leafletReady) return;
    _zoneMode[name] = mode;
    _applyZoneMode(name);
  }

  function toggleAirspaceFilter(group) {
    _airspaceFilter[group] = !_airspaceFilter[group];
    if (_airspaceCache) _renderAirspace(_airspaceCache);
    return _airspaceFilter[group];
  }

  return { init, populate, populateLayer, syncPositions, toggleLayer, getZoneMode, setZoneMode, invalidate, getCenter, setOverlay, toggleAirspaceFilter };

})();