'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
require('../src/data-source.js');

function memoryDirectory(files) {
  return {
    kind: 'directory', name: 'sample',
    async getDirectoryHandle(name) {
      const entry = files[name];
      if (!entry || typeof entry !== 'object') throw new Error('Missing directory: ' + name);
      return memoryDirectory(entry);
    },
    async getFileHandle(name) {
      if (typeof files[name] !== 'string') throw new Error('Missing file: ' + name);
      return { getFile: async () => new Blob([files[name]]) };
    },
    async *[Symbol.asyncIterator]() {
      for (const [name, value] of Object.entries(files)) yield [name, {kind: typeof value === 'string' ? 'file' : 'directory'}];
    }
  };
}

function example() {
  const pack = size => gzipSync(Buffer.alloc(size)).toString('base64');
  const layer = (name, obj) => '// Generated data.\nwindow.' + name + ' = ' + JSON.stringify(obj) + ';';
  const bounds = [100, 200, 130, 230], crs = 'EPSG:6675';
  const m = { source_width: 4, source_height: 4, source_spacing_m: [10, 10], width_m: 30, height_m: 30,
    display_centers: {left:100, bottom:200, right:130, top:230}, origin_easting:115, origin_northing:215,
    baseElevation:-100, quantization_m:0.01, elevation_max_m:3, crs, geographicCenter:{latitude:35, longitude:140} };
  const tile = {level:0, x:0, z:0, rows:4, cols:4, c0:0, c1:3, r0:0, r1:3, kind:'land', file:'L0/0_0.js'};
  const heights = pack(32), strataData = pack(8);
  const manifest = {metadata:m, tileCells:256, levels:[{level:0,step:1,tilesX:1,tilesZ:1}],
    tiles:{'0/0/0':tile}, oceanMask:{rows:2,cols:2,step:2,bits:pack(1)}};
  const strata = {metadata:{width_m:30,height_m:30,bounds,crs,rows:2,cols:2,levels:2},ids:strataData};
  const coast = {widthM:30,heightM:30,bounds,crs,cellM:15,rows:2,cols:2,distances:pack(8),coastalHeights:pack(8)};
  const vegetation = {rows:2,columns:2,bounds,crs,classes:pack(4)};
  return {'terrain-1m':{'manifest.js':layer('NOTO_TILESET',manifest),L0:{'0_0.js':
    'window.NOTO_TILE_RECEIVE("0/0/0",{"rows":4,"cols":4,"heights":"' + heights.slice(0,10) + '"\n+ "' + heights.slice(10) + '"});'}},
    'shoreline-data.js':layer('NOTO_SHORELINE',coast),'vegetation-data.js':layer('NOTO_VEGETATION',vegetation),
    'strata-data.js':layer('NOTO_STRATA',strata).replace('"'+strataData+'"','["'+strataData.slice(0,8)+'","'+strataData.slice(8)+'"].join("")')};
}

test('reads generated geographic layers and split-string tiles without executing scripts', async () => {
  const files = example();
  const source = await NotoDataSource.openPackage(memoryDirectory(files), true);
  const tile = await source.tilePayload({...source.tileset.tiles['0/0/0'],key:'0/0/0'});
  assert.equal(tile.rows,4);
  files['strata-data.js'] += '\nglobalThis.externalLayerRan=true;';
  await assert.rejects(NotoDataSource.openPackage(memoryDirectory(files), true));
  assert.equal(globalThis.externalLayerRan, undefined);
});

test('rejects a shifted classification grid, an incomplete tileset, or the wrong raster payload size', async () => {
  const shifted = example();
  shifted['vegetation-data.js'] = shifted['vegetation-data.js'].replace('[100,200,130,230]','[101,200,131,230]');
  await assert.rejects(NotoDataSource.openPackage(memoryDirectory(shifted), true), /bounds differ/);
  const missing = example(); delete missing['terrain-1m'].L0['0_0.js'];
  await assert.rejects(NotoDataSource.openPackage(memoryDirectory(missing), true), /Missing terrain tile/);
  const broken = example(); broken['vegetation-data.js'] = broken['vegetation-data.js'].replace('"rows":2','"rows":5');
  await assert.rejects(NotoDataSource.openPackage(memoryDirectory(broken), true), /vegetation size/);
});
