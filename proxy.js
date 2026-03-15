/* =====================================================
   PROXY — OmniVision data gateway  (v3.1 - Architecture Fixes)

   Architecture:
   ─────────────────────────────────────────────────
   Background workers refresh data on the server
   continuously — browser gets cached responses in
   <5ms regardless of when the page loads.

   Endpoints:
     GET  /api/flights                ← Unified flight API (best source wins)
     GET  /api/ships                  ← Live AIS via Server-Side WebSocket
     GET  /api/celestrak              ← satellites      (cached 1h)
     POST /api/windy-forecast         ← Windy point API (passthrough)
     GET  /api/windy-webcams          ← Windy webcams   (passthrough)
     GET  /api/owm-tiles/:l/:z/:x/:y  ← OWM tiles       (passthrough)
     GET  /api/rainviewer             ← RainViewer      (passthrough)
     GET  /api/tiles/:s/:z/:x/:y      ← CartoDB tiles   (disk-cached)
     GET  /api/airspace               ← OpenAIP cache   (disk-cached)
     GET  /api/config

   Start: node proxy.js
   PM2:   pm2 start proxy.js --name omnivision-proxy
===================================================== */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const stream    = require('stream');
const WebSocket = require('ws'); // Hinzugefügt für serverseitiges AIS

// ---- Config ----
const PORT                  = process.env.PORT                  || 3001;
const OPENSKY_CLIENT_ID     = process.env.OPENSKY_CLIENT_ID;
const OPENSKY_CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;
const WINDY_WEBCAMS_KEY     = process.env.WINDY_WEBCAMS_KEY;
const WINDY_FORECAST_KEY    = process.env.WINDY_FORECAST_KEY;
const WINDY_MAP_KEY         = process.env.WINDY_MAP_KEY;
const OWM_API_KEY           = process.env.OWM_API_KEY;
const AIS_API_KEY           = process.env.AIS_API_KEY;
const OPENAIP_API_KEY       = process.env.AIP_API_KEY; // free at openaip.net

const TLE_CACHE_FILE    = path.join(__dirname, '.tle-cache.json');
const SHIPS_CACHE_FILE  = path.join(__dirname, '.ships-cache.json');
const ROADMAP_FILE      = path.join(__dirname, 'roadmap.json');
const LIKES_FILE        = path.join(__dirname, '.likes.json');
if (!fs.existsSync(LIKES_FILE)) fs.writeFileSync(LIKES_FILE, '{}', 'utf8');

// ---- Tile cache config ----
const TILE_CACHE_DIR      = path.join(__dirname, '.tile-cache');
const TILE_CACHE_MAX_AGE  = parseInt(process.env.TILE_CACHE_MAX_AGE_DAYS || '30') * 86400_000;
const TILE_CACHE_MAX_ZOOM = parseInt(process.env.TILE_CACHE_MAX_ZOOM || '12');
if (!fs.existsSync(TILE_CACHE_DIR)) fs.mkdirSync(TILE_CACHE_DIR, { recursive: true });

// ---- Airspace cache config ----
const AIRSPACE_REGIONS = [
  { id: 'europe',    bbox: '-15,35,45,72'    },
  { id: 'n-america', bbox: '-170,15,-50,75'  },
  { id: 's-america', bbox: '-85,-60,-30,15'  },
  { id: 'asia',      bbox: '25,5,145,55'     },
  { id: 'me-africa', bbox: '-20,-40,60,40'   },
  { id: 'oceania',   bbox: '100,-50,180,10'  },
  { id: 'russia',    bbox: '30,50,180,80'    },
];
const AIRSPACE_CACHE_DIR = path.join(__dirname, '.airspace-cache');
const AIRSPACE_TTL_MS    = 24 * 3600_000;
if (!fs.existsSync(AIRSPACE_CACHE_DIR)) fs.mkdirSync(AIRSPACE_CACHE_DIR, { recursive: true });

const _airspaceCache = {}; // regionId → { features: [], ts: 0 }

const OPENAIP_TYPE = {
  1: 'RESTRICTED', 2: 'DANGER',  3: 'PROHIBITED', 4: 'CTR',
  5: 'TMA',        6: 'CTR',     7: 'TMA',        8: 'RESTRICTED',
  9: 'RESTRICTED', 10: 'FIR',    11: 'UIR',        12: 'ADIZ',
};
const OPENAIP_CLASS = ['CLASS_A','CLASS_B','CLASS_C','CLASS_D','CLASS_E','CLASS_F','CLASS_G'];

