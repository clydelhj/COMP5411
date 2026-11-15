'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/terrain.js'), 'utf8');
const start = source.indexOf('    async function prepareShaderPrograms(object) {');
const end = source.indexOf('    const refinementState', start);
assert.ok(start >= 0 && end > start, 'shader preparation entry point exists');

function harness({ parallel = true, initialized = false, compile } = {}) {
  let lost = false;
  const original = { target: {}, face: 3, mip: 2, viewport: [3, 4, 500, 400], scissor: [5, 6, 50, 40], scissorTest: true };
  const state = { ...original }, calls = [];
  const renderer = {
    getRenderTarget: () => state.target,
    getActiveCubeFace: () => state.face,
    getActiveMipmapLevel: () => state.mip,
    getViewport: target => Object.assign(target, { value: state.viewport }),
    getScissor: target => Object.assign(target, { value: state.scissor }),
    getScissorTest: () => state.scissorTest,
    setRenderTarget(target, face = 0, mip = 0) { state.target = target; state.face = face; state.mip = mip; },
    setViewport: value => { state.viewport = value.value; },
    setScissor: value => { state.scissor = value.value; },
    setScissorTest: value => { state.scissorTest = value; },
    compileAsync(object, camera, scene) {
      calls.push({ object, camera, scene, target: state.target });
      return compile?.(calls.length) ?? Promise.resolve();
    }
  };
  const context = {
    initialized, renderer, graphicsContext: { isContextLost: () => lost },
    shaderWarmup: { completed: 0, pending: 0, lastMs: 0, parallel },
    shaderWarmupTarget: {}, camera: {}, scene: {},
    THREE: { Vector4: class Vector4 {} }, performance: { now: () => 1 }
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.prepare = prepareShaderPrograms;', context);
  return { context, original, state, calls, loseContext: () => { lost = true; } };
}

test('async preparation restores active rendering state before waiting and prepares both output variants', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ compile: index => index === 1 ? pending : Promise.resolve() });
  const object = {};
  const result = h.context.prepare(object);
  assert.deepEqual(h.state, h.original, 'another frame can render while compilation is pending');
  assert.equal(h.context.shaderWarmup.pending, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].target, null);
  release(); await result;
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].target, h.context.shaderWarmupTarget);
  assert.ok(h.calls.every(call => call.object === object && call.scene === h.context.scene));
  assert.deepEqual(h.state, h.original);
  assert.equal(h.context.shaderWarmup.completed, 1);
  assert.equal(h.context.shaderWarmup.pending, 0);
});

test('shader rejection and context loss restore state and leave no pending preparation', async () => {
  const rejected = harness({ compile: () => { throw new Error('compile failure'); } });
  await assert.rejects(rejected.context.prepare({}), /compile failure/);
  assert.deepEqual(rejected.state, rejected.original);
  assert.equal(rejected.context.shaderWarmup.pending, 0);
  assert.equal(rejected.context.shaderWarmup.completed, 0);
  const lost = harness(); lost.loseContext();
  await assert.rejects(lost.context.prepare({}), /context was lost/);
  assert.equal(lost.calls.length, 0);
  assert.equal(lost.context.shaderWarmup.pending, 0);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const duringWait = harness({ compile: () => pending });
  const result = duringWait.context.prepare({});
  duringWait.loseContext(); release();
  await assert.rejects(result, /context was lost/);
  assert.equal(duringWait.calls.length, 1, 'no new preparation is started after context loss');
  assert.equal(duringWait.context.shaderWarmup.pending, 0);
});

test('unsupported parallel compilation warms loading variants but does not add per-patch navigation waits', async () => {
  const loading = harness({ parallel: false });
  await loading.context.prepare({});
  assert.equal(loading.calls.length, 2);
  const ready = harness({ parallel: false, initialized: true });
  await ready.context.prepare({});
  assert.equal(ready.calls.length, 0);
  assert.equal(ready.context.shaderWarmup.pending, 0);
});

