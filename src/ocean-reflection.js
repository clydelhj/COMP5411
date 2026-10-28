/* A cached, terrain-only planar reflection. Camera/projective math follows the MIT-licensed
 * Three.js r186 Reflector: https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/Reflector.js
 * The retained THREE-LICENSE.txt contains the Three.js license notice.
 */
(function registerOceanReflection(global) {
  'use strict';

  const WIDTH = 512;
  const HEIGHT = 288;
  const MAX_TRIANGLES = 150000;
  const UPDATE_INTERVAL_MS = 100;
  const SETTLING_FRAMES = 8;

  function create({ THREE, renderer, camera, terrain, metadata }) {
    const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    empty.name = 'Empty terrain reflection';
    empty.needsUpdate = true;
    const uniforms = {
      uSeaReflection: { value: empty },
      uSeaReflectionMatrix: { value: new THREE.Matrix4() },
      uSeaReflectionEnabled: { value: 0 }
    };
    const scene = new THREE.Scene();
    const proxy = new THREE.Group();
    proxy.name = 'Coarse reflection-only terrain';
    proxy.matrixAutoUpdate = false;
    scene.add(proxy);
    const material = new THREE.MeshLambertMaterial({
      color: 0x5b6250,
      side: THREE.FrontSide,
      fog: false,
      toneMapped: false
    });
    material.name = 'Coarse terrain reflection shading';
    const ambient = new THREE.HemisphereLight(0xc5d4dc, 0x44483a, 0.65);
    const sun = new THREE.DirectionalLight(0xfff1d4, 1.15);
    scene.add(ambient, sun, sun.target);
    const reflectedCamera = new THREE.PerspectiveCamera();
    const position = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const up = new THREE.Vector3();
    const target = new THREE.Vector3();
    const rotation = new THREE.Matrix4();
    const observedCamera = new THREE.Matrix4();
    const observedProjection = new THREE.Matrix4();
    const observedTerrain = new THREE.Matrix4();
    const identity = new THREE.Matrix4();
    let observed = false;
    let renderTarget = null;
    let disposed = false;
    let failed = false;
    let reason = 'No coarse terrain';
    let pending = false;
    let settling = 0;
    let waterVisible = false;
    let captures = 0;
    let proxyTriangles = 0;
    let lastCapture = -Infinity;
    let lightingKey = '';

    function invalidate(nextReason = 'Terrain reflection changed') {
      if (disposed || failed || !proxyTriangles) return;
      pending = true;
      settling = SETTLING_FRAMES;
      reason = nextReason;
    }

    function clearProxy() {
      for (const child of [...proxy.children]) {
        proxy.remove(child);
        child.geometry.dispose();
      }
      proxyTriangles = 0;
    }

    /* Read the original coarse grid, never the coastal refinement mesh. The latter can
     * contain millions of triangles even when its parent tile is labelled 128 m.
     */
    function gridInfo(item) {
      const geometry = item?.geometry || item;
      const info = geometry?.metadata || {};
      const query = geometry?.heightQuery;
      const rows = query?.rows || info.sample_rows;
      const cols = query?.cols || info.sample_cols;
      if (!(rows >= 2 && cols >= 2) || !geometry?.heights || geometry.heights.length < rows * cols) return null;
      const origin = info.heightOrigin;
      const step = info.step;
      if (!(query?.xs?.length >= cols && query?.zs?.length >= rows) &&
          !(origin?.length >= 2 && step?.length >= 2)) return null;
      return { geometry, info, query, rows, cols };
    }

    function setTerrain(map) {
      if (disposed || failed) return;
      clearProxy();
      const values = map?.values ? Array.from(map.values()) : Array.isArray(map) ? map : [];
      const grids = values.map(gridInfo).filter(Boolean);
      const cellCount = grids.reduce((sum, grid) => sum + (grid.rows - 1) * (grid.cols - 1), 0);
      const stride = Math.max(1, Math.ceil(Math.sqrt(cellCount * 2 / MAX_TRIANGLES)));
      for (const grid of grids) {
        if (proxyTriangles >= MAX_TRIANGLES) break;
        const { geometry, info, query, rows, cols } = grid;
        const axis = count => {
          const indices = [];
          for (let index = 0; index < count - 1; index += stride) indices.push(index);
          indices.push(count - 1);
          return indices;
        };
        const rowAxis = axis(rows);
        const colAxis = axis(cols);
        const positions = new Float32Array(rowAxis.length * colAxis.length * 3);
        const valid = new Uint8Array(rowAxis.length * colAxis.length);
        const xs = query?.xs;
        const zs = query?.zs;
        const coordinate = (index, component) => {
          const exact = component === 0 ? xs : zs;
          if (exact) return exact[index];
          const offset = index * info.step[component];
          return info.heightOrigin[component] + Math.min(offset, info.heightExtent?.[component] ?? offset);
        };
        for (let row = 0; row < rowAxis.length; row++) {
          for (let col = 0; col < colAxis.length; col++) {
            const vertex = row * colAxis.length + col;
            const height = geometry.heights[rowAxis[row] * cols + colAxis[col]];
            const x = coordinate(colAxis[col], 0);
            const z = coordinate(rowAxis[row], 1);
            valid[vertex] = Number.isFinite(height) && Number.isFinite(x) && Number.isFinite(z) ? 1 : 0;
            positions[vertex * 3] = Number.isFinite(x) ? x : 0;
            positions[vertex * 3 + 1] = Number.isFinite(height) ? Math.max(0.02, height) : 0.02;
            positions[vertex * 3 + 2] = Number.isFinite(z) ? z : 0;
          }
        }
        const indices = [];
        for (let row = 0; row < rowAxis.length - 1; row++) {
          for (let col = 0; col < colAxis.length - 1; col++) {
            if (proxyTriangles + 2 > MAX_TRIANGLES) break;
            const sourceRow = Math.floor((rowAxis[row] + rowAxis[row + 1] - 1) / 2);
            const sourceCol = Math.floor((colAxis[col] + colAxis[col + 1] - 1) / 2);
            if (geometry.landCells && !geometry.landCells[sourceRow * (cols - 1) + sourceCol]) continue;
            const a = row * colAxis.length + col;
            const b = a + 1;
            const c = a + colAxis.length;
            const d = c + 1;
            if (!(valid[a] && valid[b] && valid[c] && valid[d])) continue;
            indices.push(a, c, b, b, c, d);
            proxyTriangles += 2;
          }
        }
        if (!indices.length) continue;
        const buffer = new THREE.BufferGeometry();
        buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        buffer.setIndex(indices);
        buffer.computeVertexNormals();
        buffer.computeBoundingSphere();
        const mesh = new THREE.Mesh(buffer, material);
        mesh.name = 'Original coarse heightfield reflection proxy';
        proxy.add(mesh);
      }
      observed = false;
      if (proxyTriangles) {
        invalidate('Coarse terrain proxy ready');
      } else {
        uniforms.uSeaReflectionEnabled.value = 0;
        pending = false;
        settling = 0;
        reason = 'No valid coarse land cells';
      }
    }

    function setLighting(state = {}) {
      if (disposed || failed) return;
      const key = JSON.stringify([state.direction, state.sunColor, state.sunIntensity, state.skyColor, state.elevation, state.weather]);
      if (key === lightingKey) return;
      lightingKey = key;
      const daylight = Math.max(0.025, Math.min(1, ((state.elevation ?? 30) + 7) / 22));
      if (state.sunColor?.length >= 3) sun.color.fromArray(state.sunColor);
      sun.intensity = Math.max(0, Math.min(2.0, (state.sunIntensity ?? 2) * 0.5));
      if (state.direction?.length >= 3) sun.position.fromArray(state.direction).multiplyScalar(1000);
      else sun.position.set(-300, 900, -200);
      if (state.skyColor?.length >= 3) ambient.color.fromArray(state.skyColor);
      ambient.intensity = 0.18 + daylight * 0.65;
      invalidate('Lighting changed');
    }

    function prepareCamera() {
      // Reflect the eye, forward point and camera up across Y=0. Only owned matrices change.
      position.setFromMatrixPosition(camera.matrixWorld);
      rotation.extractRotation(camera.matrixWorld);
      direction.set(0, 0, -1).applyMatrix4(rotation);
      target.copy(position).add(direction);
      reflectedCamera.position.set(position.x, -position.y, position.z);
      target.y = -target.y;
      up.set(0, 1, 0).applyMatrix4(rotation);
      up.y = -up.y;
      reflectedCamera.up.copy(up);
      reflectedCamera.lookAt(target);
      reflectedCamera.near = camera.near;
      reflectedCamera.far = camera.far;
      reflectedCamera.projectionMatrix.copy(camera.projectionMatrix);
      reflectedCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      reflectedCamera.updateMatrixWorld(true);
      uniforms.uSeaReflectionMatrix.value.set(
        0.5, 0, 0, 0.5,
        0, 0.5, 0, 0.5,
        0, 0, 0.5, 0.5,
        0, 0, 0, 1
      ).multiply(reflectedCamera.projectionMatrix).multiply(reflectedCamera.matrixWorldInverse);
    }

    function capture() {
      if (!renderTarget) {
        renderTarget = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, {
          minFilter: THREE.LinearMipmapLinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthBuffer: true,
          stencilBuffer: false,
          generateMipmaps: true
        });
        renderTarget.texture.name = 'Cached coarse terrain reflection';
        renderTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
      }
      const saved = {
        target: renderer.getRenderTarget(),
        cubeFace: renderer.getActiveCubeFace?.() ?? 0,
        mipLevel: renderer.getActiveMipmapLevel?.() ?? 0,
        viewport: renderer.getViewport(new THREE.Vector4()),
        scissor: renderer.getScissor(new THREE.Vector4()),
        scissorTest: renderer.getScissorTest(),
        clearColor: renderer.getClearColor(new THREE.Color()),
        clearAlpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear,
        infoAutoReset: renderer.info.autoReset,
        renderInfo: { ...renderer.info.render },
        xrEnabled: renderer.xr?.enabled
      };
      try {
        if (renderer.xr) renderer.xr.enabled = false;
        renderer.info.autoReset = false;
        renderer.autoClear = true;
        renderer.setRenderTarget(renderTarget);
        renderer.setViewport(0, 0, WIDTH, HEIGHT);
        renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 0);
        renderer.render(scene, reflectedCamera);
      } finally {
        renderer.setRenderTarget(saved.target, saved.cubeFace, saved.mipLevel);
        renderer.setViewport(saved.viewport);
        renderer.setScissor(saved.scissor);
        renderer.setScissorTest(saved.scissorTest);
        renderer.setClearColor(saved.clearColor, saved.clearAlpha);
        renderer.autoClear = saved.autoClear;
        renderer.info.autoReset = saved.infoAutoReset;
        Object.assign(renderer.info.render, saved.renderInfo);
        if (renderer.xr) renderer.xr.enabled = saved.xrEnabled;
      }
      uniforms.uSeaReflection.value = renderTarget.texture;
      uniforms.uSeaReflectionEnabled.value = 1;
    }

    function update({ now = 0, waterVisible: visible = true } = {}) {
      waterVisible = visible;
      if (disposed || failed || !proxyTriangles || !visible) return false;
      const transform = terrain?.matrixWorld || identity;
      if (!observed || !observedCamera.equals(camera.matrixWorld) ||
          !observedProjection.equals(camera.projectionMatrix) || !observedTerrain.equals(transform)) {
        observedCamera.copy(camera.matrixWorld);
        observedProjection.copy(camera.projectionMatrix);
        observedTerrain.copy(transform);
        observed = true;
        invalidate('View or terrain scale changed');
      }
      if (!pending) return false;
      settling = Math.max(0, settling - 1);
      // At rest the last allowed settling frame captures the final view, even at low frame rates.
      if (now - lastCapture < UPDATE_INTERVAL_MS && settling > 0) return false;
      try {
        proxy.matrix.copy(transform);
        prepareCamera();
        capture();
        captures++;
        lastCapture = now;
        pending = false;
        settling = 0;
        reason = 'Cached terrain reflection';
        return true;
      } catch (error) {
        failed = true;
        pending = false;
        settling = 0;
        uniforms.uSeaReflection.value = empty;
        uniforms.uSeaReflectionEnabled.value = 0;
        reason = `Reflection disabled: ${error?.message || String(error)}`;
        console.warn(reason);
        return false;
      }
    }

    return {
      uniforms,
      setTerrain,
      setLighting,
      invalidate,
      update,
      needsFrame: () => !disposed && !failed && waterVisible && pending && settling > 0,
      getState: () => ({
        mode: 'cached-coarse-planar',
        supported: !failed && !disposed,
        active: uniforms.uSeaReflectionEnabled.value === 1,
        reason,
        width: WIDTH,
        height: HEIGHT,
        proxyTriangles,
        proxyMeshes: proxy.children.length,
        captures,
        pending,
        settlingFrames: settling,
        lastCaptureMs: Number.isFinite(lastCapture) ? lastCapture : null,
        // RGBA8 mip chain plus a conservative 32-bit depth attachment; depth has no mip chain.
        targetMiB: WIDTH * HEIGHT * (4 * 4 / 3 + 4) / 1048576,
        sourceWidthM: metadata?.width_m ?? null
      }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        pending = false;
        uniforms.uSeaReflection.value = empty;
        uniforms.uSeaReflectionEnabled.value = 0;
        clearProxy();
        renderTarget?.dispose();
        material.dispose();
        empty.dispose();
      }
    };
  }
  global.NotoOceanReflection = { create };
})(window);
