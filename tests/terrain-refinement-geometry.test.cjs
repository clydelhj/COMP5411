'use strict';

// Exercise each progressive commit with real geometry, generated heights and a curved coast.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const EPSILON = 0.0003;

async function fixture() {
  const runtime = vm.createContext({ window: {}, Map, Set, console, Blob, Response, DecompressionStream, atob,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array });
  runtime.window = runtime;
  for (const name of ['model-volume', 'coastal-geometry', 'tile-geometry', 'terrain-lod', 'terrain-refinement', 'water-motion']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', name + '.js'), 'utf8'), runtime, { filename: name + '.js' });
  }
  const library = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor', 'three-libraries.js'), 'utf8'), library);
  const packed = library.window.NOTO_LIBRARIES.core;
  const source = zlib.gunzipSync(Buffer.from(Array.isArray(packed) ? packed.join('') : packed, 'base64'));
  const THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
  const width = 1024, height = 768, cellM = 8;
  const metadata = { width_m: width, height_m: height, source_width: width + 1, source_height: height + 1, source_spacing_m: [1, 1] };
  const surface = (c, r) => 40 + c * 0.03 + r * 0.012 + Math.sin(c / 55) * Math.cos(r / 71) * 4;
  const distance = (x, z) => x + z * 0.15 + Math.sin(z / 23) * 6;
  const cols = width / cellM, rows = height / cellM;
  const distances = new Uint16Array(cols * rows), heights = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) * cellM - width / 2, z = (r + 0.5) * cellM - height / 2;
    distances[r * cols + c] = Math.round(32768 + distance(x, z) * 8);
    heights[r * cols + c] = Math.round((surface(x + width / 2, z + height / 2) + 100) * 100);
  }
  const gzip = values => zlib.gzipSync(Buffer.from(values.buffer)).toString('base64');
  const shoreline = { widthM: width, heightM: height, cols, rows, cellM,
    distances: gzip(distances), coastalHeights: gzip(heights) };
  const field = await runtime.NotoCoastalGeometry.prepare(shoreline);
  const materials = { top: new THREE.MeshStandardMaterial(), cut: new THREE.MeshStandardMaterial() };
  const motion = await runtime.NotoWaterMotion.create(THREE, shoreline, materials, field);
  motion.setView(1, 1);
  const oceanAt = (r, c) => field.distance(c - width / 2, r - height / 2) >= 0;
  oceanAt.coast = field;
  const tileset = { metadata, oceanMask: { step: cellM, rows: rows + 1, cols: cols + 1 } };
  const descriptors = {};
  for (let z = 0; z * 256 < height; z++) for (let x = 0; x * 256 < width; x++) {
    const key = `0/${x}/${z}`;
    descriptors[key] = { key, file: key + '.js', level: 0, step: 1, c0: x * 256, c1: Math.min(width, (x + 1) * 256),
      r0: z * 256, r1: Math.min(height, (z + 1) * 256), hasLand: true, min: 0, max: 100 };
  }
  const lod = runtime.NotoTerrainLOD.create({ metadata, descriptors, levels: [{ level: 0, step: 1 }], unavailable: new Set() });
  const planner = runtime.NotoTerrainRefinement.create({ lod, metadata });
  const raw = new Map(), cache = new Map(), cacheStats = { built: 0, reused: 0, equivalent: 0 };
  function samples(tile) {
    if (!raw.has(tile.key)) raw.set(tile.key, Uint16Array.from({ length: tile.rows * tile.cols }, (_, i) => {
      const r = Math.min(tile.r1, tile.r0 + Math.floor(i / tile.cols) * tile.step);
      const c = Math.min(tile.c1, tile.c0 + i % tile.cols * tile.step);
      return oceanAt(r, c) ? 65535 : Math.round((surface(c, r) + 100) * 100);
    }));
    return raw.get(tile.key);
  }
  function buildSet(tiles, previous = new Map()) {
    const next = new Map(), changed = [];
    for (const tile of tiles) {
      const old = previous.get(tile.key);
      if (old?.tile.cacheKey === lod.geometryKey(tile)) next.set(tile.key, old);
      else changed.push(tile);
    }
    changed.sort((a, b) => b.step - a.step || a.key.localeCompare(b.key));
    for (const tile of changed) {
      const cacheKey = lod.geometryKey(tile);
      let item = cache.get(cacheKey);
      if (item) cacheStats.reused++;
      if (!item) {
        const geometry = runtime.NotoTileGeometry.build(THREE, tileset, tile, samples(tile),
          tile.neighbors.map(neighbor => ({ tile: neighbor, heights: samples(neighbor) })), oceanAt);
        for (const kind of ['land', 'water']) runtime.NotoTileGeometry.conformEdges(THREE, tile, geometry, [...next.values()], metadata, kind);
        const finalKey = lod.noteGeometry(tile, geometry.coarseOnlyDependencies);
        const equivalent = cache.get(finalKey);
        if (equivalent) {
          geometry.dispose();
          item = equivalent;
          cacheStats.equivalent++;
        } else {
          item = { tile: { ...tile, cacheKey: finalKey }, geometry };
          cache.set(finalKey, item);
          cacheStats.built++;
        }
      }
      next.set(tile.key, item);
    }
    runtime.NotoTileGeometry.synchronizeNormals([...next.values()].map(item => item.geometry));
    return next;
  }
  return { runtime, THREE, width, height, metadata, field, lod, planner, buildSet, cache, motion, materials, cacheStats, samples, oceanAt, tileset };
}

