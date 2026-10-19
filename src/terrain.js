// Native DEM viewer: every visible tile uses a common display level.
// Resident regional meshes maintain coverage while more detailed tiles load.
(async function startTerrainViewer() {
  'use strict';

  // Main flow: load the manifest and shared resources, create the scene/loading queue, select local LOD by distance,
  // Replace visible tile sets atomically. Input and resource changes update navigation, collision constraints and quality.
  const status = document.querySelector('#status');
  const slider = document.querySelector('#vertical-scale');
  const scaleLabel = document.querySelector('#scale-value');
  const resolutionLabel = document.querySelector('#grid-resolution');
  const tileset = window.NOTO_TILESET;
  const zoomButtons = [...document.querySelectorAll('[data-zoom]')];
  const helpDialog = document.querySelector('#controls-help');
  const settingsDialog = document.querySelector('#terrain-settings');
  const resolutionSelect = document.querySelector('#maximum-resolution');
  const windowResolutionSelect = document.querySelector('#window-resolution');
  const vegetationDetailSelect = document.querySelector('#vegetation-detail');
  const idleSleepSelect = document.querySelector('#idle-sleep-delay');
  const windowResolutionLabel = document.querySelector('#window-resolution-current');
  let navigationReady = false;
  const navigationPaused = () => !navigationReady || helpDialog.open || settingsDialog.open;
  document.querySelector('#settings-button').addEventListener('click', () => settingsDialog.showModal());
  document.querySelector('#settings-close').addEventListener('click', () => settingsDialog.close());
  document.querySelector('#help-button').addEventListener('click', () => helpDialog.showModal());
  document.querySelector('#help-close').addEventListener('click', () => helpDialog.close());
  /* Yield to a zero-delay browser task so a frame can be drawn. Returns Promise<void>. */
  const waitFrame = () => new Promise(resolve => setTimeout(resolve, 0));

  // 1. Offline-compatible script resources and compressed arrays.
  async function decompress(value) {
    /* Decode a Base64 gzip payload through Uint8Array and DecompressionStream. Returns Promise<ArrayBuffer>. */
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  /* Decompress a Base64 gzip payload and decode UTF-8. Returns Promise<string>. */
  const decode = async value => new TextDecoder().decode(await decompress(value));
  /* Wrap JavaScript source in a text/javascript Blob. Returns an object URL string. */
  const moduleURL = source => URL.createObjectURL(new Blob([source], {
    type: 'text/javascript'
  }));
  function errorMessage(error) {
    /* Report an error to the console and visible status area. Returns undefined. */
    console.error(error);
    zoomButtons.forEach(button => {
      button.disabled = true;
    });
    // Once ready, sleep controls remain available even if a later tile fails.
    resolutionSelect.disabled = windowResolutionSelect.disabled = vegetationDetailSelect.disabled = true;
    status.hidden = false;
    status.className = 'error';
    status.textContent = `Unable to load terrain: ${error.message}`;
  }
  try {
    if (!tileset || !window.NotoTileGeometry || !window.NotoRockMaterials || !window.NotoWaterMaterials || !window.NotoWaterMotion || !window.NotoEnvironment || !window.NotoVegetation) {
      throw new Error('Missing local terrain assets. Keep the data, src and vendor folders together.');
    }
    const libraries = window.NOTO_LIBRARIES;
    const coreURL = moduleURL(await decode(libraries.core));
    const threeURL = moduleURL((await decode(libraries.module)).replaceAll('./three.core.js', coreURL));
    const controlsURL = moduleURL((await decode(libraries.controls)).replaceAll("from 'three'", `from '${threeURL}'`));
    const THREE = await import(threeURL);
    const {
      OrbitControls
    } = await import(controlsURL);
    const m = tileset.metadata;
    // Source DEM spacing, in metres.
    const nativeSpacing = m.source_spacing_m[0];
    // Display levels are sorted by spacing. The array index selects a level; levelKey identifies its tile callback prefix.
    const displayLevels = [...tileset.levels].sort((a, b) => a.step - b.step);
    const maxLevel = displayLevels.length - 1;
    // minimumLevel: index of the finest allowed display level; defaults to the actual 5 m level.
    let minimumLevel = displayLevels.findIndex(level => level.step * nativeSpacing === 5);
    if (minimumLevel < 0) throw new Error('Missing default 5 m terrain display level');
    resolutionSelect.replaceChildren(...displayLevels.map((entry, level) => {
      const spacing = nativeSpacing * entry.step;
      return new Option(`${spacing} m${level === 0 ? ' (finest)' : ''}`, String(level));
    }));
    resolutionSelect.value = String(minimumLevel);
    // CPU and memory hints only initialize quality; measured frame times drive later adjustments.
    const hardware = {
      threads: navigator.hardwareConcurrency || 4,
      memoryGB: navigator.deviceMemory ?? null
    };
    const capable = hardware.threads >= 16 && (hardware.memoryGB === null || hardware.memoryGB >= 8);
    // Convert MiB to bytes.
    const MiB = 1024 * 1024;
    // Budgets use grid-cell counts; rawBytes, geometryBytes and bytesPerCell use bytes.
    // frameMs and buildMs use milliseconds; pixelRatio is dimensionless.
    const quality = {
      // Start conservatively; sustained fast frames can raise the budget.
      maxCells: (capable ? 2 : 1) * MiB,
      cellLimit: (capable ? 12 : 4) * MiB,
      // CPU hints do not identify GPU capability. Slow frames also reduce geometry budgets on integrated graphics.
      cellFloor: 0.25 * MiB,
      pixelRatio: Math.min(devicePixelRatio, capable ? 1.5 : 1.25),
      rawBytes: (capable ? 128 : 64) * MiB,
      geometryBytes: (capable ? 2048 : 768) * MiB,
      bytesPerCell: 200,
      effectiveCells: 0,
      frameMs: 0,
      gpuMs: 0,
      buildMs: 0,
      slowWindows: 0,
      fastWindows: 0,
      changedAt: 0
    };
    // windowResolution: auto or a string specifying the CSS-pixel multiplier.
    let windowResolution = 'auto';
    // idleSleepDelay: seconds as a string, or never to keep visible animations active.
    // lastInteractionAt: monotonic timestamp of the last input or inertial camera movement, in milliseconds.
    let idleSleepDelay = '30',
      lastInteractionAt = 0;
    let autoPixelRatio = quality.pixelRatio;
    // Choose the first actual level at or above 16 m for regional residency; levels need not be powers of two.
    const residentLevel = displayLevels.findIndex(level => level.step * nativeSpacing >= 16);
    const descriptors = tileset.tiles;
    for (const [key, tile] of Object.entries(descriptors)) {
      const [levelKey, xKey, zKey] = key.split('/');
      const level = displayLevels.findIndex(entry => String(entry.level) === levelKey);
      if (level < 0) throw new Error(`Unknown terrain display level: ${levelKey}`);
      const x = Number(xKey),
        z = Number(zKey);
      Object.assign(tile, {
        key,
        level,
        levelKey,
        x,
        z,
        step: displayLevels[level].step
      });
      tile.interior = tile.c0 > 0 && tile.r0 > 0 && tile.c1 < m.source_width - 1 && tile.r1 < m.source_height - 1;
      tile.surroundedByLand = tile.kind === 'land' && [[-1, 0], [1, 0], [0, -1], [0, 1]].every(([dx, dz]) => descriptors[`${levelKey}/${x + dx}/${z + dz}`]?.kind === 'land');
    }
    const ocean = tileset.oceanMask;
    const oceanBits = new Uint8Array(await decompress(ocean.bits));
    function oceanAt(r, c) {
      /* Query the packed ocean mask at native row/column coordinates. Clamp to mask bounds and return a boolean. */
      const row = Math.max(0, Math.min(ocean.rows - 1, Math.floor(r / ocean.step)));
      const col = Math.max(0, Math.min(ocean.cols - 1, Math.floor(c / ocean.step)));
      const i = row * ocean.cols + col;
      return Boolean(oceanBits[i >> 3] >> (i & 7) & 1);
    }
    const strata = {
      ...window.NOTO_STRATA,
      ids: new Uint8Array(await decompress(window.NOTO_STRATA.ids))
    };
    const vegetationData = await window.NotoVegetation.prepareData(THREE, window.NOTO_VEGETATION);
    vegetationData.grass = await window.NotoGroundGrass.prepare(THREE, vegetationData, strata);
    let vegetation = null;
    // The material configuration separates asset loading from the rock-material factory.
    const materialFactory = await window.NotoRockMaterials.prepare(THREE, strata, window.NOTO_MATERIAL_CONFIG, vegetationData.groundCover);
    materialFactory.shared.grass = vegetationData.grass;

    // 2. Scene and shared water resources; physical coordinates remain unchanged.
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      // Request the high-performance GPU; the browser, driver and operating system still choose the adapter.
      powerPreference: 'high-performance'
    });
    // Read the actual canvas device once; a power preference alone is not proof.
    const graphicsContext = renderer.getContext();
    const graphicsDebug = graphicsContext.getExtension('WEBGL_debug_renderer_info');
    const graphics = {
      renderer: graphicsDebug ? graphicsContext.getParameter(graphicsDebug.UNMASKED_RENDERER_WEBGL) : 'Unavailable',
      powerPreference: graphicsContext.getContextAttributes()?.powerPreference ?? 'default'
    };
    // A short JS submission does not imply a cheap GPU frame. Sample GPU time
    // asynchronously when supported, without gl.finish() or an extra render loop.
    const gpuTimer = graphicsContext.getExtension('EXT_disjoint_timer_query_webgl2');
    const gpuQueries = [];
    let gpuSampleFrame = 0,
      gpuMeasuredAt = -Infinity;
    function collectGpuTime(now) {
      if (!gpuTimer || !gpuQueries.length) return;
      const disjoint = graphicsContext.getParameter(gpuTimer.GPU_DISJOINT_EXT);
      while (gpuQueries.length) {
        const {
          query,
          submittedAt
        } = gpuQueries[0];
        if (!disjoint && !graphicsContext.getQueryParameter(query, graphicsContext.QUERY_RESULT_AVAILABLE)) break;
        gpuQueries.shift();
        if (!disjoint && now - submittedAt < 2500) {
          const ms = graphicsContext.getQueryParameter(query, graphicsContext.QUERY_RESULT) / 1e6;
          if (Number.isFinite(ms) && ms > 0 && ms < 5000) {
            quality.gpuMs = now - gpuMeasuredAt < 2500 ? quality.gpuMs * 0.5 + ms * 0.5 : ms;
            gpuMeasuredAt = now;
          }
        }
        graphicsContext.deleteQuery(query);
      }
      if (disjoint) {
        quality.gpuMs = 0;
        gpuMeasuredAt = -Infinity;
      }
    }
    function applyWindowResolution() {
      /*
       * Apply automatic or manual renderer pixel density, capped by GPU texture limits. Update
       * canvas and settings without changing camera FOV or terrain spacing. Returns undefined.
       */
      const requested = windowResolution === 'auto' ? autoPixelRatio : Number(windowResolution);
      quality.pixelRatio = Math.min(requested, renderer.capabilities.maxTextureSize / innerWidth, renderer.capabilities.maxTextureSize / innerHeight);
      renderer.setPixelRatio(quality.pixelRatio);
      renderer.setSize(innerWidth, innerHeight);
      windowResolutionLabel.textContent = `Canvas: ${renderer.domElement.width} × ${renderer.domElement.height} pixels`;
    }
    applyWindowResolution();
    windowResolutionSelect.addEventListener('change', () => {
      windowResolution = windowResolutionSelect.value;
      applyWindowResolution();
      wakeRendering();
    });
    vegetationDetailSelect.addEventListener('change', () => {
      vegetation?.setDetail(vegetationDetailSelect.value);
      wakeRendering();
    });
    idleSleepSelect.addEventListener('change', () => {
      const value = idleSleepSelect.value;
      if (!['0', '15', '30', '60', '300', 'never'].includes(value)) return;
      idleSleepDelay = value;
      wakeRendering();
    });
    renderer.setClearColor(0xe6ebed);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', 'Noto Peninsula terrain: drag to rotate, right-drag to pan, scroll to zoom');
    renderer.domElement.tabIndex = 0;
    document.querySelector('#viewport').appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const terrain = new THREE.Group();
    scene.add(terrain);
    // Shared water textures use a continuous phase in global X/Z coordinates.
    const waterMaterials = window.NotoWaterMaterials.create(THREE);
    const coastalField = await window.NotoCoastalGeometry.prepare(window.NOTO_SHORELINE);
    oceanAt.coast = coastalField;
    const waterMotion = await window.NotoWaterMotion.create(THREE, window.NOTO_SHORELINE, waterMaterials, coastalField);
    materialFactory.shared.waterMotion = waterMotion;
    const waterTop = waterMaterials.top;
    const waterCut = waterMaterials.cut;
    const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 700000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = Math.max(10, nativeSpacing * 4);
    controls.maxDistance = Math.max(m.width_m, m.height_m) * 8;
    controls.maxPolarAngle = Math.PI * 0.85;
    controls.screenSpacePanning = true;
    const environment = window.NotoEnvironment.create({
      THREE,
      renderer,
      scene,
      camera,
      controls,
      metadata: m,
      sampleHeight: surfaceHeight,
      capable,
      onChange: weather => {
        waterMotion.setWeather(weather);
        waterMotion.setSky(scene.fog.color);
        vegetation?.setLighting(environment.getState().cardBrightness);
        wakeRendering();
      }
    });
    const flashlight = window.NotoSceneEffects.createFlashlight({
      THREE,
      scene,
      camera,
      renderer,
      metadata: m,
      sampleHeight: surfaceHeight,
      shore: coastalField,
      wake: wakeRendering,
      paused: navigationPaused
    });
    const surf = window.NotoSceneEffects.createSurf({
      THREE,
      terrain,
      camera,
      renderer,
      field: coastalField,
      motion: waterMotion
    });
    waterMotion.setWeather(environment.getState().weather);
    waterMotion.setSky(scene.fog.color);

    // 3. Bounded asynchronous script loading, shared by file and HTTP pages.
    const rawCache = new Map();
    // Report unavailable tiles only once per session; retain coarse coverage instead of substituting water.
    const unavailableTiles = new Set();
    const spatialLOD = window.NotoTerrainLOD.create({
      metadata: m,
      levels: displayLevels,
      descriptors,
      unavailable: unavailableTiles
    });
    const inFlight = new Map();
    const receivers = new Map();
    const queue = [];
    const cacheStats = {
      rawHits: 0,
      geometryHits: 0,
      built: 0,
      evicted: 0
    };
    let loading = 0;
    // Tile keys bridge script callbacks to pending compressed-payload requests.
    window.NOTO_TILE_RECEIVE = (key, payload) => receivers.get(key)?.(payload);
    function pump() {
      /*
       * Run queued requests by ascending priority within the concurrency limit. Release each slot
       * in finally and schedule remaining work. Returns undefined.
       */
      queue.sort((a, b) => a.priority - b.priority);
      while (loading < (capable ? 6 : 4) && queue.length) {
        const job = queue.shift();
        loading++;
        job.run().finally(() => {
          loading--;
          pump();
        });
      }
    }
    function loadRaw(tile, priority = 0) {
      /*
       * Load, decompress and cache one height array, combining concurrent requests for the same
       * tile. Inputs: tile descriptor with key/file/rows/cols; priority is a number, lower first,
       * default 0. Refresh raw-cache recency on a hit; reuse or reprioritize an in-flight request.
       * Display leaves resample source tiles; source scripts deliver compressed arrays through
       * callbacks. Fileless ocean tiles use four 65535 placeholders. Validate array length, cache
       * the result and clear in-flight state on completion. Returns Promise<Uint16Array>.
       */
      if (rawCache.has(tile.key)) {
        const values = rawCache.get(tile.key);
        rawCache.delete(tile.key);
        rawCache.set(tile.key, values);
        cacheStats.rawHits++;
        return Promise.resolve(values);
      }
      if (tile.virtual) {
        if (inFlight.has(tile.key)) return inFlight.get(tile.key);
        const task = spatialLOD.sample(tile, source => loadRaw(source, priority)).then(data => {
          rawCache.set(tile.key, data);
          return data;
        }).finally(() => inFlight.delete(tile.key));
        inFlight.set(tile.key, task);
        return task;
      }
      if (unavailableTiles.has(tile.key)) {
        const error = new Error(`Terrain detail unavailable: ${tile.key}`);
        error.terrainTileKey = tile.key;
        return Promise.reject(error);
      }
      if (inFlight.has(tile.key)) {
        const queued = queue.find(job => job.key === tile.key);
        if (queued) queued.priority = Math.min(queued.priority, priority);
        return inFlight.get(tile.key);
      }
      const promise = new Promise((resolve, reject) => {
        queue.push({
          key: tile.key,
          priority,
          run: async () => {
            try {
              let values;
              if (!tile.file) {
                values = new Uint16Array(4).fill(65535);
              } else {
                const payload = await new Promise((done, fail) => {
                  const script = document.createElement('script');
                  const timeout = setTimeout(() => finish(new Error(`Tile timed out: ${tile.key}`)), 30000);
                  let received = false;
                  function finish(error, data) {
                    /* Complete a request by clearing its timer, callback and script, then resolving data or rejecting the error. */
                    clearTimeout(timeout);
                    receivers.delete(tile.key);
                    script.remove();
                    if (error) fail(error);else done(data);
                  }
                  receivers.set(tile.key, data => {
                    received = true;
                    finish(null, data);
                  });
                  script.onerror = () => finish(new Error(`Missing terrain tile: ${tile.file}`));
                  script.onload = () => {
                    if (!received) finish(new Error(`Invalid terrain tile: ${tile.key}`));
                  };
                  script.src = `${tileset.basePath}/${tile.file}`;
                  document.head.appendChild(script);
                });
                values = new Uint16Array(await decompress(payload.heights));
                if (values.length !== tile.rows * tile.cols) throw new Error(`Tile size mismatch: ${tile.key}`);
              }
              rawCache.set(tile.key, values);
              resolve(values);
            } catch (error) {
              unavailableTiles.add(tile.key);
              error.terrainTileKey = tile.key;
              reject(error);
            } finally {
              inFlight.delete(tile.key);
            }
          }
        });
        queueMicrotask(pump);
      });
      inFlight.set(tile.key, promise);
      return promise;
    }

    // 4. Refine nested display patches by distance, using different grid spacing for near and far terrain.
    const frustum = new THREE.Frustum();
    const matrix = new THREE.Matrix4();
    const box = new THREE.Box3();
    const guardFrustum = new THREE.Frustum();
    const guardProjection = new THREE.Matrix4();
    // Maximum number of tile objects allowed in one view.
    const MAX_TILE_OBJECTS = 384;
    function geometryTile(tile) {
      /* Return the original land tile, or a shallow copy with a 2-by-2 node grid for a fileless water tile. */
      return tile.file ? tile : {
        ...tile,
        rows: 2,
        cols: 2
      };
    }
    function surfaceCells(tile) {
      /* Estimate cell cost: data tiles use (rows-1)*(cols-1); water uses its actual wave-grid budget. */
      return tile.file ? (tile.rows - 1) * (tile.cols - 1) : Math.ceil((tile.r1 - tile.r0) / tile.step) * Math.ceil((tile.c1 - tile.c0) / tile.step);
    }
    function tileBox(tile) {
      /*
       * Fill a reusable Box3 with tile extents and scaled elevations. Interior land and water use
       * tight lower bounds when possible. The returned box is shared.
       */
      const scale = terrain.scale.y;
      // Interior land has no exposed underground walls, so its bounds can be tightened when the camera is above the base.
      const floor = tile.kind === 'water' && tile.interior && camera.position.y >= 0 ? 0 : tile.surroundedByLand && tile.interior && camera.position.y >= tile.min * scale ? tile.min : -100;
      box.min.set(-m.width_m / 2 + tile.c0 * nativeSpacing, floor * scale, -m.height_m / 2 + tile.r0 * nativeSpacing);
      box.max.set(-m.width_m / 2 + tile.c1 * nativeSpacing, Math.max(0, tile.max ?? m.elevation_max_m) * scale, -m.height_m / 2 + tile.r1 * nativeSpacing);
      return box;
    }
    const levels = Array.from({
      length: maxLevel + 1
    }, (_, level) => Object.values(descriptors).filter(tile => tile.level === level));
    function chooseLeaves() {
      // Use different split/merge screen-error thresholds; retain nearby detail through small camera turns.
      camera.updateMatrixWorld();
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(matrix);
      guardProjection.copy(camera.projectionMatrix);
      guardProjection.elements[0] /= 1.3;
      guardProjection.elements[5] /= 1.3;
      matrix.multiplyMatrices(guardProjection, camera.matrixWorldInverse);
      guardFrustum.setFromProjectionMatrix(matrix);
      const pixels = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      const residentBytes = [...residentGeometryLevels].reduce((sum, level) => sum + levels[level].reduce((total, tile) => total + (geometryCache.get(tile.key)?.bytes ?? surfaceCells(tile) * quality.bytesPerCell), 0), 0);
      quality.effectiveCells = Math.min(quality.maxCells, Math.max(quality.cellFloor, Math.floor((quality.geometryBytes - residentBytes) * 0.8 / quality.bytesPerCell)));
      return spatialLOD.select({
        step: displayLevels[minimumLevel].step,
        budget: quality.effectiveCells,
        limit: MAX_TILE_OBJECTS,
        score(tile) {
          const bounds = tileBox(tile);
          const distance = Math.max(1, bounds.distanceToPoint(camera.position));
          // Keep an orientation-independent 1 km buffer around the camera, preserving ground and nearby detail while turning.
          if (distance > 1000 && !guardFrustum.intersectsBox(bounds)) return 0;
          return nativeSpacing * tile.step * pixels / distance;
        }
      });
    }

    // 5. Keep complete coverage and commit only after all new patches and seams are ready.
    let live = new Map(),
      revision = 0,
      initialized = false,
      lodTimer;
    let currentPlan = null;
    const geometryCache = new Map(),
      buildTasks = new Map(),
      residentMaps = new Map();
    const residentGeometryLevels = new Set([maxLevel]);
    let geometryBytes = 0,
      foregroundBusy = false,
      pendingSelection = null;
    let lastMotion = 0,
      lastBuildAt = -Infinity;
    let warmingResident = false;
    const buildingRaw = new Map();
    function neighborsFor(tile) {
      /*
       * Get a display leaf's seam context or a source tile's same-level 3x3 neighborhood. Input:
       * center descriptor with level/x/z. For source tiles, collect existing descriptors at
       * row/column offsets -1..1 to supply boundary heights and normals. Returns Array<object>,
       * including the center.
       */
      if (tile.virtual) return tile.neighbors || [tile];
      const result = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const neighbor = descriptors[`${tile.levelKey}/${tile.x + dx}/${tile.z + dz}`];
        if (neighbor) result.push(neighbor);
      }
      return result;
    }
    function estimateBytes(geometry) {
      /*
       * Estimate geometry memory in bytes. Deduplicate land, water and height ArrayBuffers, account
       * for CPU/GPU copies and add fixed overhead.
       */
      const buffers = new Set();
      const add = array => {
        if (array) buffers.add(array.buffer);
      };
      for (const owner of ['land', 'water']) for (const part of ['top', 'walls', 'bottom']) {
        const piece = geometry[owner]?.[part];
        if (!piece) continue;
        for (const attribute of Object.values(piece.attributes)) add(attribute.array);
        add(piece.index?.array);
        add(piece.userData.notoOriginalBoundaryNormals);
        add(piece.userData.notoBoundaryVertexIndices);
      }
      add(geometry.heights);
      add(geometry.coastSegments);
      add(geometry.shoreQueryRanges);
      // Estimate CPU arrays, their GPU copies and a fixed material allowance.
      return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength * 2, 16384);
    }
    function trimCaches() {
      /*
       * Trim caches while protecting visible, building and selected tiles. Dispose unused
       * nonresident geometry over budget, then evict unprotected raw arrays. Returns undefined.
       */
      const needed = new Set([...live.values()].map(item => item.tile.cacheKey || item.tile.key).concat([...buildTasks.keys()], (pendingSelection || []).map(tile => tile.cacheKey || tile.key)));
      const rawNeeded = new Set([...live.keys(), ...(pendingSelection || []).map(tile => tile.key)]);
      for (const [key, item] of geometryCache) {
        if (geometryBytes <= quality.geometryBytes) break;
        if (needed.has(key) || !item.tile.virtual && residentGeometryLevels.has(item.tile.level)) continue;
        geometryCache.delete(key);
        geometryBytes -= item.bytes;
        disposeItem(item);
        cacheStats.evicted++;
      }
      let bytes = [...rawCache.values()].reduce((sum, data) => sum + data.byteLength, 0);
      for (const [key, data] of rawCache) {
        if (bytes <= quality.rawBytes) break;
        if (descriptors[key]?.level >= residentLevel || rawNeeded.has(key) || buildingRaw.has(key)) continue;
        rawCache.delete(key);
        bytes -= data.byteLength;
      }
    }
    async function getItem(tile, priority = 0, coarser = []) {
      /*
       * Reuse or construct tile geometry, geological materials and scene objects. Inputs: tile
       * descriptor; raw-load priority, lower first, default 0. Look up the patch/seam cache key and
       * refresh recency; reuse an existing build task. Load center/context heights, construct
       * geometry/materials/group and record cache/build costs. Dispose resources on failure and
       * clear task/protection counters on completion. Returns Promise<object> with tile, geometry,
       * materials, group and bytes.
       */
      const cacheKey = tile.cacheKey || tile.key;
      if (geometryCache.has(cacheKey)) {
        const item = geometryCache.get(cacheKey);
        geometryCache.delete(cacheKey);
        geometryCache.set(cacheKey, item);
        cacheStats.geometryHits++;
        // Collision queries use displayed geometry directly; cache hits need not reload source files.
        return item;
      }
      if (buildTasks.has(cacheKey)) return buildTasks.get(cacheKey);
      const neighbors = neighborsFor(tile);
      for (const neighbor of neighbors) buildingRaw.set(neighbor.key, (buildingRaw.get(neighbor.key) || 0) + 1);
      const task = (async () => {
        let geometry, materials;
        try {
          await Promise.all(neighbors.map(neighbor => loadRaw(neighbor, priority)));
          const started = performance.now();
          lastBuildAt = started;
          // Cache keys include seam context. Sample coarse/fine boundaries on the same coarse triangle without internal sidewalls.
          geometry = window.NotoTileGeometry.build(THREE, tileset, geometryTile(tile), rawCache.get(tile.key), neighbors.map(neighbor => ({
            tile: geometryTile(neighbor),
            heights: rawCache.get(neighbor.key)
          })), oceanAt);
          if (tile.virtual) {
            window.NotoTileGeometry.conformEdges(THREE, tile, geometry, coarser, m);
            window.NotoTileGeometry.conformEdges(THREE, tile, geometry, coarser, m, 'water');
          }
          materials = geometry.land ? await materialFactory.createTile(geometry.heights, geometry.metadata) : null;
          const item = {
            tile,
            geometry,
            materials,
            group: meshGroup(geometry, materials),
            bytes: estimateBytes(geometry)
          };
          if (tile.file && surfaceCells(tile) > 1000) quality.bytesPerCell = quality.bytesPerCell * 0.95 + item.bytes / surfaceCells(tile) * 0.05;
          geometryCache.set(cacheKey, item);
          geometryBytes += item.bytes;
          cacheStats.built++;
          quality.buildMs = quality.buildMs * 0.9 + (performance.now() - started) * 0.1;
          lastBuildAt = performance.now();
          return item;
        } catch (error) {
          geometry?.dispose();
          materials?.dispose();
          throw error;
        } finally {
          buildTasks.delete(cacheKey);
          for (const neighbor of neighbors) {
            const count = buildingRaw.get(neighbor.key) - 1;
            if (count) buildingRaw.set(neighbor.key, count);else buildingRaw.delete(neighbor.key);
          }
        }
      })();
      buildTasks.set(cacheKey, task);
      return task;
    }
    function showSet(next) {
      /*
       * Atomically show a nonempty map of built tiles. Synchronize boundary normals, replace groups
       * and request a frame; an empty map preserves current coverage.
       */
      if (!next.size) return;
      const firstTile = next.values().next().value.tile;
      const resident = firstTile.virtual ? null : residentMaps.get(firstTile.level);
      // Reusing a subset of the resident meshes may require boundary-normal synchronization.
      if (resident && resident !== next) resident.normalsReady = false;
      if (!next.normalsReady) window.NotoTileGeometry.synchronizeNormals([...next.values()].map(item => item.geometry));
      if (resident === next) next.normalsReady = true;
      for (const [key, item] of live) if (next.get(key) !== item) terrain.remove(item.group);
      for (const [key, item] of next) if (live.get(key) !== item) terrain.add(item.group);
      live = new Map(next);
      if (firstTile.virtual) spatialLOD.commit([...next.values()].map(item => item.tile));
      waterMotion.setView(displayLevels[minimumLevel].step * nativeSpacing, terrain.scale.y);
      environment.markDirty();
      vegetation?.markDirty();
      initialized = true;
      resolutionSelect.disabled = false;
      windowResolutionSelect.disabled = false;
      vegetationDetailSelect.disabled = false;
      idleSleepSelect.disabled = false;
      flashlight.ready();
      zoomButtons.forEach(button => {
        button.disabled = false;
      });
      status.hidden = true;
      requestRender();
    }
    function disposeItem(item) {
      /* Dispose tile geometry and tile-owned rock materials; keep shared resources alive. */
      item.geometry.dispose();
      item.materials?.dispose();
    }
    function meshGroup(geometry, materials) {
      /*
       * Build a Group from land/water tops, cut walls and bases. Land materials belong to the tile;
       * water materials are shared.
       */
      const group = new THREE.Group();
      if (geometry.land) {
        group.add(new THREE.Mesh(geometry.land.top, materials.top));
        if (geometry.land.walls) group.add(new THREE.Mesh(geometry.land.walls, materials.cut));
        group.add(new THREE.Mesh(geometry.land.bottom, materials.bottom));
      }
      if (geometry.water) {
        group.add(new THREE.Mesh(geometry.water.top, waterTop));
        if (geometry.water.walls) group.add(new THREE.Mesh(geometry.water.walls, waterCut));
        group.add(new THREE.Mesh(geometry.water.bottom, waterCut));
      }
      group.children.forEach(mesh => {
        mesh.castShadow = mesh.geometry === geometry.land?.top || mesh.geometry === geometry.land?.walls;
        mesh.receiveShadow = true;
        if (mesh.geometry === geometry.water?.top) {
          mesh.geometry.computeBoundingBox();
          mesh.geometry.boundingBox.expandByScalar(2);
          mesh.geometry.computeBoundingSphere();
          mesh.geometry.boundingSphere.radius += 2;
        }
      });
      return group;
    }
    // This is a frustum test, not terrain occlusion culling.
    function updateResolution() {
      /* Find the finest visible land spacing and update the grid label and hints only when their text changes. */
      camera.updateMatrixWorld();
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(matrix);
      let finest = Infinity;
      for (const item of live.values()) {
        if (!item.geometry.land || !frustum.intersectsBox(tileBox(item.tile))) continue;
        finest = Math.min(finest, item.tile.step * nativeSpacing);
      }
      const grid = Number.isFinite(finest) ? `${finest} m` : '—';
      const text = `Source ${nativeSpacing} m · Near grid ${grid}`;
      if (resolutionLabel.textContent !== text) resolutionLabel.textContent = text;
      resolutionLabel.title = 'Nearest visible detail; distant patches use coarser grids';
    }
    async function updateLOD() {
      // Retain current full coverage during asynchronous construction; include seam signatures when comparing plans.
      const selected = chooseLeaves();
      const plan = selected.map(tile => tile.cacheKey || tile.key).join('|');
      // Compare the requested plan separately from the displayed set to avoid rebuilding the same seams.
      const displayed = selected.length === live.size && selected.every(tile => live.get(tile.key)?.tile.cacheKey === tile.cacheKey);
      if (displayed) {
        currentPlan = plan;
        if (foregroundBusy) {
          revision++;
          pendingSelection = null;
        }
        return;
      }
      if (plan === currentPlan && foregroundBusy && pendingSelection) return;
      currentPlan = plan;
      revision++;
      pendingSelection = selected;
      if (foregroundBusy) return;
      foregroundBusy = true;
      try {
        while (pendingSelection) {
          const desired = pendingSelection,
            thisRevision = revision;
          const next = new Map();
          for (const tile of [...desired].sort((a, b) => b.step - a.step)) {
            const cached = geometryCache.has(tile.cacheKey || tile.key);
            next.set(tile.key, await getItem(tile, 0, [...next.values()]));
            if (revision !== thisRevision) break;
            // Yield between geometry builds to keep the main thread responsive.
            if (!cached) await waitFrame();
          }
          if (revision !== thisRevision) continue;
          showSet(next);
          pendingSelection = null;
          trimCaches();
        }
      } catch (error) {
        pendingSelection = null;
        currentPlan = null;
        // Retain existing coverage. After a missing source file, reselect an available sampling level for that region.
        if (error.terrainTileKey) {
          console.warn('Using available terrain detail:', error.message);
          for (const key of rawCache.keys()) if (key.startsWith('patch/')) rawCache.delete(key);
          scheduleLOD();
        } else {
          errorMessage(error);
        }
      } finally {
        foregroundBusy = false;
      }
    }
    resolutionSelect.addEventListener('change', () => {
      /*
       * Apply the finest terrain limit and cancel uncommitted older requests. Read the generated
       * select option; reject levels finer than the source DEM or outside the tileset. Update
       * request revision to prevent stale asynchronous commits. Keep current coverage until the
       * complete patch set for the new limit is ready. Returns undefined; updates settings and the
       * loading plan.
       */
      const level = Number(resolutionSelect.value);
      if (!Number.isInteger(level) || level < 0 || level > maxLevel) return;
      if (level === minimumLevel) return;
      minimumLevel = level;
      revision++;
      pendingSelection = null;
      currentPlan = null;
      // Explicit settings also retain old coverage until the complete replacement set is ready.
      wakeRendering();
      if (initialized) updateLOD();
    });
    async function warmResident() {
      /*
       * Preload full-map coarse height inputs for local refinement. Mark warm-up active, load
       * source levels from coarsest through residentLevel, and keep only the initial coarsest
       * complete geometry set. Build other display patches on demand, trim caches and schedule
       * selection. Always clear the warm-up flag. Returns Promise<void>.
       */
      warmingResident = true;
      try {
        // Raw arrays for 16 m and coarser levels remain resident.
        for (let level = maxLevel; level >= residentLevel; level--) {
          for (const tile of levels[level]) {
            await loadRaw(tile, 1);
            await waitFrame();
          }
        }
        trimCaches();
        currentPlan = null;
        scheduleLOD();
      } finally {
        warmingResident = false;
      }
    }
    function scheduleLOD() {
      /*
       * Coalesce repeated LOD update requests. Keep an existing timer; otherwise clear a new timer
       * after 300 ms and update LOD if initialized. Returns undefined and schedules delayed work.
       */
      if (lodTimer) return;
      lodTimer = setTimeout(() => {
        lodTimer = null;
        if (initialized) updateLOD();
      }, 300);
    }

    // 6. Wheel, buttons, keyboard navigation and conservative collision constraints.
    // Use the highest corner of each displayed cell as a conservative ceiling against slopes and water.
    // Until geometry is ready, use the native tile maximum for unseen regions.
    // Horizontal clearance offsets are metres; the vertical limit uses scaled world-space height.
    const clearance = 5;
    const safePosition = new THREE.Vector3();
    const safeTarget = new THREE.Vector3();
    let hasSafePose = false;
    function surfaceCeiling(x, z) {
      /*
       * Estimate safe surface height at model x/z in metres. Convert to source rows/columns;
       * outside bounds return zero. Locate the displayed leaf, or use native tile maxima as a
       * conservative fallback. Query displayed geometry; ordinary cells use four corner elevations
       * and water uses the zero plane. Apply vertical scale to the maximum valid height. Returns a
       * safe world-space height number.
       */
      const c = (x + m.width_m / 2) / nativeSpacing;
      const r = (z + m.height_m / 2) / nativeSpacing;
      if (c < 0 || r < 0 || c > m.source_width - 1 || r > m.source_height - 1) return 0;
      const item = spatialLOD.at(live, r, c);
      if (!item) {
        const fallback = descriptors[`0/${Math.floor(Math.min(c, m.source_width - 1.000001) / 256)}/${Math.floor(Math.min(r, m.source_height - 1.000001) / 256)}`];
        return Math.max(0, fallback?.max ?? m.elevation_max_m) * terrain.scale.y;
      }
      const tile = item.tile;
      if (item.geometry.sampleHeight) {
        const y = item.geometry.sampleHeight(x, z, true);
        return y === null ? 0 : Math.max(0, y) * terrain.scale.y;
      }
      if (!item.geometry.land) return 0;
      const raw = item.geometry.heights;
      if (!raw) return Math.max(0, tile.max) * terrain.scale.y;
      const {
        sample_rows: rows,
        sample_cols: cols
      } = item.geometry.metadata;
      const row = Math.min(rows - 2, Math.floor((r - tile.r0) / tile.step));
      const col = Math.min(cols - 2, Math.floor((c - tile.c0) / tile.step));
      if (!item.geometry.landCells[row * (cols - 1) + col]) return 0;
      const a = row * cols + col;
      const values = [raw[a], raw[a + 1], raw[a + cols], raw[a + cols + 1]];
      // Water and missing coastal nodes close at sea level; the camera cannot enter through those cells.
      return Math.max(0, ...values) * terrain.scale.y;
    }
    function surfaceHeight(x, z) {
      /*
       * Query the precise displayed land-triangle height for plant placement. Inputs: centered
       * model x/z in metres. Locate the displayed leaf/cell, exclude water with the shared land
       * mask, and interpolate along the
       * (top-left,bottom-left,top-right)/(top-right,bottom-left,bottom-right) diagonal. Returns
       * number|null, including vertical scale; missing land returns null.
       */
      if (!live.size) return null;
      const c = (x + m.width_m / 2) / nativeSpacing;
      const r = (z + m.height_m / 2) / nativeSpacing;
      if (c < 0 || r < 0 || c >= m.source_width - 1 || r >= m.source_height - 1) return null;
      const item = spatialLOD.at(live, r, c);
      if (!item?.geometry.land) return null;
      if (item.geometry.sampleHeight) {
        const y = item.geometry.sampleHeight(x, z);
        return y === null ? null : y * terrain.scale.y;
      }
      const tile = item.tile,
        geometry = item.geometry;
      const cols = geometry.metadata.sample_cols,
        rows = geometry.metadata.sample_rows;
      const col = Math.min(cols - 2, Math.floor((c - tile.c0) / tile.step));
      const row = Math.min(rows - 2, Math.floor((r - tile.r0) / tile.step));
      if (!geometry.landCells[row * (cols - 1) + col]) return null;
      const left = tile.c0 + col * tile.step,
        top = tile.r0 + row * tile.step;
      const u = (c - left) / (Math.min(left + tile.step, tile.c1) - left);
      const v = (r - top) / (Math.min(top + tile.step, tile.r1) - top);
      const a = row * cols + col,
        h = geometry.heights;
      const y = u + v <= 1 ? h[a] * (1 - u - v) + h[a + 1] * u + h[a + cols] * v : h[a + 1] * (1 - v) + h[a + cols] * (1 - u) + h[a + cols + 1] * (u + v - 1);
      return Number.isFinite(y) ? y * terrain.scale.y : null;
    }
    function cameraFloor(x, z) {
      /*
       * Sample a 3-by-3 horizontal clearance footprint. Return the highest surface plus the camera
       * clearance as the minimum safe world Y.
       */
      let floor = 0;
      for (const dx of [-clearance, 0, clearance]) {
        for (const dz of [-clearance, 0, clearance]) floor = Math.max(floor, surfaceCeiling(x + dx, z + dz));
      }
      return floor + clearance;
    }
    function clearPath(from, to) {
      /*
       * Check a camera segment for clearance. Paths above the global maximum pass immediately; low
       * paths sample every half source cell, with at most 8192 samples. Longer low paths are
       * rejected.
       */
      const highest = Math.max(0, m.elevation_max_m) * terrain.scale.y + clearance;
      if (Math.min(from.y, to.y) >= highest) return true;
      const distance = Math.hypot(to.x - from.x, to.z - from.z);
      const count = Math.max(1, Math.ceil(distance / (nativeSpacing * 0.5)));
      // Reject very long low paths instead of undersampling collision checks.
      if (count > 8192) return false;
      for (let i = 1; i <= count; i++) {
        const t = i / count;
        const x = from.x + (to.x - from.x) * t;
        const z = from.z + (to.z - from.z) * t;
        const y = from.y + (to.y - from.y) * t;
        if (y < cameraFloor(x, z)) return false;
      }
      return true;
    }
    function constrainCamera() {
      /*
       * Constrain the camera to safe terrain clearance. Raise saved/current poses when terrain
       * rises; restore the last safe pose after unsafe movement and clear damping. Save the
       * accepted camera and target.
       */
      // Grid or exaggeration changes can raise terrain beneath a stationary camera; raise the saved safe pose first.
      if (hasSafePose) {
        const lift = Math.max(0, cameraFloor(safePosition.x, safePosition.z) - safePosition.y);
        if (lift) {
          safePosition.y += lift;
          safeTarget.y += lift;
          camera.position.y += lift;
          controls.target.y += lift;
        }
        if (!clearPath(safePosition, camera.position)) {
          camera.position.copy(safePosition);
          controls.target.copy(safeTarget);
          // Clear damping so a rejected motion is not applied repeatedly.
          const damping = controls.enableDamping;
          controls.enableDamping = false;
          controls.update();
          controls.enableDamping = damping;
          camera.position.copy(safePosition);
          controls.target.copy(safeTarget);
        }
      } else {
        const lift = Math.max(0, cameraFloor(camera.position.x, camera.position.z) - camera.position.y);
        camera.position.y += lift;
        controls.target.y += lift;
      }
      safePosition.copy(camera.position);
      safeTarget.copy(controls.target);
      hasSafePose = true;
      camera.lookAt(controls.target);
    }
    // A minimum zoom distance in metres prevents proportional zoom from stalling near the target.
    // ZOOM_MIN_STEP_M: minimum movement per wheel notch, in metres.
    const ZOOM_MIN_STEP_M = 12;
    // ZOOM_DISTANCE_FACTOR: distance fraction moved per wheel notch.
    const ZOOM_DISTANCE_FACTOR = 0.12;
    // ZOOM_SMOOTHING_MS: pending-input decay time constant, in milliseconds.
    const ZOOM_SMOOTHING_MS = 50;
    const zoomDirection = new THREE.Vector3();
    const zoomCandidate = new THREE.Vector3();
    let pendingZoom = 0;
    let zoomTime = 0;
    function requestZoom(units) {
      /*
       * Queue zoom input: positive units move forward, negative units backward. Ignore
       * loading/modal states, clear opposing pending motion, apply distance/minimum step limits and
       * request a frame.
       */
      if (!initialized || navigationPaused() || !Number.isFinite(units) || !units) return;
      const distance = camera.position.distanceTo(controls.target);
      if (pendingZoom * units < 0) pendingZoom = 0;
      pendingZoom += units * Math.max(ZOOM_MIN_STEP_M, distance * ZOOM_DISTANCE_FACTOR);
      lastMotion = performance.now();
      wakeRendering();
    }
    function moveZoom(now) {
      /*
       * Advance smoothed zoom using a millisecond timestamp. Limit travel, test the path and find a
       * safe partial movement if blocked. Move the target forward when approaching the minimum
       * orbit distance; clear pending motion on collision.
       */
      if (!pendingZoom || navigationPaused()) {
        pendingZoom = 0;
        zoomTime = 0;
        return;
      }
      const dt = zoomTime ? Math.min(now - zoomTime, 50) : 1000 / 60;
      zoomTime = now;
      const distance = camera.position.distanceTo(controls.target);
      zoomDirection.subVectors(controls.target, camera.position).normalize();
      let step = pendingZoom * (1 - Math.exp(-dt / ZOOM_SMOOTHING_MS));
      if (Math.abs(pendingZoom) < 0.01) step = pendingZoom;
      step = Math.max(step, distance - controls.maxDistance);
      const candidateAt = fraction => zoomCandidate.copy(camera.position).addScaledVector(zoomDirection, step * fraction);
      let fraction = 1;
      if (!clearPath(camera.position, candidateAt(1))) {
        let low = 0;
        let high = 1;
        for (let iteration = 0; iteration < 12; iteration++) {
          const middle = (low + high) / 2;
          if (clearPath(camera.position, candidateAt(middle))) low = middle;else high = middle;
        }
        fraction = low;
      }
      const accepted = step * fraction;
      camera.position.addScaledVector(zoomDirection, accepted);
      // Forward zoom can pass the old target while maintaining useful speed near the ground.
      const targetAdvance = Math.max(0, controls.minDistance - (distance - accepted));
      controls.target.addScaledVector(zoomDirection, targetAdvance);
      pendingZoom = fraction < 1 || !step ? 0 : pendingZoom - step;
      if (Math.abs(pendingZoom) < 1e-6) pendingZoom = 0;
      constrainCamera();
      lastMotion = now;
    }

    // Capture wheel input for metre-based zoom. OrbitControls still handles dragging, touch and orbiting.
    renderer.domElement.addEventListener('wheel', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
      requestZoom(THREE.MathUtils.clamp(-pixels / 100, -3, 3));
    }, {
      capture: true,
      passive: false
    });
    renderer.domElement.addEventListener('pointerdown', () => {
      pendingZoom = 0;
      zoomTime = 0;
    });
    for (const button of zoomButtons) {
      button.addEventListener('click', event => {
        requestZoom(Number(button.dataset.zoom));
        if (event.detail) renderer.domElement.focus({
          preventScroll: true
        });
      });
    }
    const keyActions = {
      KeyW: 'forward',
      ArrowUp: 'forward',
      PageUp: 'forward',
      KeyS: 'back',
      ArrowDown: 'back',
      PageDown: 'back',
      KeyA: 'left',
      ArrowLeft: 'left',
      KeyD: 'right',
      ArrowRight: 'right',
      KeyQ: 'turnLeft',
      KeyE: 'turnRight',
      KeyR: 'up',
      KeyF: 'down'
    };
    const pressed = new Set();
    const direction = new THREE.Vector3(),
      right = new THREE.Vector3(),
      movement = new THREE.Vector3();
    const upAxis = new THREE.Vector3(0, 1, 0);
    let keyTime = 0;
    function editable(target) {
      /* Return whether an event target is editable or is an input, textarea, select or button. */
      return target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target?.tagName);
    }
    // Handle navigation only for page key events, preserving form input and modifier shortcuts.
    window.addEventListener('keydown', event => {
      if (navigationPaused() || !keyActions[event.code] || editable(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      pressed.add(event.code);
      wakeRendering();
    });
    window.addEventListener('keyup', event => {
      if (pressed.delete(event.code)) wakeRendering();
    });
    // Clear held keys when focus leaves the page or enters a form control.
    const releaseKeys = () => {
      pressed.clear();
      keyTime = 0;
    };
    // Modal, blur and hidden-page transitions clear all input; form focus clears only keyboard navigation.
    const releaseNavigation = () => {
      releaseKeys();
      pendingZoom = 0;
      zoomTime = 0;
    };
    helpDialog.addEventListener('focusin', releaseNavigation);
    settingsDialog.addEventListener('focusin', releaseNavigation);
    window.addEventListener('blur', releaseNavigation);
    document.addEventListener('focusin', event => {
      if (editable(event.target)) releaseKeys();
    });
    function moveKeyboard(now) {
      /*
       * Advance keyboard navigation with a bounded time step. Build forward/right/yaw motion,
       * choose speed from clearance above ground, and move camera and target together. Reset the
       * clock when no keys are held.
       */
      if (navigationPaused()) releaseKeys();
      if (!pressed.size) {
        keyTime = 0;
        return;
      }
      const dt = keyTime ? Math.min((now - keyTime) / 1000, 0.05) : 1 / 60;
      keyTime = now;
      const actions = new Set([...pressed].map(code => keyActions[code]));
      const yaw = (Number(actions.has('turnLeft')) - Number(actions.has('turnRight'))) * dt;
      direction.subVectors(controls.target, camera.position);
      if (yaw) controls.target.copy(camera.position).add(direction.applyAxisAngle(upAxis, yaw));
      direction.y = 0;
      if (direction.lengthSq() < 1e-10) direction.set(0, 0, -1);
      direction.normalize();
      right.crossVectors(direction, upAxis).normalize();
      movement.copy(direction).multiplyScalar(Number(actions.has('forward')) - Number(actions.has('back')));
      movement.addScaledVector(right, Number(actions.has('right')) - Number(actions.has('left')));
      movement.y = Number(actions.has('up')) - Number(actions.has('down'));
      const altitude = Math.max(0, camera.position.y - cameraFloor(camera.position.x, camera.position.z));
      const speed = THREE.MathUtils.clamp(altitude * 0.6, 8, 4000);
      if (movement.lengthSq()) movement.normalize().multiplyScalar(speed * dt);
      camera.position.add(movement);
      controls.target.add(movement);
    }

    // 7. Adapt quality during continuous interaction or animation, excluding idle and loading intervals.
    // Frame timestamps are milliseconds; use consecutive frame intervals when asynchronous GPU timing is unavailable.
    let frameLast = 0,
      frameSamples = [],
      sampleStart = 0,
      coverageAt = 0;
    function observeFrame(now, continuous = false) {
      /*
       * Measure continuous interaction or animation frames while terrain is stable, then adjust the
       * rendering budget. Parameters: now is the requestAnimationFrame timestamp in milliseconds;
       * continuous indicates that the previous frame requested this one. Exclude construction and
       * hidden-page intervals. Collect consecutive draw intervals without treating sleep as slow
       * rendering. Sustained slow frames reduce mesh/pixel budgets; sustained fast frames gradually
       * restore device limits. Resize and select a new LOD when the budget changes. Returns
       * undefined; updates statistics, quality and LOD requests.
       */
      const delta = now - frameLast;
      const loadingTerrain = foregroundBusy || warmingResident || buildTasks.size || now - lastBuildAt < 250;
      // A frame interval is valid only when the preceding frame explicitly requested continuation. The first input-woken frame includes sleep time,
      // so recent pointer movement does not make that interval a rendering cost or part of a continuous slow-frame window.
      if (!continuous || loadingTerrain || document.hidden) {
        frameSamples = [];
        sampleStart = 0;
        frameLast = now;
        quality.slowWindows = 0;
        quality.fastWindows = 0;
        return;
      }
      if (frameLast && delta > 0 && delta < 5000) {
        if (!sampleStart) sampleStart = now;
        frameSamples.push(Math.min(delta, 250));
      } else {
        frameSamples = [];
        sampleStart = 0;
      }
      frameLast = now;
      if (!sampleStart || now - sampleStart < 1500 || frameSamples.length < 4) return;
      const frameMean = frameSamples.reduce((sum, value) => sum + value, 0) / frameSamples.length;
      const measuredMs = Math.max(frameMean, now - gpuMeasuredAt < 2500 ? quality.gpuMs : 0);
      // Allow fewer samples for severely slow frames, but require consecutive windows so one pause cannot downshift detail.
      if (frameSamples.length < 20 && measuredMs < 80) return;
      quality.frameMs = measuredMs;
      quality.slowWindows = quality.frameMs > 30 ? quality.slowWindows + 1 : 0;
      quality.fastWindows = quality.frameMs < 19 ? quality.fastWindows + 1 : 0;
      frameSamples = [];
      sampleStart = now;
      // Use a 6-second cooldown in either direction and reduce slow-frame budgets in stages to avoid losing most cells at once.
      if (now - quality.changedAt < 6000) return;
      let changed = false;
      if (quality.slowWindows >= 3 || quality.frameMs >= 120 && quality.slowWindows >= 2) {
        quality.maxCells = Math.max(quality.cellFloor, Math.floor(quality.maxCells * (quality.frameMs >= 120 ? 0.7 : 0.85)));
        if (windowResolution === 'auto') autoPixelRatio = Math.max(0.75, autoPixelRatio - 0.25);
        vegetation?.adjustAutomaticDetail(1);
        changed = true;
      } else if (quality.fastWindows >= 3) {
        quality.maxCells = Math.min(quality.cellLimit, Math.ceil(quality.maxCells * 1.2));
        if (windowResolution === 'auto') autoPixelRatio = Math.min(devicePixelRatio, capable ? 1.5 : 1.25, autoPixelRatio + 0.1);
        vegetation?.adjustAutomaticDetail(-1);
        changed = true;
      }
      if (changed) {
        quality.changedAt = now;
        quality.slowWindows = 0;
        quality.fastWindows = 0;
        applyWindowResolution();
        currentPlan = null;
        scheduleLOD();
      }
    }

    // 8. On-demand drawing, with visible waves, rain and wind active until sleep.
    // A null pending frame ID means no frame is queued; queued frames can be cancelled when hidden.
    let framePending = null;
    let frameContinuation = false;
    let sceneUpdatePending = false;
    let lastAnimationFrame = null,
      waterVisible = false,
      vegetationRevision = -1;
    const bounds = new THREE.Box3(),
      center = new THREE.Vector3(),
      size = new THREE.Vector3();
    function render(now) {
      /*
       * Perform a full scene update or a lightweight animation frame according to pending work.
       * Parameter: now is the requestAnimationFrame timestamp in milliseconds. Full updates handle
       * navigation, collision, clipping, coverage, instances and performance. Animation-only frames
       * advance shared time and feed quality feedback; budget changes trigger LOD selection.
       * Continue unfinished interaction, but limit idle animation by its deadline and visibility.
       * Stop idle continuation for dialogs, expired deadlines or no visible animated effects.
       * Returns undefined.
       */
      const continuous = frameContinuation;
      frameContinuation = false;
      framePending = null;
      if (document.hidden) return;
      collectGpuTime(now);
      const updateScene = sceneUpdatePending;
      sceneUpdatePending = false;
      let pendingPlants = false;
      if (navigationReady && !navigationPaused()) {
        observeFrame(now, continuous);
      } else {
        frameLast = 0;
        frameSamples = [];
        sampleStart = 0;
      }
      if (updateScene) {
        moveKeyboard(now);
        controls.update();
        constrainCamera();
        moveZoom(now);
        bounds.min.set(-m.width_m / 2, -100 * terrain.scale.y, -m.height_m / 2);
        bounds.max.set(m.width_m / 2, m.elevation_max_m * terrain.scale.y, m.height_m / 2);
        camera.near = 0.5;
        camera.far = Math.max(camera.near + 1, camera.position.distanceTo(bounds.getCenter(center)) + bounds.getSize(size).length() * 0.55);
        camera.updateProjectionMatrix();
        if (initialized && now - coverageAt > 80) {
          camera.updateMatrixWorld();
          matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
          frustum.setFromProjectionMatrix(matrix);
          coverageAt = now;
        }
        pendingPlants = vegetation?.update(now, terrain.scale.y) ?? false;
        const nextPlantRevision = vegetation?.getState().placementRevision;
        if (nextPlantRevision !== vegetationRevision) {
          environment.markDirty();
          vegetationRevision = nextPlantRevision;
        }
        waterVisible = [...live.values()].some(item => item.geometry.water && frustum.intersectsBox(tileBox(item.tile)));
        environment.updateView(terrain.scale.y);
        surf.update(live, environment.getState().cardBrightness);
      } else {
        // Idle animation frames advance clocks without repeating LOD, collision, frustum or instance-placement work.
        vegetation?.animate(now);
      }
      flashlight.update(terrain.scale.y, live);
      const animate = !navigationPaused();
      const animationDelta = animate && lastAnimationFrame !== null ? Math.min(0.05, Math.max(0, (now - lastAnimationFrame) / 1000)) : 0;
      if (animate) {
        if (waterVisible) waterMotion.advance(animationDelta);
        environment.animate(animationDelta);
      }
      lastAnimationFrame = animate ? now : null;
      const measureGpu = gpuTimer && navigationReady && !navigationPaused() && !foregroundBusy && !warmingResident && !buildTasks.size && now - lastBuildAt >= 250 && gpuQueries.length < 3 && ++gpuSampleFrame % 4 === 0;
      const gpuQuery = measureGpu ? graphicsContext.createQuery() : null;
      if (gpuQuery) graphicsContext.beginQuery(gpuTimer.TIME_ELAPSED_EXT, gpuQuery);
      renderer.render(scene, camera);
      if (gpuQuery) {
        graphicsContext.endQuery(gpuTimer.TIME_ELAPSED_EXT);
        gpuQueries.push({
          query: gpuQuery,
          submittedAt: now
        });
      }
      if (updateScene) updateResolution();
      if (pressed.size || pendingZoom || pendingPlants) {
        requestRender();
      } else if (!navigationPaused() && stayAwake(now) && (waterVisible || environment.hasAnimation() || vegetation?.hasAnimation())) {
        requestRender(false);
      }
      frameContinuation = framePending !== null;
      // Maintain a clock baseline for event-triggered frames; the first resumed animation step is capped at 50 ms.
    }
    function requestRender(updateScene = true) {
      /*
       * Request at most one animation frame. Merge the full-update flag so animation requests
       * cannot clear it; do not queue frames while hidden.
       */
      sceneUpdatePending ||= updateScene;
      if (framePending === null && !document.hidden) framePending = requestAnimationFrame(render);
    }
    function wakeRendering() {
      /* Record actual interaction and request a full frame. Loading and animation do not reset the idle deadline. */
      lastInteractionAt = performance.now();
      requestRender();
    }
    function stayAwake(now) {
      /*
       * Return whether animation is allowed at the supplied timestamp: never is unlimited, zero
       * sleeps immediately, otherwise compare elapsed time with the configured delay.
       */
      // A requestAnimationFrame timestamp can precede input handled in that frame; explicitly reject zero delay.
      return idleSleepDelay === 'never' || idleSleepDelay !== '0' && now - lastInteractionAt < Number(idleSleepDelay) * 1000;
    }
    for (const dialog of [helpDialog, settingsDialog]) dialog.addEventListener('close', wakeRendering);
    controls.addEventListener('start', wakeRendering);
    controls.addEventListener('end', wakeRendering);
    document.addEventListener('visibilitychange', () => {
      releaseNavigation();
      // Exclude hidden time from performance sampling; show completed hidden-page loads after visibility resumes.
      frameLast = 0;
      frameSamples = [];
      sampleStart = 0;
      if (document.hidden) {
        if (framePending !== null) cancelAnimationFrame(framePending);
        framePending = null;
        frameContinuation = false;
        lastAnimationFrame = null;
      } else {
        wakeRendering();
        scheduleLOD();
      }
    });
    function updateScale() {
      /*
       * The vertical slider changes display Y scale only. Update its label/accessibility text and
       * request rendering/LOD; leave the DEM unchanged.
       */
      terrain.scale.y = Number(slider.value);
      waterMotion.setView(displayLevels[minimumLevel].step * nativeSpacing, terrain.scale.y);
      environment.markDirty();
      vegetation?.markDirty();
      scaleLabel.textContent = `1:${slider.value}`;
      slider.setAttribute('aria-valuetext', `${slider.value} times vertical exaggeration`);
      wakeRendering();
      scheduleLOD();
    }
    slider.addEventListener('input', updateScale);
    // Control changes record interaction and request a frame and LOD update.
    controls.addEventListener('change', () => {
      lastMotion = performance.now();
      wakeRendering();
      scheduleLOD();
    });
    window.addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      applyWindowResolution();
      wakeRendering();
      scheduleLOD();
    });
    renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      errorMessage(new Error('WebGL context was lost. Reload to restore terrain.'));
    });
    status.textContent = 'Loading vegetation models…';
    vegetation = await window.NotoVegetation.create({
      THREE,
      renderer,
      scene,
      camera,
      data: vegetationData,
      sampleHeight: surfaceHeight
    });
    vegetation.setDetail(vegetationDetailSelect.value);
    vegetation.setLighting(environment.getState().cardBrightness);
    // Read-only diagnostic snapshot.
    window.terrainViewer = {
      getState: () => ({
        ready: initialized && navigationReady,
        graphics: {
          ...graphics
        },
        environment: environment.getState(),
        water: waterMotion.getState(),
        surf: surf.getState(),
        flashlight: flashlight.getState(),
        maximumResolutionM: nativeSpacing * displayLevels[minimumLevel].step,
        windowResolution,
        idleSleepDelay,
        canvasPixels: [renderer.domElement.width, renderer.domElement.height],
        vegetation: vegetation.getState(),
        metadata: m,
        verticalScale: terrain.scale.y,
        tiles: [...live.keys()],
        activeTiles: live.size,
        unavailableTiles: [...unavailableTiles],
        cachedTiles: rawCache.size,
        geometryCacheTiles: geometryCache.size,
        estimatedGeometryMiB: geometryBytes / MiB,
        residentGridM: nativeSpacing * displayLevels[residentLevel].step,
        residentDataReady: levels[residentLevel].every(tile => rawCache.has(tile.key)),
        residentGeometryGrids: [...residentMaps.keys()].map(level => nativeSpacing * displayLevels[level].step),
        hardware,
        quality: {
          ...quality
        },
        cache: {
          ...cacheStats
        },
        finestGridM: Math.min(...[...live.values()].map(item => item.tile.step * nativeSpacing)),
        gridLevels: [...new Set([...live.values()].map(item => item.tile.level))],
        gridSpacingsM: [...new Set([...live.values()].map(item => item.tile.step * nativeSpacing))].sort((a, b) => a - b),
        lodMode: 'distance-adaptive',
        surfaceCells: [...live.values()].reduce((sum, item) => sum + surfaceCells(item.tile), 0),
        renderedTriangles: renderer.info.render.triangles,
        renderedFrames: renderer.info.render.frame,
        drawCalls: renderer.info.render.calls,
        camera: camera.position.toArray(),
        target: controls.target.toArray()
      })
    };
    updateScale();
    const extent = Math.max(m.width_m, m.height_m);
    controls.target.set(0, (-100 + m.elevation_max_m) * terrain.scale.y / 2, 0);
    camera.position.copy(controls.target).add(new THREE.Vector3(extent * 0.12, extent * 0.72, extent * 0.87).multiplyScalar(Math.max(1, 1 / camera.aspect) * 1.2));
    controls.update();
    status.textContent = 'Loading terrain tiles…';
    // Build complete coarse coverage before requesting fine detail.
    const initial = new Map();
    for (const tile of levels[maxLevel]) {
      initial.set(tile.key, await getItem(tile));
      await waitFrame();
    }
    residentMaps.set(maxLevel, initial);
    showSet(initial);
    // Enable navigation after coarse inputs are ready; local LOD selection always keeps full-map coverage.
    await warmResident();
    navigationReady = true;
    controls.enabled = true;
    wakeRendering();
    await updateLOD();
  } catch (error) {
    errorMessage(error);
  }
})();
