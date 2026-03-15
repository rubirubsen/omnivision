var HUD = (function() {

  function startClock() {
    var el = document.getElementById('clock');
    function tick() {
      el.textContent = new Date().toISOString().replace('T',' ').slice(0,19) + ' UTC';
    }
    tick(); setInterval(tick, 1000);
  }

  function updateStats(counts) {
    const total   = counts.flights.length;
    const visible = counts.globeFlights !== undefined ? counts.globeFlights : total;
    const flightEl = document.getElementById('ac-count');
    if (flightEl) {
      flightEl.textContent = visible < total
        ? visible.toLocaleString() + ' / ' + total.toLocaleString()
        : total.toLocaleString();
      flightEl.title = visible < total
        ? 'Globe shows ' + visible.toLocaleString() + ' of ' + total.toLocaleString() + ' flights. Switch to 2D map to see all.'
        : '';
    }
    document.getElementById('ship-count').textContent = counts.ships.length.toLocaleString();
    document.getElementById('jam-count').textContent  = counts.jammingZones.length;
    document.getElementById('sat-count').textContent  = counts.satellites.length;
  }

  // ---- Hover Tooltip — minimal ----
  function showTooltip(x, y, userData) {
    if (!userData) { hideTooltip(); return; }
    var t = document.getElementById('tooltip');
    var data = userData.data;
    t.style.display = 'block';
    t.style.left = (x + 16) + 'px';
    t.style.top  = (y - 10) + 'px';

    if (userData.type === 'flight') {
      document.getElementById('tip-name').textContent   = data.callsign || data.id || '???';
      document.getElementById('tip-origin').textContent = data.origin   || data.country || '—';
    } else if (userData.type === 'ship') {
      document.getElementById('tip-name').textContent   = data.name || '???';
      document.getElementById('tip-origin').textContent = 'Vessel';
    } else if (userData.type === 'satellite') {
      document.getElementById('tip-name').textContent   = data.name || '???';
      document.getElementById('tip-origin').textContent = 'Satellite';
    }
  }

  function hideTooltip() {
    document.getElementById('tooltip').style.display = 'none';
  }

  // ---- Flight Detail Panel ----
  function openFlightPanel(data) {
    var p = document.getElementById('flight-panel');
    p.classList.add('open');

    document.getElementById('fp-callsign').textContent = data.callsign || data.id || '???';
    document.getElementById('fp-airline').textContent  = data.origin || data.country || '—';
    document.getElementById('fp-speed').textContent    = data.speed ? Math.round(data.speed) + ' kts' : '—';
    document.getElementById('fp-alt').textContent      = data.alt   ? Math.round(data.alt).toLocaleString() + ' ft' : '—';
    document.getElementById('fp-country').textContent  = data.country || '—';
    document.getElementById('fp-icao').textContent     = data.id || '—';
    document.getElementById('fp-dep').textContent      = '—';
    document.getElementById('fp-arr').textContent      = '—';
    document.getElementById('fp-src').textContent      = 'ADS-B / OpenSky';

    // Show loading spinner
    document.getElementById('fp-loading').classList.add('active');
  }

  function updateFlightRoute(departure, destination) {
    document.getElementById('fp-dep').textContent = departure || '—';
    document.getElementById('fp-arr').textContent = destination || '—';
    document.getElementById('fp-loading').classList.remove('active');
  }

  function closeFlightPanel() {
    document.getElementById('flight-panel').classList.remove('open');
    document.getElementById('fp-loading').classList.remove('active');
  }

  // mode: 0=off, 1=on/dot-only, 2=dot+radius
  function setToggleState(name, mode) {
    var el = document.getElementById('toggle-' + name);
    if (!el) return;
    if (mode === 2)      el.className = 'toggle mode2';
    else if (mode === 1) el.className = 'toggle on';
    else                 el.className = 'toggle off';
    // Update label suffix for 3-way zone toggles
    var lbl = document.getElementById('toggle-label-' + name);
    if (lbl) {
      if      (mode === 0) lbl.textContent = '';
      else if (mode === 1) lbl.textContent = '●';
      else if (mode === 2) lbl.textContent = '◎';
    }
    // Show/hide airspace indicator in layer panel
    var airRow = document.getElementById('layer-airspace');
    if (airRow) airRow.style.opacity = '1';
  }

  function setActiveView(view) {
    document.getElementById('btn-globe').classList.toggle('active', view === 'globe');
    document.getElementById('btn-map').classList.toggle('active', view === 'map');
    // Webcams and Airspace are 2D-only layers
    ['layer-webcams', 'layer-airspace'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.opacity = view === 'map' ? '1' : '0.4';
    });
  }

  // ---- Weather Panel ----
  var _weatherVisible = false;

  function toggleWeatherPanel() {
    _weatherVisible = !_weatherVisible;
    var p = document.getElementById('weather-panel');
    if (_weatherVisible) {
      p.classList.add('open');
    } else {
      p.classList.remove('open');
    }
    return _weatherVisible;
  }

  function openWeatherPanel(lat, lon) {
    _weatherVisible = true;
    document.getElementById('weather-panel').classList.add('open');
    if (lat !== undefined) Weather.load(lat, lon);
  }

  function closeWeatherPanel() {
    _weatherVisible = false;
    document.getElementById('weather-panel').classList.remove('open');
  }

  return {
    startClock:        startClock,
    updateStats:       updateStats,
    showTooltip:       showTooltip,
    hideTooltip:       hideTooltip,
    openFlightPanel:   openFlightPanel,
    updateFlightRoute: updateFlightRoute,
    closeFlightPanel:  closeFlightPanel,
    setToggleState:    setToggleState,
    setActiveView:     setActiveView,
    toggleWeatherPanel: toggleWeatherPanel,
    openWeatherPanel:   openWeatherPanel,
    closeWeatherPanel:  closeWeatherPanel,
  };

}());