'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Exercise the real visibility helper; browser fixtures separately compare images.
function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../src/terrain.js'), 'utf8');
  const start = source.indexOf('    function updateTerrainBaseVisibility()');
  const end = source.indexOf('    // This is a frustum test', start);
  assert.ok(start >= 0 && end > start);
  const material = { transparent: false };
  const mesh = (base = false) => ({
    userData: { notoBaseFace: base }, material,
    geometry: { index: { count: 6 } }, renderOrder: 0, visible: true
  });
  const item = { group: { renderOrder: 0, children: [mesh(), mesh(), mesh(true)] } };
  const camera = { position: { x: 0, y: 25, z: 0 } }, terrain = { scale: { y: 1 } };
  const baseCulling = { updates: 0, live: null, showBase: null };
  const runtime = vm.createContext({ camera, terrain, baseCulling, live: new Map([['patch', item]]) });
  vm.runInContext(source.slice(start, end) + '\nthis.update = updateTerrainBaseVisibility;', runtime);
  return { item, camera, terrain, baseCulling, material, runtime };
}

test('culling preserves tops, walls, ordering, shared material and same-side cache', () => {
  const { item, camera, baseCulling, material, runtime } = fixture();
  runtime.update();
  assert.equal(item.group.children[0].visible, true);
  assert.equal(item.group.children[1].visible, true);
  assert.equal(item.group.children[2].visible, false);
  assert.equal(item.group.renderOrder, 0);
  assert.ok(item.group.children.every(mesh => mesh.renderOrder === 0));
  assert.equal(material.visible, undefined);
  camera.position.x = 100;
  camera.position.y = 125;
  runtime.update();
  assert.equal(baseCulling.updates, 1, 'camera motion on the same side needs no update');
  runtime.live = new Map(runtime.live);
  runtime.update();
  assert.equal(baseCulling.updates, 2, 'a committed frontier updates its base meshes');
});

test('flat bases return at and below the plane for all height scales', () => {
  const { item, camera, terrain, baseCulling, runtime } = fixture();
  for (const scale of [1, 5, 10]) for (const offset of [2, 0, -2]) {
    terrain.scale.y = scale;
    camera.position.y = -100 * scale + offset;
    runtime.update();
    const show = offset <= 0;
    assert.equal(item.group.children[2].visible, show);
    assert.equal(item.group.children[0].visible, true);
    assert.equal(item.group.children[1].visible, true);
    assert.equal(baseCulling.culledMeshes, show ? 0 : 1);
    assert.equal(baseCulling.culledTriangles, show ? 0 : 2);
  }
});
