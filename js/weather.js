/* =====================================================
   WEATHER — Windy API integration
   Point Forecast API + Map Forecast API (tiles)
   https://api.windy.com
===================================================== */

var Weather = (function() {

  var _lat = 53.55; // Hamburg default
  var _lon = 9.99;
  var _currentTab = 'forecast';

  var OVERLAYS = [
    { id: 'wind',     label: '💨 Wind'        },
    { id: 'rain',     label: '🌧 Rain'         },
    { id: 'temp',     label: '🌡 Temperature'  },
    { id: 'clouds',   label: '☁️ Clouds'       },
    { id: 'pressure', label: '📊 Pressure'     },
    { id: 'waves',    label: '🌊 Waves'        },
  ];
  var _currentOverlay = 'wind';


  // ============================================================
  //  LOAD — entry point, called with lat/lon
  // ============================================================
  function load(lat, lon) {
    _lat = lat !== undefined ? lat : _lat;
    _lon = lon !== undefined ? lon : _lon;
    _renderTabs();
    _showTab(_currentTab);
  }

  function _renderTabs() {
    var panel = document.getElementById('weather-panel');
    if (!panel) return;
    panel.innerHTML =
      '<div class="wp-header">' +
        '<span class="wp-title">⛅ WEATHER</span>' +
        '<div class="wp-coords">' + _lat.toFixed(2) + '° / ' + _lon.toFixed(2) + '°</div>' +
        '<button class="wp-close" onclick="HUD.closeWeatherPanel()">✕</button>' +
      '</div>' +
      '<div class="wp-tabs">' +
        '<button class="wp-tab active" id="wt-forecast" onclick="Weather._tab(\'forecast\')">📡 Forecast</button>' +
        '<button class="wp-tab"        id="wt-map"      onclick="Weather._tab(\'map\')">🌍 Map</button>' +
      '</div>' +
      '<div id="wp-content" class="wp-content"></div>';
  }

  function _tab(name) {
    _currentTab = name;
    document.querySelectorAll('.wp-tab').forEach(function(b) { b.classList.remove('active'); });
    var btn = document.getElementById('wt-' + name);
    if (btn) btn.classList.add('active');
    _showTab(name);
  }

  function _showTab(name) {
    var content = document.getElementById('wp-content');
    if (!content) return;

    if (name === 'forecast') _loadForecast(content);
    if (name === 'map')      _loadWindyMap(content);
  }

  // ============================================================
  //  FORECAST — Windy Point Forecast API
  // ============================================================
  function _loadForecast(el) {
    el.innerHTML = '<div class="wp-loading">Loading forecast…</div>';

    fetch('/api/windy-forecast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: _lat, lon: _lon,
        model: 'gfs',
        parameters: ['wind', 'dewpoint', 'rh', 'pressure', 'temp', 'precip'],
        levels: ['surface'],
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) { _renderForecast(el, data); })
    .catch(function(e) { el.innerHTML = '<div class="wp-error">Forecast error: ' + e.message + '</div>'; });
  }

  function _renderForecast(el, data) {
    if (!data || data.error) {
      el.innerHTML = '<div class="wp-error">' + (data && data.error ? data.error : 'No data') + '</div>';
      return;
    }

    var ts    = data.ts || [];
    var temps = data['temp-surface']     || [];
    var winds = data['wind_u-surface']   || [];
    var windv = data['wind_v-surface']   || [];
    var prec  = data['precip-surface'] || [];
    var html  = '<div class="wp-forecast">';

    // Show next 8 periods (~24h if 3h intervals)
    var count = Math.min(8, ts.length);
    for (var i = 0; i < count; i++) {
      var d      = new Date(ts[i]);
      var hour   = d.getUTCHours().toString().padStart(2,'0') + ':00Z';
      var date   = (d.getUTCMonth()+1) + '/' + d.getUTCDate();
      var tempC  = temps[i] !== undefined ? Math.round(temps[i] - 273.15) : '—';
      var wu     = winds[i] || 0;
      var wv     = windv[i] || 0;
      var wspd   = Math.round(Math.sqrt(wu*wu + wv*wv) * 1.943844); // m/s → kts
      var wdir   = Math.round((Math.atan2(wu, wv) * 180 / Math.PI + 180) % 360);
      var rain   = prec[i] !== undefined ? prec[i].toFixed(1) : '0.0';
      var icon   = tempC > 20 ? '☀️' : tempC > 10 ? '⛅' : tempC > 0 ? '🌥️' : '❄️';

      html += '<div class="wf-row">' +
        '<div class="wf-time"><div class="wf-date">' + date + '</div>' + hour + '</div>' +
        '<div class="wf-icon">' + icon + '</div>' +
        '<div class="wf-temp">' + tempC + '°C</div>' +
        '<div class="wf-wind"><span class="wf-wdir" style="transform:rotate(' + wdir + 'deg)">↑</span> ' + wspd + ' kts</div>' +
        '<div class="wf-rain">' + rain + 'mm</div>' +
      '</div>';
    }

    html += '</div>';
    html += '<div class="wp-footer">GFS Model · ' + new Date().toUTCString().slice(0,16) + '</div>';
    el.innerHTML = html;
  }

  // ============================================================
  //  MAP — Windy overlay controls for the main 2D map
  // ============================================================
  function _loadWindyMap(el) {
    el.innerHTML =
      '<div class="wm-info">Switches the weather overlay on the main 2D map.</div>' +
      '<div class="wm-selector">' +
        OVERLAYS.map(function(o) {
          return '<button class="wm-btn' + (o.id === _currentOverlay ? ' active' : '') + '" ' +
            'onclick="Weather._setOverlay(\'' + o.id + '\')">' + o.label + '</button>';
        }).join('') +
        '<button class="wm-btn' + (!_currentOverlay ? ' active' : '') + '" onclick="Weather._setOverlay(null)">✕ Off</button>' +
      '</div>';
  }

  function _setOverlay(overlay) {
    _currentOverlay = overlay;
    document.querySelectorAll('.wm-btn').forEach(function(b) { b.classList.remove('active'); });
    var sel = overlay
      ? '.wm-btn[onclick*="\'' + overlay + '\'"]'
      : '.wm-btn[onclick*="null"]';
    var btn = document.querySelector(sel);
    if (btn) btn.classList.add('active');
    if (typeof Map2D !== 'undefined') Map2D.setOverlay(overlay);
  }

  return {
    load:        load,
    _tab:        _tab,
    _setOverlay: _setOverlay,
  };

}());
