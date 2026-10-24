'use strict';

// Run with a modern Node.js runtime: node --test tests/geometry-worker.test.cjs.
// All terrain fixtures are generated below; no project DEM or asset download is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { Worker: ThreadWorker } = require('node:worker_threads');
const { test, before } = require('node:test');

const root = path.resolve(__dirname, '..');
let THREE;
let coreURL;
let coreSource;

/* Adapt browser Blob Workers to real Node worker threads, preserving asynchronous
 * messages and transfer lists. This tests serialization rather than a fake inline worker. */
class BlobWorker {
  constructor(url) {
    this.pending = [];
    this.listeners = new Map();
    this.terminated = false;
    fetch(url).then(response => response.text()).then(source => {
      if (this.terminated) return;
      const bootstrap = `
        const { parentPort, workerData } = require('node:worker_threads');
        globalThis.self = globalThis;
        const pending = [];
        let receive = null;
        function setReceive(handler) {
          receive = handler;
          if (handler) for (const data of pending.splice(0)) handler({ data });
        }
        Object.defineProperty(globalThis, 'onmessage', { set: setReceive, get: () => receive });
        globalThis.addEventListener = (type, handler) => {
          if (type === 'message') setReceive(handler);
        };
        globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
        parentPort.on('message', data => {
          if (receive) receive({ data }); else pending.push(data);
        });
        import('data:text/javascript;base64,' + Buffer.from(workerData).toString('base64'))
          .catch(error => { setImmediate(() => { throw error; }); });
      `;
      this.thread = new ThreadWorker(bootstrap, { eval: true, workerData: source });
      this.thread.on('message', data => this.emit('message', { data }));
      this.thread.on('error', error => this.emit('error', {
        message: error.message, error, preventDefault() {}
      }));
      for (const [data, transfer] of this.pending.splice(0)) this.thread.postMessage(data, transfer);
    }).catch(error => this.emit('error', { message: error.message, error, preventDefault() {} }));
  }

  emit(type, event) {
    this[`on${type}`]?.(event);
    for (const handler of this.listeners.get(type) || []) handler(event);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  postMessage(data, transfer) {
    if (this.thread) this.thread.postMessage(data, transfer);
    else this.pending.push([data, transfer]);
  }

  terminate() {
    this.terminated = true;
    this.thread?.terminate();
  }
}

function loadRuntime(Worker = BlobWorker) {
  const context = vm.createContext({
    console, Blob, Response, URL, DecompressionStream, TextDecoder,
    atob, btoa, setTimeout, clearTimeout, Worker,
    performance, Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array,
    Float64Array, ArrayBuffer
  });
  context.window = context;
  context.self = context;
  for (const file of ['model-volume.js', 'coastal-geometry.js', 'tile-geometry.js', 'geometry-worker.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
  }
  return context;
}

function descriptor(key, c0, c1, r0, r1, step = 8, level = 0) {
  return {
    key, c0, c1, r0, r1, step, level, virtual: true,
    rows: Math.ceil((r1 - r0) / step) + 1,
    cols: Math.ceil((c1 - c0) / step) + 1
  };
}

function heightsFor(tile, height) {
  return Uint16Array.from({ length: tile.rows * tile.cols }, (_, index) => {
    const row = Math.min(tile.r1, tile.r0 + Math.floor(index / tile.cols) * tile.step);
    const col = Math.min(tile.c1, tile.c0 + index % tile.cols * tile.step);
    const value = height(col, row);
    return value === null ? 65535 : Math.round((value + 100) * 100);
  });
}

function fixture(width = 128, height = 64, ocean = () => false) {
  const cols = Math.floor(width / 8) + 1;
  const rows = Math.floor(height / 8) + 1;
  const oceanBits = new Uint8Array(Math.ceil(rows * cols / 8));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (ocean(c * 8, r * 8)) oceanBits[(r * cols + c) >> 3] |= 1 << ((r * cols + c) & 7);
  }
  const tileset = {
    metadata: {
      source_spacing_m: [1, 1], width_m: width, height_m: height,
      source_width: width + 1, source_height: height + 1
    },
    oceanMask: { cols, rows, step: 8 }
  };
  const oceanAt = (r, c) => {
    r = Math.max(0, Math.min(rows - 1, Math.floor(r / 8)));
    c = Math.max(0, Math.min(cols - 1, Math.floor(c / 8)));
    const index = r * cols + c;
    return Boolean(oceanBits[index >> 3] >> (index & 7) & 1);
  };
  return { tileset, oceanBits, oceanAt };
}

function coastlineSource(constantDistance = null) {
  const cols = 16, rows = 8, cellM = 8, widthM = 128, heightM = 64;
  const distances = new Uint16Array(cols * rows);
  const heights = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) * cellM - widthM / 2;
    const z = (r + 0.5) * cellM - heightM / 2;
    distances[r * cols + c] = Math.round(32768 + (constantDistance ?? x + Math.sin(z / 16) * 3) * 8);
    heights[r * cols + c] = Math.round((120 + x * 0.06 + z * 0.03) * 100);
  }
  const encode = values => zlib.gzipSync(Buffer.from(values.buffer)).toString('base64');
  return {
    cols, rows, cellM, widthM, heightM,
    distances: encode(distances), coastalHeights: encode(heights)
  };
}

