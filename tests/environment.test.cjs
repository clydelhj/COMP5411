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

function fixture(capable = true) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        value: '', textContent: '', handlers: {},
        addEventListener(name, handler) { this.handlers[name] = handler; },
        setAttribute() {}
      });
      return elements.get(selector);
    }
  };
  const runtime = vm.createContext({ window: {}, document, performance });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/environment.js'), 'utf8'), runtime);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(50, 100, 50);
  const renderer = { shadowMap: {}, setClearColor() {} };
  const events = [];
  const environment = runtime.window.NotoEnvironment.create({
    THREE, scene, camera, renderer, capable,
    controls: { target: new THREE.Vector3() },
    metadata: { width_m: 10000, height_m: 10000 },
    sampleHeight: () => 0,
    onChange: weather => events.push(weather)
  });
  return {
    environment, camera, events,
    rain: scene.getObjectByName('Noto local rain'),
    weather(value) {
      const input = elements.get('#scene-weather');
      input.value = value;
      input.handlers.change();
    }
  };
}

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
