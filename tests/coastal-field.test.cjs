'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const runtime = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/coastal-geometry.js'), 'utf8'), runtime);
const sample = runtime.window.NotoCoastalGeometry.sampleDistance;
const source = { rows: 48, cols: 48, cellM: 8, widthM: 384, heightM: 384 };
function field(fn) {
  return Uint16Array.from({ length: source.rows * source.cols }, (_, i) => {
    const x = (i % source.cols + .5) * 8 - 192;
    const z = (Math.floor(i / source.cols) + .5) * 8 - 192;
    return Math.round(32768 + fn(x, z) * 8);
  });
}
function bilinear(values, x, z) {
  const u = (x + 192) / 8 - .5, v = (z + 192) / 8 - .5;
  const c = Math.floor(u), r = Math.floor(v), tx = u - c, tz = v - r;
  const a = r * source.cols + c;
  return ((values[a] * (1-tx) + values[a+1] * tx) * (1-tz)
    + (values[a+source.cols] * (1-tx) + values[a+source.cols+1] * tx) * tz - 32768) / 8;
}

test('continuous coastline sampling preserves straight shores and the distant field', () => {
  const plane = field((x,z) => x + z * .5);
  for (let z = -80; z <= 80; z += 7.3) for (let x = -100; x <= 100; x += 6.7) {
    assert(Math.abs(sample(plane, source, x, z) - (x + z*.5)) < 1e-9);
  }
  const curved = field((x,z) => x + 8*Math.sin(z/6));
  const unchanged = curved.slice();
  for (const x of [-150,-100,100,150]) for (const z of [-70,5,70]) {
    assert.equal(sample(curved,source,x,z),bilinear(curved,x,z));
  }
  assert.deepEqual(curved,unchanged,'sampling does not edit the source field');
});

test('shoreline tangent remains continuous across the original 8 m cell boundaries', () => {
  const values = field((x,z) => x + 8*Math.sin(z/6));
  const epsilon = .001;
  let originalJump = 0, filteredJump = 0;
  for (let z = -100; z < 100; z += 8) {
    const derivativeJump = fn => Math.abs((fn(z+epsilon)-fn(z))/epsilon - (fn(z)-fn(z-epsilon))/epsilon);
    originalJump = Math.max(originalJump, derivativeJump(zz=>bilinear(values,1,zz)));
    filteredJump = Math.max(filteredJump, derivativeJump(zz=>sample(values,source,1,zz)));
  }
  assert(originalJump > .5,'fixture exposes the bilinear tangent discontinuity');
  assert(filteredJump < .001,'cubic contour removes sharp grid-boundary tangent jumps');
});

test('constant fields and crop-edge sampling remain finite and bounded', () => {
  for (const value of [-500,0,500]) {
    const values=field(()=>value);
    for (const [x,z] of [[0,0],[-192,-192],[192,192],[-1e6,1e6]]) {
      assert(Math.abs(sample(values,source,x,z)-value)<1e-9);
    }
  }
  const values=field((x,z)=>Math.max(-10,Math.min(10,x+z)));
  for (const x of [-192,-188,188,192]) for (const z of [-192,-188,188,192]) {
    const result=sample(values,source,x,z);
    assert(Number.isFinite(result) && result >= -10-1e-9 && result <= 10+1e-9);
  }
});
