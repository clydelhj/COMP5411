'use strict';

// Rain allocation and scheduling regressions. Shader compilation and world-space
// motion are checked separately in the real-browser scene.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { before, test } = require('node:test');
const root = path.resolve(__dirname, '..');
let THREE;

before(async () => {
  const library = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), library);
  const packed = library.window.NOTO_LIBRARIES.core;
  const source = zlib.gunzipSync(Buffer.from(Array.isArray(packed) ? packed.join('') : packed, 'base64'));
  THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
});

function fixture(capable = true, geographicCenter) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        value: selector === '#scene-weather' ? 'clear' : '', textContent: '', handlers: {},
        addEventListener(name, handler) { this.handlers[name] = handler; },
        setAttribute() {}
      });
      return elements.get(selector);
    }
  };
  let now = 0;
  const runtime = vm.createContext({ window: {}, document, performance: { now: () => now } });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/environment.js'), 'utf8'), runtime);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(50, 100, 50);
  const renderer = { shadowMap: {}, setClearColor() {} };
  const events = [];
  const environment = runtime.window.NotoEnvironment.create({
    THREE, scene, camera, renderer, capable,
    controls: { target: new THREE.Vector3() },
    metadata: { width_m: 10000, height_m: 10000, geographicCenter },
    sampleHeight: () => 0,
    onChange: weather => events.push(weather)
  });
  return {
    environment, camera, events,
    rain: scene.getObjectByName('Noto local rain'),
    clickCycle() { elements.get('#day-cycle').handlers.click(); },
    frameAt(ms) { now = ms; return environment.advanceDayCycle(ms); },
    setDateTime(date, minutes) {
      elements.get('#scene-date').value = date;
      elements.get('#scene-time').value = String(minutes);
      elements.get('#scene-time').handlers.input();
      return environment.getState();
    },
    weather(value) {
      const input = elements.get('#scene-weather');
      input.value = value;
      input.handlers.change();
    }
  };
}

test('day-night playback advances one day in 30 seconds, rolls over at midnight, and yields to manual controls', () => {
  const viewer = fixture();
  const { environment, clickCycle, frameAt } = viewer;
  const state = () => environment.getState();
  viewer.setDateTime('2028-02-28', 1080);
  assert.equal(frameAt(0), false);
  clickCycle();
  assert.equal(frameAt(7500), true);
  assert.deepEqual([state().date, state().time, state().shadowEnabled], ['2028-02-29', '00:00', false]);
  viewer.weather('cloudy');
  assert.equal(environment.isDayCyclePlaying(), true);
  frameAt(22500);
  assert.deepEqual([state().time, state().shadowEnabled], ['12:00', true]);
  frameAt(30000);
  assert.deepEqual([state().date, state().time], ['2028-02-29', '18:00']);
  clickCycle();
  assert.equal(frameAt(50000), false);
  assert.equal(state().time, '18:00');
  clickCycle();
  frameAt(57500);
  assert.deepEqual([state().date, state().time], ['2028-03-01', '00:00']);
  viewer.setDateTime('2028-03-01', 540);
  assert.equal(frameAt(60000), false);
  assert.equal(state().time, '09:00');
  viewer.setDateTime('2100-12-31', 1438);
  clickCycle();
  frameAt(65000);
  assert.deepEqual([state().date, state().time, environment.isDayCyclePlaying()], ['2100-12-31', '23:59', false]);
  environment.dispose();
});

test('rain uses deterministic varied trajectories with one shared parameter set per streak', () => {
  const a = fixture(), b = fixture();
  for (const name of ['position', 'aEnd', 'aRainMotion']) {
    assert.deepEqual(Array.from(a.rain.geometry.attributes[name].array), Array.from(b.rain.geometry.attributes[name].array));
  }
  const motion = a.rain.geometry.attributes.aRainMotion;
  assert.equal(motion.count, 4400, 'fixed high-tier population has two endpoints per drop');
  const speeds = new Set(), shutters = new Set();
  for (let i = 0; i < motion.count; i += 2) {
    const speed = motion.getX(i), shutter = motion.getY(i), wind = motion.getZ(i);
    assert(speed >= 9 && speed <= 15);
    assert(shutter >= 0.035 && shutter <= 0.055);
    assert(wind >= 0.8 && wind <= 1.2);
    assert.equal(motion.getX(i + 1), speed);
    assert.equal(motion.getY(i + 1), shutter);
    assert.equal(motion.getZ(i + 1), wind);
    speeds.add(speed); shutters.add(shutter);
  }
  assert(speeds.size > 100 && shutters.size > 100, 'streak speed and length are not uniform');
  a.environment.dispose(); b.environment.dispose();
});

