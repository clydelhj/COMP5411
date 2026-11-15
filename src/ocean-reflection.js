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

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function smooth(low, high, value) {
    const t = clamp((value - low) / (high - low), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Integrate albedo in linear RGB once at setup. A bounded stratified sample of each
  // source photograph replaces its subpixel detail, without inventing a coast-wide tint.
  function createAlbedoSampler(THREE, shared) {
    const image = shared?.textureSet?.color?.image;
    const classes = shared?.layerTexture?.image?.data;
    const fallback = new THREE.Color('#756a56').toArray();
    if (!image?.data || !classes || !shared?.palette) return () => fallback;
    const samplesX = Math.min(64, image.width), samplesY = Math.min(64, image.height);
    const linear = Float32Array.from({ length: 256 }, (_, i) => {
      const s = i / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    const means = Array.from({ length: image.depth }, (_, layer) => {
      const sum = [0, 0, 0];
      for (let row = 0; row < samplesY; row++) for (let col = 0; col < samplesX; col++) {
        const x = Math.floor((col + 0.5) * image.width / samplesX);
        const y = Math.floor((row + 0.5) * image.height / samplesY);
        const offset = ((layer * image.height + y) * image.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) sum[channel] += linear[image.data[offset + channel]];
      }
      const color = sum.map(value => value / (samplesX * samplesY));
      const tint = shared.palette.colors[layer]?.toArray() || fallback;
      const luminance = color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
      const tintLuminance = tint[0] * 0.299 + tint[1] * 0.587 + tint[2] * 0.114;
      return color.map((value, channel) => value
        * (0.66 + 0.34 * clamp(tint[channel] / Math.max(tintLuminance, 0.001), 0.55, 1.65))
        * (0.82 + 0.18 * clamp(luminance / 0.52, 0.72, 1.28)));
    });
    const weights = (position, halfWidth) => {
      const nearest = Math.floor(position + 0.5), delta = position - nearest;
      const lower = smooth(-halfWidth, halfWidth, -0.5 - delta);
      const upper = smooth(-halfWidth, halfWidth, 0.5 - delta);
      return [nearest, [lower, upper - lower, 1 - upper]];
    };
    return (x, z, height) => {
      const { cols, rows, levels, width, height: extent } = shared;
      const latticeX = clamp(x / width + 0.5, 0, 1) * (cols - 1);
      const latticeZ = clamp(z / extent + 0.5, 0, 1) * (rows - 1);
      // Match the surface shader's categorical blend kernel, including shallow strata.
      const [cx, wx] = weights(latticeX, Math.max(0.00001, Math.min(0.9, 192 * (cols - 1) / width)));
      const [cz, wz] = weights(latticeZ, Math.max(0.00001, Math.min(0.9, 192 * (rows - 1) / extent)));
      const [, wy] = weights(0, Math.max(0.00001, Math.min(0.9, 9.6 * (levels - 1) / Math.max(height + 100, 1))));
      const result = [0, 0, 0];
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const weight = wx[dx + 1] * wy[dy + 1] * wz[dz + 1];
        if (weight <= 0.00001) continue;
        const index = ((clamp(cz + dz, 0, rows - 1) * levels + clamp(dy, 0, levels - 1)) * cols + clamp(cx + dx, 0, cols - 1)) * 2;
        const color = means[classes[index]] || fallback;
        for (let channel = 0; channel < 3; channel++) result[channel] += weight * color[channel];
      }
      return result;
    };
  }

  function create({ THREE, renderer, camera, terrain, metadata, surfaceMaterials = null, coastalField = null }) {
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
      color: 0xffffff,
      vertexColors: true,
      side: THREE.FrontSide,
      fog: false,
      toneMapped: false
    });
    material.name = 'Source-albedo terrain reflection';
    const albedoAt = createAlbedoSampler(THREE, surfaceMaterials);
    const cover = surfaceMaterials?.groundCover;
    const grass = surfaceMaterials?.grass;
    const grassVisibility = surfaceMaterials?.grassVisibility || { value: 1 };
    let observedGrassVisibility = grassVisibility.value;
    // The existing small proxy pass uses one cover read and, when present, two grass
    // reads. Main-view terrain shaders and their detailed meshes are never rendered here.
    if (cover) material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, {
        uReflectionCover: { value: cover },
        uReflectionExtent: { value: new THREE.Vector2(surfaceMaterials.width, surfaceMaterials.height) },
        uReflectionGrassVisibility: grassVisibility
      });
      if (grass) Object.assign(shader.uniforms, {
        uReflectionGrassMask: { value: grass.mask }, uReflectionGrassColor: { value: grass.color }
      });
      const varyings = 'varying vec3 vReflectionPosition; varying float vReflectionSlope;';
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + varyings)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvReflectionPosition=position; vReflectionSlope=abs(normalize(normal).y);');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        ${varyings}
        uniform sampler2D uReflectionCover;
        uniform vec2 uReflectionExtent;
        uniform float uReflectionGrassVisibility;
        ${grass ? `uniform sampler2D uReflectionGrassMask;
          uniform sampler2D uReflectionGrassColor;
          ${global.NotoGroundGrass?.shaderDeclarations || 'float grassPatchCoverage(vec2 p) { return 0.6; }'}` : ''}`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec2 coverUv=vReflectionPosition.xz/uReflectionExtent+0.5;
        vec4 coverColor=texture2D(uReflectionCover,coverUv);
        float slopeCoverage=smoothstep(0.5,0.819152,vReflectionSlope);
        float geologyBrightness=clamp(dot(diffuseColor.rgb,vec3(0.299,0.587,0.114))*2.0,0.65,1.25);
        diffuseColor.rgb=mix(diffuseColor.rgb,coverColor.rgb*geologyBrightness*0.98,
          coverColor.a*slopeCoverage*uReflectionGrassVisibility);
        ${grass ? `
          float grassPatch=grassPatchCoverage(vReflectionPosition.xz);
          float grassCoverage=texture2D(uReflectionGrassMask,coverUv).r*grassPatch*slopeCoverage
            *smoothstep(1.5,3.0,vReflectionPosition.y)*uReflectionGrassVisibility;
          vec3 grassColor=textureLod(uReflectionGrassColor,vec2(0.5),20.0).rgb;
          float grassLuminance=dot(grassColor,vec3(0.2126,0.7152,0.0722));
          grassColor=mix(grassColor*0.88,grassLuminance*vec3(0.48,0.94,0.29),0.50+0.34*grassPatch);
          diffuseColor.rgb=mix(diffuseColor.rgb,grassColor*0.96,grassCoverage);` : ''}`);
    };
    material.customProgramCacheKey = () => `noto-coast-reflection-albedo-${Boolean(cover)}-${Boolean(grass)}`;
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
        const colors = new Float32Array(positions.length);
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
            const distance = coastalField?.distance(x, z);
            const displayHeight = Number.isFinite(distance) && global.NotoCoastalGeometry?.contactHeight
              ? global.NotoCoastalGeometry.contactHeight(height, distance) : height;
            positions[vertex * 3 + 1] = Number.isFinite(displayHeight) ? Math.max(0, displayHeight) : 0;
            positions[vertex * 3 + 2] = Number.isFinite(z) ? z : 0;
            colors.set(albedoAt(x, z, height), vertex * 3);
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
        buffer.setAttribute('color', new THREE.BufferAttribute(colors, 3));
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
      const key = JSON.stringify([state.direction, state.sunColor, state.sunIntensity, state.skyColor,
        state.hemisphereColor, state.hemisphereGroundColor, state.hemisphereIntensity, state.elevation, state.weather]);
      if (key === lightingKey) return;
      lightingKey = key;
      const daylight = Math.max(0.025, Math.min(1, ((state.elevation ?? 30) + 7) / 22));
      if (state.sunColor?.length >= 3) sun.color.fromArray(state.sunColor);
      sun.intensity = Math.max(0, state.sunIntensity ?? 2);
      if (state.direction?.length >= 3) sun.position.fromArray(state.direction).multiplyScalar(1000);
      else sun.position.set(-300, 900, -200);
      const ambientColor = state.hemisphereColor || state.skyColor;
      if (ambientColor?.length >= 3) ambient.color.fromArray(ambientColor);
      if (state.hemisphereGroundColor?.length >= 3) ambient.groundColor.fromArray(state.hemisphereGroundColor);
      ambient.intensity = state.hemisphereIntensity ?? (0.10 + daylight * 1.4);
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
        // Render-target viewports are already physical pixels; setViewport would apply canvas DPR again.
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
      if (observedGrassVisibility !== grassVisibility.value) {
        observedGrassVisibility = grassVisibility.value;
        invalidate('Ground cover visibility changed');
      }
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
        albedoMode: surfaceMaterials ? 'source-texture-means-and-cover' : 'neutral-fallback',
        coverTextureReads: cover ? (grass ? 3 : 1) : 0,
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
