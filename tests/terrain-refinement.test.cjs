'use strict';

// Synthetic topology tests: node --test tests/terrain-refinement.test.cjs.
// No DEM, browser, network or third-party test dependency is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture(base = 1, width = 128 * base * 4 + 17, height = 128 * base * 3 + 11) {
  const context = vm.createContext({ window: {}, Map, Set });
  for (const file of ['terrain-lod.js', 'terrain-refinement.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context, { filename: file });
  }
  const metadata = { source_width: width + 1, source_height: height + 1, source_spacing_m: [1, 1], width_m: width, height_m: height };
  const descriptors = {};
  const sourceSpan = 256 * base;
  for (let z = 0; z * sourceSpan < height; z++) for (let x = 0; x * sourceSpan < width; x++) {
    const c0 = x * sourceSpan, r0 = z * sourceSpan;
    const c1 = Math.min(width, c0 + sourceSpan), r1 = Math.min(height, r0 + sourceSpan);
    const key = `0/${x}/${z}`;
    descriptors[key] = { key, file: `generated/${key}.js`, level: 0, levelKey: '0', step: base,
      c0, c1, r0, r1, cols: Math.ceil((c1 - c0) / base) + 1, rows: Math.ceil((r1 - r0) / base) + 1,
      hasLand: true, kind: 'land', min: 0, max: 100 };
  }
  const lod = context.window.NotoTerrainLOD.create({ metadata, descriptors, levels: [{ level: 0, step: base }], unavailable: new Set() });
  const planner = context.window.NotoTerrainRefinement.create({ lod, metadata });
  return { lod, planner, metadata, width, height };
}

function displayed(tiles) {
  return new Map(Array.from(tiles, tile => [tile.key, { tile, geometry: {} }]));
}

function assertCover(tiles, width, height) {
  const values = Array.from(tiles, value => value.tile || value);
  assert.ok(values.length, 'there is always visible terrain');
  assert.equal(new Set(values.map(tile => tile.key)).size, values.length, 'patch keys are unique');
  let covered = 0;
  for (let i = 0; i < values.length; i++) {
    const a = values[i];
    assert.ok(a.c0 >= 0 && a.r0 >= 0 && a.c1 <= width && a.r1 <= height, 'patch lies within the crop');
    assert.ok(a.c1 > a.c0 && a.r1 > a.r0, 'patch has positive area');
    covered += (a.c1 - a.c0) * (a.r1 - a.r0);
    for (let j = 0; j < i; j++) {
      const b = values[j];
      const overlap = Math.max(a.c0, b.c0) < Math.min(a.c1, b.c1) && Math.max(a.r0, b.r0) < Math.min(a.r1, b.r1);
      assert.equal(overlap, false, `patches ${a.key} and ${b.key} do not overlap`);
    }
  }
  assert.equal(covered, width * height, 'the full crop remains covered without holes');
}

function converge(input, live, desired, priority = () => 0) {
  const types = [];
  for (let i = 0; i < 512; i++) {
    const transaction = input.planner.next(live, desired, priority);
    if (!transaction) {
      assert.equal(input.planner.signature(live), input.planner.signature(desired), 'converges to exact target and seam context');
      return { live, types };
    }
    assert.equal(input.planner.isApplicable(transaction, live), true);
    assertCover(transaction.tiles, input.width, input.height);
    const before = input.planner.signature(live);
    assert.equal(transaction.beforeSignature, before);
    assert.notEqual(transaction.signature, before, 'every transaction makes progress');
    types.push(transaction.type);
    live = displayed(transaction.tiles);
    input.lod.commit(transaction.tiles);
  }
  assert.fail('progressive refinement did not converge');
}

test('every intermediate frontier preserves cropped coverage for all representative detail limits', async t => {
  for (const base of [1, 3, 5, 8, 128]) await t.test(`${base} m`, () => {
    const input = fixture(base);
    const desired = input.lod.decorate(input.lod.coarse(base, base));
    assertCover(desired, input.width, input.height);
    const result = converge(input, new Map(), desired);
    assert.equal(result.types[0], 'bootstrap');
    assert.ok(result.types.length > 0);
    assert.ok(Array.from(result.live.values()).every(item => item.tile.step === base));
    assert.ok(desired.some(tile => (tile.c1 - tile.c0) % base !== 0 || (tile.r1 - tile.r0) % base !== 0) || base === 1,
      'fixture exercises a shortened final grid interval');
  });
});

