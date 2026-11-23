'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { before, test } = require('node:test');
const root = path.resolve(__dirname, '..');
let THREE, create;

before(async () => {
  const runtime = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), runtime);
  const packed = runtime.window.NOTO_LIBRARIES.core;
  const source = zlib.gunzipSync(Buffer.from(Array.isArray(packed) ? packed.join('') : packed, 'base64'));
  THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
  vm.runInContext(fs.readFileSync(path.join(root, 'src/first-person.js'), 'utf8'), runtime);
  create = runtime.window.NotoFirstPerson.create;
});

function fixture({ sampleLand = () => 10, distance = () => -1, waveHeight = () => 0 } = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(-6, 30, 35);
  const controls = { enabled: true, enableDamping: true, target: new THREE.Vector3(-6, 10, 0), update() {} };
  const view = create({
    THREE, camera, controls, canvas: { addEventListener() {} },
    metadata: { width_m: 100, height_m: 120, source_spacing_m: [1, 1] },
    sampleLand, shore: { distance }, water: { sample: () => [0, waveHeight(), 0] }, changed() {}
  });
  return { camera, controls, view };
}

function close(value, expected) {
  assert(Math.abs(value - expected) < 1e-9, `expected ${value} to be within 1e-9 of ${expected}`);
}

test('diagonal travel matches straight-line speed and follows the displayed slope', () => {
  const sampleLand = (x, z) => 20 + x / 2 - z / 4;
  const straight = fixture({ sampleLand }), diagonal = fixture({ sampleLand });
  for (const run of [straight, diagonal]) assert.equal(run.view.enter(), true);
  const start = straight.camera.position.clone();
  straight.view.move(new Set(['forward']), 0.5);
  diagonal.view.move(new Set(['forward', 'right']), 0.5);
  for (const { camera } of [straight, diagonal]) {
    const { x, y, z } = camera.position;
    close(Math.hypot(x - start.x, z - start.z), 12);
    close(y - sampleLand(x, z), 1.8);
  }
  assert(diagonal.camera.position.x > start.x && diagonal.camera.position.z < start.z);
});

test('travel crosses the shore, follows changing wave height at rest and restores the saved orbit', () => {
  let wave = -0.7;
  const { camera, controls, view } = fixture({
    sampleLand: x => x < 0 ? -x / 2 : null,
    distance: x => x,
    waveHeight: () => wave
  });
  const eye = camera.position.clone(), target = controls.target.clone();
  assert(view.enter());
  assert.equal(controls.enabled, false);
  close(camera.position.y, 3 + 1.8);
  view.move(new Set(['right']), 0.5);
  close(camera.position.x, 6);
  close(camera.position.y, wave + 1.8);
  const heading = controls.target.clone().sub(camera.position);
  wave = -2.4;
  view.followWaves();
  close(camera.position.x, 6);
  close(camera.position.z, 0);
  close(camera.position.y, wave + 1.8);
  close(controls.target.clone().sub(camera.position).distanceTo(heading), 0);
  view.move(new Set(['left']), 0.5);
  close(camera.position.y, 3 + 1.8);
  view.followWaves();
  close(camera.position.y, 3 + 1.8);
  view.exit();
  assert.equal(view.active, false);
  assert.equal(controls.enabled, true);
  assert.equal(controls.enableDamping, true);
  assert(camera.position.equals(eye) && controls.target.equals(target));
});

test('missing inland elevations block entry or movement and valid travel stays inside the dataset', () => {
  const missing = fixture({ sampleLand: () => null });
  const eye = missing.camera.position.clone(), target = missing.controls.target.clone();
  assert.equal(missing.view.enter(), false);
  assert(missing.camera.position.equals(eye) && missing.controls.target.equals(target));
  assert(!missing.view.active && missing.controls.enabled);

  const inland = fixture({ sampleLand: x => x < 0 ? 10 : null });
  assert(inland.view.enter());
  const before = inland.camera.position.clone();
  inland.view.move(new Set(['right']), 0.5);
  assert(inland.camera.position.equals(before));

  const edge = fixture();
  assert(edge.view.enter());
  edge.view.move(new Set(['right', 'back']), 10);
  close(edge.camera.position.x, 49.5);
  close(edge.camera.position.z, 59.5);
  edge.view.move(new Set(['left', 'forward']), 10);
  close(edge.camera.position.x, -49.5);
  close(edge.camera.position.z, -59.5);
});
