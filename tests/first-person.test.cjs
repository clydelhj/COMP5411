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

test('dashboard reports horizontal speed, projected position and the current scene conditions', () => {
  const fields = new Map();
  const document = {
    body: { classList: { toggle() {} } },
    querySelector(id) { const field = { textContent: '' }; fields.set(id, field); return field; }
  };
  const runtime = vm.createContext({ window: {}, document });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/first-person.js'), 'utf8'), runtime);
  const dashboard = runtime.window.NotoFirstPerson.createDashboard({ origin_easting: 1000, origin_northing: 2000 });
  const text = key => fields.get('#fp-' + key).textContent;
  dashboard.setConditions({ date: '2028-02-28', time: '23:59', weather: 'clear' });
  dashboard.show(true, { x: 0, y: 10, z: 0 }, 0);
  dashboard.updateMotion({ x: 3, y: 12, z: 4 }, 200);
  assert.equal(text('speed'), '90');
  assert.equal(text('position'), 'E 1,003 · N 1,996 m');
  dashboard.updateMotion({ x: 3, y: 13, z: 4 }, 220);
  assert.equal(text('speed'), '0');
  dashboard.setConditions({ date: '2028-02-29', time: '00:00', weather: 'rainy' });
  assert.deepEqual(['date', 'time', 'weather'].map(text), ['2028-02-29', '00:00', 'Rainy']);
});

test('left and right turn in place; aliases share a turn rate and opposite inputs cancel', () => {
  const { camera, controls, view } = fixture();
  assert(view.enter());
  const start = camera.position.clone();
  const yaw = () => Math.atan2(controls.target.x - camera.position.x, camera.position.z - controls.target.z);
  view.move(new Set(['left']), 0.25);
  close(yaw(), -0.25);
  view.move(new Set(['right', 'turnRight']), 0.5);
  close(yaw(), 0.25);
  view.move(new Set(['left', 'turnRight']), 0.5);
  close(yaw(), 0.25);
  view.move(new Set(['turnLeft']), 0.25);
  close(yaw(), 0);
  assert(camera.position.equals(start));
});

test('steering while driving curves the path and follows the displayed slope', () => {
  const sampleLand = (x, z) => 20 + x / 2 - z / 4;
  const { camera, view } = fixture({ sampleLand });
  assert(view.enter());
  let previousBearing = -Infinity;
  for (let frame = 0; frame < 10; frame++) {
    const { x, z } = camera.position;
    view.move(new Set(['forward', 'right']), 0.05);
    const dx = camera.position.x - x, dz = camera.position.z - z;
    const bearing = Math.atan2(dx, -dz);
    assert(dz < 0 && bearing > previousBearing, 'successive steps turn right');
    assert(Math.abs(Math.hypot(dx, dz) - 24 * 0.05) < 0.001);
    close(camera.position.y - sampleLand(camera.position.x, camera.position.z), 1.8);
    previousBearing = bearing;
  }
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
  view.move(new Set(['right']), Math.PI / 2);
  view.move(new Set(['forward']), 0.5);
  close(camera.position.x, 6);
  close(camera.position.y, wave + 1.8);
  const heading = controls.target.clone().sub(camera.position);
  wave = -2.4;
  view.followWaves();
  close(camera.position.x, 6);
  close(camera.position.z, 0);
  close(camera.position.y, wave + 1.8);
  close(controls.target.clone().sub(camera.position).distanceTo(heading), 0);
  view.move(new Set(['back']), 0.5);
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
  inland.view.move(new Set(['right']), Math.PI / 2);
  inland.view.move(new Set(['forward']), 0.5);
  assert(inland.camera.position.equals(before));

  const edge = fixture();
  assert(edge.view.enter());
  edge.view.move(new Set(['right']), 3 * Math.PI / 4);
  edge.view.move(new Set(['forward']), 10);
  close(edge.camera.position.x, 49.5);
  close(edge.camera.position.z, 59.5);
  edge.view.move(new Set(['back']), 10);
  close(edge.camera.position.x, -49.5);
  close(edge.camera.position.z, -59.5);
});