function itemHarness(prepareShaderPrograms) {
  const created = [];
  const context = {
    geometryCache: new Map(), buildTasks: new Map(), buildingRaw: new Map(), rawCache: new Map(),
    geometryBytes: 0, lastBuildAt: 0, quality: { buildMs: 0 },
    cacheStats: { geometryHits: 0, built: 0 }, performance: { now: () => 1 },
    spatialLOD: { geometryKey: tile => tile.key, noteGeometry: () => 'shared' },
    neighborsFor: tile => [tile], loadRaw: async () => {}, geometryTile: tile => tile,
    geometryBuilder: { build: async () => {
      const result = { land: {}, heights: [], metadata: {}, geometryDisposals: 0, materialDisposals: 0,
        dispose() { this.geometryDisposals++; } };
      created.push(result); return result;
    } },
    materialFactory: { createTile: async heights => {
      const geometry = created.find(item => item.heights === heights);
      return { dispose() { geometry.materialDisposals++; } };
    } },
    meshGroup: () => ({}), estimateBytes: () => 100, prepareShaderPrograms, prepareItemUploads: () => Promise.resolve(true)
  };
  const itemStart = source.indexOf('    async function getItem(');
  const itemEnd = source.indexOf('    async function showSet(', itemStart);
  assert.ok(itemStart >= 0 && itemEnd > itemStart);
  vm.runInNewContext(source.slice(itemStart, itemEnd) + '\nthis.getItem = getItem;', context);
  return { context, created };
}

test('concurrent shader waits retain one cache owner for equivalent seam variants', async () => {
  let entered = 0, notifyEntered, release;
  const bothEntered = new Promise(resolve => { notifyEntered = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  const h = itemHarness(async () => { if (++entered === 2) notifyEntered(); await ready; });
  const first = h.context.getItem({ virtual: true, key: 'seam-a' });
  const second = h.context.getItem({ virtual: true, key: 'seam-b' });
  await bothEntered; release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
  assert.equal(h.context.geometryCache.size, 1);
  assert.equal(h.context.geometryBytes, 100);
  assert.equal(h.context.cacheStats.built, 1);
  assert.equal(h.context.cacheStats.geometryHits, 1);
  assert.equal(h.created.reduce((sum, item) => sum + item.geometryDisposals, 0), 1);
  assert.equal(h.created.reduce((sum, item) => sum + item.materialDisposals, 0), 1);
  assert.equal(h.context.buildTasks.size, 0);
  assert.equal(h.context.buildingRaw.size, 0);
});

test('failed shader preparation disposes uncommitted geometry and material ownership', async () => {
  const h = itemHarness(async () => { throw new Error('link failed'); });
  await assert.rejects(h.context.getItem({ virtual: true, key: 'failed' }), /link failed/);
  assert.equal(h.context.geometryCache.size, 0);
  assert.equal(h.context.geometryBytes, 0);
  assert.equal(h.created[0].geometryDisposals, 1);
  assert.equal(h.created[0].materialDisposals, 1);
  assert.equal(h.context.buildTasks.size, 0);
  assert.equal(h.context.buildingRaw.size, 0);
});

test('a complete old cover remains published until all replacement uploads are ready', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const previous = { tile: { key: 'old', level: 0 }, group: {} };
  const replacement = { tile: { key: 'new', level: 0 }, group: {} };
  const changes = [];
  const context = {
    live: new Map([['old', previous]]), residentMaps: new Map(),
    geometryBuilder: { synchronizeNormals: async () => true }, prepareItemUploads: () => ready,
    terrainUploads: { getState: () => ({}) }, terrain: { scale: { y: 1 }, remove: group => changes.push(['remove', group]), add: group => changes.push(['add', group]) },
    temporal: { invalidate() {} }, waterMotion: { setView() {} }, displayLevels: [{ step: 1 }], minimumLevel: 0, nativeSpacing: 1,
    environment: { markDirty() {} }, vegetation: null, initialized: false,
    resolutionSelect: {}, windowResolutionSelect: {}, vegetationDetailSelect: {}, grassVisibilityCheckbox: {}, treeVisibilityCheckbox: {},
    idleSleepSelect: {}, temporalCheckbox: {}, flashlight: { ready() {} }, zoomButtons: [], status: {}, requestRender() {}
  };
  const showStart = source.indexOf('    async function showSet(');
  const showEnd = source.indexOf('    function disposeItem(', showStart);
  vm.runInNewContext(source.slice(showStart, showEnd) + '\nthis.show = showSet;', context);
  const result = context.show(new Map([['new', replacement]]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes.length, 0);
  assert.equal(context.live.get('old'), previous);
  release(true);
  assert.equal(await result, true);
  assert.deepEqual(changes.map(change => change[0]), ['remove', 'add']);
  assert.equal(context.live.get('new'), replacement);
});