function compareArray(actual, expected, label) {
  assert.equal(actual?.constructor.name, expected?.constructor.name, `${label} typed array`);
  assert.deepEqual(Array.from(actual || []), Array.from(expected || []), label);
}

function compareGeometry(actual, expected) {
  assert.equal(Boolean(actual.coarseOnlyDependencies), Boolean(expected.coarseOnlyDependencies), 'coastal dependency qualification survives transfer');
  assert.deepEqual(JSON.parse(JSON.stringify(actual.metadata)), JSON.parse(JSON.stringify(expected.metadata)));
  for (const key of ['heights', 'landCells', 'shoreQueryRanges', 'coastSegments']) {
    compareArray(actual[key], expected[key], key);
  }
  for (const kind of ['land', 'water']) for (const part of ['top', 'walls', 'bottom']) {
    const a = actual[kind]?.[part], b = expected[kind]?.[part];
    assert.equal(Boolean(a), Boolean(b), `${kind}.${part} presence`);
    if (!b) continue;
    assert.ok(a instanceof THREE.BufferGeometry, `${kind}.${part} hydrates a BufferGeometry`);
    assert.deepEqual(Object.keys(a.attributes).sort(), Object.keys(b.attributes).sort());
    for (const attribute of Object.keys(b.attributes)) {
      compareArray(a.attributes[attribute].array, b.attributes[attribute].array, `${kind}.${part}.${attribute}`);
      assert.equal(a.attributes[attribute].itemSize, b.attributes[attribute].itemSize);
    }
    compareArray(a.index?.array, b.index?.array, `${kind}.${part}.index`);
    assert.ok(a.boundingSphere, `${kind}.${part} bounds survive hydration`);
  }
}

async function createWorker(runtime, input, extras = {}) {
  const shoreline = extras.shoreline || coastlineSource(-500);
  const coastalField = extras.coastalField || await runtime.NotoCoastalGeometry.prepare(shoreline);
  const client = await runtime.NotoGeometryWorker.create({
    THREE, coreURL, tileset: input.tileset, oceanBits: input.oceanBits,
    shoreline, coastalField, ...extras
  });
  assert.equal(client.getState().mode, 'worker', 'fixtures must exercise a dedicated worker, not fallback');
  return client;
}

before(async () => {
  const payloadContext = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor', 'three-libraries.js'), 'utf8'), payloadContext);
  const payload = payloadContext.window.NOTO_LIBRARIES.core;
  const compressed = Buffer.from(Array.isArray(payload) ? payload.join('') : payload, 'base64');
  const decoded = zlib.gunzipSync(compressed);
  coreSource = decoded.toString('utf8');
  coreURL = `data:text/javascript;base64,${decoded.toString('base64')}`;
  THREE = await import(coreURL);
});

test('worker geometry preserves regular land, internal NoData and ocean ownership', async t => {
  const runtime = loadRuntime();
  for (const type of ['land', 'hole', 'ocean']) await t.test(type, async () => {
    const input = fixture(128, 64, () => type === 'ocean');
    const tile = descriptor(type, 0, 128, 0, 64, 8);
    const raw = heightsFor(tile, (c, r) => type === 'ocean' || type === 'hole' && c === 64 && r === 32 ? null : 30 + c * 0.07 + r * 0.03);
    const snapshot = raw.slice();
    const expected = runtime.NotoTileGeometry.build(THREE, input.tileset, tile, raw, [], input.oceanAt);
    const client = await createWorker(runtime, input);
    assert.ok(client, 'real worker initialized');
    t.after(() => client.dispose());
    const actual = await client.build(tile, raw, [], []);
    compareGeometry(actual, expected);
    compareArray(raw, snapshot, 'caller height array remains owned and unchanged');
    assert.equal(raw.byteLength, snapshot.byteLength);
    actual.dispose();
    expected.dispose();
  });
});

