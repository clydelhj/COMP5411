'use strict';

// Exercise the generated texture data without allocating a browser/GPU context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');

test('water fields retain normal precision and periodic preintegrated foam coverage', async () => {
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
    const foam = first.textures.foam, foamPixels = foam.image.data;
    assert.equal(foam.format, THREE.RGFormat);
    assert.equal(foam.colorSpace, THREE.NoColorSpace);
    assert.equal(foam.generateMipmaps, true);
    assert.equal(foamPixels.byteLength, 512 * 512 * 2, 'foam allocation is bounded to RG8');
    assert.equal(Buffer.compare(Buffer.from(foamPixels.buffer), Buffer.from(second.textures.foam.image.data.buffer)), 0);
    const sums = [0, 0], holes = [0, 0], partial = [0, 0];
    for (let i = 0; i < width * height; i++) {
      assert(foamPixels[i * 2 + 1] >= foamPixels[i * 2], 'thicker aerated films retain at least the thin-film coverage');
      for (let c = 0; c < 2; c++) {
        const value = foamPixels[i * 2 + c];
        sums[c] += value;
        if (value === 0) holes[c]++;
        if (value > 10 && value < 245) partial[c]++;
      }
    }
    for (let c = 0; c < 2; c++) {
      assert(holes[c] > count * 0.01, 'both layers have genuine water holes');
      assert(partial[c] > count * 0.25, 'optical thickness varies continuously instead of forming binary patches');
      assert(Math.abs(sums[c] / (count * 255) - foam.userData.coverageMean[c]) < 1e-10,
        'stored means describe preintegrated coverage for mip filtering');
      let seam = 0, adjacent = 0;
      for (let row = 0; row < height; row++) {
        seam += Math.abs(foamPixels[row * width * 2 + c] - foamPixels[(row * width + width - 1) * 2 + c]);
        for (let col = 1; col < width; col++) adjacent += Math.abs(foamPixels[(row * width + col) * 2 + c] - foamPixels[(row * width + col - 1) * 2 + c]);
      }
      assert(seam / height < adjacent / (height * (width - 1)) * 1.8, 'periodic foam X boundary stays comparable to interior variation');
      seam = 0; adjacent = 0;
      for (let col = 0; col < width; col++) {
        seam += Math.abs(foamPixels[col * 2 + c] - foamPixels[((height - 1) * width + col) * 2 + c]);
        for (let row = 1; row < height; row++) adjacent += Math.abs(foamPixels[(row * width + col) * 2 + c] - foamPixels[((row - 1) * width + col) * 2 + c]);
      }
      assert(seam / width < adjacent / (width * (height - 1)) * 1.8, 'periodic foam Z boundary stays comparable to interior variation');
    }
    if (process.env.OCEAN_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.OCEAN_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.OCEAN_ARTIFACT_DIR, 'foam-density.rg8'), Buffer.from(foamPixels.buffer));
      fs.writeFileSync(path.join(process.env.OCEAN_ARTIFACT_DIR, 'foam-density.json'), JSON.stringify({ width, height,
        channels: ['thin coverage', 'thick coverage'], means: foam.userData.coverageMean,
        holes: holes.map(value => value / count), partial: partial.map(value => value / count) }, null, 2));
    }
  } finally {
    first.dispose(); second.dispose();
  }
});