function _aipTypeName(item) {
  return OPENAIP_TYPE[item.type]
    || (item.icaoClass != null && item.icaoClass <= 6 ? OPENAIP_CLASS[item.icaoClass] : null)
    || 'DEFAULT';
}

function _findAirspaceRegion(lat, lon) {
  for (const r of AIRSPACE_REGIONS) {
    const [w, s, e, n] = r.bbox.split(',').map(Number);
    if (lat >= s && lat <= n && lon >= w && lon <= e) return r;
  }
  return null;
}

// ---- CORS ----
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---- URLs ----
const OPENSKY_TOKEN_URL  = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';

const FLIGHT_REGIONS = [
  'https://api.airplanes.live/v2/bbox?min_lat=35&max_lat=72&min_lon=-15&max_lon=45',    // Europa
  'https://api.airplanes.live/v2/bbox?min_lat=25&max_lat=50&min_lon=-130&max_lon=-60',  // N.Amerika
  'https://api.airplanes.live/v2/bbox?min_lat=20&max_lat=55&min_lon=60&max_lon=145',    // Asien
  'https://api.airplanes.live/v2/bbox?min_lat=-40&max_lat=25&min_lon=-85&max_lon=-30',  // S.Amerika
  'https://api.airplanes.live/v2/bbox?min_lat=-40&max_lat=30&min_lon=10&max_lon=55',    // Afrika
  'https://api.airplanes.live/v2/bbox?min_lat=-50&max_lat=10&min_lon=100&max_lon=180',  // Ozeanien
];

// ============================================================
//  HTTPS HELPERS
// ============================================================

