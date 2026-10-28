'use strict';

// Generated coverage and placement fixtures; no DEM, browser or asset download is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { before, test } = require('node:test');
const root = path.resolve(__dirname, '..');
let THREE, ground;

before(async () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), context);
  const source = zlib.gunzipSync(Buffer.from(context.window.NOTO_LIBRARIES.core, 'base64')).toString('utf8');
  THREE = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const globals = { window: { NOTO_GRASS_TEXTURES: { color: 'fixture-color', normal: 'fixture-normal' } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/ground-grass.js'), 'utf8'), globals);
  ground = globals.window.NotoGroundGrass;
});

function strata(family = 'soil', id = 1) {
  return { metadata: { cols: 2, rows: 2, levels: 2 }, palette: [{ id, family }], ids: new Uint8Array(8).fill(id) };
}

async function prepare(category = 3, family = 'soil', id = 1) {
  const textureThree = { ...THREE, TextureLoader: class {
    async loadAsync() { return new THREE.DataTexture(new Uint8Array([90, 130, 45, 255]), 1, 1); }
  } };
  return ground.prepare(textureThree, { width: 400, height: 400, categoryAt: typeof category === 'function' ? category : () => category }, strata(family, id));
}

test('grass coverage excludes water, built-up, facilities, reef and missing source classes', async () => {
  for (const category of [0, 1, 2, 4, 11, 30]) {
    const data = await prepare(category);
    assert.equal(data.coverageAt(0, 0), 0, 'excluded category ' + category);
    assert.equal(data.coverageAt(100, -100), 0, 'excluded interior category ' + category);
  }
});

test('observed herb/woodland and bare soil retain nonzero deterministic grass cover', async () => {
  for (const category of [3, 12, 14, 19, 25]) {
    const a = await prepare(category), b = await prepare(category);
    assert(a.coverageAt(0, 0) > 0.1, 'eligible category ' + category);
    assert(Math.abs(a.coverageAt(0, 0) - a.mask.image.data[0] / 255 * ground.patchCoverage(0, 0)) < 1e-7);
    assert.deepEqual(Array.from(a.mask.image.data), Array.from(b.mask.image.data));
    assert.equal(a.coverageAt(1000, 1000), 0, 'outside mask');
  }
});

test('bare weatherable surfaces receive illustrative cover while loose beaches and fresh igneous rock stay bare', async () => {
  for (const id of [8, 10, 11, 13, 18, 23, 24, 25, 27, 28]) {
    const data = await prepare(3, 'rock', id);
    assert(data.coverageAt(0, 0) > 0.1, 'weatherable surface ' + id);
    assert(data.mask.image.data.every(value => value === 201), 'fractional suitability is applied once');
  }
  for (const id of [1, 2, 3, 5, 12, 14, 17]) {
    const data = await prepare(3, id === 2 || id === 5 ? 'sand' : 'rock', id);
    assert.equal(data.coverageAt(0, 0), 0, 'excluded bare material ' + id);
  }
});

test('grass patches are deterministic, continuous and varied rather than a repeated planting grid', () => {
  const samples = [];
  for (let z = -280; z <= 280; z += 28) for (let x = -280; x <= 280; x += 28) {
    const value = ground.patchCoverage(x, z);
    assert.equal(value, ground.patchCoverage(x, z));
    assert(value >= 0.18 && value <= 1);
    assert(Math.abs(value - ground.patchCoverage(x + 0.01, z - 0.01)) < 0.002, 'continuous field');
    samples.push(value);
  }
  assert(Math.max(...samples) - Math.min(...samples) > 0.7, 'visible spatial variation');
});

function placement({ verticalScale = 1, slope = 0.12, enabled = true } = {}) {
  const scene = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 500);
  camera.position.set(0, 20 * verticalScale + 12, 8);
  camera.lookAt(0, 20 * verticalScale, -35);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const sampleHeight = (x, z) => (20 + x * slope + z * slope * 0.25) * verticalScale;
  const controller = ground.create({ THREE, scene, camera, data: { coverageAt: () => 0.88 }, sampleHeight, time: { value: 0 } });
  const view = { position: camera.position.clone(), frustum };
  const generator = controller.prepareUpdate(verticalScale, 0, enabled, view);
  let result;
  do { result = generator.next(); } while (!result.done);
  controller.commit(result.value);
  return { scene, controller, sampleHeight, prepared: result.value };
}

test('tufts follow displayed terrain at 1/5/10 exaggeration without scaling natural blade height', () => {
  for (const verticalScale of [1, 5, 10]) {
    const { scene, controller, sampleHeight } = placement({ verticalScale });
    const state = controller.getState();
    assert(state.tufts > 100, 'visible grass at scale ' + verticalScale);
    assert(state.tufts <= 34000, 'bounded placement');
    for (const sample of state.sampleInstances) assert(Math.abs(sample.y - sampleHeight(sample.x, sample.z)) < 0.0001);
    for (const mesh of scene.children) {
      if (!mesh.count) continue;
      const matrix = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, 0);
      const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      matrix.decompose(position, rotation, scale);
      assert(scale.y >= 0.6 && scale.y <= 1.2, 'natural grass height is independent of terrain scale');
      assert(Math.abs(position.y - (sampleHeight(position.x, position.z) - 0.015)) < 0.001, 'root is embedded in displayed surface');
      const vertices = mesh.geometry.attributes.position.array;
      const localRoot = mesh.geometry.attributes.grassRoot.array;
      const slope = mesh.geometry.attributes.grassSlope.array;
      const foot = new THREE.Vector3((vertices[0] + vertices[3]) / 2,
        localRoot[0] * slope[0] + localRoot[1] * slope[1], (vertices[2] + vertices[5]) / 2).applyMatrix4(matrix);
      assert(Math.abs(foot.y - (sampleHeight(foot.x, foot.z) - 0.015)) < 0.001, 'rotated blade roots follow the slope across the tuft footprint');
    }
  }
});

test('placement stays fixed across repeated updates, visibility off hides all tufts, steep faces reject grass', () => {
  const a = placement(), b = placement();
  assert.deepEqual(a.controller.getState().sampleInstances, b.controller.getState().sampleInstances);
  assert.equal(placement({ enabled: false }).controller.getState().tufts, 0);
  assert.equal(placement({ slope: 3 }).controller.getState().tufts, 0);
  a.controller.hide();
  assert.equal(a.controller.getState().tufts, 0);
  assert(a.scene.children.every(mesh => mesh.count === 0));
});