test('lunar direction, phase and angular size follow the observer and Japanese date/time', () => {
  const noto = fixture();
  const sydney = fixture(true, { latitude: -33.8688, longitude: 151.2093 });
  // JPL Horizons: target 301, sea-level geodetic sites, airless observer quantities 4,10,13.
  // Reference dates below use JST; Horizons was queried at the equivalent UTC instant.
  const references = [
    [noto, '2026-11-09', 16, 239.540, 2.277, 0.00252, 1803.3],
    [noto, '2026-11-17', 19, 200.859, 35.823, 0.49021, 1818.6],
    [noto, '2026-11-21', 12, 58.991, -23.794, 0.84343, 1888.5],
    [noto, '2026-11-21', 19, 133.719, 53.532, 0.86490, 1936.8],
    [noto, '2026-11-24', 18, 75.372, 21.606, 0.99800, 1996.6],
    [noto, '2026-12-01', 15, 308.677, -31.136, 0.50403, 1881.4],
    [sydney, '2026-11-21', 19, 16.043, 44.272, 0.86610, 1933.3]
  ];
  const degrees = 180 / Math.PI;
  for (const [viewer, date, hour, azimuth, altitude, fraction, diameterArcsec] of references) {
    const state = viewer.setDateTime(date, hour * 60);
    const [east, up, south] = state.moonDirection;
    const bearing = (Math.atan2(east, -south) * degrees + 360) % 360;
    assert(Math.abs(1 - Math.hypot(east, up, south)) < 1e-10);
    assert(Math.abs(bearing - azimuth) < 0.3, `azimuth at ${date} ${hour}:00`);
    assert(Math.abs(Math.asin(up) * degrees - altitude) < 0.2, `altitude at ${date} ${hour}:00`);
    assert(Math.abs(state.moonIllumination - fraction) < 0.01, `illumination at ${date} ${hour}:00`);
    assert(Math.abs(2 * state.moonAngularRadius * degrees * 3600 - diameterArcsec) < 10);
  }
  const previous = noto.environment.getState().moonDirection;
  noto.weather('rainy');
  assert.equal(noto.environment.getState().moonDirection, previous);
  assert.equal(noto.setDateTime('2026-02-30', 720).moonDirection, previous);
  noto.environment.dispose();
  sydney.environment.dispose();
});

test('rain camera updates and clock ticks preserve buffers; zero, invalid and disabled ticks freeze', () => {
  const { environment, rain, camera, weather } = fixture(false);
  const attributes = Object.values(rain.geometry.attributes);
  const buffers = attributes.map(attribute => attribute.array);
  const copies = buffers.map(array => array.slice());
  environment.animate(1);
  assert.equal(environment.getState().rainTime, 0, 'clear weather does not advance rain');
  weather('rainy');
  environment.updateView(1);
  assert.equal(environment.getState().rainCount, 1200);
  assert.equal(rain.visible, true);
  environment.animate(0.05);
  const clock = environment.getState().rainTime;
  for (const dt of [0, -1, NaN, Infinity]) environment.animate(dt);
  assert.equal(environment.getState().rainTime, clock);
  camera.position.set(-120, 900, 20);
  environment.updateView(5);
  assert.deepEqual(rain.material.uniforms.uRainAnchor.value.toArray(), camera.position.toArray());
  for (let i = 0; i < attributes.length; i++) {
    assert.equal(attributes[i].array, buffers[i], 'navigation does not allocate replacement particles');
    assert.deepEqual(buffers[i], copies[i], 'particle motion is evaluated by the GPU');
    assert.equal(attributes[i].version, 0, 'no repeated particle upload');
  }
  weather('clear');
  environment.animate(1);
  assert.equal(environment.getState().rainTime, clock);
  assert.equal(environment.getState().rainCount, 0);
  environment.dispose();
});