test('the highest-priority region refines before unrelated regions and invalidates neighboring seams', () => {
  const input = fixture(1, 1024, 512);
  const desired = input.lod.decorate(input.lod.coarse(1, 1));
  const previous = input.lod.decorate(input.lod.coarse(1, 4));
  const live = displayed(previous);
  const right = previous.find(tile => tile.c0 === 512);
  const left = previous.find(tile => tile.c0 === 0);
  const transaction = input.planner.next(live, desired, tile => tile.c0 >= 512 ? 100 : 1);
  assert.equal(transaction.type, 'split');
  assert.equal(transaction.region.key, right.key);
  assert.deepEqual(Array.from(transaction.removedKeys), [right.key]);
  assert.ok(transaction.addedKeys.length >= 4 && transaction.addedKeys.length <= 10, 'one bounded local subtree is prepared');
  assert.ok(transaction.tiles.filter(tile => transaction.addedKeys.includes(tile.key)).every(tile =>
    tile.c0 >= right.c0 && tile.c1 <= right.c1 && tile.r0 >= right.r0 && tile.r1 <= right.r1), 'replacement stays inside the selected parent');
  assert.ok(transaction.changedKeys.includes(left.key), 'neighbor is rebuilt with the new coarse/fine seam context');
  assert.equal(transaction.addedKeys.includes(left.key), false, 'neighbor keeps its topology key');
  assertCover(transaction.tiles, input.width, input.height);
});

test('camera target changes do not invalidate useful work, but displayed prerequisites and base changes do', () => {
  const input = fixture(1, 1024, 512);
  const firstTarget = input.lod.decorate(input.lod.coarse(1, 1));
  const live = displayed(input.lod.decorate(input.lod.coarse(1, 4)));
  const transaction = input.planner.next(live, firstTarget, tile => tile.c0 >= 512 ? 100 : 1);
  const changedTarget = input.lod.decorate(input.lod.coarse(1, 2));
  input.planner.next(live, changedTarget, tile => tile.c0 === 0 ? 100 : 1);
  assert.equal(input.planner.isApplicable(transaction, live, 1), true, 'camera-only target revisions cannot starve a valid replacement');
  assert.equal(input.planner.isApplicable(transaction, live, 3), false, 'new user detail base rejects incompatible work');
  const after = displayed(transaction.tiles);
  assert.equal(input.planner.isApplicable(transaction, after, 1), false, 'a transaction cannot be committed twice');
  const tampered = displayed(Array.from(live.values(), item => ({ ...item.tile })));
  const item = tampered.values().next().value;
  item.tile.cacheKey += '|changed-seam';
  assert.equal(input.planner.isApplicable(transaction, tampered, 1), false, 'changed seam prerequisites reject stale work');
  converge(input, after, changedTarget);
});

test('merging reclaims distant detail before moving the refinement budget elsewhere', () => {
  const input = fixture(1, 1024, 512);
  const coarse = input.lod.coarse(1, 4);
  const left = coarse.find(tile => tile.c0 === 0), right = coarse.find(tile => tile.c0 === 512);
  const fine = parent => input.lod.children(parent).flatMap(child => input.lod.children(child));
  const live = displayed(input.lod.decorate([...fine(left), right]));
  const desired = input.lod.decorate([left, ...fine(right)]);
  const transaction = input.planner.next(live, desired, tile => tile.c0 >= 512 ? 100 : 1);
  assert.equal(transaction.type, 'merge');
  assert.equal(transaction.region.key, left.key);
  assertCover(transaction.tiles, input.width, input.height);
  const result = converge(input, displayed(transaction.tiles), desired, tile => tile.c0 >= 512 ? 100 : 1);
  assert.ok(result.types.includes('split'));
});

test('native startup coverage and incompatible 3 m grids bootstrap to an aligned coarse frontier', () => {
  const input = fixture(1, 1307, 913);
  const native = displayed([{ key: 'native/128/0/0', virtual: false, c0: 0, c1: input.width, r0: 0, r1: input.height, step: 128 }]);
  const initialTarget = input.lod.decorate(input.lod.coarse(1, 1));
  const initial = input.planner.next(native, initialTarget);
  assert.equal(initial.type, 'bootstrap');
  assertCover(initial.tiles, input.width, input.height);
  assert.ok(initial.tiles.every(tile => tile.virtual && tile.key.startsWith('patch/1/')));
  const live = displayed(initial.tiles);
  const changedTarget = input.lod.decorate(input.lod.coarse(3, 3));
  const changed = input.planner.next(live, changedTarget);
  assert.equal(changed.type, 'bootstrap');
  assert.equal(changed.baseStep, 3);
  assert.ok(changed.tiles.every(tile => tile.key.startsWith('patch/3/')));
  assertCover(changed.tiles, input.width, input.height);
  converge(input, displayed(changed.tiles), changedTarget);
});

test('unchanged topology refreshes only stale seam signatures and then becomes idle', () => {
  const input = fixture(5);
  const desired = input.lod.decorate(input.lod.coarse(5, 5));
  const stale = desired.map((tile, index) => index ? tile : { ...tile, cacheKey: tile.cacheKey + '|stale' });
  const live = displayed(stale);
  const transaction = input.planner.next(live, desired);
  assert.equal(transaction.type, 'refresh');
  assert.deepEqual(Array.from(transaction.addedKeys), []);
  assert.deepEqual(Array.from(transaction.removedKeys), []);
  assert.deepEqual(Array.from(transaction.changedKeys), [desired[0].key]);
  assertCover(transaction.tiles, input.width, input.height);
  assert.equal(input.planner.next(displayed(transaction.tiles), desired), null);
  assert.equal(input.planner.next(live, []), null);
});


