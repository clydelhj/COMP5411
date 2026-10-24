// Visual grass cover on soil; source classes, strata and DEM are unchanged.
(function registerGroundGrass(global) {
  'use strict';

  const HERBS = new Set([5, 6, 7, 10, 12, 13, 14, 15, 16, 17]);
  const WOODS = new Set([8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  const SPACING_M = 0.8,
    RADIUS_M = 80,
    LIMIT = 34000;
  const smooth = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  function seed(i, j, salt = 0) {
    let n = Math.imul(i ^ 0x45d9f3b, 374761393) ^ Math.imul(j + salt * 1013, 668265263);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967296;
  }
  async function prepare(THREE, vegetation, strata) {
    /*
     * Inputs: vegetation lookup, first stratum and material families. Returns shared grass textures
     * and coverage queries. Retain the observed herb/woodland extent; bare class 3 receives
     * illustrative grass only for the soil family. This appearance layer is not written to GIS and
     * does not convert rock, beaches or urban areas to grassland.
     */
    const {
      width,
      height
    } = vegetation;
    const columns = Math.ceil(width / 20),
      rows = Math.ceil(height / 20);
    const values = new Float32Array(columns * rows),
      allowed = new Float32Array(values.length);
    const {
      cols,
      rows: layerRows,
      levels
    } = strata.metadata;
    const soils = new Set(strata.palette.filter(p => p.family === 'soil').map(p => p.id));
    function soilAt(u, v) {
      const x = Math.max(0, Math.min(cols - 1.000001, u * (cols - 1)));
      const z = Math.max(0, Math.min(layerRows - 1.000001, v * (layerRows - 1)));
      const c = Math.floor(x),
        r = Math.floor(z),
        tx = smooth(0, 1, x - c),
        tz = smooth(0, 1, z - r);
      const at = (a, b) => soils.has(strata.ids[b * levels * cols + a]) ? 1 : 0;
      return (at(c, r) * (1 - tx) + at(c + 1, r) * tx) * (1 - tz) + (at(c, r + 1) * (1 - tx) + at(c + 1, r + 1) * tx) * tz;
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      const u = (c + 0.5) / columns,
        v = (r + 0.5) / rows;
      const category = vegetation.categoryAt((u - 0.5) * width, (v - 0.5) * height);
      const i = r * columns + c;
      allowed[i] = HERBS.has(category) || WOODS.has(category) ? 1 : category === 3 ? soilAt(u, v) : 0;
      values[i] = HERBS.has(category) ? 0.94 : WOODS.has(category) ? 0.62 : 0.68 * allowed[i];
    }
    // Use an approximately 40 m continuous grass transition, independently of the broader geological material blend.
    const scratch = new Float32Array(values.length);
    for (let pass = 0; pass < 3; pass++) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
        const i = r * columns + c;
        scratch[i] = (values[i] * 2 + values[r * columns + Math.max(0, c - 1)] + values[r * columns + Math.min(columns - 1, c + 1)]) / 4;
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
        const i = r * columns + c;
        values[i] = (scratch[i] * 2 + scratch[Math.max(0, r - 1) * columns + c] + scratch[Math.min(rows - 1, r + 1) * columns + c]) / 4;
      }
    }
    const bytes = Uint8Array.from(values, (v, i) => Math.round(v * allowed[i] * 255));
    const mask = new THREE.DataTexture(bytes, columns, rows, THREE.RedFormat);
    mask.minFilter = THREE.LinearMipmapLinearFilter;
    mask.magFilter = THREE.LinearFilter;
    mask.generateMipmaps = true;
    mask.unpackAlignment = 1;
    mask.needsUpdate = true;
    const loader = new THREE.TextureLoader();
    const color = await loader.loadAsync(global.NOTO_GRASS_TEXTURES.color);
    const normal = await loader.loadAsync(global.NOTO_GRASS_TEXTURES.normal);
    color.colorSpace = THREE.SRGBColorSpace;
    for (const texture of [color, normal]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 4;
    }
    function coverageAt(x, z) {
      const u = (x + width / 2) / width * columns - 0.5,
        v = (z + height / 2) / height * rows - 0.5;
      if (u < 0 || v < 0 || u >= columns - 1 || v >= rows - 1) return 0;
      const category = vegetation.categoryAt(x, z);
      if (!HERBS.has(category) && !WOODS.has(category) && category !== 3) return 0;
      const c = Math.floor(u),
        r = Math.floor(v),
        tx = u - c,
        tz = v - r,
        i = r * columns + c;
      return ((bytes[i] * (1 - tx) + bytes[i + 1] * tx) * (1 - tz) + (bytes[i + columns] * (1 - tx) + bytes[i + columns + 1] * tx) * tz) / 255;
    }
    return {
      mask,
      color,
      normal,
      coverageAt,
      width,
      height
    };
  }
  function create({
    THREE,
    scene,
    camera,
    data,
    sampleHeight,
    time
  }) {
    /*
     * Use fixed 0.8 m planting positions with 12/6/3-blade geometry and at most three draw calls;
     * individual blades cast no shadows. The vegetation scheduler prepares placement in bounded
     * slices, commits a complete set, and advances wind through the shared sleep clock.
     */
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      side: THREE.DoubleSide
    });
    material.onBeforeCompile = shader => {
      shader.uniforms.uGrassTime = time;
      shader.uniforms.uGrassCamera = {
        value: camera.position
      };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        attribute vec2 grassRoot;
        attribute vec2 grassSlope;
        uniform float uGrassTime;
        uniform vec3 uGrassCamera;
        varying float vGrassFade;`);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 foot = instanceMatrix[3].xyz;
        transformed.y += dot(grassRoot, grassSlope);
        float bend = position.y * position.y;
        transformed.x += sin(uGrassTime * 1.6 + foot.x * 0.7 + foot.z * 0.4) * bend * 0.16;
        vGrassFade = 1.0 - smoothstep(55.0, 80.0, distance(foot, uGrassCamera));`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGrassFade;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
        float threshold = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898,78.233))) * 43758.5453);
        if (vGrassFade < threshold) discard;`);
    };
    material.customProgramCacheKey = () => 'noto-ground-grass-v1';
    const pools = [12, 6, 3].map(blades => {
      const positions = [],
        colors = [],
        roots = [],
        indices = [];
      for (let b = 0; b < blades; b++) {
        const angle = seed(b, 17) * Math.PI * 2,
          dx = Math.cos(angle),
          dz = Math.sin(angle);
        const x = (seed(b, 3) - 0.5) * 0.65,
          z = (seed(b, 7) - 0.5) * 0.65;
        const h = 0.18 + seed(b, 1) * 0.28,
          w = 0.009 + seed(b, 2) * 0.018;
        const n = positions.length / 3;
        for (const [side, y, bend] of [[-1, 0, 0], [1, 0, 0], [-0.6, h * 0.52, 0.025], [0.6, h * 0.52, 0.025], [0, h, 0.09]]) {
          positions.push(x + dx * w * side - dz * bend, y, z + dz * w * side + dx * bend);
          roots.push(x, z);
          const tone = y / h;
          colors.push(0.10 + tone * 0.13, 0.15 + tone * 0.16, 0.025 + tone * 0.045);
        }
        indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2, n + 2, n + 3, n + 4);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute('grassRoot', new THREE.Float32BufferAttribute(roots, 2));
      geometry.setAttribute('grassSlope', new THREE.InstancedBufferAttribute(new Float32Array(LIMIT * 2), 2).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const mesh = new THREE.InstancedMesh(geometry, material, LIMIT);
      mesh.name = `Ground grass ${blades} blades`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      scene.add(mesh);
      return mesh;
    });
    const frustum = new THREE.Frustum(),
      matrix = new THREE.Matrix4();
    const position = new THREE.Vector3(),
      scale = new THREE.Vector3(),
      rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0),
      tint = new THREE.Color();
    let state = {
      tufts: 0,
      triangles: 0,
      sampleInstances: []
    };
    // Scratch buffers never touch displayed attributes until the entire placement pass is ready.
    const staged = pools.map(() => ({
      count: 0,
      capacity: 256,
      matrices: new Float32Array(256 * 16),
      colors: new Float32Array(256 * 3),
      slopes: new Float32Array(256 * 2)
    }));
    function reserve(buffer) {
      if (buffer.count < buffer.capacity) return;
      buffer.capacity = Math.min(LIMIT, buffer.capacity * 2);
      for (const [key, size] of [['matrices', 16], ['colors', 3], ['slopes', 2]]) {
        const next = new Float32Array(buffer.capacity * size);
        next.set(buffer[key]);
        buffer[key] = next;
      }
    }
    function* prepareUpdate(verticalScale, tier, enabled, view) {
      /* Yield bounded candidate batches to the parent vegetation scheduler. The camera/frustum
       * snapshot stays fixed for this pass, so continuous navigation cannot restart it forever.
       */
      staged.forEach(buffer => { buffer.count = 0; });
      const nextState = {
        tufts: 0,
        triangles: 0,
        sampleInstances: []
      };
      if (!enabled) return { state: nextState, buffers: staged };
      const viewPosition = view.position;
      frustum.copy(view.frustum);
      const i0 = Math.floor((viewPosition.x - RADIUS_M) / SPACING_M),
        i1 = Math.ceil((viewPosition.x + RADIUS_M) / SPACING_M);
      const j0 = Math.floor((viewPosition.z - RADIUS_M) / SPACING_M),
        j1 = Math.ceil((viewPosition.z + RADIUS_M) / SPACING_M);
      let candidates = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if ((++candidates & 31) === 0) yield;
        const x = (i + 0.15 + seed(i, j) * 0.7) * SPACING_M,
          z = (j + 0.15 + seed(i, j, 1) * 0.7) * SPACING_M;
        // Reject square-grid corners before coverage and displayed-surface queries.
        if ((x - viewPosition.x) ** 2 + (z - viewPosition.z) ** 2 > RADIUS_M ** 2) continue;
        const coverage = data.coverageAt(x, z);
        if (coverage < 0.08 || seed(i, j, 2) > coverage) continue;
        const y = sampleHeight(x, z);
        if (y === null || !Number.isFinite(y) || y < 1.5 * verticalScale) continue;
        position.set(x, y + 0.35, z);
        const distance = viewPosition.distanceTo(position);
        if (distance > RADIUS_M || !frustum.containsPoint(position)) continue;
        const hx = sampleHeight(x + 1, z),
          hz = sampleHeight(x, z + 1);
        if (hx === null || hz === null) continue;
        const gx = hx - y,
          gz = hz - y;
        const slope = Math.hypot(gx, gz) / verticalScale;
        if (seed(i, j, 3) < smooth(0.70, 1.19, slope)) continue;
        const level = tier === 0 && distance < 16 ? 0 : tier < 2 && distance < 42 ? 1 : 2;
        const mesh = pools[level], buffer = staged[level], n = buffer.count;
        if (n >= LIMIT) continue;
        const angle = seed(i, j, 4) * Math.PI * 2,
          sx = 0.85 + seed(i, j, 5) * 0.45,
          sy = 0.65 + seed(i, j, 6) * 0.5;
        rotation.setFromAxisAngle(up, angle);
        position.set(x, y - 0.015, z);
        matrix.compose(position, rotation, scale.set(sx, sy, sx));
        reserve(buffer);
        buffer.matrices.set(matrix.elements, n * 16);
        const tone = seed(i, j, 7);
        tint.setRGB(0.78 + tone * 0.35, 0.83 + tone * 0.25, 0.72 + tone * 0.25);
        buffer.colors[n * 3] = tint.r;
        buffer.colors[n * 3 + 1] = tint.g;
        buffer.colors[n * 3 + 2] = tint.b;
        buffer.slopes[n * 2] = (gx * Math.cos(angle) - gz * Math.sin(angle)) * sx / sy;
        buffer.slopes[n * 2 + 1] = (gx * Math.sin(angle) + gz * Math.cos(angle)) * sx / sy;
        buffer.count++;
        nextState.tufts++;
        nextState.triangles += mesh.geometry.index.count / 3;
        if (nextState.sampleInstances.length < 16) nextState.sampleInstances.push({
          x,
          y,
          z,
          level,
          coverage
        });
      }
      return { state: nextState, buffers: staged };
    }
    function commit(prepared) {
      /* Only populated prefixes are copied/uploaded. Keep BufferAttribute identities stable so
       * repeated placement passes reuse their WebGL buffers rather than leaking replacements.
       */
      for (let level = 0; level < pools.length; level++) {
        const mesh = pools[level], buffer = prepared.buffers[level];
        mesh.count = buffer.count;
        if (!buffer.count) continue;
        if (!mesh.instanceColor) {
          mesh.setColorAt(0, tint);
          material.needsUpdate = true;
        }
        for (const [attribute, values, size] of [
          [mesh.instanceMatrix, buffer.matrices, 16],
          [mesh.instanceColor, buffer.colors, 3],
          [mesh.geometry.attributes.grassSlope, buffer.slopes, 2]
        ]) {
          attribute.array.set(values.subarray(0, buffer.count * size));
          attribute.clearUpdateRanges();
          attribute.addUpdateRange(0, buffer.count * size);
          attribute.needsUpdate = true;
        }
      }
      state = prepared.state;
    }
    function hide() {
      pools.forEach(mesh => { mesh.count = 0; });
      state = { tufts: 0, triangles: 0, sampleInstances: [] };
    }
    return {
      prepareUpdate,
      commit,
      hide,
      getState: () => ({
        ...state,
        spacingM: SPACING_M,
        drawDistanceM: RADIUS_M
      })
    };
  }
  global.NotoGroundGrass = {
    prepare,
    create
  };
})(window);
