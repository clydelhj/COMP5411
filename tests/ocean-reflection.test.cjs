'use strict';

// Inspect the bounded proxy with real Three.js classes but no browser or GPU allocation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');

test('terrain reflection preserves source albedo, contact height, lighting and cache reuse', async () => {
  const root = path.resolve(__dirname, '..'), runtime = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/three-libraries.js'), 'utf8'), runtime);
  const packed = runtime.window.NOTO_LIBRARIES.core;
  const source = zlib.gunzipSync(Buffer.from(Array.isArray(packed) ? packed.join('') : packed, 'base64'));
  const THREE = await import('data:text/javascript;base64,' + source.toString('base64'));
  for (const file of ['coastal-geometry.js', 'ocean-reflection.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), runtime);
  }
  const pixels = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 64, 64, 64, 255, 64, 64, 64, 255]);
  const classes = Uint8Array.from({ length: 16 }, (_, index) => index % 2 ? 0 : (Math.floor(index / 2) % 2));
  const surfaceMaterials = {
    textureSet: { color: new THREE.DataArrayTexture(pixels, 2, 1, 2) },
    layerTexture: new THREE.Data3DTexture(classes, 2, 2, 2),
    palette: { colors: [new THREE.Color(0xffffff), new THREE.Color(0xffffff)] },
    cols: 2, rows: 2, levels: 2, width: 200, height: 200,
    grassVisibility: { value: 1 }
  };
  let capturedScene, captures = 0, renderTarget = null;
  const renderer = {
    info: { autoReset: true, render: { calls: 0 } }, xr: { enabled: false }, autoClear: true,
    getRenderTarget: () => renderTarget,
    setRenderTarget: target => { renderTarget = target; },
    getViewport: value => value.set(0, 0, 800, 600), setViewport: () => {},
    getScissor: value => value.set(0, 0, 800, 600), setScissor: () => {},
    getScissorTest: () => false, setScissorTest: () => {},
    getClearColor: value => value.set(0), getClearAlpha: () => 1, setClearColor: () => {},
    render: scene => { capturedScene = scene; captures++; }
  };
  const camera = new THREE.PerspectiveCamera(42, 4 / 3, 1, 10000);
  camera.position.set(200, 20, 0); camera.lookAt(-100, 10, 0); camera.updateMatrixWorld(true);
  const terrain = new THREE.Group(); terrain.updateMatrixWorld(true);
  const reflection = runtime.window.NotoOceanReflection.create({ THREE, renderer, camera, terrain,
    metadata: { width_m: 200 }, surfaceMaterials, coastalField: { distance: x => x } });
  try {
    reflection.setTerrain([{ heights: new Float32Array(9).fill(20), landCells: new Uint8Array(4).fill(1),
      heightQuery: { rows: 3, cols: 3, xs: [-100, 0, 100], zs: [-100, 0, 100] } }]);
    reflection.setLighting({ direction: [0, 1, 0], sunIntensity: 3, sunColor: [1, 0.9, 0.8],
      hemisphereColor: [0.4, 0.5, 0.6], hemisphereGroundColor: [0.1, 0.2, 0.3], hemisphereIntensity: 1.5 });
    assert.equal(reflection.update({ now: 1000 }), true);
    const proxy = capturedScene.children.find(child => child.isGroup);
    assert.equal(proxy.children.length, 1);
    const mesh = proxy.children[0], position = mesh.geometry.attributes.position, color = mesh.geometry.attributes.color;
    assert.equal(position.getY(0), 20, 'offshore contact profile leaves inland height unchanged');
    assert.equal(position.getY(1), 0, 'shore height agrees with the displayed contact profile');
    assert.equal(position.getY(2), 0, 'coarse water-side vertices do not form raised reflected walls');
    assert(color.getX(0) > color.getX(2) + 0.2, 'different geology reflects its own source albedo');
    assert(color.getX(0) > 0.4, 'black/white source texture is averaged after sRGB decoding');
    assert([...color.array].every(Number.isFinite));
    assert.equal(capturedScene.children.find(child => child.isDirectionalLight).intensity, 3);
    const ambient = capturedScene.children.find(child => child.isHemisphereLight);
    assert.equal(ambient.intensity, 1.5);
    assert.deepEqual(ambient.groundColor.toArray(), [0.1, 0.2, 0.3]);
    assert.equal(reflection.update({ now: 1200 }), false);
    assert.equal(captures, 1, 'unchanged view does not recapture');
    surfaceMaterials.grassVisibility.value = 0;
    assert.equal(reflection.update({ now: 1400 }), true, 'cover visibility invalidates the existing cache');
    assert(reflection.getState().proxyTriangles <= 150000);
    assert.equal(renderTarget, null, 'proxy pass restores the caller render target');
  } finally {
    reflection.dispose(); surfaceMaterials.textureSet.color.dispose(); surfaceMaterials.layerTexture.dispose();
  }
});