function cells(tiles) {
  return Array.from(tiles, value => value.tile || value).reduce((sum, tile) =>
    sum + Math.ceil((tile.c1 - tile.c0) / tile.step) * Math.ceil((tile.r1 - tile.r0) / tile.step), 0);
}

test('bounded subtree lookahead reaches nearby detail without exceeding three levels or ten leaves', () => {
  const input = fixture(1, 1024, 1024);
  const desired = input.lod.decorate(input.lod.coarse(1, 1));
  const previous = input.lod.decorate(input.lod.coarse(1, 8));
  const limits = { budget: cells(desired), limit: desired.length };
  const transaction = input.planner.next(displayed(previous), desired,
    tile => 1 / (1 + tile.c0 * tile.c0 + tile.r0 * tile.r0), limits);
  assert.equal(transaction.type, 'split');
  assert.equal(transaction.removedKeys.length, 1);
  assert.ok(transaction.addedKeys.length > 4 && transaction.addedKeys.length <= 10, 'lookahead batches a useful but bounded subtree');
  const replacements = transaction.tiles.filter(tile => transaction.addedKeys.includes(tile.key));
  const parent = transaction.region;
  assert.ok(replacements.every(tile => tile.step >= parent.step / 8), 'no branch descends more than three levels');
  assert.equal(Math.min(...replacements.map(tile => tile.step)), 1, 'priority branch reaches requested local detail');
  assert.ok(replacements.every(tile => tile.c0 >= parent.c0 && tile.c1 <= parent.c1 && tile.r0 >= parent.r0 && tile.r1 <= parent.r1));
  assert.ok(cells(transaction.tiles) <= limits.budget);
  assert.ok(transaction.tiles.length <= limits.limit);
  assertCover(transaction.tiles, input.width, input.height);
});

test('spare allocated capacity refines the nearby branch before merging distant detail', () => {
  const input = fixture(1, 1024, 512);
  const coarse = input.lod.coarse(1, 4);
  const left = coarse.find(tile => tile.c0 === 0), right = coarse.find(tile => tile.c0 === 512);
  const fineLeft = input.lod.children(left).flatMap(child => input.lod.children(child));
  const previous = input.lod.decorate([...fineLeft, right]);
  const desired = input.lod.decorate([left, ...input.lod.children(right)]);
  const live = displayed(previous), limits = { budget: 32 * 128 * 128, limit: 64 };
  assert.ok(desired.length < previous.length, 'new camera target uses fewer leaves than the displayed frontier');
  const transaction = input.planner.next(live, desired, tile => tile.c0 >= 512 ? 100 : 1, limits);
  assert.equal(transaction.type, 'split', 'actual allocated headroom avoids an unnecessary distant merge first');
  assert.equal(transaction.region.key, right.key);
  assert.ok(cells(transaction.tiles) <= limits.budget);
  assert.ok(transaction.tiles.length <= limits.limit);
  assertCover(transaction.tiles, input.width, input.height);
  for (const hard of [
    { budget: cells(previous), limit: limits.limit },
    { budget: limits.budget, limit: previous.length }
  ]) {
    const reclaim = input.planner.next(live, desired, tile => tile.c0 >= 512 ? 100 : 1, hard);
    assert.equal(reclaim.type, 'merge', 'hard allocation requires reclaiming distant detail');
    assert.equal(reclaim.region.key, left.key);
    assert.ok(cells(reclaim.tiles) <= hard.budget);
    assert.ok(reclaim.tiles.length <= hard.limit);
    assertCover(reclaim.tiles, input.width, input.height);
  }
});

test('hard cell and patch limits bound lookahead or suppress a split when nothing can be reclaimed', () => {
  const input = fixture(1, 1024, 1024);
  const desired = input.lod.decorate(input.lod.coarse(1, 1));
  const previous = input.lod.decorate(input.lod.coarse(1, 8));
  const live = displayed(previous);
  assert.equal(input.planner.next(live, desired, () => 1, { budget: cells(previous), limit: 384 }), null);
  assert.equal(input.planner.next(live, desired, () => 1, { budget: cells(desired), limit: 1 }), null);
  for (const allowed of [4, 7, 10]) {
    const limits = { budget: allowed * 128 * 128, limit: allowed };
    const transaction = input.planner.next(live, desired, () => 1, limits);
    assert.equal(transaction.type, 'split');
    assert.ok(cells(transaction.tiles) <= limits.budget, 'lookahead respects the allocated cell ceiling');
    assert.ok(transaction.tiles.length <= limits.limit, 'lookahead respects the allocated patch ceiling');
    assert.equal(transaction.addedKeys.length, allowed, 'uses the available bounded local work');
    assertCover(transaction.tiles, input.width, input.height);
  }
});
