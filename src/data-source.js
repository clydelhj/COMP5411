/* Open generated map data as read-only files; external wrappers are parsed as data. */
(function dataSourceModule(global) {
  'use strict';

  function requireData(condition, message) {
    if (!condition) throw new Error(message);
  }
  function stripHeader(text) {
    return text.replace(/^\s*(?:(?:\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)\s*)*/, '').trim();
  }
  function parseObject(text) {
    // Older exporters split base64 into quoted chunks using either + or [].join("").
    if (text.includes('.join("")') || /"\s*\+\s*"/.test(text)) {
      text = text.replace(/\[\s*("[A-Za-z0-9+/=]*"(?:\s*,\s*"[A-Za-z0-9+/=]*")*)\s*\]\.join\(""\)/g,
        (_, pieces) => '"' + pieces.replace(/["\s,]/g, '') + '"').replace(/"\s*\+\s*"/g, '');
    }
    return JSON.parse(text, (key, value) => {
      requireData(key !== '__proto__', 'Invalid data key');
      return value;
    });
  }
  function parseLayer(text, name) {
    const source = stripHeader(text);
    const prefix = new RegExp('^window\\.' + name + '\\s*=\\s*');
    requireData(prefix.test(source), 'Expected ' + name);
    return parseObject(source.replace(prefix, '').replace(/;\s*$/, ''));
  }
  function parseTile(text, key) {
    const source = stripHeader(text);
    const header = /^window\.NOTO_TILE_RECEIVE\(\s*"([^"]+)"\s*,\s*/.exec(source);
    requireData(header && header[1] === key && /\)\s*;?$/.test(source), 'Invalid terrain tile: ' + key);
    return parseObject(source.slice(header[0].length).replace(/\)\s*;?$/, ''));
  }
  async function readText(directory, filename) {
    try {
      const handle = await directory.getFileHandle(filename);
      return await (await handle.getFile()).text();
    } catch (error) {
      throw new Error('Could not read ' + filename + '. ' + error.message);
    }
  }
  const integer = value => Number.isSafeInteger(value) && value > 0;
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-4;
  const equalBounds = (a, b) => Array.isArray(a) && a.length === 4 && a.every((n, i) => close(n, b[i]));

  function validateLayers(tileset, shoreline, strata, vegetation) {
    const m = tileset.metadata, grid = strata.metadata, mask = tileset.oceanMask;
    const dx = m.source_spacing_m[0], dz = m.source_spacing_m[1];
    requireData(integer(m.source_width) && integer(m.source_height) && dx > 0 && close(dx, dz)
      && close((m.source_width - 1) * dx, m.width_m) && close((m.source_height - 1) * dz, m.height_m)
      && m.width_m > 0 && m.height_m > 0 && Number.isFinite(m.elevation_max_m)
      && m.quantization_m === 0.01 && m.baseElevation === -100 && tileset.tileCells === 256,
      'Unsupported DEM dimensions, spacing, tile size or height encoding');
    const center = m.display_centers;
    const bounds = [center.left, center.bottom, center.right, center.top];
    requireData(close(bounds[2] - bounds[0], m.width_m) && close(bounds[3] - bounds[1], m.height_m)
      && close(m.origin_easting, (bounds[0] + bounds[2]) / 2) && close(m.origin_northing, (bounds[1] + bounds[3]) / 2),
      'DEM bounds and model origin do not match');
    requireData(close(shoreline.widthM, m.width_m) && close(shoreline.heightM, m.height_m)
      && (!shoreline.bounds || equalBounds(shoreline.bounds, bounds)), 'Shoreline and DEM extents differ');
    requireData(close(grid.width_m, m.width_m) && close(grid.height_m, m.height_m)
      && (!grid.bounds || equalBounds(grid.bounds, bounds)), 'Geology and DEM extents differ');
    requireData(equalBounds(vegetation.bounds, bounds), 'Vegetation and DEM bounds differ');
    const crs = [m.crs, grid.crs, shoreline.crs, vegetation.crs].filter(Boolean);
    requireData(new Set(crs).size <= 1, 'Data layers use different coordinate reference systems');
    requireData(integer(grid.cols) && integer(grid.rows) && integer(grid.levels) && integer(vegetation.rows)
      && integer(vegetation.columns) && integer(shoreline.cols) && integer(shoreline.rows) && shoreline.cellM > 0
      && integer(mask.rows) && integer(mask.cols) && integer(mask.step), 'Invalid raster dimensions');
    requireData([strata.ids, vegetation.classes, shoreline.coastalHeights, shoreline.distances, mask.bits]
      .every(value => typeof value === 'string' && value.length > 0), 'Missing encoded raster payload');
    if (m.geographicCenter) {
      const { latitude, longitude } = m.geographicCenter;
      requireData(Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude)
        && Math.abs(longitude) <= 180, 'Invalid geographic center');
    } else {
      // The original maps predate geographicCenter and include WGS84 vegetation bounds.
      const wgs = vegetation.wgs84_bounds;
      requireData(Array.isArray(wgs) && wgs.length === 4 && wgs.every(Number.isFinite)
        && -180 <= wgs[0] && wgs[0] < wgs[2] && wgs[2] <= 180
        && -90 <= wgs[1] && wgs[1] < wgs[3] && wgs[3] <= 90, 'Missing geographic center or WGS84 bounds');
      m.geographicCenter = {latitude: (wgs[1] + wgs[3]) / 2, longitude: (wgs[0] + wgs[2]) / 2};
    }
  }
  async function checkLength(payload, bytes, label) {
    const packed = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
    const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > bytes) {
          await reader.cancel();
          throw new Error('Invalid ' + label + ' size');
        }
      }
      requireData(size === bytes, 'Invalid ' + label + ' size');
    } finally { reader.releaseLock(); }
  }
  async function openPackage(directory, inspect) {
    const terrain = await directory.getDirectoryHandle('terrain-1m').catch(() => {
      throw new Error('Select the data folder containing terrain-1m and its three companion map files.');
    });
    const [tileset, shoreline, strata, vegetation] = await Promise.all([
      readText(terrain, 'manifest.js').then(text => parseLayer(text, 'NOTO_TILESET')),
      readText(directory, 'shoreline-data.js').then(text => parseLayer(text, 'NOTO_SHORELINE')),
      readText(directory, 'strata-data.js').then(text => parseLayer(text, 'NOTO_STRATA')),
      readText(directory, 'vegetation-data.js').then(text => parseLayer(text, 'NOTO_VEGETATION'))
    ]);
    validateLayers(tileset, shoreline, strata, vegetation);
    const levels = new Map();
    for (const level of tileset.levels) {
      requireData(integer(level.step) && integer(level.tilesX) && integer(level.tilesZ)
        && !levels.has(String(level.level)), 'Invalid terrain level');
      levels.set(String(level.level), level);
    }
    requireData(levels.get('0')?.step === 1, 'Missing native terrain level');
    const files = new Map(), directories = new Map();
    for (const level of levels.values()) {
      for (let z = 0; z < level.tilesZ; z++) for (let x = 0; x < level.tilesX; x++) {
        const key = level.level + '/' + x + '/' + z;
        const tile = tileset.tiles[key];
        requireData(tile && integer(tile.rows) && integer(tile.cols) && tile.rows <= 257 && tile.cols <= 257
          && (tile.file || tile.kind === 'water'), 'Missing or invalid tile record: ' + key);
        if (!tile.file) continue;
        const path = /^([A-Za-z0-9_-]+)\/([0-9]+_[0-9]+\.js)$/.exec(tile.file);
        requireData(path, 'Invalid terrain tile path: ' + key);
        if (!files.has(path[1])) files.set(path[1], new Set());
        files.get(path[1]).add(path[2]);
      }
    }
    for (const [folder, expected] of files) {
      const handle = await terrain.getDirectoryHandle(folder);
      directories.set(folder, handle);
      if (inspect) {
        for await (const [name, entry] of handle) if (entry.kind === 'file') expected.delete(name);
        requireData(!expected.size, 'Missing terrain tile: ' + folder + '/' + expected.values().next().value);
      }
    }
    async function tilePayload(tile) {
      const [folder, filename] = tile.file.split('/');
      const payload = parseTile(await readText(directories.get(folder), filename), tile.key);
      requireData(payload.rows === tile.rows && payload.cols === tile.cols && typeof payload.heights === 'string',
        'Terrain tile header mismatch: ' + tile.key);
      return payload;
    }
    if (inspect) {
      const grid = strata.metadata, coastBytes = shoreline.rows * shoreline.cols * 2, mask = tileset.oceanMask;
      await checkLength(mask.bits, Math.ceil(mask.rows * mask.cols / 8), 'ocean mask');
      await checkLength(strata.ids, grid.rows * grid.cols * grid.levels, 'geology');
      await checkLength(vegetation.classes, vegetation.rows * vegetation.columns, 'vegetation');
      await checkLength(shoreline.distances, coastBytes, 'shoreline distances');
      await checkLength(shoreline.coastalHeights, coastBytes, 'shoreline heights');
      const coarsest = [...levels.values()].sort((a, b) => b.step - a.step)[0];
      for (const [key, tile] of Object.entries(tileset.tiles)) {
        if (String(tile.level) !== String(coarsest.level) || !tile.file) continue;
        const payload = await tilePayload({ ...tile, key });
        await checkLength(payload.heights, tile.rows * tile.cols * 2, key);
      }
    }
    return { tileset, shoreline, strata, vegetation, tilePayload };
  }

  // Store only a read-only directory handle. Large tile files stay in the chosen folder.
  async function savedFolder(operation, value) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('terrain-viewer-data-source', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('folders');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('folders', operation === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('folders'), key = location.pathname;
        const request = operation === 'put' ? store.put(value, key) : store[operation](key);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('Could not save the data folder'));
      });
    } finally { db.close(); }
  }
  async function initialize() {
    const choose = document.querySelector('#choose-data-folder');
    const reset = document.querySelector('#reset-data-folder');
    const label = document.querySelector('#data-source-status');
    const available = typeof global.showDirectoryPicker === 'function' && Boolean(global.indexedDB);
    const busy = active => { choose.disabled = active || !available; reset.disabled = active; };
    reset.addEventListener('click', async () => {
      busy(true);
      try { await savedFolder('delete'); location.reload(); }
      catch (error) { busy(false); label.textContent = error.message; }
    });
    choose.addEventListener('click', async () => {
      busy(true);
      const previous = label.textContent;
      try {
        const handle = await global.showDirectoryPicker({ mode: 'read', id: 'terrain-data' });
        label.textContent = 'Checking data files and grid alignment…';
        await openPackage(handle, true);
        await savedFolder('put', handle);
        label.textContent = 'Loading selected data…';
        location.reload();
      } catch (error) {
        busy(false);
        label.textContent = error.name === 'AbortError' ? previous : 'Data folder was not applied. ' + error.message;
      }
    });
    choose.disabled = !available;
    const bundled = { tileset: global.NOTO_TILESET, shoreline: global.NOTO_SHORELINE,
      strata: global.NOTO_STRATA, vegetation: global.NOTO_VEGETATION };
    if (!available) {
      label.textContent = 'Bundled data. To choose a folder, open this page in desktop Edge or Chrome from a local file, localhost or HTTPS.';
      return bundled;
    }
    try {
      const handle = await savedFolder('get');
      if (!handle) return bundled;
      reset.hidden = false;
      if (await handle.queryPermission({mode: 'read'}) !== 'granted') {
        throw new Error('Select the folder again to allow read access.');
      }
      const source = await openPackage(handle, false);
      const name = String(source.tileset.metadata.source || handle.name);
      document.querySelector('.panel h1').textContent = name;
      document.title = name + ' · Terrain viewer';
      const bounds = source.vegetation.wgs84_bounds;
      document.querySelector('.model-extent').textContent = Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
        ? 'Lat ' + bounds[1].toFixed(2) + '° to ' + bounds[3].toFixed(2) + '° · Lon ' + bounds[0].toFixed(2) + '° to ' + bounds[2].toFixed(2) + '°'
        : (source.tileset.metadata.width_m / 1000).toFixed(1) + ' × ' + (source.tileset.metadata.height_m / 1000).toFixed(1) + ' km';
      label.textContent = 'Local folder: ' + handle.name + ' · ' + name;
      return source;
    } catch (error) {
      label.textContent = 'Using bundled data. ' + error.message;
      return bundled;
    }
  }
  global.NotoDataSource = { initialize, openPackage };
})(typeof window !== 'undefined' ? window : globalThis);
