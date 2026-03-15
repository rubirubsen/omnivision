/* =====================================================
   API — Live data fetchers  (v3 - Architecture Fixes)

   Flights:    Fetched from unified backend proxy (/api/flights).
               Backend handles fallbacks (airplanes.live -> adsb.lol -> OpenSky).
               Source flag passed to HUD.

   Satellites: CelesTrak GP JSON + satellite.js SGP4
               TLEs refreshed hourly, positions every 10s.

   Ships:      Fetched from unified backend proxy (/api/ships).
               Backend maintains persistent WebSocket to AISstream.io.
===================================================== */

var API = (function () {

  // ---- Proxy endpoints (server-side) ----
  var PROXY = {
    flights      : '/api/flights',
    ships        : '/api/ships',
    celestrakVis : '/api/celestrak?group=visual',
    celestrakSta : '/api/celestrak?group=stations',
  };

  var SAT_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/satellite.js/4.1.3/satellite.min.js';

  // ---- Timing ----
  var FLIGHT_POLL_MS   = 15000;
  var SAT_PROP_MS      = 10000;
  var TLE_TTL_MS       = 3600000;
  var SHIP_POLL_MS     = 15000; // Polling instead of WS
  var SHIP_FLUSH_MS    = 2000;
  var SHIP_PRUNE_MS    = 600000;

  // ---- Internal state ----
  var _satLib            = null;
  var _gpRecords         = [];
  var _tleFetchedAt      = 0;
  var _shipFlushTimer    = null;
  var _ships             = {};   // MMSI → ship object

  var _onFlights    = null;
  var _onSatellites = null;
  var _onShips      = null;
  var _onError      = null;

  // ============================================================
  //  HUD helpers
  // ============================================================

  function _setStatus(layer, state, label) {
    var COLORS = { live: '#00ffe0', sim: '#ffd700', error: '#ff4444', ws: '#4488ff' };
    var LABELS = { live: 'LIVE', sim: 'SIM', error: 'ERR', ws: 'WS' };
    var el = document.getElementById('api-status-' + layer);
    if (!el) return;
    el.style.color = COLORS[state] || '#fff';
    el.textContent = label || LABELS[state] || state;
  }

  // ============================================================
  //  INIT
  // ============================================================

  async function init(onFlights, onSatellites, onShips, onError) {
    _onFlights    = onFlights;
    _onSatellites = onSatellites;
    _onShips      = onShips;
    _onError      = onError || console.warn;

    await _loadSatelliteJS();

    _fetchFlights();
    _fetchAndPropagate();
    _initAIS();

    setInterval(_fetchFlights,      FLIGHT_POLL_MS);
    setInterval(_fetchAndPropagate, SAT_PROP_MS);
    setInterval(_fetchShips,        SHIP_POLL_MS); // Polling interval
  }

  // ============================================================
  //  FLIGHTS — Unified backend fetch
  // ============================================================

  function normalizeBackendFlights(data, source) {
    var ac = data.ac || data.aircraft || data.states || [];
    
    if (source === 'opensky') {
      return ac
        .filter(function (s) { return s[5] !== null && s[6] !== null && s[8] === false; })
        .map(function (s) {
          return {
            id      : s[0],
            callsign: (s[1] || s[0] || '').trim(),
            lat     : s[6],
            lon     : s[5],
            alt     : s[13] ? Math.round(s[13] * 3.28084) : (s[7] ? Math.round(s[7] * 3.28084) : 0),
            speed   : s[9]  ? Math.round(s[9]  * 1.94384) : 0,
            heading : s[10] || 0,
            origin  : s[2]  || '—',
            country : s[2]  || '—',
            dlat: 0, dlon: 0, _live: true,
          };
        });
    }
    
    // Default (airplanes.live, adsb.lol)
    return ac
      .filter(function (a) { return a.lat && a.lon && !a.gnd && !a.on_ground; })
      .map(function (a) {
        return {
          id      : a.hex || a.icao || a.icao24,
          callsign: (a.flight || a.callsign || a.hex || '').trim(),
          lat     : +a.lat,
          lon     : +a.lon,
          alt     : Math.round(+a.alt_baro || +a.alt_geom || +a.altitude || 0),
          speed   : Math.round(+a.gs || +a.speed || 0),
          heading : +a.track || +a.heading || 0,
          origin   : a.r || a.reg || a.registration || '—',
          country  : a.ownOp || a.flag || '—',
          category : a.category || '',
          military : !!(a.military),
          dlat: 0, dlon: 0, _live: true,
        };
      });
  }

  async function _fetchFlights() {
    try {
      var res = await fetch(PROXY.flights);
      if (res.status === 503) {
        console.log('[API] Flight cache warming up...');
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);

      var source = res.headers.get('X-Cache-Source') || 'SIM';
      var data = await res.json();
      var flights = normalizeBackendFlights(data, source);

      if (flights.length > 0) {
        _setStatus('flights', 'live', source.split('.')[0].toUpperCase());
        if (_onFlights) _onFlights(flights);
      }
    } catch (e) {
      console.warn('[API] Flights fetch failed:', e.message);
      _setStatus('flights', 'error');
    }
  }

  // ============================================================
  //  AIS STREAM — REST Polling from Backend
  // ============================================================

  function _initAIS() {
    // Initial fetch. Polling set in init().
    _fetchShips();
  }

  async function _fetchShips() {
    try {
      var res = await fetch(PROXY.ships);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      
      data.forEach(function(s) {
        if (s.lat == null || s.lon == null) return;
        if (!_ships[s.mmsi]) {
          _ships[s.mmsi] = {
            id       : s.mmsi,
            mmsi     : s.mmsi,
            name     : (s.name || 'AIS-' + String(s.mmsi).slice(-4)).trim(),
            lat      : s.lat,
            lon      : s.lon,
            speed    : s.speed || 0,
            heading  : s.heading || 0,
            type     : s.type ? _vesselType(s.type) : 'Vessel',
            dest     : s.dest || '—',
            dlat     : 0, dlon: 0, _live: true,
            _lastSeen: s._lastSeen
          };
        } else {
          var ship = _ships[s.mmsi];
          ship.lat = s.lat;
          ship.lon = s.lon;
          ship.speed = s.speed || 0;
          ship.heading = s.heading || 0;
          ship._lastSeen = s._lastSeen;
          if (s.name) ship.name = s.name.trim();
          if (s.type) ship.type = _vesselType(s.type);
          if (s.dest) ship.dest = s.dest.trim();
        }
      });
      _scheduleFlush();
    } catch (e) {
      console.warn('[API] Ships fetch failed:', e.message);
      _setStatus('ships', 'error');
    }
  }

  function _scheduleFlush() {
    if (_shipFlushTimer) return;
    _shipFlushTimer = setTimeout(function () {
      _shipFlushTimer = null;

      // Prune old ships
      var cutoff = Date.now() - SHIP_PRUNE_MS;
      Object.keys(_ships).forEach(function (k) {
        if (_ships[k]._lastSeen < cutoff) delete _ships[k];
      });

      var arr = Object.values(_ships);
      var el  = document.getElementById('ship-count');
      if (el) el.textContent = arr.length.toLocaleString();
      if (arr.length) _setStatus('ships', 'live', 'LIVE');
      if (_onShips) _onShips(arr);
    }, SHIP_FLUSH_MS);
  }

  function _vesselType(code) {
    var n = parseInt(code);
    if (n >= 70 && n <= 79) return 'Cargo';
    if (n >= 80 && n <= 89) return 'Tanker';
    if (n >= 60 && n <= 69) return 'Passenger';
    if (n === 30)           return 'Fishing';
    if (n === 36)           return 'Sailing';
    if (n === 37)           return 'Pleasure';
    if (n === 50)           return 'Pilot';
    if (n === 51)           return 'SAR';
    if (n === 52)           return 'Tug';
    if (n === 55)           return 'Law Enforcement';
    return 'Vessel';
  }

  // ============================================================
  //  satellite.js — lazy CDN load
  // ============================================================

  function _loadSatelliteJS() {
    return new Promise(function (resolve) {
      if (window.satellite) { _satLib = window.satellite; resolve(); return; }
      var s     = document.createElement('script');
      s.src     = SAT_JS_CDN;
      s.onload  = function () { _satLib = window.satellite; console.log('[API] satellite.js ready'); resolve(); };
      s.onerror = function () { _onError('[API] satellite.js CDN failed'); resolve(); };
      document.head.appendChild(s);
    });
  }

  // ============================================================
  //  CELESTRAK + SGP4
  // ============================================================

  async function _fetchAndPropagate() {
    if (!_gpRecords.length || Date.now() - _tleFetchedAt > TLE_TTL_MS) {
      await _fetchGP();
    }
    _propagate();
  }

  async function _fetchGP() {
    var urls = [PROXY.celestrakVis, PROXY.celestrakSta];
    for (var i = 0; i < urls.length; i++) {
      try {
        var res     = await fetch(urls[i]);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var records = await res.json();
        if (!Array.isArray(records) || !records.length) throw new Error('empty');

        var parsed = [];
        records.forEach(function (r) {
          try {
            var satrec = (r.line1 && r.line2)
              ? _satLib.twoline2satrec(r.line1, r.line2)
              : _omm2satrec(r);
            if (satrec) parsed.push({ name: r.OBJECT_NAME || r.name || '?', satrec: satrec });
          } catch (_) {}
        });

        _gpRecords    = parsed;
        _tleFetchedAt = Date.now();
        _setStatus('satellites', 'live');
        console.log('[API] CelesTrak: ' + _gpRecords.length + ' satellites');
        return;
      } catch (e) {
        console.warn('[API] CelesTrak:', e.message);
      }
    }
    _onError('[API] CelesTrak failed');
    _setStatus('satellites', 'error');
  }

  function _propagate() {
    if (!_satLib || !_gpRecords.length) return;
    var now  = new Date();
    var gmst = _satLib.gstime(now);
    var sats = [];
    _gpRecords.forEach(function (rec, i) {
      try {
        var pv = _satLib.propagate(rec.satrec, now);
        if (!pv || !pv.position || isNaN(pv.position.x)) return;
        var geo = _satLib.eciToGeodetic(pv.position, gmst);
        var lat = _satLib.degreesLat(geo.latitude);
        var lon = _satLib.degreesLong(geo.longitude);
        if (isNaN(lat) || isNaN(lon)) return;
        sats.push({ id: i, name: rec.name, currentLat: lat, currentLon: lon, altKm: Math.round(geo.height), _live: true });
      } catch (_) {}
    });
    if (_onSatellites) _onSatellites(sats);
  }

  // ---- OMM JSON → satellite.js satrec ----

  function _omm2satrec(omm) {
    if (!_satLib) return null;
    if (_satLib.json && typeof _satLib.json === 'function') return _satLib.json(omm);

    var cat     = String(omm.NORAD_CAT_ID || 0).padStart(5, '0');
    var intdes  = (omm.OBJECT_ID || '00000A').replace(/-/g, '').substring(0, 8).padEnd(8, ' ');
    var epochDt = new Date(omm.EPOCH);
    var year2   = String(epochDt.getUTCFullYear()).slice(2);
    var doy     = Math.floor((epochDt - new Date(epochDt.getUTCFullYear(), 0, 0)) / 86400000);
    var fracDay = (epochDt.getUTCHours() * 3600 + epochDt.getUTCMinutes() * 60 + epochDt.getUTCSeconds()) / 86400;
    var epochStr = year2 + String(doy).padStart(3, '0') + '.' + String(fracDay.toFixed(8)).slice(2);
    var line1 = '1 ' + cat + 'U ' + intdes + ' ' + epochStr.padEnd(14, ' ') +
                ' ' + _fmtTleDot(omm.MEAN_MOTION_DOT  || 0) +
                ' ' + _fmtTleExp(omm.MEAN_MOTION_DDOT || 0) +
                ' ' + _fmtTleExp(omm.BSTAR            || 0) +
                ' 0 ' + String(omm.ELEMENT_SET_NO || 999).padStart(4, ' ') + '0';
    var line2 = '2 ' + cat +
                ' ' + _fmtAngle(omm.INCLINATION)       +
                ' ' + _fmtAngle(omm.RA_OF_ASC_NODE)    +
                ' ' + String(Math.round((omm.ECCENTRICITY || 0) * 1e7)).padStart(7, '0') +
                ' ' + _fmtAngle(omm.ARG_OF_PERICENTER) +
                ' ' + _fmtAngle(omm.MEAN_ANOMALY)      +
                ' ' + _fmtMM(omm.MEAN_MOTION) + String(omm.REV_AT_EPOCH || 0).padStart(5, ' ') + '0';
    return _satLib.twoline2satrec(line1, line2);
  }

  function _fmtAngle(v)  { return (parseFloat(v) || 0).toFixed(4).padStart(8, ' '); }
  function _fmtMM(v)     { return (parseFloat(v) || 0).toFixed(8).padStart(11, ' '); }
  function _fmtTleDot(v) {
    var s = (parseFloat(v) || 0).toFixed(8);
    return (v >= 0 ? ' ' : '-') + s.replace(/^-?0\./, '.').substring(0, 9);
  }
  function _fmtTleExp(v) {
    if (!v) return ' 00000-0';
    var exp  = Math.floor(Math.log10(Math.abs(v))) + 1;
    var mant = Math.round(v / Math.pow(10, exp - 5));
    return (v < 0 ? '-' : ' ') + String(Math.abs(mant)).padStart(5, '0') + (exp < 0 ? '' : '+') + exp;
  }

  return { init: init };

}());