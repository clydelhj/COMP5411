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

function fixture({ sampleLand = () => 10, distance = () => -1, waveHeight = () => 0,
  verticalScale = () => 1, width = 10000, depth = 10000 } = {}) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(-6, 30, 35);
  const controls = { enabled: true, enableDamping: true, target: new THREE.Vector3(-6, 10, 0), update() {} };
  const view = create({
    THREE, camera, controls, canvas: { addEventListener() {} },
    metadata: { width_m: width, height_m: depth, source_spacing_m: [1, 1] },
    sampleLand, verticalScale, shore: { distance }, water: { sample: () => [0, waveHeight(), 0] }, changed() {}
  });
  return { camera, controls, view };
}

function close(value, expected) {
  assert(Math.abs(value - expected) < 1e-9, `expected ${value} to be within 1e-9 of ${expected}`);
}

function drive(view, actions, seconds) {
  const keys = new Set(actions);
  for (let i = 0; i < Math.round(seconds * 50); i++) view.move(keys, 0.02);
}

test('dashboard dials track vehicle speed and heading alongside position and scene conditions', () => {
  const fields = new Map();
  const angles = new Map();
  const document = {
    body: { classList: { toggle() {} } },
    querySelector(id) {
      const field = { textContent: '', style: { setProperty: (name, value) => angles.set(name, value) } };
      fields.set(id, field);
      return field;
    }
  };
  const runtime = vm.createContext({ window: {}, document });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/first-person.js'), 'utf8'), runtime);
  const dashboard = runtime.window.NotoFirstPerson.createDashboard({ origin_easting: 1000, origin_northing: 2000 });
  const text = key => fields.get('#fp-' + key).textContent;
  dashboard.setConditions({ date: '2028-02-28', time: '23:59', weather: 'clear' });
  dashboard.show(true, { x: 0, y: 10, z: 0 }, 0);
  dashboard.updateMotion({ x: 3, y: 12, z: 4 }, 25, 90);
  assert.equal(text('speed'), '90');
  assert.equal(angles.get('--speed-angle'), '16.9deg');
  assert.equal(text('position'), 'E 1,003 m\nN 1,996 m');
  assert.equal(text('heading'), '090° E');
  dashboard.updateMotion({ x: 3, y: 13, z: 4 }, 0, -45);
  assert.equal(text('speed'), '0');
  assert.equal(text('heading'), '315° NW');
  assert.equal(angles.get('--heading-angle'), '315deg');
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
  const sampleLand = (x, z) => 20 + x / 8 - z / 16;
  const { camera, view } = fixture({ sampleLand });
  assert(view.enter());
  let previousBearing = -Infinity;
  for (let frame = 0; frame < 10; frame++) {
    const { x, z } = camera.position;
    view.move(new Set(['forward', 'right']), 0.05);
    const dx = camera.position.x - x, dz = camera.position.z - z;
    const bearing = Math.atan2(dx, -dz);
    assert(dz < 0 && bearing > previousBearing, 'successive steps turn right');
    assert(view.speedMps > 0);
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
  drive(view, ['forward'], 2.7);
  assert(camera.position.x > 0);
  view.park();
  const afloatX = camera.position.x;
  close(camera.position.y, wave + 1.8);
  const heading = controls.target.clone().sub(camera.position);
  wave = -2.4;
  view.followWaves();
  close(camera.position.x, afloatX);
  close(camera.position.z, 0);
  close(camera.position.y, wave + 1.8);
  close(controls.target.clone().sub(camera.position).distanceTo(heading), 0);
  drive(view, ['back'], 7);
  assert(camera.position.x < 0);
  close(camera.position.y, -camera.position.x / 2 + 1.8);
  view.followWaves();
  close(camera.position.y, -camera.position.x / 2 + 1.8);
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
  inland.view.move(new Set(['right']), Math.PI / 2);
  drive(inland.view, ['forward'], 5);
  assert(inland.camera.position.x < 0 && inland.camera.position.x > -1);
  assert(inland.view.speedMps < 0.5);

  for (const [radians, axis, boundary] of [[0, 'z', -59.5], [Math.PI / 2, 'x', 49.5],
    [Math.PI, 'z', 59.5], [3 * Math.PI / 2, 'x', -49.5]]) {
    const edge = fixture({ width: 100, depth: 120 });
    assert(edge.view.enter());
    edge.view.move(new Set(['right']), radians);
    drive(edge.view, ['forward'], 10);
    close(edge.camera.position[axis], boundary);
    close(edge.view.speedMps, 0);
  }
});

test('traction and power limit acceleration, and releasing the throttle allows coasting', () => {
  const { camera, view } = fixture();
  assert(view.enter());
  drive(view, ['forward'], 2);
  const earlyGain = view.speedMps;
  drive(view, ['forward'], 10);
  const atSpeed = view.speedMps;
  drive(view, ['forward'], 2);
  assert(earlyGain > 0 && atSpeed > earlyGain && view.speedMps - atSpeed < earlyGain);
  const z = camera.position.z, beforeCoast = view.speedMps;
  drive(view, [], 1);
  assert(camera.position.z < z && view.speedMps > 0 && view.speedMps < beforeCoast);
  drive(view, ['brake'], 8);
  close(view.speedMps, 0);
  const stopped = camera.position.z;
  drive(view, ['brake', 'forward'], 1);
  close(camera.position.z, stopped);
});

test('opposite throttle brakes to a standstill before reversing', () => {
  const { camera, view } = fixture();
  assert(view.enter());
  drive(view, ['forward'], 3);
  const initialZ = camera.position.z;
  for (let i = 0; i < 200 && view.speedMps > 0; i++) drive(view, ['back'], 0.02);
  close(view.speedMps, 0);
  const stoppedZ = camera.position.z;
  assert(stoppedZ < initialZ);
  drive(view, ['back'], 0.1);
  close(camera.position.z, stoppedZ);
  drive(view, ['back'], 2);
  assert(camera.position.z > stoppedZ && view.speedMps > 0);
});

test('physical slope and water resistance affect speed independently of display exaggeration', () => {
  function onSlope(grade, scale = 1) {
    const { view } = fixture({ sampleLand: (x, z) => (20 - z * grade) * scale, verticalScale: () => scale });
    assert(view.enter());
    drive(view, ['forward'], 5);
    return view;
  }
  const uphill = onSlope(0.1), level = onSlope(0), downhill = onSlope(-0.1);
  assert(uphill.speedMps < level.speedMps && level.speedMps < downhill.speedMps);
  close(uphill.speedMps, onSlope(0.1, 5).speedMps);
  const before = downhill.speedMps;
  drive(downhill, [], 1);
  assert(downhill.speedMps > before);
  const { view: boat } = fixture({ sampleLand: () => null, distance: () => 10 });
  assert(boat.enter());
  drive(boat, ['forward'], 5);
  assert(boat.speedMps > 0 && boat.speedMps < level.speedMps);
});
