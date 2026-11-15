'use strict';

// Real Three.js CPU ownership/capacity tests. GPU reuse is checked in the viewer.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), zlib = require('node:zlib');
const { test, before } = require('node:test');
const root = path.resolve(__dirname, '..');
let THREE, buffers;
before(async () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), context);
  const source = zlib.gunzipSync(Buffer.from(context.window.NOTO_LIBRARIES.core, 'base64'));
  THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/instance-buffers.js'), 'utf8'), context);
  buffers = context.window.NotoInstanceBuffers;
});

test('initial storage is bounded and has a stable color variant without changing population limits', () => {
  for (const limit of [24, 240, 34000, 60000]) {
    const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
    const mesh = buffers.create(THREE, geometry, material, limit);
    assert.equal(mesh.count, 0);
    assert.equal(mesh.instanceMatrix.count, Math.min(256, limit));
    assert.equal(mesh.instanceColor.count, mesh.instanceMatrix.count);
    assert.equal(mesh.instanceMatrix.usage, THREE.DynamicDrawUsage);
    assert.ok(mesh.instanceColor.array.every(value => value === 1));
    assert.equal(mesh.geometry, geometry); assert.equal(mesh.material, material);
  }
});

test('growth releases instance ownership once, retains mesh/material/prototype and accepts the full population', () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  const mesh = buffers.create(THREE, geometry, material, 60000);
  let instanceDisposals = 0, geometryDisposals = 0, materialDisposals = 0;
  mesh.addEventListener('dispose', () => instanceDisposals++);
  geometry.addEventListener('dispose', () => geometryDisposals++);
  material.addEventListener('dispose', () => materialDisposals++);
  const initial = mesh.instanceMatrix;
  assert.equal(buffers.reserve(THREE, mesh, 190, 60000), false);
  assert.equal(mesh.instanceMatrix, initial);
  mesh.count = 300;
  assert.equal(buffers.reserve(THREE, mesh, mesh.count, 60000), true);
  assert.equal(mesh.instanceMatrix.count, 512);
  assert.equal(mesh.instanceColor.count, 512);
  assert.equal(instanceDisposals, 1);
  assert.equal(geometryDisposals, 0); assert.equal(materialDisposals, 0);
  assert.equal(mesh.count, 300);
  const matrix = new THREE.Matrix4().makeTranslation(7, 11, 13);
  mesh.setMatrixAt(299, matrix);
  const readback = new THREE.Matrix4(); mesh.getMatrixAt(299, readback);
  assert.deepEqual(readback.elements, matrix.elements);
  const retained = mesh.instanceMatrix;
  assert.equal(buffers.reserve(THREE, mesh, 20, 60000), false);
  assert.equal(mesh.instanceMatrix, retained, 'smaller views do not shrink/reallocate');
  assert.equal(buffers.reserve(THREE, mesh, 60000, 60000), true);
  assert.equal(mesh.instanceMatrix.count, 60000);
  assert.equal(instanceDisposals, 2);
  assert.throws(() => buffers.reserve(THREE, mesh, 60001, 60000), /Invalid instance population/);
});

test('grass growth replaces slope storage and releases its GPU owner without replacing CPU prototype data', () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  geometry.setAttribute('grassSlope', new THREE.InstancedBufferAttribute(new Float32Array(512), 2));
  const positions = geometry.attributes.position;
  const mesh = buffers.create(THREE, geometry, material, 34000);
  let geometryDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++);
  assert.equal(buffers.reserve(THREE, mesh, 700, 34000, { grassSlope: 2 }), true);
  assert.equal(geometry.attributes.position, positions);
  assert.equal(geometry.attributes.grassSlope.count, 700);
  assert.equal(mesh.instanceMatrix.count, 700);
  assert.equal(geometryDisposals, 1);
  assert.equal(buffers.reserve(THREE, mesh, 600, 34000, { grassSlope: 2 }), false);
  assert.equal(geometryDisposals, 1);
});
