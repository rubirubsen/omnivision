/* =====================================================
   APP — Main orchestrator
   Wires: Data ↔ API ↔ Globe ↔ Map2D ↔ HUD
===================================================== */
var jammingFilter = { combat: true, border: true, strat: true };

var App = (function() {

  var flights    = [];
  var ships      = [];
  var satellites = [];
  var currentView = 'globe';
  var t           = 0;
  var rotating    = false;

  // Layer state: booleans for binary layers, number (0/1/2) for 3-way zone toggles
  var layerState = {
    flights   : true,
    ships     : true,
    satellites: true,
    jamming   : 1,    // 0=off, 1=dot only, 2=dot+radius
    webcams   : false,
    airspace  : false,
  };

  // Ship type filters (matches _vesselType() categories in api.js)
  var shipFilter = {
    Cargo  : true, Tanker : true, Passenger: true,
    Fishing: true, Sailing: true, Pleasure : true,
    Tug    : true, SAR    : true, Vessel   : true,
  };

  // Flight filters
  var flightTypeFilter = { commercial: true, cargo: true, military: true, private: true };
  var flightAlt        = { min: 0, max: 60000 };

  var _CARGO_PFX = ['FDX','UPS','CLX','GTI','ABD','PAC','VKG','ATN','CKS','BOX','CAO','TAY','NPT','SWG','TGX','MPH'];
  var _MIL_PFX   = ['RCH','SPAR','VALOR','KNIFE','JAKE','EXEC','NAVY','ARMY','USAF','GAF','RAF','JOLLY','PEDRO','MAGIC','DUKE','FURY','HAWK','BONE','BUFF','VIPER','COBRA','SLAM'];

  function _classifyFlight(f) {
    if (f.military) return 'military';
    var cs = (f.callsign || '').toUpperCase();
    if (_MIL_PFX.some(function(p) { return cs.startsWith(p); })) return 'military';
    if (_CARGO_PFX.some(function(p) { return cs.startsWith(p); })) return 'cargo';
    if (!cs || cs.length < 4 || /^[0-9A-F]{6}$/i.test(cs)) return 'private';
    return 'commercial';
  }

  function init() {
    ships = Data.generateShips();
    Globe.init(document.getElementById('canvas-container'));
    Globe.populate(flights, ships, satellites, Data.jammingZones);
    Globe.onMaxZoom(function(rotX, rotY) {
      var lat = -(rotX * 180 / Math.PI);
      var lon =  (rotY * 180 / Math.PI) % 360;
      if (lon > 180)  lon -= 360;
      if (lon < -180) lon += 360;
      _autoSwitchToMap(lat, lon);
    });
    HUD.startClock();
    HUD.updateStats({ flights: flights, ships: ships, jammingZones: Data.jammingZones, satellites: satellites });
    _syncAllToggleUI();
    _initFilterDivs();
    _attachGlobeHover();
    _loop();
    API.init(_onLiveFlights, _onLiveSatellites, _onLiveShips, function(msg) { console.warn(msg); });
  }

  // Show filter sub-panels whose parent layer starts ON
  function _initFilterDivs() {
    var map = {
      'flight-filters' : layerState.flights,
      'ship-filters'   : layerState.ships,
      'jamming-filters': layerState.jamming > 0,
    };
    Object.keys(map).forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = map[id] ? '' : 'none';
    });
    if (layerState.flights) _updateAltTrack();
  }

  // Push all current state values to HUD toggle indicators
  function _syncAllToggleUI() {
    Object.keys(layerState).forEach(function(name) {
      var val = layerState[name];
      HUD.setToggleState(name, typeof val === 'number' ? val : (val ? 1 : 0));
    });
  }

  // Sync map layer visibility after Map2D.init() + populate().
  function _syncMapLayers() {
    ['flights', 'ships', 'satellites'].forEach(function(name) {
      if (!layerState[name]) Map2D.toggleLayer(name);
    });
    Map2D.setZoneMode('jamming', layerState.jamming);
    if (layerState.webcams)  Map2D.toggleLayer('webcams');
    if (layerState.airspace) Map2D.toggleLayer('airspace');
  }

  // Density-preserving grid sampler — keeps max N per 10°x10° cell.
  // Globe always gets thinned data; 2D map gets the full filtered set.
  function _thinForGlobe(data, maxPerCell) {
    maxPerCell = maxPerCell || 4;
    var GRID_LON = 36;
    var cells = {}, result = [];
    data.forEach(function(f) {
      var ci = (Math.floor((f.lat + 90)  / 10) * GRID_LON) +
                Math.floor((f.lon + 180) / 10);
      cells[ci] = (cells[ci] || 0);
      if (cells[ci] < maxPerCell) { result.push(f); cells[ci]++; }
    });
    return result;
  }

  function _filteredFlights() {
    return flights.filter(function(f) {
      var alt = f.alt || 0;
      if (alt < flightAlt.min || alt > flightAlt.max) return false;
      return flightTypeFilter[_classifyFlight(f)] !== false;
    });
  }

  function _filteredShips() {
    return ships.filter(function(s) {
      var t = s.type || 'Vessel';
      return shipFilter[t] !== false;
    });
  }

  function _onLiveFlights(liveData) {
    if (!liveData || !liveData.length) return;
    flights = liveData;
    var filtered = _filteredFlights();
    Globe.populateLayer('flights', _thinForGlobe(filtered));
    if (currentView === 'map') Map2D.populateLayer('flights', filtered);
    HUD.updateStats({ flights: filtered, ships: ships, jammingZones: Data.jammingZones, satellites: satellites });
  }

  function _onLiveShips(liveData) {
    if (!liveData || !liveData.length) return;
    ships = liveData;
    var filtered = _filteredShips();
    Globe.populateLayer('ships', _thinForGlobe(filtered, 3));
    if (currentView === 'map') Map2D.populateLayer('ships', filtered);
    HUD.updateStats({ flights: flights, ships: filtered, jammingZones: Data.jammingZones, satellites: satellites });
  }

  function _onLiveSatellites(liveData) {
    if (!liveData || !liveData.length) return;
    var oldMeshes = satellites.map(function(s) { return s._mesh || null; });
    satellites = liveData.map(function(s, i) { s._mesh = oldMeshes[i] || null; return s; });
    var hasNewMeshes = satellites.some(function(s) { return !s._mesh; });
    if (hasNewMeshes) {
      Globe.populateLayer('satellites', satellites);
      if (currentView === 'map') Map2D.populateLayer('satellites', satellites);
    }
    HUD.updateStats({ flights: flights, ships: ships, jammingZones: Data.jammingZones, satellites: satellites });
  }

  function _loop() {
    requestAnimationFrame(_loop);
    t += 0.016;
    Data.tick(ships);
    Globe.syncPositions(flights, ships, satellites);
    if (currentView === 'map') Map2D.syncPositions(flights, ships, satellites);
    Globe.render(t);
  }

  async function _autoSwitchToMap(lat, lon) {
    if (currentView === 'map') return;
    currentView = 'map';
    HUD.setActiveView('map');
    var globeEl = document.getElementById('canvas-container');
    var mapEl   = document.getElementById('map-container');
    globeEl.style.transition = 'opacity 0.5s';
    globeEl.style.opacity    = '0';
    await new Promise(function(r){ setTimeout(r, 500); });
    globeEl.style.display    = 'none';
    globeEl.style.opacity    = '1';
    globeEl.style.transition = '';
    mapEl.style.display = 'block';
    Map2D.init(mapEl, lat, lon, 6);
    Map2D.populate(flights, ships, satellites, Data.jammingZones);
    Map2D.invalidate();
    _syncMapLayers();
    Globe.resetZoom();
  }

  async function setView(view) {
    if (view === currentView) return;
    currentView = view;
    HUD.setActiveView(view);
    var globeEl = document.getElementById('canvas-container');
    var mapEl   = document.getElementById('map-container');
    if (view === 'map') {
      globeEl.style.display = 'none';
      mapEl.style.display   = 'block';
      Map2D.init(mapEl);
      Map2D.populate(flights, ships, satellites, Data.jammingZones);
      Map2D.invalidate();
      _syncMapLayers();
    } else {
      mapEl.style.display   = 'none';
      globeEl.style.display = 'block';
      Globe.refresh();  // force re-render in case _needsRender was false while map was shown
    }
  }

  function toggleRotation() {
    rotating = !rotating;
    Globe.setAutoRotate(rotating);
    var btn = document.getElementById('btn-rotate');
    if (btn) btn.classList.toggle('active', rotating);
  }

  function toggleJammingFilter(type, btn) {
    jammingFilter[type] = !jammingFilter[type];
    if (btn) btn.classList.toggle('on', jammingFilter[type]);
    
    // Daten filtern und beide Maps updaten
    var filtered = Data.jammingZones.filter(function(z) { return jammingFilter[z.type]; });
    Globe.populateLayer('jamming', filtered);
    if (currentView === 'map' && typeof Map2D !== 'undefined') {
      Map2D.populateLayer('jamming', filtered);
    }
  }

  function toggleLayer(name) {
    if (name === 'airspace' && currentView !== 'map') return;

    if (name === 'flights') {
      layerState.flights = !layerState.flights;
      HUD.setToggleState('flights', layerState.flights ? 1 : 0);
      Globe.toggleLayer('flights');
      if (currentView === 'map') Map2D.toggleLayer('flights');
      var ff = document.getElementById('flight-filters');
      if (ff) ff.style.display = layerState.flights ? '' : 'none';
      return;
    }

    if (name === 'ships') {
      layerState.ships = !layerState.ships;
      HUD.setToggleState('ships', layerState.ships ? 1 : 0);
      Globe.toggleLayer('ships');
      if (currentView === 'map') Map2D.toggleLayer('ships');
      var sf = document.getElementById('ship-filters');
      if (sf) sf.style.display = layerState.ships ? '' : 'none';
      return;
    }

    if (name === 'jamming') {
      var prev = layerState.jamming;
      layerState.jamming = (layerState.jamming + 1) % 3;
      HUD.setToggleState('jamming', layerState.jamming);
      if (prev === 0) Globe.toggleLayer('jamming');           // 0→1: turn on
      if (layerState.jamming === 0) Globe.toggleLayer('jamming'); // 2→0: turn off
      if (currentView === 'map') Map2D.setZoneMode('jamming', layerState.jamming);
      var filtersEl = document.getElementById('jamming-filters');
      if (filtersEl) filtersEl.style.display = layerState.jamming > 0 ? '' : 'none';
      return;
    }

    // Binary layers
    layerState[name] = !layerState[name];
    HUD.setToggleState(name, layerState[name] ? 1 : 0);

    if (name === 'webcams') {
      Globe.toggleLayer('webcams');
      if (layerState.webcams) _fetchGlobeWebcams();
      if (currentView === 'map') Map2D.toggleLayer('webcams');
      return;
    }

    if (name === 'airspace') {
      if (currentView === 'map') Map2D.toggleLayer(name);
      var filtersEl = document.getElementById('airspace-filters');
      if (filtersEl) filtersEl.style.display = layerState.airspace ? '' : 'none';
      return;
    }

    Globe.toggleLayer(name);
    if (currentView === 'map') Map2D.toggleLayer(name);
  }

  function toggleAirspaceFilter(group, btn) {
    if (typeof Map2D === 'undefined') return;
    var on = Map2D.toggleAirspaceFilter(group);
    if (btn) btn.classList.toggle('on', on);
  }

  function toggleShipFilter(type, btn) {
    // SAR shares the Tug button
    var types = type === 'Tug' ? ['Tug', 'SAR', 'Pilot', 'Law Enforcement'] : [type];
    var newState = !shipFilter[types[0]];
    types.forEach(function(t) { shipFilter[t] = newState; });
    if (btn) btn.classList.toggle('on', newState);
    var filtered = _filteredShips();
    Globe.populateLayer('ships', _thinForGlobe(filtered, 3));
    if (currentView === 'map') Map2D.populateLayer('ships', filtered);
    HUD.updateStats({ flights: flights, ships: filtered, jammingZones: Data.jammingZones, satellites: satellites });
  }

  function toggleFlightTypeFilter(type, btn) {
    flightTypeFilter[type] = !flightTypeFilter[type];
    if (btn) btn.classList.toggle('on', flightTypeFilter[type]);
    _applyFlightFilter();
  }

  function setAltMin(val) {
    flightAlt.min = Math.min(val, flightAlt.max - 1000);
    var el = document.getElementById('alt-min');
    if (el) el.value = flightAlt.min;
    _updateAltTrack();
    _applyFlightFilter();
  }

  function setAltMax(val) {
    flightAlt.max = Math.max(val, flightAlt.min + 1000);
    var el = document.getElementById('alt-max');
    if (el) el.value = flightAlt.max;
    _updateAltTrack();
    _applyFlightFilter();
  }

  function _updateAltTrack() {
    var minPct = (flightAlt.min / 60000) * 100;
    var maxPct = (flightAlt.max / 60000) * 100;
    var track  = document.getElementById('alt-range-track');
    if (track) track.style.background =
      'linear-gradient(to right, #1a1a2e ' + minPct + '%, #00ffe0 ' + minPct + '%, #00ffe0 ' + maxPct + '%, #1a1a2e ' + maxPct + '%)';
    var minLbl = document.getElementById('alt-min-label');
    var maxLbl = document.getElementById('alt-max-label');
    if (minLbl) minLbl.textContent = flightAlt.min === 0 ? '0' : Math.round(flightAlt.min / 1000) + 'k ft';
    if (maxLbl) maxLbl.textContent = flightAlt.max >= 60000 ? 'MAX' : Math.round(flightAlt.max / 1000) + 'k ft';
  }

  function _applyFlightFilter() {
    var filtered = _filteredFlights();
    Globe.populateLayer('flights', _thinForGlobe(filtered));
    if (currentView === 'map') Map2D.populateLayer('flights', filtered);
    HUD.updateStats({ flights: filtered, ships: ships, jammingZones: Data.jammingZones, satellites: satellites });
  }

  function _fetchGlobeWebcams() {
    fetch('/api/windy-webcams?limit=50')
      .then(function(r) { return r.json(); })
      .then(function(d) { Globe.populateLayer('webcams', d.webcams || []); })
      .catch(function() {});
  }

  function toggleWeather() {
    var open = HUD.toggleWeatherPanel();
    var btn  = document.getElementById('btn-weather');
    if (btn) btn.classList.toggle('active', open);
    if (open) {
      var lat = 53.55, lon = 9.99;
      if (currentView === 'map' && typeof Map2D !== 'undefined') {
        var c = Map2D.getCenter ? Map2D.getCenter() : null;
        if (c) { lat = c.lat; lon = c.lng; }
      }
      Weather.load(lat, lon);
    }
  }

  var _selectedFlight = null;

  function deselectFlight() {
    _selectedFlight = null;
    Globe.deselectFlight();
    HUD.closeFlightPanel();
  }

  function _attachGlobeHover() {
    var canvas = Globe.getCanvas();
    if (!canvas) return;
    var mouse = new THREE.Vector2();
    canvas.addEventListener('mousemove', function(e) {
      mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      HUD.showTooltip(e.clientX, e.clientY, Globe.getHitAtMouse(mouse));
    });
    canvas.addEventListener('click', function(e) {
      mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      var hit = Globe.getHitAtMouse(mouse);
      if (!hit || hit.type !== 'flight') { deselectFlight(); return; }
      var f = hit.data;
      _selectedFlight = f;
      Globe.selectFlight(f._instanceIdx);
      HUD.openFlightPanel(f);
      if (f._destLoaded) {
        HUD.updateFlightRoute(f.departure, f.destination);
      } else {
        HUD.updateFlightRoute('—', '—');
      }
    });
    canvas.addEventListener('mouseleave', function() { HUD.hideTooltip(); });
  }

  function togglePanelBtn(panelId, btnId) {
    var panel = document.getElementById(panelId);
    var btn   = document.getElementById(btnId);
    if (!panel) return;
    var hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
    if (btn) btn.classList.toggle('active', hidden);
  }

  return { init, setView, toggleLayer, toggleRotation, toggleJammingFilter, deselectFlight, toggleWeather, togglePanelBtn, toggleAirspaceFilter, toggleShipFilter, toggleFlightTypeFilter, setAltMin, setAltMax };

}());

document.addEventListener('DOMContentLoaded', function() { App.init(); });