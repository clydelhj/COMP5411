'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), zlib = require('node:zlib');
const { test, before } = require('node:test');
const root = path.resolve(__dirname, '..');
let THREE, create;
before(async () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), context);
  const source = zlib.gunzipSync(Buffer.from(context.window.NOTO_LIBRARIES.core, 'base64'));
  THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/terrain-upload-queue.js'), 'utf8'), context);
  create = context.window.NotoTerrainUploadQueue.create;
});

function harness(options = {}) {
  let clock = 0, hidden = false, lost = false;
  const callbacks = [], calls = [];
  const state = { target: {}, face: 2, mip: 3, viewport: new THREE.Vector4(7, 8, 500, 400),
    scissor: new THREE.Vector4(1, 2, 50, 40), scissorTest: true };
  const renderer = {
    autoClear: true, shadowMap: { autoUpdate: true, needsUpdate: true },
    getContext: () => ({ isContextLost: () => lost }),
    getRenderTarget: () => state.target, getActiveCubeFace: () => state.face, getActiveMipmapLevel: () => state.mip,
    getViewport: value => value.copy(state.viewport), getScissor: value => value.copy(state.scissor), getScissorTest: () => state.scissorTest,
    setRenderTarget(target, face = 0, mip = 0) {
      state.target = target; state.face = face; state.mip = mip;
      if (target?.viewport) state.viewport = target.viewport.clone();
    },
    setViewport(value) {
      assert.ok(value?.isVector4, 'target viewport comes from setRenderTarget, not a DPR-scaled 1px override');
      state.viewport = value.clone();
    },
    setScissor: value => { state.scissor = value.clone(); }, setScissorTest: value => { state.scissorTest = value; },
    compileAsync: async () => {},
    initTexture(texture) { calls.push(texture); clock += 2; },
    render(scene) {
      const geometry = scene.children[0].geometry;
      assert.equal(geometry.drawRange.count, 3);
      assert.equal(renderer.shadowMap.needsUpdate, false);
      calls.push(geometry); clock += 2;
      if (options.fail) throw new Error('driver failure');
    }
  };
  const snapshot = () => ({ ...state, viewport: state.viewport.toArray(), scissor: state.scissor.toArray(),
    autoClear: renderer.autoClear, shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate });
  const queue = create({ THREE, renderer, camera: new THREE.PerspectiveCamera(), schedule: callback => callbacks.push(callback),
    now: () => clock, paused: () => hidden });
  return { queue, callbacks, calls, snapshot, setHidden: value => { hidden = value; }, loseContext: () => { lost = true; } };
}

test('preparation splits bounded upload batches, restores draw ranges and all renderer state', async () => {
  const h = harness(), initial = h.snapshot(), owner = {};
  await h.queue.warmup(); assert.deepEqual(h.snapshot(), initial);
  const a = new THREE.BoxGeometry(), b = new THREE.PlaneGeometry(), texture = new THREE.DataTexture();
  a.setDrawRange(3, 12);
  let disposals = 0; a.addEventListener('dispose', () => disposals++);
  const ready = h.queue.prepare(owner, [texture, a, b]);
  assert.equal(h.calls.length, 0, 'queueing does not block Worker construction');
  assert.equal(h.callbacks.length, 1);
  h.callbacks.shift()();
  assert.equal(h.calls.length, 2, 'the 4ms task budget stops this batch');
  assert.equal(h.queue.getState().pending, 1);
  assert.deepEqual(a.drawRange, { start: 3, count: 12 });
  assert.deepEqual(h.snapshot(), initial);
  h.callbacks.shift()();
  assert.equal(await ready, true);
  assert.equal(h.queue.getState().batches, 2);
  assert.equal(h.queue.getState().pending, 0);
  h.queue.dispose();
  assert.equal(disposals, 0, 'the queue never disposes shared terrain geometry');
});

test('eviction cancels queued ownership; hidden work pauses and context loss settles pending promises', async () => {
  const h = harness(), owner = {}, geometry = new THREE.BoxGeometry();
  const cancelled = h.queue.prepare(owner, [geometry]);
  h.queue.cancel(owner); h.callbacks.shift()();
  assert.equal(await cancelled, false); assert.equal(h.calls.length, 0);
  h.setHidden(true);
  const ready = h.queue.prepare({}, [geometry]);
  assert.equal(h.callbacks.length, 0);
  h.setHidden(false); h.queue.resume();
  h.loseContext(); h.callbacks.shift()();
  assert.equal(await ready, false); assert.equal(h.calls.length, 0);
  assert.equal(h.queue.getState().pending, 0);
  assert.match(h.queue.getState().error, /context was lost/);
});

test('normal version changes are prepared once and failures restore geometry and renderer state', async () => {
  const h = harness(), owner = {}, geometry = new THREE.BoxGeometry();
  const ready = h.queue.prepare(owner, [geometry]);
  geometry.attributes.normal.needsUpdate = true;
  h.callbacks.shift()(); await ready;
  await h.queue.prepare(owner, [geometry]);
  assert.equal(h.callbacks.length, 0, 'version at actual upload includes queued seam changes');
  geometry.attributes.normal.needsUpdate = true;
  const updated = h.queue.prepare(owner, [geometry]);
  h.callbacks.shift()(); await updated;
  assert.equal(h.calls.length, 2);
  const failure = harness({ fail: true }), original = failure.snapshot();
  const failed = failure.queue.prepare({}, [geometry]);
  failure.callbacks.shift()();
  assert.equal(await failed, false);
  assert.deepEqual(failure.snapshot(), original);
  assert.equal(geometry.drawRange.count, Infinity);
  assert.equal(failure.queue.getState().pending, 0);
});