test('continuous coastal topology and displayed height queries survive the worker boundary', async t => {
  const runtime = loadRuntime();
  const input = fixture(128, 64, c => c >= 64);
  const source = coastlineSource();
  const field = await runtime.NotoCoastalGeometry.prepare(source);
  input.oceanAt.coast = field;
  const tile = descriptor('coastal', 0, 128, 0, 64, 16);
  const raw = heightsFor(tile, (c, r) => c > 64 ? null : 20 + c * 0.06 + r * 0.03);
  const expected = runtime.NotoTileGeometry.build(THREE, input.tileset, tile, raw, [], input.oceanAt);
  const client = await createWorker(runtime, input, { shoreline: source, coastalField: field });
  assert.ok(client);
  t.after(() => client.dispose());
  const actual = await client.build(tile, raw, [], []);
  compareGeometry(actual, expected);
  assert.equal(typeof actual.sampleHeight, 'function', 'displayed triangle sampler is available after hydration');
  for (const conservative of [false, true]) for (let x = -55; x <= 55; x += 5) {
    for (let z = -25; z <= 25; z += 5) {
      assert.equal(actual.sampleHeight(x, z, conservative), expected.sampleHeight(x, z, conservative), `height at ${x},${z}, conservative=${conservative}`);
    }
  }
  actual.dispose();
  expected.dispose();
});

test('worker imports supplied core source without depending on a main-realm Blob URL', async t => {
  const runtime = loadRuntime();
  const input = fixture();
  // An inaccessible URL models the opaque-origin Blob URL used by file:// pages.
  const client = await createWorker(runtime, input, {
    coreSource, coreURL: 'blob:null/unavailable-main-realm-module'
  });
  t.after(() => client.dispose());
  const tile = descriptor('source-import', 0, 128, 0, 64, 16);
  const raw = heightsFor(tile, (c, r) => 25 + c * 0.05 + r * 0.02);
  const actual = await client.build(tile, raw, [], []);
  const expected = runtime.NotoTileGeometry.build(THREE, input.tileset, tile, raw, [], input.oceanAt);
  compareGeometry(actual, expected);
  assert.equal(client.getState().mode, 'worker');
  actual.dispose();
  expected.dispose();
});

test('mixed LOD water keeps coarse-endpoint displacement attributes', async t => {
  const runtime = loadRuntime();
  const input = fixture(128, 64, () => true);
  const coarse = descriptor('coarse-water', 0, 64, 0, 64, 16, 1);
  const fine = descriptor('fine-water', 64, 128, 0, 64, 8, 0);
  const coarseRaw = heightsFor(coarse, () => null);
  const fineRaw = heightsFor(fine, () => null);
  const coarseDirect = runtime.NotoTileGeometry.build(THREE, input.tileset, coarse, coarseRaw, [], input.oceanAt);
  const expected = runtime.NotoTileGeometry.build(THREE, input.tileset, fine, fineRaw, [{ tile: coarse, heights: coarseRaw }], input.oceanAt);
  runtime.NotoTileGeometry.conformEdges(THREE, fine, expected, [{ tile: coarse, geometry: coarseDirect }], input.tileset.metadata, 'land');
  runtime.NotoTileGeometry.conformEdges(THREE, fine, expected, [{ tile: coarse, geometry: coarseDirect }], input.tileset.metadata, 'water');
  const client = await createWorker(runtime, input);
  assert.ok(client);
  t.after(() => client.dispose());
  const coarseWorker = await client.build(coarse, coarseRaw, [], []);
  const snapshot = coarseWorker.water.top.attributes.position.array.slice();
  const actual = await client.build(fine, fineRaw, [{ tile: coarse, heights: coarseRaw }], [{ tile: coarse, geometry: coarseWorker }]);
  compareGeometry(actual, expected);
  const edges = actual.water?.top?.attributes.notoSeaEdge;
  assert.ok(edges?.array.length > 0, 'animated seam attributes exist');
  assert.ok(edges.array.some(value => value !== 0), 'seam attributes include coarse endpoints');
  compareArray(coarseWorker.water.top.attributes.position.array, snapshot, 'coarse geometry is not detached');
  for (const geometry of [coarseDirect, expected, coarseWorker, actual]) geometry.dispose();
});