function httpsRequest(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const timeout = options.timeout || 12000;
    const req     = https.request({
      hostname: u.hostname,
      path    : u.pathname + u.search,
      method  : options.method || 'GET',
      headers : options.headers || {},
      family  : 4,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout after ' + timeout + 'ms')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsRequestBinary(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const timeout = options.timeout || 12000;
    const req     = https.request({
      hostname: u.hostname,
      path    : u.pathname + u.search,
      method  : 'GET',
      headers : options.headers || {},
      family: 4,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================
//  SERVER-SIDE AIS WEBSOCKET
// ============================================================

const shipsCache = new Map();
let aisWs = null;

// Boot: Disk-Snapshot laden damit Browser sofort echte Schiffe bekommt
if (fs.existsSync(SHIPS_CACHE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(SHIPS_CACHE_FILE, 'utf8'));
    const cutoff = Date.now() - 7_200_000; // max 2h alt
    const now = Date.now();
    saved.forEach(s => {
      if (s._lastSeen > cutoff) {
        s._lastSeen = now; // Reset auf jetzt — sonst frisst der 10-min Prune sie sofort
        shipsCache.set(s.mmsi, s);
      }
    });
    console.log(`[AIS] Loaded ${shipsCache.size} ships from disk cache`);
  } catch (e) { console.warn('[AIS] Could not load disk cache:', e.message); }
}

// Alle 5 Minuten Snapshot auf Disk schreiben
setInterval(() => {
  if (!shipsCache.size) return;
  fs.writeFile(SHIPS_CACHE_FILE, JSON.stringify(Array.from(shipsCache.values())), err => {
    if (err) console.warn('[AIS] Disk snapshot failed:', err.message);
  });
}, 300_000);

let _aisBackoffMs = 5000; // Exponential backoff state

function connectAIS() {
  if (!AIS_API_KEY) return;
  try {
    aisWs = new WebSocket('wss://stream.aisstream.io/v0/stream');
    let _aisPing = null;
    let _aisGotData = false;

    aisWs.on('open', () => {
      console.log('[AIS] WebSocket connected globally');
      aisWs.send(JSON.stringify({
        APIKey: AIS_API_KEY,
        BoundingBoxes: [
          [[-90, -180], [90, 180]]
        ],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData']
      }));
      _aisPing = setInterval(() => {
        if (aisWs.readyState === WebSocket.OPEN) aisWs.ping();
      }, 20000);
    });

    aisWs.on('message', (data) => {
      if (!_aisGotData) {
        _aisGotData = true;
        _aisBackoffMs = 5000; // Reset backoff on first successful message
        console.log('[AIS] Receiving data — backoff reset');
      }
      try {
        const msg = JSON.parse(data);
        const mmsi = msg.MetaData?.MMSI;
        if (!mmsi) return;

        if (!shipsCache.has(mmsi)) {
          shipsCache.set(mmsi, { mmsi, _lastSeen: Date.now(), dlat: 0, dlon: 0, _live: true });
        }

        const ship = shipsCache.get(mmsi);
        ship._lastSeen = Date.now();

        if (msg.MessageType === 'PositionReport') {
          const pos = msg.Message.PositionReport;
          if (Math.abs(pos.Latitude) <= 90 && Math.abs(pos.Longitude) <= 180) {
            ship.lat = pos.Latitude;
            ship.lon = pos.Longitude;
            ship.speed = Math.round(pos.Sog || 0);
            ship.heading = Math.round(pos.TrueHeading >= 0 && pos.TrueHeading < 360 ? pos.TrueHeading : (pos.Cog || 0));
          }
        } else if (msg.MessageType === 'ShipStaticData') {
          const stat = msg.Message.ShipStaticData;
          if (stat.Name) ship.name = stat.Name.trim();
          if (stat.Type) ship.type = stat.Type;
          if (stat.Destination) ship.dest = stat.Destination.trim();
        }
      } catch (e) {}
    });

    aisWs.on('close', (code, reason) => {
      clearInterval(_aisPing);
      // Exponential backoff: double each time, cap at 5 minutes
      _aisBackoffMs = Math.min(_aisBackoffMs * 2, 300_000);
      console.warn(`[AIS] Connection lost. Code: ${code || '?'} — Reconnecting in ${_aisBackoffMs/1000}s`);
      setTimeout(connectAIS, _aisBackoffMs);
    });

    aisWs.on('error', (err) => {
      // 503 = account issue / rate limit — log clearly
      if (err.message && err.message.includes('503')) {
        console.error('[AIS] Server returned 503 — check aisstream.io account/quota');
      } else {
        console.error('[AIS] WebSocket error:', err.message);
      }
    });
  } catch (e) {
    console.error('[AIS] Init error:', e.message);
  }
}

// Prune veraltete Schiffe alle 5 Minuten
setInterval(() => {
  const cutoff = Date.now() - 1_800_000; // 30 Minuten
  for (const [mmsi, ship] of shipsCache.entries()) {
    if (ship._lastSeen < cutoff) shipsCache.delete(mmsi);
  }
}, 300_000);

// ============================================================
//  BACKGROUND CACHE WORKERS
// ============================================================

const cache = {
  flights  : { data: null, ts: 0, source: 'SIM' }, // Unified Flight Cache
  celestrak: { data: null, ts: 0 },
};

const TTL = {
  flights  : 30_000,   // 30s — halves adsb.one request rate vs 15s
  celestrak: 3_600_000,
};

// Adaptive backoff for rate-limited sources
let _oskBackoffUntil   = 0;
let _adsbOneBackoffUntil = 0;
const OSK_BACKOFF_MS     = 5 * 60_000; // 5 minutes
const ADSBONEBACKOFF_MS  = 2 * 60_000; // 2 minutes

let _oskToken = null, _oskExpiry = 0;

async function _getOskToken() {
  if (_oskToken && Date.now() < _oskExpiry - 60000) return _oskToken;
  if (!OPENSKY_CLIENT_ID) return null;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: OPENSKY_CLIENT_ID, client_secret: OPENSKY_CLIENT_SECRET }).toString();
  const r    = await httpsRequest(OPENSKY_TOKEN_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  }, body);
  if (r.status !== 200) throw new Error('OSK token HTTP ' + r.status);
  const d   = JSON.parse(r.body);
  _oskToken = d.access_token;
  _oskExpiry = Date.now() + (d.expires_in || 1800) * 1000;
  return _oskToken;
}

// ---- UNIFIED FLIGHT REFRESHER (Löst die Race Condition) ----
async function refreshFlightsUnified() {
  
  // 1. Priorität: airplanes.live
  try {
    const results = await Promise.allSettled(
      FLIGHT_REGIONS.map(url => httpsRequest(url, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'identity' }, timeout: 8000 }).then(r => r.status === 200 ? JSON.parse(r.body) : { ac: [] }))
    );
    const seen = new Set(); const ac = [];
    results.forEach(r => {
      if (r.status !== 'fulfilled') return;
      (r.value.ac || r.value.aircraft || []).forEach(a => {
        if (!a.hex || seen.has(a.hex)) return;
        seen.add(a.hex); ac.push(a);
      });
    });

    if (ac.length > 50) {
      cache.flights = { data: JSON.stringify({ ac }), ts: Date.now(), source: 'airplanes.live' };
      console.log(`[Cache] Flights: ${ac.length} von airplanes.live (Primary)`);
      return; // STOPPT HIER! Fallbacks werden nicht mehr gefetcht!
    }
  } catch (e) { console.warn('[Cache] airplanes.live failed:', e.message); }

  // 2. Priorität: adsb.lol (Fallback A)
  try {
    const adsbLolRegions = FLIGHT_REGIONS.map(url => url.replace('api.airplanes.live', 'api.adsb.lol'));
    const results = await Promise.allSettled(
      adsbLolRegions.map(url => httpsRequest(url, { headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' }, timeout: 8000 }).then(r => r.status === 200 ? JSON.parse(r.body) : { ac: [] }))
    );
    const seen = new Set(); const ac = [];
    results.forEach(r => {
      if (r.status !== 'fulfilled') return;
      (r.value.ac || []).forEach(a => { if (a.hex && !seen.has(a.hex)) { seen.add(a.hex); ac.push(a); } });
    });

    if (ac.length > 50) {
      cache.flights = { data: JSON.stringify({ ac }), ts: Date.now(), source: 'adsb.lol' };
      console.log(`[Cache] Flights: ${ac.length} von adsb.lol (Fallback A)`);
      return;
    }
  } catch (e) { console.warn('[Cache] adsb.lol failed:', e.message); }

  // 3. Priorität: adsb.one (Fallback B — community, no auth, VPS-friendly)
  if (Date.now() < _adsbOneBackoffUntil) {
    console.log(`[Cache] adsb.one skipped (backoff for ${Math.round((_adsbOneBackoffUntil - Date.now()) / 1000)}s)`);
  } else
  try {
    const ADSB_ONE_REGIONS = [
      'https://api.adsb.one/v2/point/53/15/2500',   // Europe
      'https://api.adsb.one/v2/point/37/-95/3000',  // N.America
      'https://api.adsb.one/v2/point/35/105/3000',  // Asia
      'https://api.adsb.one/v2/point/-15/-55/3000', // S.America
      'https://api.adsb.one/v2/point/-25/135/2500', // Oceania
    ];
    const results = await Promise.allSettled(
      ADSB_ONE_REGIONS.map(url => httpsRequest(url, { headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 })
        .then(r => {
          if (r.status !== 200) return { ac: [] };
          const parsed = JSON.parse(r.body);
          return parsed;
        }))
    );
    const seen = new Set(); const ac = [];
    results.forEach(r => {
      if (r.status !== 'fulfilled') return;
      (r.value.ac || r.value.aircraft || []).forEach(a => {
        if (!a.hex || seen.has(a.hex)) return;
        seen.add(a.hex); ac.push(a);
      });
    });

    if (ac.length > 50) {
      cache.flights = { data: JSON.stringify({ ac }), ts: Date.now(), source: 'adsb.one' };
      console.log(`[Cache] Flights: ${ac.length} von adsb.one (Fallback B)`);
      return;
    } else {
      console.warn(`[Cache] adsb.one: only ${ac.length} ac — skipping`);
    }
  } catch (e) {
    if (e.message && e.message.includes('429')) _adsbOneBackoffUntil = Date.now() + ADSBONEBACKOFF_MS;
    console.warn('[Cache] adsb.one failed:', e.message);
  }

  // 4. Priorität: OpenSky (Letzte Rettung — adaptive backoff to preserve daily quota)
  if (Date.now() < _oskBackoffUntil) {
    console.log(`[Cache] OpenSky skipped (backoff for ${Math.round((_oskBackoffUntil - Date.now()) / 1000)}s)`);
    return;
  }
  try {
    const token = await _getOskToken();
    if (token) {
      const r = await httpsRequest(OPENSKY_STATES_URL, { headers: { Authorization: 'Bearer ' + token }, timeout: 12000 });
      if (r.status === 200) {
        cache.flights = { data: r.body, ts: Date.now(), source: 'opensky' };
        console.log('[Cache] Flights: loaded from OpenSky (Last Resort)');
        return;
      } else {
        if (r.status === 401) { _oskToken = null; console.warn('[Cache] OpenSky 401 — token invalidated'); }
        else if (r.status === 429) {
          _oskBackoffUntil = Date.now() + OSK_BACKOFF_MS;
          console.warn(`[Cache] OpenSky 429 — rate limited, backing off ${OSK_BACKOFF_MS / 60000}min`);
        }
        else console.warn('[Cache] OpenSky HTTP', r.status);
      }
    }
  } catch (e) { console.warn('[Cache] OpenSky failed:', e.message); }
}

// ---- CelesTrak TLEs ----
async function refreshCelesTrak() {
  const HEADERS = { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0 (compatible; WorldView/1.0)' };

  // Helper: fetch ivanstanojevic with multi-page merge
  async function _fetchIvan() {
    const pages = await Promise.allSettled([1, 2, 3].map(p =>
      httpsRequest(`https://tle.ivanstanojevic.me/api/tle/?page_size=100&page=${p}&format=json`, { headers: HEADERS, timeout: 15000 })
        .then(r => {
          if (r.status !== 200) return [];
          const parsed = JSON.parse(r.body);
          return (parsed.member || parsed.data || []).map(s => ({ OBJECT_NAME: s.name, line1: s.line1, line2: s.line2 }));
        })
    ));
    return pages.flatMap(p => p.status === 'fulfilled' ? p.value : []);
  }

  const sources = [
    // ivanstanojevic — multi-page, VPS-friendly
    { fetch: _fetchIvan, isDirect: true },
    // celestrak.org — JSON (works from home/residential, blocked on most VPS)
    { fetch: () => httpsRequest('https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=JSON',   { headers: HEADERS, timeout: 15000 }) },
    { fetch: () => httpsRequest('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=JSON', { headers: HEADERS, timeout: 15000 }) },
    // celestrak.org — TLE text fallback
    { fetch: () => httpsRequest('https://celestrak.org/NORAD/elements/visual.txt', { headers: { ...HEADERS, Accept: 'text/plain' }, timeout: 15000 }), isTle: true },
  ];

  for (const src of sources) {
    try {
      let arr;

      if (src.isDirect) {
        arr = await src.fetch();
      } else {
        const r = await src.fetch();
        if (r.status !== 200) continue;
        const body = r.body.trim();

        if (src.isTle) {
          // Parse 3-line TLE text format
          const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
          arr = [];
          for (let i = 0; i + 2 < lines.length; i += 3) {
            arr.push({ OBJECT_NAME: lines[i], line1: lines[i+1], line2: lines[i+2] });
          }
        } else if (body.startsWith('[')) {
          arr = JSON.parse(body);
        } else {
          const parsed = JSON.parse(body);
          arr = (parsed.member || parsed.data || []).map(s => ({ OBJECT_NAME: s.name, line1: s.line1, line2: s.line2 }));
        }
      }

      if (!Array.isArray(arr) || arr.length < 10) continue;

      const data = JSON.stringify(arr);
      cache.celestrak = { data, ts: Date.now() };
      fs.writeFileSync(TLE_CACHE_FILE, data, 'utf8');
      console.log(`[Cache] CelesTrak: ${arr.length} satellites`);
      return;
    } catch (e) {
      console.warn('[Cache] CelesTrak source failed:', e.message);
    }
  }

  if (fs.existsSync(TLE_CACHE_FILE)) {
    cache.celestrak = { data: fs.readFileSync(TLE_CACHE_FILE, 'utf8'), ts: Date.now() - TTL.celestrak + 300_000 };
    console.warn('[Cache] CelesTrak: serving from disk cache');
  }
}

// ---- Airspace background refresh ----
async function refreshAirspaceRegion(region) {
  if (!OPENAIP_API_KEY) return;
  const allFeatures = [];
  let page = 1;
  try {
    while (true) {
      const query = new URLSearchParams({ bbox: region.bbox, limit: '200', page: String(page) });
      const r = await httpsRequest(
        `https://api.core.openaip.net/api/airspaces?${query}`,
        { headers: { 'x-openaip-api-key': OPENAIP_API_KEY, 'Accept': 'application/json', 'Accept-Encoding': 'identity' }, timeout: 15000 }
      );
      if (r.status !== 200) { console.warn(`[Airspace] ${region.id} HTTP ${r.status}`); break; }
      const data  = JSON.parse(r.body);
      const items = data.items || [];
      items.forEach(item => allFeatures.push({
        name      : item.name,
        type      : _aipTypeName(item),
        geometry  : item.geometry,
        bbox      : item.bbox,
        lowerLimit: item.lowerLimit?.value ?? item.lowerLimit,
        upperLimit: item.upperLimit?.value ?? item.upperLimit,
      }));
      if (page >= data.totalPages || items.length < 200) break;
      page++;
    }
    _airspaceCache[region.id] = { features: allFeatures, ts: Date.now() };
    fs.writeFileSync(path.join(AIRSPACE_CACHE_DIR, region.id + '.json'), JSON.stringify(allFeatures), 'utf8');
    console.log(`[Airspace] ${region.id}: ${allFeatures.length} zones`);
  } catch (e) {
    _loadAirspaceFromDisk(region);
  }
}

function _loadAirspaceFromDisk(region) {
  const p = path.join(AIRSPACE_CACHE_DIR, region.id + '.json');
  if (!fs.existsSync(p)) return;
  try {
    const features = JSON.parse(fs.readFileSync(p, 'utf8'));
    const { mtimeMs } = fs.statSync(p);
    _airspaceCache[region.id] = { features, ts: mtimeMs };
    console.log(`[Airspace] ${region.id}: ${features.length} zones (disk)`);
  } catch (_) {}
}

async function refreshAllAirspace() {
  for (const region of AIRSPACE_REGIONS) { await refreshAirspaceRegion(region); }
}

// ---- Boot Sequence ----
console.log('[Proxy] Starting background data workers...');
refreshFlightsUnified();
refreshCelesTrak();

AIRSPACE_REGIONS.forEach(_loadAirspaceFromDisk);
if (OPENAIP_API_KEY) setTimeout(refreshAllAirspace, 10_000);
if (AIS_API_KEY)     connectAIS();

setInterval(refreshFlightsUnified, TTL.flights);
setInterval(refreshCelesTrak,      TTL.celestrak);
if (OPENAIP_API_KEY) setInterval(refreshAllAirspace, AIRSPACE_TTL_MS);

// ============================================================
//  RESPONSE HELPERS
// ============================================================

function sendJSON(res, status, data, extra = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json', ...extra });
  res.end(body);
}

function send502(res, msg) {
  sendJSON(res, 502, { error: msg });
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end',  () => resolve(b));
  });
}

// ============================================================
//  HTTP SERVER
// ============================================================

const server = http.createServer(async (req, res) => {

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = req.url;

  if (req.method === 'GET' && url === '/api/config') {
    sendJSON(res, 200, { windyMapKey: WINDY_MAP_KEY || '' });
    return;
  }

  // ── /api/ships (NEU: Löst Frontend-WebSocket ab) ─────────────
  if (req.method === 'GET' && url === '/api/ships') {
    // Gibt das Array aller gecachten Schiffe zurück
    sendJSON(res, 200, Array.from(shipsCache.values()));
    return;
  }

  // ── /api/flights (Unified Fallback Handler) ──────────────────
  if (req.method === 'GET' && (url === '/api/flights' || url === '/api/airplanes-live' || url === '/api/adsblol' || url.startsWith('/api/opensky-states'))) {
    if (cache.flights.data) {
      const age = Math.round((Date.now() - cache.flights.ts) / 1000);
      // Fallback-Sicherheit für alte api.js Endpunkte: Liefert immer den besten funktionierenden Cache
      sendJSON(res, 200, cache.flights.data, { 'X-Cache-Age': age + 's', 'X-Cache-Source': cache.flights.source });
      return;
    }
    sendJSON(res, 503, { error: 'Flight data warming up' });
    return;
  }

  // ── /api/celestrak ───────────────────────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/celestrak')) {
    if (cache.celestrak.data) {
      const age = Math.round((Date.now() - cache.celestrak.ts) / 1000);
      sendJSON(res, 200, cache.celestrak.data, { 'X-Cache-Age': age + 's', 'Cache-Control': 'max-age=3600' });
      return;
    }
    sendJSON(res, 503, { error: 'TLE data unavailable' });
    return;
  }

  // ── /api/windy-forecast (POST passthrough + Origin Fix) ──────
  if (req.method === 'POST' && url === '/api/windy-forecast') {
    try {
      const raw     = await readBody(req);
      const payload = JSON.parse(raw);
      payload.key   = WINDY_FORECAST_KEY;
      const bodyStr = JSON.stringify(payload);
      const r       = await httpsRequest('https://api.windy.com/api/point-forecast/v2', {
        method : 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Content-Length': Buffer.byteLength(bodyStr), 
          'Accept-Encoding': 'identity',
          'Origin': 'https://core-now.com',
          'Referer': 'https://core-now.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        timeout: 10000,
      }, bodyStr);
      sendJSON(res, r.status, r.body);
    } catch (e) { send502(res, e.message); }
    return;
  }

  // ── /api/windy-webcams (Origin Fix) ──────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/windy-webcams')) {
    try {
      const params  = new URL(url, 'http://localhost').searchParams;
      const qp      = { limit: params.get('limit') || '50', offset: '0', include: 'location,images,urls' };
      if (params.get('n')) qp.bbox = [params.get('n'), params.get('e'), params.get('s'), params.get('w')].join(',');
      else if (params.get('nearby')) qp.nearby = params.get('nearby');
      
      const r = await httpsRequest(`https://api.windy.com/webcams/api/v3/webcams?${new URLSearchParams(qp)}`, {
        headers: { 
          'x-windy-api-key': WINDY_WEBCAMS_KEY, 
          'Accept-Encoding': 'identity',
          'Origin': 'https://core-now.com',
          'Referer': 'https://core-now.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000,
      });
      sendJSON(res, r.status, r.body);
    } catch (e) { send502(res, e.message); }
    return;
  }

  // ── /api/owm-tiles/:layer/:z/:x/:y ──────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/owm-tiles/')) {
    if (!OWM_API_KEY) { res.writeHead(503, CORS); res.end('OWM_API_KEY not configured'); return; }
    try {
      const parts   = url.replace('/api/owm-tiles/', '').split('/');
      const [layer, z, x, y] = parts;
      const allowed = ['wind_new', 'temp_new', 'clouds_new', 'pressure_new', 'precipitation_new'];
      if (!allowed.includes(layer)) { res.writeHead(400, CORS); res.end('unknown layer'); return; }
      const r = await httpsRequest(
        `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${OWM_API_KEY}`,
        { headers: { 'Accept-Encoding': 'identity' }, timeout: 8000 }
      );
      res.writeHead(r.status, { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' });
      res.end(Buffer.from(r.body, 'binary'));
    } catch (e) { res.writeHead(502, CORS); res.end('upstream error'); }
    return;
  }

  // ── /api/rainviewer ──────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/rainviewer') {
    try {
      const r = await httpsRequest('https://api.rainviewer.com/public/weather-maps.json', {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
        timeout: 8000,
      });
      sendJSON(res, r.status, r.body, { 'Cache-Control': 'max-age=120' });
    } catch (e) { send502(res, e.message); }
    return;
  }


  // ── /api/tiles/:subdomain/:z/:x/:y ──────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/tiles/')) {
    const tilePath = url.replace('/api/tiles/', '').split('?')[0];
    const parts    = tilePath.split('/');
    if (parts.length < 4) { res.writeHead(400, CORS); res.end('bad path'); return; }

    const [s, z, x, y] = parts;
    const zi = parseInt(z);

    if (!['a','b','c','d'].includes(s) || isNaN(zi) || zi < 0 || zi > 20) {
      res.writeHead(400, CORS); res.end('invalid tile params'); return;
    }

    const TILE_HEADERS = {
      ...CORS,
      'Content-Type'           : 'image/png',
      'Cache-Control'          : 'public, max-age=2592000',
      'X-Content-Type-Options' : 'nosniff',
    };

    const cacheDir  = path.join(TILE_CACHE_DIR, z, x);
    const cachePath = path.join(cacheDir, y + '.png');

    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < TILE_CACHE_MAX_AGE) {
        res.writeHead(200, { ...TILE_HEADERS, 'X-Tile-Cache': 'HIT' });
        fs.createReadStream(cachePath).pipe(res);
        return;
      }
    }

    const upstreamUrl = `https://${s}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
    const cartoDB = new URL(upstreamUrl);

    https.get({
      hostname: cartoDB.hostname,
      path    : cartoDB.pathname,
      headers : { 'User-Agent': 'OmniVision/2.0', 'Accept-Encoding': 'identity' },
      timeout : 8000,
    }, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        res.writeHead(upstream.statusCode, CORS);
        res.end();
        return;
      }

      res.writeHead(200, { ...TILE_HEADERS, 'X-Tile-Cache': 'MISS' });

      if (zi <= TILE_CACHE_MAX_ZOOM) {
        fs.mkdirSync(cacheDir, { recursive: true });
        const tee        = new stream.PassThrough();
        const fileStream = fs.createWriteStream(cachePath);
        upstream.pipe(tee);
        tee.pipe(res);
        tee.pipe(fileStream);
        fileStream.on('error', () => {
          try { fs.unlinkSync(cachePath); } catch(_) {}
        });
      } else {
        upstream.pipe(res);
      }
    }).on('error', () => {
      if (!res.headersSent) {
        res.writeHead(200, { ...CORS, 'Content-Type': 'image/png' });
      }
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    });
    return;
  }

  // ── /api/airspace ─────────────────────────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/airspace')) {
    if (!OPENAIP_API_KEY) {
      sendJSON(res, 200, [], { 'X-Airspace': 'no-key' });
      return;
    }
    try {
      const params = new URL(url, 'http://localhost').searchParams;
      const lat    = parseFloat(params.get('lat') || '51');
      const lon    = parseFloat(params.get('lon') || '10');
      const region = _findAirspaceRegion(lat, lon);

      if (!region) {
        sendJSON(res, 200, [], { 'X-Airspace': 'no-region' });
        return;
      }

      let cached = _airspaceCache[region.id];

      if (!cached) {
        _loadAirspaceFromDisk(region);
        cached = _airspaceCache[region.id];
      }

      if (!cached) {
        refreshAirspaceRegion(region);
        sendJSON(res, 200, [], { 'X-Airspace': `warming (${region.id})` });
        return;
      }

      const features = cached.features;
      const ageH     = Math.round((Date.now() - cached.ts) / 3600_000);
      sendJSON(res, 200, features, {
        'Cache-Control': 'max-age=3600',
        'X-Airspace'   : `${features.length} zones (${region.id}, ${ageH}h)`,
      });
    } catch (e) {
      console.warn('[Proxy] Airspace error:', e.message);
      sendJSON(res, 200, []);
    }
    return;
  }

  // ── /api/roadmap ──────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/roadmap') {
    try {
      const data = fs.readFileSync(ROADMAP_FILE, 'utf8');
      sendJSON(res, 200, data, { 'Cache-Control': 'max-age=3600' });
    } catch (e) {
      send502(res, 'roadmap.json not found');
    }
    return;
  }

  // ── /api/likes ────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/likes') {
    try {
      const likes = JSON.parse(fs.readFileSync(LIKES_FILE, 'utf8'));
      sendJSON(res, 200, likes);
    } catch (e) { sendJSON(res, 200, {}); }
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/likes/')) {
    const id = url.replace('/api/likes/', '').split('?')[0];
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) {
      sendJSON(res, 400, { error: 'invalid id' });
      return;
    }
    try {
      const likes = JSON.parse(fs.readFileSync(LIKES_FILE, 'utf8'));
      likes[id] = (likes[id] || 0) + 1;
      fs.writeFile(LIKES_FILE, JSON.stringify(likes, null, 2), (err) => {
        if (err) return sendJSON(res, 500, { error: 'save failed' });
        sendJSON(res, 200, { id, likes: likes[id] });
      });
    } catch (e) { send502(res, e.message); }
    return;
  }

  // ── 404 ──────────────────────────────────────────────────────
  res.writeHead(404, CORS);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('[Proxy] Running on port', PORT);
  if (OPENSKY_CLIENT_ID) console.log('[Proxy] OpenSky client:', OPENSKY_CLIENT_ID);
  if (AIS_API_KEY)       console.log('[Proxy] AISstream key: configured & WebSocket Active');
  else                   console.warn('[Proxy] AIS_API_KEY not set — ships will be decorative');
  if (OPENAIP_API_KEY)   console.log('[Proxy] AIP_API: configured');
  else                   console.log('[Proxy] AIP_API_KEY not set - no Flightzones available')
});