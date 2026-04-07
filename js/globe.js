/* =====================================================
   GLOBE — Three.js 3D renderer  (v2 — optimized)

   Performance fixes vs v1:
   ─────────────────────────────────────────────────
   1. Dirty flags — _flightsDirty / _shipsDirty / _satsDirty
      _updateFlightPoints() only runs when data actually changed,
      not every requestAnimationFrame tick.

   2. Jamming pulse: NO more geometry.dispose()+new RingGeometry()
      per frame. Pulse ring is a pre-built full ring that we scale
      and fade via mesh.scale + material.opacity. Zero GC pressure.

   3. Zoom-scale guard — sprite scale only updated when zoom
      delta > threshold, not every frame.

   4. Render-on-demand — renderer.render() skipped when nothing
      changed (no rotation interpolation, no dirty layers, no
      jamming animation). Drops to ~0% CPU when globe is idle.

   5. Dead reckoning — flights extrapolate position from
      heading+speed between API polls (15s interval), so the
      globe always looks live without hammering the GPU with
      full buffer updates at 60fps.

   Architecture unchanged — same public API as v1.
===================================================== */

var Globe = (function () {

  var scene, camera, renderer;
  var globePivot, globeMesh;
  var rotX = 0.3, rotY = 0, targetRotX = 0.3, targetRotY = 0;
  var zoom = 2.8, targetZoom = 2.8;
  var isDragging = false, prevMouse = { x: 0, y: 0 };
  var autoRotate = false;
  var _onMaxZoom = null, _maxZoomFired = false;

  var layers = {
    flights   : { group: null, enabled: true },
    ships     : { group: null, enabled: true },
    satellites: { group: null, enabled: true },
    jamming   : { group: null, enabled: true },
    webcams   : { group: null, enabled: false },
  };

  // ---- Flight buffer ----
  var _flightPoints  = null;
  var _flightData    = [];
  var MAX_FLIGHTS    = 15000;
  var _planeTexture  = null;

  // ---- Dirty flags ----
  var _flightsDirty  = false;
  var _shipsDirty    = false;
  var _satsDirty     = false;

  // ---- Dead reckoning ----
  var _drLastUpdate  = 0;       // timestamp of last full flight data push
  var DR_INTERVAL_MS = 3000;    // extrapolate every 3s between polls

  // ---- Zoom-scale guard ----
  var _lastScaledZoom = -1;
  var ZOOM_SCALE_EPS  = 0.02;   // only rescale sprites if zoom changed > this

  // ---- Render-on-demand ----
  var _needsRender = true;      // always render first frame
  function _markRender() { _needsRender = true; }

  var _selectedFlightIdx = -1;

  // ============================================================
  //  HELPERS
  // ============================================================

  function latLonToVec3(lat, lon, r) {
    r = r || 1.01;
    var phi   = (90 - lat) * Math.PI / 180;
    var theta = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
       r * Math.cos(phi),
       r * Math.sin(phi) * Math.sin(theta)
    );
  }

  function _isFacingCamera(lat, lon) {
    var pos = latLonToVec3(lat, lon, 1.0);
    pos.applyEuler(new THREE.Euler(rotX, rotY, 0, 'XYZ'));
    return pos.z > -0.05;
  }

  function _fmtCoord(lat, lon) {
    var la = Math.abs(lat).toFixed(2) + '° ' + (lat >= 0 ? 'N' : 'S');
    var lo = Math.abs(lon).toFixed(2) + '° ' + (lon >= 0 ? 'E' : 'W');
    return la + '  ' + lo;
  }

  function _hexToRgb(h) {
    var n = (typeof h === 'string') ? parseInt(h.replace('#', ''), 16) : h;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // ============================================================
  //  PLANE TEXTURE (canvas — unchanged from v1)
  // ============================================================

  function _makeCanvasPlaneTexture(colorHex) {
    var rgb = _hexToRgb(colorHex);
    var S   = 64;
    var cv  = document.createElement('canvas');
    cv.width = cv.height = S;
    var c   = cv.getContext('2d');
    var col = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';

    c.clearRect(0, 0, S, S);
    c.fillStyle = col;
    c.save();
    c.translate(S / 2, S / 2);
    c.scale(S / 44, S / 44);

    c.beginPath(); c.ellipse(0, 0, 3, 14, 0, 0, Math.PI * 2); c.fill();

    c.beginPath();
    c.moveTo(-3, -2); c.lineTo(-20, 8); c.lineTo(-20, 11);
    c.lineTo(-3, 4);  c.lineTo(3, 4);
    c.lineTo(20, 11); c.lineTo(20, 8); c.lineTo(3, -2);
    c.closePath(); c.fill();

    c.beginPath();
    c.moveTo(-3, 9); c.lineTo(-9, 18); c.lineTo(-3, 16);
    c.lineTo(0, 14); c.lineTo(3, 16);  c.lineTo(9, 18);
    c.lineTo(3, 9);  c.closePath();    c.fill();

    c.restore();
    return new THREE.CanvasTexture(cv);
  }

  // ============================================================
  //  FLIGHT RENDERING — ShaderMaterial Points
  // ============================================================

  function _buildFlightPoints() {
    if (_flightPoints) {
      layers.flights.group.remove(_flightPoints);
      _flightPoints.geometry.dispose();
      _flightPoints.material.dispose();
      _flightPoints = null;
    }

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        map        : { value: _planeTexture },
        selectedIdx: { value: -1 },
      },
      vertexShader: [
        'attribute float heading;',
        'attribute float idx;',
        'varying float vHeading;',
        'varying float vIdx;',
        'void main() {',
        '  vHeading = heading;',
        '  vIdx     = idx;',
        // modelMatrix incorporates globePivot rotation → worldPos.z > 0 = front hemisphere
        // WebGL hard-clips gl.POINTS at the viewport edge when the CENTER is off-screen,
        // creating a visible "cut line". Hide back-hemisphere points before that happens.
        '  vec4 wpos = modelMatrix * vec4(position, 1.0);',
        '  if (wpos.z < 0.05) {',
        '    gl_PointSize = 0.0;',
        '    gl_Position  = vec4(10.0, 10.0, 10.0, 1.0);',
        '  } else {',
        '    gl_PointSize = 22.0;',
        '    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '  }',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map;',
        'uniform float selectedIdx;',
        'varying float vHeading;',
        'varying float vIdx;',
        'void main() {',
        '  vec2 uv  = gl_PointCoord - 0.5;',
        '  uv.y     = -uv.y;',
        '  float s  = sin(vHeading); float c = cos(vHeading);',
        '  uv       = vec2(c*uv.x+s*uv.y, -s*uv.x+c*uv.y) + 0.5;',
        '  if (uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) discard;',
        '  vec4 col = texture2D(map,uv);',
        '  if (col.a < 0.4) discard;',
        '  if (abs(vIdx-selectedIdx)<0.5) col.rgb = vec3(1.0,0.15,0.15);',
        '  gl_FragColor = col;',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite : false,
      depthTest  : true,
    });

    var geo       = new THREE.BufferGeometry();
    var positions = new Float32Array(MAX_FLIGHTS * 3);
    var headings  = new Float32Array(MAX_FLIGHTS);
    var indices   = new Float32Array(MAX_FLIGHTS);

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('heading',  new THREE.BufferAttribute(headings,  1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('idx',      new THREE.BufferAttribute(indices,   1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);

    _flightPoints = new THREE.Points(geo, mat);
    _flightPoints.frustumCulled = false;
    _flightPoints.renderOrder   = 1;
    layers.flights.group.add(_flightPoints);
  }

  // Only called when _flightsDirty — not every frame
  function _updateFlightPoints() {
    if (!_flightPoints || !_flightData.length) return;

    var positions = _flightPoints.geometry.attributes.position.array;
    var headings  = _flightPoints.geometry.attributes.heading.array;
    var indices   = _flightPoints.geometry.attributes.idx.array;
    var visible   = 0;

    for (var i = 0; i < _flightData.length && visible < MAX_FLIGHTS; i++) {
      var f = _flightData[i];
      if (f.lat == null || f.lon == null) continue;
      var pos = latLonToVec3(f.lat, f.lon, 1.016);
      positions[visible * 3]     = pos.x;
      positions[visible * 3 + 1] = pos.y;
      positions[visible * 3 + 2] = pos.z;
      headings[visible]  = (f.heading || 0) * Math.PI / 180;
      indices[visible]   = visible;
      f._instanceIdx     = visible;
      visible++;
    }

    _flightPoints.geometry.attributes.position.needsUpdate = true;
    _flightPoints.geometry.attributes.heading.needsUpdate  = true;
    _flightPoints.geometry.attributes.idx.needsUpdate      = true;
    _flightPoints.geometry.setDrawRange(0, visible);

    _flightsDirty = false;
    _markRender();
  }

  // Dead reckoning — move flights along heading between API polls
  // Called every DR_INTERVAL_MS, much cheaper than full buffer update
  function _deadReckon() {
    if (!_flightData.length || !_flightPoints) return;
    var dtSec = DR_INTERVAL_MS / 1000;
    var changed = false;

    for (var i = 0; i < _flightData.length; i++) {
      var f = _flightData[i];
      if (!f.speed || !f.heading || f.lat == null) continue;

      // speed in knots → degrees per second (approximate)
      var knotsPerDegLat = 60;               // 1 deg lat ≈ 60 nm
      var hdgRad         = f.heading * Math.PI / 180;
      var distNm         = f.speed * dtSec / 3600;

      f.lat += (distNm / knotsPerDegLat) * Math.cos(hdgRad);
      f.lon += (distNm / (knotsPerDegLat * Math.cos(f.lat * Math.PI / 180))) * Math.sin(hdgRad);

      // Wrap longitude
      if (f.lon >  180) f.lon -= 360;
      if (f.lon < -180) f.lon += 360;
      changed = true;
    }

    if (changed) {
      _flightsDirty = true;
      _markRender();
    }
  }

  function selectFlight(idx) {
    _selectedFlightIdx = idx;
    if (_flightPoints) {
      _flightPoints.material.uniforms.selectedIdx.value = idx;
      _markRender();
    }
  }

  function deselectFlight() {
    _selectedFlightIdx = -1;
    if (_flightPoints) {
      _flightPoints.material.uniforms.selectedIdx.value = -1;
      _markRender();
    }
  }

  // ============================================================
  //  ICON SPRITES — ships + satellites (unchanged from v1)
  // ============================================================

  var _iconCache = {};

  function _makeIconSprite(type, colorHex, size) {
    var key = type + '_' + colorHex;
    if (!_iconCache[key]) {
      var C   = 128;
      var cv  = document.createElement('canvas');
      cv.width = cv.height = C;
      var ctx = cv.getContext('2d');
      var c   = C / 2;
      var col = _hexToRgb(colorHex);
      var css = 'rgb(' + col.r + ',' + col.g + ',' + col.b + ')';

      if (type === 'ship') {
        // Ship hull silhouette — top-down view, bow pointing up
        ctx.save();
        ctx.translate(c, c);
        ctx.shadowColor = css; ctx.shadowBlur = 10;
        ctx.fillStyle   = css;
        var sz = 26;
        ctx.beginPath();
        ctx.moveTo(0,         -sz * 0.9);
        ctx.lineTo( sz * 0.35, -sz * 0.4);
        ctx.lineTo( sz * 0.4,   sz * 0.5);
        ctx.lineTo( sz * 0.2,   sz * 0.9);
        ctx.lineTo(-sz * 0.2,   sz * 0.9);
        ctx.lineTo(-sz * 0.4,   sz * 0.5);
        ctx.lineTo(-sz * 0.35, -sz * 0.4);
        ctx.closePath();
        ctx.fill();
        // Bridge block
        ctx.shadowBlur = 0;
        ctx.fillStyle  = 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',0.55)';
        ctx.fillRect(-sz * 0.18, -sz * 0.1, sz * 0.36, sz * 0.4);
        ctx.restore();

      } else if (type === 'satellite') {
        ctx.beginPath(); ctx.arc(c, c, 28, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fill();
        ctx.save(); ctx.translate(c, c); ctx.fillStyle = css;
        ctx.fillRect(-44, -5, 20, 10); ctx.fillRect(24, -5, 20, 10);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1;
        [-38, -30, -22].forEach(function (x) { ctx.beginPath(); ctx.moveTo(x, -5); ctx.lineTo(x, 5); ctx.stroke(); });
        [30, 38].forEach(function (x) { ctx.beginPath(); ctx.moveTo(x, -5); ctx.lineTo(x, 5); ctx.stroke(); });
        ctx.fillStyle = css;
        ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(12, 0); ctx.lineTo(0, 12); ctx.lineTo(-12, 0); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

      } else if (type === 'camera') {
        // Glow halo
        var grad = ctx.createRadialGradient(c, c, 8, c, c, 40);
        grad.addColorStop(0, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',0.25)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath(); ctx.arc(c, c, 40, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();
        ctx.save(); ctx.translate(c, c);
        ctx.shadowColor = css; ctx.shadowBlur = 10;
        ctx.fillStyle = css;
        // Body
        ctx.roundRect(-22, -14, 44, 28, 4); ctx.fill();
        // Viewfinder bump
        ctx.roundRect(-8, -22, 16, 10, 2); ctx.fill();
        // Lens ring
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.beginPath(); ctx.arc(0, 2, 11, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = css; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 2, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',0.3)';
        ctx.beginPath(); ctx.arc(0, 2, 4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      _iconCache[key] = new THREE.CanvasTexture(cv);
    }

    var mat = new THREE.SpriteMaterial({ map: _iconCache[key], transparent: true, depthWrite: false, depthTest: true });
    var spr = new THREE.Sprite(mat);
    spr.scale.set(size, size, 1);
    return spr;
  }

  function _makeLabelSprite(text, colorHex) {
    var col = _hexToRgb(colorHex);
    var cv  = document.createElement('canvas');
    cv.width = 200; cv.height = 36;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(2,10,20,0.75)'; ctx.fillRect(0, 0, 200, 36);
    ctx.font      = 'bold 18px monospace';
    ctx.fillStyle = 'rgb(' + col.r + ',' + col.g + ',' + col.b + ')';
    ctx.fillText(text, 6, 24);
    var mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false });
    var spr = new THREE.Sprite(mat);
    spr.scale.set(0.1, 0.018, 1);
    return spr;
  }

  function _makeSatGroundLine(satPos) {
    var nadir = satPos.clone().normalize();
    var geo   = new THREE.BufferGeometry().setFromPoints([satPos, nadir]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.2 }));
  }

  // ============================================================
  //  SCENE INIT
  // ============================================================

  function init(container) {
    var W = container.clientWidth, H = container.clientHeight;

    scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x020408);

    camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
    camera.position.set(0, 0, zoom);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    container.appendChild(renderer.domElement);

    globePivot = new THREE.Group();
    scene.add(globePivot);

    _buildStarfield();
    _buildGlobe();
    _buildGridLines();
    _buildLayerGroups();
    _buildLighting();
    _attachControls(renderer.domElement);

    _planeTexture = _makeCanvasPlaneTexture(0xffd700);
    _buildFlightPoints();

    // Dead reckoning timer
    setInterval(_deadReckon, DR_INTERVAL_MS);

    window.addEventListener('resize', function () {
      var W = container.clientWidth, H = container.clientHeight;
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      renderer.setSize(W, H);
      _markRender();
    });
  }

  function _buildStarfield() {
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(6000 * 3);
    for (var i = 0; i < pos.length; i++) pos[i] = (Math.random() - 0.5) * 400;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaaccff, size: 0.3, sizeAttenuation: true })));
  }

  function _buildGlobe() {
    var texLoader = new THREE.TextureLoader();
    var earthTex  = texLoader.load(
      'https://unpkg.com/three-globe/example/img/earth-night.jpg',
      function () { _markRender(); }
    );
    earthTex.anisotropy = 16;
    globeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 64),
      new THREE.MeshPhongMaterial({ map: earthTex, specular: new THREE.Color(0x111122), shininess: 8 })
    );
    globeMesh.renderOrder = 0;
    globePivot.add(globeMesh);
  }

  function _buildGridLines() {
    var mat = new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.05 });
    for (var lat = -80; lat <= 80; lat += 20) {
      var pts = [];
      for (var lon = 0; lon <= 361; lon += 2) pts.push(latLonToVec3(lat, lon, 1.001));
      globePivot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    for (var lon2 = 0; lon2 < 360; lon2 += 20) {
      var pts2 = [];
      for (var lat2 = -90; lat2 <= 90; lat2 += 2) pts2.push(latLonToVec3(lat2, lon2, 1.001));
      globePivot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts2), mat));
    }
  }

  function _buildLayerGroups() {
    Object.keys(layers).forEach(function (k) {
      layers[k].group = new THREE.Group();
      layers[k].group.renderOrder = 2;
      globePivot.add(layers[k].group);
    });
  }

  function _buildLighting() {
    scene.add(new THREE.AmbientLight(0x334455, 1.2));
    var sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(5, 3, 5);
    scene.add(sun);
    var fill = new THREE.DirectionalLight(0x112244, 0.4);
    fill.position.set(-3, -2, -3);
    scene.add(fill);
  }

  function _attachControls(el) {
    el.addEventListener('mousedown', function (e) {
      isDragging = true;
      prevMouse  = { x: e.clientX, y: e.clientY };
      document.body.classList.add('dragging');
    });
    window.addEventListener('mouseup', function () {
      isDragging = false;
      document.body.classList.remove('dragging');
    });
    var _coordEl    = null;
    var _raycaster  = new THREE.Raycaster();
    var _mousePt    = new THREE.Vector2();

    el.addEventListener('mousemove', function (e) {
      if (isDragging) {
        targetRotY += (e.clientX - prevMouse.x) * 0.005;
        targetRotX += (e.clientY - prevMouse.y) * 0.005;
        targetRotX  = Math.max(-1.4, Math.min(1.4, targetRotX));
        prevMouse   = { x: e.clientX, y: e.clientY };
        _markRender();
      }
      // Raycast globe surface for coords display
      if (!_coordEl) _coordEl = document.getElementById('coords-display');
      if (!_coordEl || !globeMesh) return;
      var W = el.clientWidth || window.innerWidth;
      var H = el.clientHeight || window.innerHeight;
      _mousePt.set((e.clientX / W) * 2 - 1, -(e.clientY / H) * 2 + 1);
      _raycaster.setFromCamera(_mousePt, camera);
      var hits = _raycaster.intersectObject(globeMesh);
      if (hits.length) {
        // Transform world hit point → globe local space (inverse of globePivot rotation)
        var p   = globePivot.worldToLocal(hits[0].point.clone());
        var lat = Math.asin(Math.max(-1, Math.min(1, p.y))) * 180 / Math.PI;
        var lon = Math.atan2(p.z, -p.x) * 180 / Math.PI - 180;
        if (lon < -180) lon += 360;
        _coordEl.textContent = _fmtCoord(lat, lon);
      } else {
        _coordEl.textContent = '—';
      }
    });

    el.addEventListener('mouseleave', function () {
      if (!_coordEl) _coordEl = document.getElementById('coords-display');
      if (_coordEl) _coordEl.textContent = '—';
    });
    el.addEventListener('wheel', function (e) {
      var W    = el.clientWidth  || window.innerWidth;
      var H    = el.clientHeight || window.innerHeight;
      var nx   = (e.clientX / W - 0.5) * 2;   // -1..1
      var ny   = (e.clientY / H - 0.5) * 2;   // -1..1

      var prev  = targetZoom;
      var delta = e.deltaY * 0.002;
      if (delta < 0 && targetZoom <= 2.8) delta = e.deltaY * 0.0003;
      targetZoom = Math.max(1.4, Math.min(5, targetZoom + delta));

      // Rotate globe toward mouse so zoom feels anchored to cursor.
      // R_y: increasing rotY moves world-x>0 content further RIGHT (away from center),
      // so to bring right-side content to center on zoom-in (dz<0, f<0) we need +=nx*f.
      // Same logic applies for rotX / ny.
      var dz = targetZoom - prev;
      if (Math.abs(dz) > 0.0005) {
        var f   = 0.41 * dz / Math.max(prev, 1.4);
        targetRotY += nx * f;
        targetRotX += ny * f;
        targetRotX  = Math.max(-1.4, Math.min(1.4, targetRotX));
      }
      _markRender();
    }, { passive: true });

    var lt = null;
    el.addEventListener('touchstart', function (e) { isDragging = true; lt = e.touches[0]; });
    el.addEventListener('touchend',   function ()  { isDragging = false; });
    el.addEventListener('touchmove',  function (e) {
      if (!isDragging || !lt) return;
      targetRotY += (e.touches[0].clientX - lt.clientX) * 0.005;
      targetRotX += (e.touches[0].clientY - lt.clientY) * 0.005;
      lt = e.touches[0];
      e.preventDefault();
      _markRender();
    }, { passive: false });
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
    _flightData   = flights;
    _flightsDirty = true;
    _drLastUpdate = Date.now();
    _markRender();
  }

  function _populateShips(ships) {
    layers.ships.group.clear();
    ships.forEach(function (s) {
      var spr = _makeIconSprite('ship', 0x4488ff, 0.055);
      spr.userData = { type: 'ship', data: s };
      spr.position.copy(latLonToVec3(s.lat, s.lon, 1.008));
      layers.ships.group.add(spr);
      s._mesh = spr;
    });
    _shipsDirty = false;
    _markRender();
  }

  function _populateSatellites(sats) {
    layers.satellites.group.clear();
    sats.forEach(function (s) {
      if (s.currentLat === undefined) return;
      var group    = new THREE.Group();
      var spr      = _makeIconSprite('satellite', 0x00ffe0, 0.075);
      spr.userData.isIcon = true;
      group.add(spr);
      var shortName = s.name.length > 14 ? s.name.substring(0, 14) : s.name;
      var lbl = _makeLabelSprite(shortName, 0x00ffe0);
      lbl.position.set(0.07, 0.04, 0);
      group.add(lbl);
      var satPos = latLonToVec3(s.currentLat, s.currentLon, 1.08);
      group.add(_makeSatGroundLine(satPos));
      group.position.copy(satPos);
      group.userData = { type: 'satellite', data: s, lat: s.currentLat, lon: s.currentLon };
      layers.satellites.group.add(group);
      s._mesh    = group;
      s._satPos  = satPos.clone();
    });
    _satsDirty = false;
    _markRender();
  }

  function _populateJamming(zones) {
    layers.jamming.group.clear();

    zones.forEach(function (z, i) {
      var center = latLonToVec3(z.lat, z.lon, 1.002);
      var look   = new THREE.Vector3(0, 0, 0);

      // Fill
      var fill = new THREE.Mesh(
        new THREE.CircleGeometry(z.radius, 48),
        new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })
      );
      fill.position.copy(center); fill.lookAt(look);
      layers.jamming.group.add(fill);

      // Outer ring
      var ring = new THREE.Mesh(
        new THREE.RingGeometry(z.radius * 0.995, z.radius, 64),
        new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.position.copy(center); ring.lookAt(look);
      layers.jamming.group.add(ring);

      // ── FIXED PULSE RING ──────────────────────────────────────
      // v1 called geometry.dispose() + new RingGeometry() 60x/sec → memory leak
      // v2: full-size ring, animate via .scale + material.opacity only — zero GC
      var pulse = new THREE.Mesh(
        new THREE.RingGeometry(z.radius * 0.01, z.radius, 48),
        new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false })
      );
      pulse.position.copy(center); pulse.lookAt(look);
      pulse.userData.isPulse = true;
      pulse.userData.phase   = i * 1.3;
      layers.jamming.group.add(pulse);
      // ─────────────────────────────────────────────────────────

      // Label
      var lbl    = _makeLabelSprite('⚡ ' + z.label, 0xff4444);
      var lblPos = latLonToVec3(z.lat, z.lon, 1.025);
      lbl.position.copy(lblPos);
      lbl.scale.set(0.18, 0.06, 1);
      layers.jamming.group.add(lbl);
    });
  }


  // ============================================================
  //  PER-FRAME SYNC  (app.js calls this every rAF)
  //  Now just marks dirty — no buffer writes here
  // ============================================================

  function syncPositions(flights, ships, satellites) {
    // Flights — dirty flag set by _deadReckon or _populateFlights
    // No work here — buffer updates happen in render() only when dirty

    // Ships — just move existing sprites (O(n) position.copy, very cheap)
    var shipsMoved = false;
    ships.forEach(function (s) {
      if (s._mesh) {
        s._mesh.position.copy(latLonToVec3(s.lat, s.lon, 1.008));
        shipsMoved = true;
      }
    });
    if (shipsMoved) _markRender();

    // Satellites — update position + nadir line
    var satsMoved = false;
    satellites.forEach(function (s) {
      if (!s._mesh || s.currentLat === undefined) return;
      var satPos = latLonToVec3(s.currentLat, s.currentLon, 1.08);
      s._mesh.position.copy(satPos);
      s._mesh.userData.lat = s.currentLat;
      s._mesh.userData.lon = s.currentLon;
      s._mesh.children.forEach(function (child) {
        if (child.isLine) {
          var nadir = satPos.clone().normalize();
          var pos   = child.geometry.attributes.position;
          pos.setXYZ(0, 0, 0, 0);
          var rel = nadir.clone().sub(satPos);
          pos.setXYZ(1, rel.x, rel.y, rel.z);
          pos.needsUpdate = true;
        }
      });
      satsMoved = true;
    });
    if (satsMoved) _markRender();
  }

  // ============================================================
  //  RENDER — on-demand
  // ============================================================

  function render(t) {
    // ── Interpolate rotation / zoom ──────────────────────────
    var dRotX = (targetRotX - rotX) * 0.08;
    var dRotY = (targetRotY - rotY) * 0.08;
    var dZoom = (targetZoom - zoom)  * 0.06;

    var interpolating = Math.abs(dRotX) > 0.0001 || Math.abs(dRotY) > 0.0001 || Math.abs(dZoom) > 0.0001;
    if (interpolating) {
      rotX += dRotX;
      rotY += dRotY;
      zoom += dZoom;
      globePivot.rotation.x = rotX;
      globePivot.rotation.y = rotY;
      camera.position.z     = zoom;
      _markRender();
    }

    // Auto-rotate
    if (!isDragging && autoRotate) {
      targetRotY += 0.0005;
      _markRender();
    }

    // Max-zoom trigger
    if (zoom < 1.45 && _onMaxZoom && !_maxZoomFired) {
      _maxZoomFired = true;
      _onMaxZoom(rotX, rotY, zoom);
    }
    if (zoom >= 1.45) _maxZoomFired = false;

    // ── Sprite zoom scaling (guarded) ────────────────────────
    if (Math.abs(zoom - _lastScaledZoom) > ZOOM_SCALE_EPS) {
      _lastScaledZoom = zoom;
      var iconScale   = Math.max(0.4, Math.min(3.5, Math.pow(2.8 / zoom, 1.5)));
      ['ships', 'satellites'].forEach(function (name) {
        layers[name].group.children.forEach(function (obj) {
          if (obj.isSprite) {
            obj.scale.setScalar(0.065 * iconScale);
          } else if (obj.isGroup) {
            obj.children.forEach(function (child) {
              if (child.isSprite && child.userData.isIcon) {
                child.scale.setScalar(0.075 * iconScale);
              }
            });
          }
        });
      });
      _markRender();
    }

    // ── Jamming pulse — scale transform only, NO geometry alloc ─
    if (layers.jamming.enabled) {
      layers.jamming.group.children.forEach(function (m) {
        if (!m.userData.isPulse) return;
        var phase = (t * 0.8 + m.userData.phase) % 1.0;
        // Scale the pre-built full ring from 0 → 1
        m.scale.set(phase, phase, 1);
        m.material.opacity = 0.6 * (1.0 - phase);
      });
      _markRender(); // jamming always animates while enabled
    }

    // ── Flush dirty flight buffer ────────────────────────────
    if (_flightsDirty) _updateFlightPoints();

    // ── Render only when something changed ──────────────────
    if (!_needsRender) return;
    _needsRender = false;
    renderer.render(scene, camera);
  }

  // ============================================================
  //  PUBLIC API
  // ============================================================

  function toggleLayer(name) {
    var l = layers[name];
    if (!l) return;
    l.enabled        = !l.enabled;
    l.group.visible  = l.enabled;
    _markRender();
  }

  function _populateWebcams(cams) {
    layers.webcams.group.clear();
    cams.forEach(function (cam) {
      var loc = cam.location;
      if (!loc || !loc.latitude || !loc.longitude) return;
      var spr = _makeIconSprite('camera', 0xff69b4, 0.05);
      spr.userData = { type: 'webcam', data: cam };
      spr.position.copy(latLonToVec3(loc.latitude, loc.longitude, 1.008));
      layers.webcams.group.add(spr);
    });
    _markRender();
  }

  function populateLayer(name, data) {
    if      (name === 'flights')    _populateFlights(data);
    else if (name === 'ships')      _populateShips(data);
    else if (name === 'satellites') _populateSatellites(data);
    else if (name === 'webcams')    _populateWebcams(data);
    else if (name === 'jamming')    _populateJamming(data); // <-- DIESE ZEILE NEU
  }

  function getHitAtMouse(mouseNDC) {
    if (_flightPoints && _flightData.length && layers.flights.enabled) {
      var ray = new THREE.Raycaster();
      ray.params.Points = { threshold: 0.04 };
      ray.setFromCamera(mouseNDC, camera);
      var hits = ray.intersectObject(_flightPoints, false);
      if (hits.length) {
        var idx = hits[0].index;
        for (var fi = 0; fi < _flightData.length; fi++) {
          if (_flightData[fi]._instanceIdx === idx) return { type: 'flight', data: _flightData[fi] };
        }
      }
    }

    var raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouseNDC, camera);
    var targets = [];
    ['ships', 'satellites'].forEach(function (name) {
      if (!layers[name].group.visible) return;
      layers[name].group.children.forEach(function (obj) {
        obj.traverse(function (c) { if (c.isSprite || c.isMesh) targets.push(c); });
      });
    });
    var hits2 = raycaster.intersectObjects(targets, false);
    if (!hits2.length) return null;
    for (var i = 0; i < hits2.length; i++) {
      var obj = hits2[i].object;
      while (obj && !obj.userData.type) obj = obj.parent;
      if (!obj) continue;
      var ud = obj.userData;
      if (ud.lat != null && !_isFacingCamera(ud.lat, ud.lon)) continue;
      return ud;
    }
    return null;
  }

  function setAutoRotate(val) { autoRotate = val; if (val) _markRender(); }
  function getCanvas()        { return renderer ? renderer.domElement : null; }
  function onMaxZoom(cb)      { _onMaxZoom = cb; }
  function resetZoom()        { targetZoom = 2.8; _maxZoomFired = false; _markRender(); }
  function refresh()          { _markRender(); }

  return {
    init, populate, populateLayer, syncPositions,
    render, toggleLayer, getHitAtMouse, getCanvas,
    selectFlight, deselectFlight, setAutoRotate,
    onMaxZoom, resetZoom, refresh,
  };

}());