test('worker normal synchronization matches direct geometry and is repeatable', async t => {
  const runtime = loadRuntime();
  const input = fixture();
  const tiles = [descriptor('left', 0, 64, 0, 64, 8), descriptor('right', 64, 128, 0, 64, 8)];
  const raws = tiles.map(tile => heightsFor(tile, (c, r) => 20 + (c - 64) ** 2 / 150 + r * 0.03));
  const expected = tiles.map((tile, index) => runtime.NotoTileGeometry.build(THREE, input.tileset, tile, raws[index], [], input.oceanAt));
  runtime.NotoTileGeometry.synchronizeNormals(expected);
  const client = await createWorker(runtime, input);
  assert.ok(client);
  t.after(() => client.dispose());
  const actual = [];
  for (let i = 0; i < tiles.length; i++) actual.push(await client.build(tiles[i], raws[i], [], []));
  const items = actual.map((geometry, index) => ({ tile: tiles[index], geometry }));
  const originalNormals = actual.map(geometry => geometry.land.top.attributes.normal.array.slice());
  assert.equal(await client.synchronizeNormals(items, () => false), false, 'obsolete selections do not commit normals');
  actual.forEach((geometry, index) => compareArray(geometry.land.top.attributes.normal.array, originalNormals[index], 'discarded normal update'));
  await client.synchronizeNormals(items);
  for (let i = 0; i < tiles.length; i++) compareGeometry(actual[i], expected[i]);
  const snapshots = actual.map(geometry => geometry.land.top.attributes.normal.array.slice());
  await client.synchronizeNormals(items);
  actual.forEach((geometry, index) => compareArray(geometry.land.top.attributes.normal.array, snapshots[index], 'stable repeated normals'));
  for (const geometry of [...expected, ...actual]) geometry.dispose();
});

test('coastal mixed LOD preserves remapped triangle queries and compact coarse edges', async t => {
  const runtime = loadRuntime();
  const input = fixture(128, 64, c => c >= 64);
  const source = coastlineSource();
  const field = await runtime.NotoCoastalGeometry.prepare(source);
  input.oceanAt.coast = field;
  const coarse = descriptor('north', 0, 128, 0, 32, 16, 1);
  const fine = descriptor('south', 0, 128, 32, 64, 8, 0);
  const surface = (c, r) => c > 64 ? null : 20 + c * 0.06 + r * 0.03;
  const coarseRaw = heightsFor(coarse, surface), fineRaw = heightsFor(fine, surface);
  const expectedCoarse = runtime.NotoTileGeometry.build(THREE, input.tileset, coarse, coarseRaw, [], input.oceanAt);
  const neighbors = [{ tile: coarse, heights: coarseRaw }];
  const expected = runtime.NotoTileGeometry.build(THREE, input.tileset, fine, fineRaw, neighbors, input.oceanAt);
  for (const kind of ['land', 'water']) {
    runtime.NotoTileGeometry.conformEdges(THREE, fine, expected, [{ tile: coarse, geometry: expectedCoarse }], input.tileset.metadata, kind);
  }
  const client = await createWorker(runtime, input, { shoreline: source, coastalField: field });
  t.after(() => client.dispose());
  const actualCoarse = await client.build(coarse, coarseRaw, [], []);
  const actual = await client.build(fine, fineRaw, neighbors, [{ tile: coarse, geometry: actualCoarse }]);
  compareGeometry(actual, expected);
  for (const kind of ['land', 'water']) {
    const compact = actualCoarse.edgeGeometry[kind]?.top;
    assert.ok(compact?.index.array.length, `${kind} coarse edge packet exists`);
    assert.ok(compact.attributes.position.array.length < actualCoarse[kind].top.attributes.position.array.length, `${kind} edge packet excludes interior geometry`);
  }
  for (const conservative of [false, true]) for (let x = -55; x <= 15; x += 5) {
    for (const z of [0, 0.001, 3, 15, 30]) {
      assert.equal(actual.sampleHeight(x, z, conservative), expected.sampleHeight(x, z, conservative), 'query after seam topology insertion');
    }
  }
  for (const geometry of [expectedCoarse, expected, actualCoarse, actual]) geometry.dispose();
});

test('blocked worker initialization uses compatible construction and disposal rejects new builds', async () => {
  class BlockedWorker {
    constructor() { throw new Error('Synthetic worker policy rejection'); }
  }
  const runtime = loadRuntime(BlockedWorker);
  const input = fixture();
  const source = coastlineSource(-500);
  const field = await runtime.NotoCoastalGeometry.prepare(source);
  const client = await runtime.NotoGeometryWorker.create({
    THREE, coreURL, tileset: input.tileset, oceanBits: input.oceanBits,
    shoreline: source, coastalField: field
  });
  assert.equal(client.getState().mode, 'main-thread-fallback');
  assert.match(client.getState().fallbackReason, /Synthetic worker policy rejection/);
  const tile = descriptor('fallback', 0, 128, 0, 64, 16);
  const raw = heightsFor(tile, (c, r) => 30 + c * 0.07 + r * 0.03);
  const actual = await client.build(tile, raw, [], []);
  const expected = runtime.NotoTileGeometry.build(THREE, input.tileset, tile, raw, [], input.oceanAt);
  compareGeometry(actual, expected);
  assert.equal(await client.synchronizeNormals([{ tile, geometry: actual }]), true);
  client.dispose();
  await assert.rejects(client.build(tile, raw, [], []), /disposed/);
  actual.dispose();
  expected.dispose();
});
