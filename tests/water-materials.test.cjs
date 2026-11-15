'use strict';

// Exercise the generated texture data without allocating a browser/GPU context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');

test('wavelet normals retain precision, periodic continuity and reproducible variance', async () => {
  const root = path.resolve(__dirname, '..');
  const runtime = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), runtime);
  const packed = runtime.window.NOTO_LIBRARIES.core;
  const source = zlib.gunzipSync(Buffer.from(Array.isArray(packed) ? packed.join('') : packed, 'base64'));
  const THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/water-materials.js'), 'utf8'), runtime);
  const first = runtime.window.NotoWaterMaterials.create(THREE);
  const second = runtime.window.NotoWaterMaterials.create(THREE);
  try {
    const texture = first.textures.detail, { data, width, height } = texture.image;
    assert.equal(texture.type, THREE.HalfFloatType);
    assert.equal(data.BYTES_PER_ELEMENT, 2);
    assert.equal(texture.generateMipmaps, true);
    assert.equal(Buffer.compare(Buffer.from(data.buffer), Buffer.from(second.textures.detail.image.data.buffer)), 0);
    const normals = new Float32Array(width * height * 3);
    const mean = [0, 0, 0];
    let slopeEnergy = 0, lengthError = 0;
    for (let i = 0; i < width * height; i++) {
      const normal = [0, 1, 2].map(c => THREE.DataUtils.fromHalfFloat(data[i * 4 + c]) * 2 - 1);
      assert(normal.every(Number.isFinite));
      assert(normal[2] > 0.8, 'no folded or singular microfacets');
      normal.forEach((value, c) => { normals[i * 3 + c] = value; mean[c] += value; });
      slopeEnergy += (normal[0] ** 2 + normal[1] ** 2) / normal[2] ** 2;
      lengthError = Math.max(lengthError, Math.abs(Math.hypot(...normal) - 1));
    }
    const count = width * height, rms = Math.sqrt(slopeEnergy / count);
    assert(rms > 0.065 && rms < 0.085, 'wavelets have bounded, nonzero physical slope variation');
    assert(lengthError < 0.002, 'half-float encoding preserves normalized vectors');
    const variance = 1 - mean.reduce((sum, value) => sum + value * value, 0) / (count * count);
    assert(Math.abs(variance - texture.userData.normalMeanVariance) < 0.002,
      'far-detail variance agrees with the encoded normal field');
    const delta = (a, b) => {
      let sum = 0;
      for (let c = 0; c < 3; c++) sum += (normals[a * 3 + c] - normals[b * 3 + c]) ** 2;
      return sum;
    };
    let edge = 0, interior = 0;
    for (let row = 0; row < height; row++) {
      edge += delta(row * width, row * width + width - 1);
      for (let col = 1; col < width; col++) interior += delta(row * width + col, row * width + col - 1);
    }
    assert(edge / height < interior / (height * (width - 1)) * 1.7,
      'periodic X boundary does not introduce a normal seam');
    edge = interior = 0;
    for (let col = 0; col < width; col++) {
      edge += delta(col, (height - 1) * width + col);
      for (let row = 1; row < height; row++) interior += delta(row * width + col, (row - 1) * width + col);
    }
    assert(edge / width < interior / (width * (height - 1)) * 1.7,
      'periodic Z boundary does not introduce a normal seam');
  } finally {
    first.dispose(); second.dispose();
  }
});