function sharedEdge(a, b, input) {
  const width = input.width / 2, height = input.height / 2;
  if ((a.c1 === b.c0 || a.c0 === b.c1) && Math.max(a.r0, b.r0) < Math.min(a.r1, b.r1)) {
    return { axis: 0, along: 2, coordinate: (a.c1 === b.c0 ? a.c1 : a.c0) - width,
      lo: Math.max(a.r0, b.r0) - height, hi: Math.min(a.r1, b.r1) - height };
  }
  if ((a.r1 === b.r0 || a.r0 === b.r1) && Math.max(a.c0, b.c0) < Math.min(a.c1, b.c1)) {
    return { axis: 2, along: 0, coordinate: (a.r1 === b.r0 ? a.r1 : a.r0) - height,
      lo: Math.max(a.c0, b.c0) - width, hi: Math.min(a.c1, b.c1) - width };
  }
  return null;
}

const edgeCache = new WeakMap();
function boundarySegments(mesh, tile, edge, input) {
  if (!mesh) return [];
  let cached = edgeCache.get(mesh);
  if (!cached) {
    cached = new Map(); edgeCache.set(mesh, cached);
    const positions = mesh.attributes.position.array, indices = mesh.index.array;
    const bounds = [
      { axis: 0, along: 2, coordinate: tile.c0 - input.width / 2 },
      { axis: 0, along: 2, coordinate: tile.c1 - input.width / 2 },
      { axis: 2, along: 0, coordinate: tile.r0 - input.height / 2 },
      { axis: 2, along: 0, coordinate: tile.r1 - input.height / 2 }
    ];
    for (const side of bounds) {
      const seen = new Set(), result = [];
      for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
        let a = indices[i + j], b = indices[i + (j + 1) % 3];
        if (Math.abs(positions[a * 3 + side.axis] - side.coordinate) > EPSILON ||
            Math.abs(positions[b * 3 + side.axis] - side.coordinate) > EPSILON) continue;
        if (positions[a * 3 + side.along] > positions[b * 3 + side.along]) [a, b] = [b, a];
        const lo = positions[a * 3 + side.along], hi = positions[b * 3 + side.along];
        if (hi - lo < 1e-5) continue;
        const key = `${lo}/${hi}/${positions[a * 3 + 1]}/${positions[b * 3 + 1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ lo, hi, a, b, y0: positions[a * 3 + 1], y1: positions[b * 3 + 1] });
      }
      cached.set(`${side.axis}/${side.coordinate}`, result.sort((a, b) => a.lo - b.lo || a.hi - b.hi));
    }
  }
  return (cached.get(`${edge.axis}/${edge.coordinate}`) || []).filter(segment => segment.hi > edge.lo + 1e-5 && segment.lo < edge.hi - 1e-5);
}

function valueAt(mesh, segment, along, animationTime = null, input = null) {
  const p = mesh.attributes.position.array, edge = mesh.attributes.notoSeaEdge?.array;
  const wave = (x, z) => input.motion.sample(x, z, animationTime)[1];
  function displaced(i) {
    if (animationTime === null) return p[i * 3 + 1];
    if (!edge || (edge[i * 4 + 2] - edge[i * 4]) ** 2 + (edge[i * 4 + 3] - edge[i * 4 + 1]) ** 2 < 1e-6) {
      return p[i * 3 + 1] + wave(p[i * 3], p[i * 3 + 2]);
    }
    const a = i * 4, dx = edge[a + 2] - edge[a], dz = edge[a + 3] - edge[a + 1];
    const t = Math.max(0, Math.min(1, ((p[i * 3] - edge[a]) * dx + (p[i * 3 + 2] - edge[a + 1]) * dz) / (dx * dx + dz * dz)));
    return p[i * 3 + 1] + wave(edge[a], edge[a + 1]) * (1 - t) + wave(edge[a + 2], edge[a + 3]) * t;
  }
  const t = (along - segment.lo) / (segment.hi - segment.lo);
  return displaced(segment.a) * (1 - t) + displaced(segment.b) * t;
}

function audit(live, input, label) {
  const items = [...live.values()];
  let area = 0, seamSamples = 0, querySamples = 0;
  for (let i = 0; i < items.length; i++) {
    const { tile, geometry } = items[i];
    area += (tile.c1 - tile.c0) * (tile.r1 - tile.r0);
    for (let j = 0; j < i; j++) {
      const other = items[j].tile;
      assert.ok(!(Math.max(tile.c0, other.c0) < Math.min(tile.c1, other.c1) && Math.max(tile.r0, other.r0) < Math.min(tile.r1, other.r1)), `${label}: no overlapping patches`);
      const edge = sharedEdge(tile, other, input);
      if (!edge) continue;
      for (const kind of ['land', 'water']) {
        const a = geometry[kind]?.top, b = items[j].geometry[kind]?.top;
        const aa = boundarySegments(a, tile, edge, input), bb = boundarySegments(b, other, edge, input);
        const knots = [...new Set([edge.lo, edge.hi, ...aa.flatMap(s => [Math.max(s.lo, edge.lo), Math.min(s.hi, edge.hi)]),
          ...bb.flatMap(s => [Math.max(s.lo, edge.lo), Math.min(s.hi, edge.hi)])])].sort((x, y) => x - y);
        let ai = 0, bi = 0;
        for (let k = 1; k < knots.length; k++) {
          if (knots[k] - knots[k - 1] < 1e-5) continue;
          const point = (knots[k] + knots[k - 1]) / 2;
          while (ai < aa.length && aa[ai].hi < point) ai++;
          while (bi < bb.length && bb[bi].hi < point) bi++;
          const sa = aa[ai]?.lo <= point && aa[ai]?.hi >= point ? aa[ai] : null;
          const sb = bb[bi]?.lo <= point && bb[bi]?.hi >= point ? bb[bi] : null;
          assert.equal(Boolean(sa), Boolean(sb), `${label}: ${kind} coverage across ${tile.key} / ${other.key} at ${point}`);
          if (!sa) continue;
          assert.ok(Math.abs(valueAt(a, sa, point) - valueAt(b, sb, point)) <= EPSILON, `${label}: ${kind} seam height at ${point}`);
          if (kind === 'water') for (const time of [0, 1.7]) {
            assert.ok(Math.abs(valueAt(a, sa, point, time, input) - valueAt(b, sb, point, time, input)) <= EPSILON,
              `${label}: animated water seam across ${tile.key} / ${other.key} at ${point}`);
          }
          seamSamples++;
        }
      }
    }
    if (geometry.land && geometry.sampleHeight) {
      const mesh = geometry.land.top, p = mesh.attributes.position.array, indices = mesh.index.array;
      const selected = [0, Math.floor(indices.length / 6) * 3, indices.length - 3];
      for (const start of selected) {
        if (start < 0 || start + 2 >= indices.length) continue;
        const ids = [indices[start], indices[start + 1], indices[start + 2]], weights = [0.2, 0.3, 0.5];
        const xyz = [0, 0, 0];
        for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) xyz[axis] += p[ids[corner] * 3 + axis] * weights[corner];
        const y = geometry.sampleHeight(xyz[0], xyz[2]);
        assert.ok(y !== null && Number.isFinite(y), `${label}: plant query remains attached`);
        assert.ok(Math.abs(y - xyz[1]) <= EPSILON, `${label}: plant query matches current stitched triangle at ${xyz}`);
        querySamples++;
      }
    }
  }
  assert.equal(area, input.width * input.height, `${label}: complete crop coverage`);
  assert.ok(seamSamples > 0, `${label}: seam checks exercised geometry`);
  assert.ok(querySamples > 0, `${label}: height queries exercised coastal patches`);
  return { seamSamples, querySamples };
}

test('local splits and merges retain land, animated water and height-query continuity after every commit', async () => {
  const input = await fixture();
  let live = input.buildSet(input.lod.decorate(input.lod.coarse(1, 4)));
  const coarse = input.lod.decorate(input.lod.coarse(1, 4));
  const fine = input.lod.decorate(input.lod.coarse(1, 1));
  const counts = { split: 0, merge: 0 }, samples = { seamSamples: 0, querySamples: 0 };
  const limits = { budget: 2 * 1024 * 1024, limit: 384 };
  try {
    audit(live, input, 'initial');
    for (const desired of [fine, coarse]) {
      for (let i = 0; i < 100; i++) {
        const transaction = input.planner.next(live, input.lod.decorate(desired), tile => 1 / (1 + tile.c0 ** 2 + tile.r0 ** 2), limits);
        if (!transaction) break;
        assert.equal(input.planner.isApplicable(transaction, live), true);
        assert.ok(transaction.tiles.length <= limits.limit);
        assert.ok(transaction.tiles.reduce((sum, tile) => sum + Math.ceil((tile.c1 - tile.c0) / tile.step) * Math.ceil((tile.r1 - tile.r0) / tile.step), 0) <= limits.budget);
        if (transaction.type === 'split') assert.ok(transaction.addedKeys.length <= 10, 'bounded local subtree');
        const next = input.buildSet(transaction.tiles, live);
        const result = audit(next, input, `${transaction.type} ${i}`);
        samples.seamSamples += result.seamSamples; samples.querySamples += result.querySamples;
        counts[transaction.type] = (counts[transaction.type] || 0) + 1;
        live = next;
        input.lod.commit(transaction.tiles);
        if (i === 99) assert.fail('geometry transactions did not converge');
      }
      assert.equal(input.planner.signature(live), input.planner.signature(input.lod.decorate(desired)));
    }
    assert.ok(counts.split >= 3 && counts.merge >= 3, 'several local splits and merges were checked');
    assert.ok(samples.seamSamples > 100 && samples.querySamples > 20);
    assert.ok(input.cacheStats.reused > 0, 'completed geometry is reused across frontiers');
    assert.equal(new Set([...input.cache.values()].map(item => item.geometry)).size, input.cache.size,
      'equivalent keys never duplicate resource ownership');
  } finally {
    for (const item of input.cache.values()) item.geometry.dispose();
    input.motion.dispose(); input.materials.top.dispose(); input.materials.cut.dispose();
  }
});


test('only coastal geometry without unresolved ownership or coarser context may ignore finer neighbors', async () => {
  const input = await fixture();
  const originals = [];
  try {
    const parents = input.lod.coarse(1, 4);
    const left = parents.find(tile => tile.c0 === 0 && tile.r0 === 0);
    const right = parents.find(tile => tile.c0 === left.c1 && tile.r0 === 0);
    const allLand = tile => new Uint16Array(tile.rows * tile.cols).fill(14000);
    const independent = input.runtime.NotoTileGeometry.build(input.THREE, input.tileset, left, allLand(left),
      [{ tile: left, heights: allLand(left) }, { tile: right, heights: allLand(right) }], input.oceanAt);
    originals.push(independent);
    assert.ok(independent.sampleHeight, 'fixture takes the coastal geometry branch');
    assert.equal(independent.coarseOnlyDependencies, true, 'resolved coastal geometry with no coarser context is independent');
    const leftDecorated = input.lod.decorate(parents).find(tile => tile.key === left.key);
    const originalKey = leftDecorated.cacheKey;
    const independentKey = input.lod.noteGeometry(leftDecorated, independent.coarseOnlyDependencies);
    assert.notEqual(independentKey, originalKey, 'proven-independent key omits equal-level neighbors');
    const splitRight = input.lod.decorate(parents.filter(tile => tile.key !== right.key).concat(input.lod.children(right)));
    const retainedLeft = splitRight.find(tile => tile.key === left.key);
    assert.equal(input.lod.geometryKey(retainedLeft), independentKey, 'finer neighbor changes do not rebuild this coarse coastal parent');
    const fine = input.lod.children(left).find(tile => tile.c1 === left.c1 && tile.r0 === 0);
    const dependent = input.runtime.NotoTileGeometry.build(input.THREE, input.tileset, fine, allLand(fine),
      [{ tile: fine, heights: allLand(fine) }, { tile: right, heights: allLand(right) }], input.oceanAt);
    originals.push(dependent);
    assert.ok(dependent.sampleHeight, 'fine fixture also takes the coastal branch');
    assert.equal(dependent.coarseOnlyDependencies, false, 'a coarser ownership/edge context must retain its dependency chain');
  } finally {
    for (const geometry of originals) geometry.dispose();
    input.motion.dispose(); input.materials.top.dispose(); input.materials.cut.dispose();
  }
});
