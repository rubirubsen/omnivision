#!/usr/bin/env node
/* =====================================================
   seed-tiles.js — CartoDB Dark Matter tile pre-seeder

   Füllt den .tile-cache/ Ordner vorab, sodass beim
   ersten Seitenaufruf alles sofort aus dem Cache kommt.

   Ausführen VOR dem Umstellen der Leaflet-URL:
     node seed-tiles.js

   Zoom-Abdeckung und Tile-Anzahl:
     Z0  =       1 Tile  (Weltkarte)
     Z1  =       4
     Z2  =      16
     Z3  =      64
     Z4  =     256
     Z5  =   1.024  → Gesamt Z0-5: ~1.365 Tiles (~5 MB)
     Z6  =   4.096  → Gesamt Z0-6: ~5.460 Tiles (~20 MB)
     Z7  =  16.384  → Gesamt Z0-7: ~21.845 Tiles (~80 MB)
     Z8  =  65.536  → Gesamt Z0-8: ~87.380 Tiles (~320 MB)

   Standard: seeded bis Z6 (gut für Übersicht + Kontinente)
   Anpassen: MAX_ZOOM weiter unten ändern

   Nach dem Seeding Leaflet-URL in map.js ändern auf:
     http://DEIN-VPS:3001/api/tiles/{s}/{z}/{x}/{y}
===================================================== */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ---- Config ----
const CACHE_DIR    = path.join(__dirname, '.tile-cache');
const MAX_ZOOM     = parseInt(process.argv[2] || '6');  // node seed-tiles.js 8
const CONCURRENCY  = 8;   // parallele Downloads (erhöhen auf 16 auf schnellen VPS)
const SUBDOMAIN    = 'a'; // immer 'a' für Seeding, Leaflet rotiert später
const RETRY_MAX    = 3;
const DELAY_MS     = 20;  // ms zwischen Requests — CartoDB nicht überlasten

if (MAX_ZOOM > 9) {
  console.error('MAX_ZOOM > 9 nicht empfohlen ohne Festplattenprüfung (Z10 = ~5GB)');
  process.exit(1);
}

// ---- Tile count berechnen ----
function tileCount(maxZoom) {
  let n = 0;
  for (let z = 0; z <= maxZoom; z++) n += Math.pow(4, z);
  return n;
}

// ---- Alle Tile-Koordinaten für einen Zoom-Level ----
function* tilesForZoom(z) {
  const max = Math.pow(2, z);
  for (let x = 0; x < max; x++)
    for (let y = 0; y < max; y++)
      yield { z, x, y };
}

// ---- Einzelnen Tile fetchen + cachen ----
function fetchTile(z, x, y) {
  return new Promise((resolve, reject) => {
    const url  = `https://${SUBDOMAIN}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
    const dir  = path.join(CACHE_DIR, String(z), String(x));
    const file = path.join(dir, y + '.png');

    // Skip if already cached
    if (fs.existsSync(file)) { resolve('skip'); return; }

    const req = https.get(url, {
      headers: { 'User-Agent': 'OmniVision-Seeder/1.0', 'Accept-Encoding': 'identity' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buf);
        resolve('ok');
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---- Retry wrapper ----
async function fetchWithRetry(z, x, y, attempt = 0) {
  try {
    return await fetchTile(z, x, y);
  } catch (e) {
    if (attempt < RETRY_MAX) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      return fetchWithRetry(z, x, y, attempt + 1);
    }
    throw e;
  }
}

// ---- Concurrency pool ----
async function runPool(tasks, concurrency) {
  let i = 0, done = 0, failed = 0, skipped = 0;
  const total = tasks.length;
  const start = Date.now();

  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      try {
        const result = await fetchWithRetry(task.z, task.x, task.y);
        if (result === 'skip') skipped++; else done++;
      } catch (e) {
        failed++;
        console.error(`  ✗ ${task.z}/${task.x}/${task.y}: ${e.message}`);
      }
      if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));

      // Progress line
      const pct     = Math.round(((done + skipped + failed) / total) * 100);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const eta     = elapsed > 2
        ? Math.round((total - done - skipped - failed) / ((done + skipped) / elapsed))
        : '?';
      process.stdout.write(`\r  Z${task.z} — ${done + skipped}/${total} tiles (${pct}%)  ↓${done} skip${skipped} ✗${failed}  ${elapsed}s elapsed, ~${eta}s left   `);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write('\n');
  return { done, skipped, failed };
}

// ---- Main ----
async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const total = tileCount(MAX_ZOOM);
  console.log(`\n🌍  OmniVision Tile Seeder`);
  console.log(`    Cache-Dir : ${CACHE_DIR}`);
  console.log(`    Max Zoom  : Z${MAX_ZOOM}`);
  console.log(`    Tiles     : ${total.toLocaleString()} (~${Math.round(total * 4 / 1024)}MB geschätzt)`);
  console.log(`    Parallel  : ${CONCURRENCY} gleichzeitig\n`);

  let totalDone = 0, totalSkipped = 0, totalFailed = 0;

  for (let z = 0; z <= MAX_ZOOM; z++) {
    const tasks = [...tilesForZoom(z)];
    console.log(`  → Zoom ${z}: ${tasks.length} Tiles`);
    const { done, skipped, failed } = await runPool(tasks, CONCURRENCY);
    totalDone    += done;
    totalSkipped += skipped;
    totalFailed  += failed;
  }

  const diskMB = (() => {
    let bytes = 0;
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else bytes += fs.statSync(p).size;
      });
    }
    walk(CACHE_DIR);
    return (bytes / 1024 / 1024).toFixed(1);
  })();

  console.log(`\n✅  Seeding abgeschlossen`);
  console.log(`    Neu geladen : ${totalDone}`);
  console.log(`    Übersprungen: ${totalSkipped} (schon gecacht)`);
  console.log(`    Fehler      : ${totalFailed}`);
  console.log(`    Disk-Nutzung: ${diskMB} MB\n`);

  if (totalFailed === 0) {
    console.log(`Jetzt in map.js die Leaflet-URL ändern auf:`);
    console.log(`  'http://DEIN-VPS:3001/api/tiles/{s}/{z}/{x}/{y}'\n`);
  } else {
    console.log(`⚠  ${totalFailed} Tiles fehlgeschlagen — script erneut ausführen um fehlende nachzuladen.\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
