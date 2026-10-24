/* Build terrain away from the UI thread; only typed buffers cross the Worker boundary. */
(function registerGeometryWorker(global) {
  'use strict';

  // This self-contained codec is shared with the Blob Worker. Never transfer live input buffers.
  function geometryTransport() {
    function packGeometry(geometry) {
      if (!geometry) return null;
      return {
        attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([key, value]) => [key, {
          array: value.array, itemSize: value.itemSize, normalized: value.normalized
        }])),
        index: geometry.index?.array ?? null,
        sphere: geometry.boundingSphere ? [...geometry.boundingSphere.center.toArray(), geometry.boundingSphere.radius] : null,
        box: geometry.boundingBox ? [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()] : null,
        userData: geometry.userData,
        groups: geometry.groups,
        drawRange: geometry.drawRange
      };
    }
    function unpackGeometry(THREE, packet) {
      if (!packet) return null;
      const geometry = new THREE.BufferGeometry();
      for (const [key, value] of Object.entries(packet.attributes)) {
        geometry.setAttribute(key, new THREE.BufferAttribute(value.array, value.itemSize, value.normalized));
      }
      if (packet.index) geometry.setIndex(new THREE.BufferAttribute(packet.index, 1));
      if (packet.sphere) geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...packet.sphere.slice(0, 3)), packet.sphere[3]);
      if (packet.box) geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...packet.box[0]), new THREE.Vector3(...packet.box[1]));
      geometry.userData = packet.userData;
      geometry.groups = packet.groups;
      geometry.drawRange = packet.drawRange;
      return geometry;
    }
    function boundaryData(geometry) {
      if (!geometry?.userData.notoBoundaryBounds) return;
      const bounds = geometry.userData.notoBoundaryBounds;
      const positions = geometry.attributes.position.array, normals = geometry.attributes.normal.array;
      const indices = [], points = [], original = [];
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], z = positions[i + 2];
        if (Math.abs(x - bounds.minX) > 1e-4 && Math.abs(x - bounds.maxX) > 1e-4 &&
            Math.abs(z - bounds.minZ) > 1e-4 && Math.abs(z - bounds.maxZ) > 1e-4) continue;
        indices.push(i / 3);
        points.push(x, positions[i + 1], z);
        original.push(normals[i], normals[i + 1], normals[i + 2]);
      }
      Object.assign(geometry.userData, {
        notoBoundaryVertexIndices: Uint32Array.from(indices),
        notoOriginalBoundaryNormals: Float32Array.from(original),
        notoBoundaryPositions: Float32Array.from(points)
      });
    }
    function edgeGeometry(geometry, tile, metadata) {
      if (!geometry) return null;
      const p = geometry.attributes.position.array, ids = geometry.index.array;
      const dx = metadata.source_spacing_m[0], dz = metadata.source_spacing_m[1];
      const x0 = tile.c0 * dx - metadata.width_m / 2, x1 = tile.c1 * dx - metadata.width_m / 2;
      const z0 = tile.r0 * dz - metadata.height_m / 2, z1 = tile.r1 * dz - metadata.height_m / 2;
      const positions = [], indices = [], seen = new Set();
      for (let i = 0; i < ids.length; i += 3) for (let j = 0; j < 3; j++) {
        const a = ids[i + j], b = ids[i + (j + 1) % 3];
        const key = `${Math.min(a, b)}/${Math.max(a, b)}`;
        if (seen.has(key)) continue;
        if (![x0, x1].some(x => Math.abs(p[a * 3] - x) < 0.002 && Math.abs(p[b * 3] - x) < 0.002) &&
            ![z0, z1].some(z => Math.abs(p[a * 3 + 2] - z) < 0.002 && Math.abs(p[b * 3 + 2] - z) < 0.002)) continue;
        seen.add(key);
        const first = positions.length / 3;
        positions.push(p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2]);
        // Degenerate triangles preserve the existing seam reader's edge interface.
        indices.push(first, first + 1, first + 1);
      }
      return { top: { attributes: { position: { array: Float32Array.from(positions) } }, index: { array: Uint32Array.from(indices) } } };
    }
    function packResult(result, tile, metadata) {
      boundaryData(result.land?.top);
      // Hydration must not scan a large water surface on the UI thread just to rebuild bounds.
      if (result.water?.top && !result.water.top.boundingBox) result.water.top.computeBoundingBox();
      const packet = {
        heights: result.heights, landCells: result.landCells, metadata: result.metadata,
        coastSegments: result.coastSegments, shoreQueryRanges: result.shoreQueryRanges,
        heightQuery: result.heightQuery, edgeGeometry: {}
      };
      for (const owner of ['land', 'water']) {
        packet[owner] = result[owner] ? {
          ...Object.fromEntries(['top', 'walls', 'bottom'].map(part => [part, packGeometry(result[owner][part])]))
        } : null;
        packet.edgeGeometry[owner] = edgeGeometry(result[owner]?.top, tile, metadata);
      }
      return packet;
    }
    function unpackResult(THREE, packet) {
      const result = { ...packet };
      for (const owner of ['land', 'water']) {
        result[owner] = packet[owner] ? Object.fromEntries(['top', 'walls', 'bottom'].map(part => [part, unpackGeometry(THREE, packet[owner][part])])) : null;
      }
      result.dispose = () => {
        for (const owner of ['land', 'water']) for (const part of ['top', 'walls', 'bottom']) result[owner]?.[part]?.dispose();
      };
      return result;
    }
    function averageNormals(entries) {
      const groups = new Map(), output = entries.map(entry => entry.normals.slice());
      for (let e = 0; e < entries.length; e++) {
        const { positions, normals } = entries[e];
        for (let i = 0; i < positions.length; i += 3) {
          const key = `${Math.round(positions[i] / 1e-4)}:${Math.round(positions[i + 1] / 1e-4)}:${Math.round(positions[i + 2] / 1e-4)}`;
          let group = groups.get(key);
          if (!group) groups.set(key, group = { x: 0, y: 0, z: 0, members: [] });
          group.x += normals[i]; group.y += normals[i + 1]; group.z += normals[i + 2];
          group.members.push(e, i);
        }
      }
      for (const group of groups.values()) {
        const length = Math.hypot(group.x, group.y, group.z) || 1;
        for (let j = 0; j < group.members.length; j += 2) {
          const values = output[group.members[j]], i = group.members[j + 1];
          values[i] = group.x / length; values[i + 1] = group.y / length; values[i + 2] = group.z / length;
        }
      }
      return output;
    }
    function transferables(value, buffers = new Set()) {
      if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
      else if (value && typeof value === 'object') for (const child of Object.values(value)) transferables(child, buffers);
      return [...buffers];
    }
    return { packResult, unpackResult, averageNormals, transferables };
  }

  // Runs entirely in a dedicated Worker. It needs Three.js core math, never a WebGL context.
  function workerMain() {
    const codec = geometryTransport();
    let THREE, tileset, oceanAt;
    self.onmessage = async ({ data }) => {
      const { id, type, payload } = data;
      try {
        let value;
        const start = performance.now();
        if (type === 'init') {
          // A file page's Blob URLs belong to its opaque origin and cannot be imported by
          // another realm. Import this Worker's own encoded copy instead; no file fetch is used.
          let coreURL = payload.coreURL;
          if (payload.coreSource) {
            const bytes = new TextEncoder().encode(payload.coreSource);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
            coreURL = 'data:text/javascript;base64,' + btoa(binary);
          }
          THREE = await import(coreURL);
          tileset = payload.tileset;
          const mask = tileset.oceanMask, bits = payload.oceanBits;
          oceanAt = (r, c) => {
            const row = Math.max(0, Math.min(mask.rows - 1, Math.floor(r / mask.step)));
            const col = Math.max(0, Math.min(mask.cols - 1, Math.floor(c / mask.step)));
            const i = row * mask.cols + col;
            return Boolean(bits[i >> 3] >> (i & 7) & 1);
          };
          oceanAt.coast = await self.NotoCoastalGeometry.prepare(payload.shoreline);
          value = true;
        } else if (type === 'build') {
          const { tile, heights, neighbors, coarser } = payload;
          const result = self.NotoTileGeometry.build(THREE, tileset, tile, heights, neighbors, oceanAt);
          if (tile.virtual) {
            self.NotoTileGeometry.conformEdges(THREE, tile, result, coarser, tileset.metadata);
            self.NotoTileGeometry.conformEdges(THREE, tile, result, coarser, tileset.metadata, 'water');
          }
          value = codec.packResult(result, tile, tileset.metadata);
        } else if (type === 'normals') {
          value = codec.averageNormals(payload);
        } else throw new Error(`Unknown terrain Worker request: ${type}`);
        self.postMessage({ id, value, elapsed: performance.now() - start }, codec.transferables(value));
      } catch (error) {
        self.postMessage({ id, error: error.message || String(error) });
      }
    };
  }

  async function create({ THREE, coreURL, coreSource, tileset, oceanBits, shoreline, coastalField }) {
    const codec = geometryTransport();
    const state = { mode: 'worker', fallbackReason: null, completedBuilds: 0, workerBuildMs: 0, mainAttachMs: 0, normalSyncMs: 0 };
    let worker = null, nextId = 0, disposed = false, startupTimer;
    const pending = new Map();
    const snapshot = () => ({ ...state, pending: pending.size });
    function fail(error) {
      if (disposed) return;
      state.mode = 'main-thread-fallback';
      state.fallbackReason = error.message || String(error);
      worker?.terminate(); worker = null;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      console.warn('Terrain Worker unavailable; using compatible geometry construction:', state.fallbackReason);
    }
    function request(type, payload) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, type, payload }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    }
    // Only geometry fields cross the boundary; selected descriptors may contain large neighbor trees.
    function descriptor(tile) {
      return Object.fromEntries(Object.entries(tile).filter(([key, value]) =>
        !['neighbors', 'cacheKey'].includes(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value) || key === 'boundaryForcedSea')));
    }
    try {
      const source = [
        'self.window = self;',
        `self.NotoVolume = (${global.NotoVolume.workerSource})();`,
        `(${global.NotoTileGeometry.workerSource})(self);`,
        `(${global.NotoCoastalGeometry.workerSource})(self);`,
        geometryTransport.toString(), `(${workerMain.toString()})();`
      ].join('\n');
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        worker = new Worker(url, { name: 'Noto terrain geometry' });
        worker.onmessage = ({ data }) => {
          const job = pending.get(data.id);
          if (!job) return;
          pending.delete(data.id);
          if (data.error) job.reject(new Error(data.error)); else job.resolve(data);
        };
        worker.onerror = event => { event.preventDefault?.(); fail(new Error(event.message || 'Terrain Worker failed')); };
        worker.onmessageerror = () => fail(new Error('Terrain Worker message could not be decoded'));
        startupTimer = setTimeout(() => fail(new Error('Terrain Worker initialization timed out')), 15000);
        // Copy static inputs once. Transfer is reserved for newly built output, preserving live caches.
        await request('init', { coreURL, coreSource, tileset: { metadata: tileset.metadata, oceanMask: tileset.oceanMask }, oceanBits, shoreline });
      } finally { clearTimeout(startupTimer); URL.revokeObjectURL(url); }
    } catch (error) { if (state.mode === 'worker') fail(error); }

    function fallbackBuild(tile, heights, neighbors, coarser) {
      const mask = tileset.oceanMask;
      const oceanAt = (r, c) => {
        const row = Math.max(0, Math.min(mask.rows - 1, Math.floor(r / mask.step)));
        const col = Math.max(0, Math.min(mask.cols - 1, Math.floor(c / mask.step)));
        const i = row * mask.cols + col;
        return Boolean(oceanBits[i >> 3] >> (i & 7) & 1);
      };
      oceanAt.coast = coastalField;
      const result = global.NotoTileGeometry.build(THREE, tileset, tile, heights, neighbors, oceanAt);
      if (tile.virtual) {
        global.NotoTileGeometry.conformEdges(THREE, tile, result, coarser, tileset.metadata);
        global.NotoTileGeometry.conformEdges(THREE, tile, result, coarser, tileset.metadata, 'water');
      }
      return result;
    }
    return {
      async build(tile, heights, neighbors, coarser = []) {
        if (disposed) throw new Error('Terrain geometry builder is disposed');
        if (!worker) return fallbackBuild(tile, heights, neighbors, coarser);
        let response;
        try {
          response = await request('build', {
            tile: descriptor(tile), heights,
            neighbors: neighbors.map(item => ({ tile: descriptor(item.tile), heights: item.heights })),
            coarser: coarser.filter(item => item.tile.step > tile.step &&
              ((item.tile.c0 === tile.c1 || item.tile.c1 === tile.c0) && Math.max(item.tile.r0, tile.r0) < Math.min(item.tile.r1, tile.r1) ||
               (item.tile.r0 === tile.r1 || item.tile.r1 === tile.r0) && Math.max(item.tile.c0, tile.c0) < Math.min(item.tile.c1, tile.c1)))
              .map(item => ({ tile: descriptor(item.tile), geometry: item.geometry.edgeGeometry || item.geometry }))
          });
        } catch (error) {
          if (state.mode !== 'worker') return fallbackBuild(tile, heights, neighbors, coarser);
          throw error;
        }
        const start = performance.now();
        const result = codec.unpackResult(THREE, response.value);
        if (result.heightQuery) result.sampleHeight = global.NotoCoastalGeometry.createHeightSampler(result, coastalField);
        state.completedBuilds++;
        state.workerBuildMs = response.elapsed;
        state.mainAttachMs = performance.now() - start;
        return result;
      },
      async synchronizeNormals(items, isCurrent = () => true) {
        if (!worker) {
          if (!isCurrent()) return false;
          global.NotoTileGeometry.synchronizeNormals(items.map(item => item.geometry));
          return true;
        }
        const tops = items.map(item => item.geometry.land?.top).filter(top => top?.userData.notoBoundaryPositions);
        const entries = tops.map(top => ({ positions: top.userData.notoBoundaryPositions, normals: top.userData.notoOriginalBoundaryNormals }));
        let response;
        try { response = await request('normals', entries); }
        catch (error) {
          if (state.mode !== 'worker') {
            if (!isCurrent()) return false;
            global.NotoTileGeometry.synchronizeNormals(items.map(item => item.geometry));
            return true;
          }
          throw error;
        }
        if (!isCurrent()) return false;
        for (let e = 0; e < tops.length; e++) {
          const attribute = tops[e].attributes.normal, indices = tops[e].userData.notoBoundaryVertexIndices;
          const values = response.value[e];
          for (let i = 0; i < indices.length; i++) {
            const target = indices[i] * 3, source = i * 3;
            attribute.array[target] = values[source];
            attribute.array[target + 1] = values[source + 1];
            attribute.array[target + 2] = values[source + 2];
          }
          attribute.needsUpdate = true;
        }
        state.normalSyncMs = response.elapsed;
        return true;
      },
      getState: snapshot,
      dispose() {
        disposed = true; clearTimeout(startupTimer); worker?.terminate(); worker = null;
        for (const job of pending.values()) job.reject(new Error('Terrain geometry builder is disposed'));
        pending.clear();
      }
    };
  }
  global.NotoGeometryWorker = { create };
})(typeof window !== 'undefined' ? window : globalThis);
