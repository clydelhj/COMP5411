'use strict';

// Generated fixtures exercise WebGL2 index limits and preserve geometry topology.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test, before } = require('node:test');

const root = path.resolve(__dirname, '..');
const runtime = vm.createContext({ window: {}, Uint16Array, Uint32Array });
vm.runInContext(fs.readFileSync(path.join(root, 'src/model-volume.js'), 'utf8'), runtime);
const volume = runtime.window.NotoVolume;
let THREE;

before(async () => {
  const library = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), library);
  const packed = library.window.NOTO_LIBRARIES.core;
  const source = zlib.gunzipSync(Buffer.from(Array.isArray(packed) ? packed.join('') : packed, 'base64'));
  THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
});

test('compact indices preserve references and WebGL2 primitive-restart boundaries', () => {
  for (const largest of [65534, 65535, 65536]) {
    const original = new Uint32Array([0, largest, 1, 1, largest, 2]);
    const compact = volume.compactIndices(original);
    assert.deepEqual(Array.from(compact), Array.from(original));
    assert.equal(compact.BYTES_PER_ELEMENT, largest < 65535 ? 2 : 4);
    assert.equal(compact.byteLength, original.length * (largest < 65535 ? 2 : 4));
    if (largest >= 65535) assert.equal(compact, original, 'large indices retain their buffer');
  }
  const existing = new Uint16Array([0, 1, 2]);
  assert.equal(volume.compactIndices(existing), existing, 'safe small buffers need no copy');
  const restart = new Uint16Array([0, 1, 65535, 2, 3]);
  assert.equal(volume.compactIndices(restart), restart, 'an existing restart value retains its type and semantics');
  const wideRestart = new Uint32Array([0, 1, 0xffffffff, 2, 3]);
  assert.equal(volume.compactIndices(wideRestart), wideRestart);
  assert.deepEqual(Array.from(volume.compactIndices([])), []);
  for (const invalid of [[-1], [1.5], [NaN], [Infinity], [0x100000000], [, 1]]) {
    assert.throws(() => volume.compactIndices(invalid), /unsigned 32-bit integers/);
  }
});

test('indexed geometry keeps triangle winding, holes and exact computed normals', () => {
  const positions = Float32Array.from([
    0, 0, 0, 1, 0.2, 0, 2, 0.4, 0,
    0, 0.1, 1, 1, 0.3, 1, 2, 0.5, 1,
    0, 0.2, 2, 1, 0.4, 2, 2, 0.6, 2
  ]);
  const mask = new Uint8Array([1, 0, 1, 1]);
  const original = volume.surfaceIndices(mask, 3, 3);
  const snapshot = original.slice();
  const expected = new THREE.BufferGeometry();
  expected.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  expected.setIndex(new THREE.BufferAttribute(original, 1));
  expected.computeVertexNormals();
  const actual = volume.makeGeometry(THREE, positions.slice(), original);
  assert.equal(actual.index.array.constructor, Uint16Array);
  assert.deepEqual(Array.from(actual.index.array), Array.from(snapshot));
  assert.deepEqual(Array.from(original), Array.from(snapshot), 'source ownership and values stay unchanged');
  assert.equal(actual.index.count, 18, 'the missing cell contributes no triangles');
  assert.deepEqual(Array.from(actual.attributes.normal.array), Array.from(expected.attributes.normal.array));
  actual.dispose();
  expected.dispose();
});

