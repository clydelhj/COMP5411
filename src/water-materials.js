/* Shared, neutral water micro-detail and foam noise. Physical color and wind-sea
 * slopes are evaluated by water-motion; model-coordinate sampling stays continuous across tiles. */
(function registerNotoWaterMaterials(global) {
  'use strict';

  // TEXTURE_SIZE: integer edge length of each square runtime texture, in pixels.
  const TEXTURE_SIZE = 512;
  // TILE_SCALE_M: horizontal repeat length in metres, used as a visual scale.
  const TILE_SCALE_M = 96;
  function periodicNoise(u, v, cells) {
    /* Generate deterministic periodic value noise for foam coverage.
Parameters: u/v are periodic coordinates; cells is the integer lattice count per repeat.
Hash wrapped lattice points and smoothly interpolate. Returns the same value in [0,1] for each position. */
    const hash = (x, y) => {
      let n = Math.imul((x % cells + cells) % cells, 374761393) + Math.imul((y % cells + cells) % cells, 668265263);
      n = Math.imul(n ^ n >>> 13, 1274126177);
      return ((n ^ n >>> 16) >>> 0) / 4294967295;
    };
    const x = u * cells,
      y = v * cells,
      ix = Math.floor(x),
      iy = Math.floor(y);
    const tx = x - ix,
      ty = y - iy;
    const sx = tx * tx * (3 - 2 * tx),
      sy = ty * ty * (3 - 2 * ty);
    return (hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx) * (1 - sy) + (hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx) * sy;
  }
  function createFoamDensity(THREE) {
    // Bake thin/thick optical coverage, not a distance field. Hardware mipmaps
    // therefore preserve the occupied fraction of unresolved films and pores.
    // Periodic, jittered cellular voids and a smooth domain warp avoid grid-shaped holes.
    function cells(count, salt) {
      const features = new Float32Array(count * count * 3);
      let state = salt;
      const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
      for (let i = 0; i < count * count; i++) {
        features[i * 3] = 0.15 + random() * 0.70;
        features[i * 3 + 1] = 0.15 + random() * 0.70;
        features[i * 3 + 2] = 0.24 + random() * 0.20;
      }
      return { count, features };
    }
    function voidDistance(field, u, v) {
      const { count, features } = field, x = u * count, y = v * count;
      const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
      let distance = 2;
      for (let row = -1; row <= 1; row++) for (let col = -1; col <= 1; col++) {
        const c = ((ix + col) % count + count) % count;
        const r = ((iy + row) % count + count) % count;
        const offset = (r * count + c) * 3;
        const dx = tx - col - features[offset], dy = ty - row - features[offset + 1];
        distance = Math.min(distance, Math.sqrt(dx * dx + dy * dy) - features[offset + 2]);
      }
      return distance;
    }
    const smooth = (a, b, value) => {
      const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const coarse = cells(12, 541191), fine = cells(32, 195411);
    const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 2);
    let thinSum = 0, thickSum = 0;
    for (let row = 0; row < TEXTURE_SIZE; row++) for (let col = 0; col < TEXTURE_SIZE; col++) {
      const u = (col + 0.5) / TEXTURE_SIZE, v = (row + 0.5) / TEXTURE_SIZE;
      const warpedU = u + 0.037 * (periodicNoise(u, v, 4) - 0.5)
        + 0.015 * (periodicNoise(u + 0.2, v + 0.7, 8) - 0.5);
      const warpedV = v + 0.037 * (periodicNoise(u + 0.63, v + 0.27, 4) - 0.5)
        + 0.015 * (periodicNoise(u + 0.8, v + 0.1, 8) - 0.5);
      const largeGap = voidDistance(coarse, warpedU, warpedV);
      const smallGap = voidDistance(fine, warpedU, warpedV);
      const smallFilm = smooth(-0.03, 0.10, smallGap);
      const grain = periodicNoise(u, v, 64);
      const thin = smooth(-0.015, 0.085, largeGap) * (0.10 + smallFilm * 0.90) * (0.5 + grain * 0.5);
      const thick = smooth(-0.12, 0.045, largeGap) * (0.50 + smallFilm * 0.50) * (0.72 + grain * 0.28);
      const offset = (row * TEXTURE_SIZE + col) * 2;
      // Integrate optical depth before mip generation. Fresh aerated layers are
      // denser than the draining film, while empty cellular voids stay exactly clear.
      pixels[offset] = Math.round((1 - Math.exp(-thin * 1.4)) * 255);
      pixels[offset + 1] = Math.round((1 - Math.exp(-thick * 3.2)) * 255);
      thinSum += pixels[offset]; thickSum += pixels[offset + 1];
    }
    const texture = new THREE.DataTexture(pixels, TEXTURE_SIZE, TEXTURE_SIZE, THREE.RGFormat);
    texture.name = 'Periodic thin/thick foam coverage';
    texture.colorSpace = THREE.NoColorSpace;
    texture.userData.coverageMean = [thinSum, thickSum].map(sum => sum / (TEXTURE_SIZE * TEXTURE_SIZE * 255));
    return texture;
  }
  function createTextures(THREE) {
    /* Bake seamless directional wavelets once. Integer Fourier modes close at the
     * tile edges; a weak second harmonic sharpens crests without value-noise lobes.
     * Precomputed row/column trigonometry keeps texture construction off the frame loop.
     * Returns mipmapped color/noise, RGBA16F normal/roughness and RG8 foam coverage.
     */
    const colorPixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    const detailPixels = new Uint16Array(colorPixels.length);
    const tau = Math.PI * 2;
    let seed = 541119, meanX = 0, meanZ = 0, meanUp = 0;
    const random = () => {
      seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
      return (seed + 0.5) / 4294967296;
    };
    const wavelets = [], used = new Set();
    while (wavelets.length < 24) {
      const band = wavelets.length;
      const frequency = 7 * (46 / 7) ** ((band + 0.5) / 24);
      const direction = band < 12 ? 0.62 + (random() - 0.5) * 1.4 : random() * Math.PI;
      let nx = Math.round(Math.cos(direction) * frequency), nz = Math.round(Math.sin(direction) * frequency);
      if (nx < 0 || (nx === 0 && nz < 0)) { nx = -nx; nz = -nz; }
      const key = `${nx},${nz}`;
      if (used.has(key)) continue;
      used.add(key);
      const phase = random() * tau, length = Math.hypot(nx, nz);
      const sinX = new Float32Array(TEXTURE_SIZE), cosX = new Float32Array(TEXTURE_SIZE);
      const sinZ = new Float32Array(TEXTURE_SIZE), cosZ = new Float32Array(TEXTURE_SIZE);
      for (let i = 0; i < TEXTURE_SIZE; i++) {
        sinX[i] = Math.sin(tau * nx * i / TEXTURE_SIZE + phase);
        cosX[i] = Math.cos(tau * nx * i / TEXTURE_SIZE + phase);
        sinZ[i] = Math.sin(tau * nz * i / TEXTURE_SIZE);
        cosZ[i] = Math.cos(tau * nz * i / TEXTURE_SIZE);
      }
      wavelets.push({ x: nx / length, z: nz / length, sinX, cosX, sinZ, cosZ });
    }
    const slopeGain = 0.075 / Math.sqrt(wavelets.length * (1 + 0.24 ** 2) * 0.5);
    for (let row = 0; row < TEXTURE_SIZE; row++) {
      for (let col = 0; col < TEXTURE_SIZE; col++) {
        const u = col / TEXTURE_SIZE,
          v = row / TEXTURE_SIZE;
        let dx = 0, dz = 0;
        for (const wave of wavelets) {
          const sine = wave.sinX[col] * wave.cosZ[row] + wave.cosX[col] * wave.sinZ[row];
          const cosine = wave.cosX[col] * wave.cosZ[row] - wave.sinX[col] * wave.sinZ[row];
          const gradient = slopeGain * sine * (1 + 0.48 * cosine);
          dx += wave.x * gradient;
          dz += wave.z * gradient;
        }
        const noise = periodicNoise(u, v, 4) * 0.55 + periodicNoise(u, v, 16) * 0.28 + periodicNoise(u, v, 64) * 0.17;
        const index = (row * TEXTURE_SIZE + col) * 4;
        colorPixels[index] = colorPixels[index + 1] = colorPixels[index + 2] = 255;
        // Alpha stores linear scalar data, not material opacity. sRGB decoding only affects RGB.
        colorPixels[index + 3] = Math.round(noise * 255);
        // RGB encodes the tangent-space normal along +X,+Z,+Y, transformed back into object space when sampled.
        const length = Math.hypot(dx, dz, 1);
        const normalX = -dx / length, normalZ = -dz / length, normalUp = 1 / length;
        meanX += normalX; meanZ += normalZ; meanUp += normalUp;
        // Sample-only half-float textures are filterable in WebGL2. Subtle slopes need
        // more than the handful of normal levels provided by 8-bit encoding near 0.5.
        detailPixels[index] = THREE.DataUtils.toHalfFloat(normalX * 0.5 + 0.5);
        detailPixels[index + 1] = THREE.DataUtils.toHalfFloat(normalZ * 0.5 + 0.5);
        detailPixels[index + 2] = THREE.DataUtils.toHalfFloat(normalUp * 0.5 + 0.5);
        detailPixels[index + 3] = THREE.DataUtils.toHalfFloat(0.045 + noise * 0.055);
      }
    }
    const color = new THREE.DataTexture(colorPixels, TEXTURE_SIZE, TEXTURE_SIZE);
    const detail = new THREE.DataTexture(detailPixels, TEXTURE_SIZE, TEXTURE_SIZE, THREE.RGBAFormat, THREE.HalfFloatType);
    const foam = createFoamDensity(THREE);
    const count = TEXTURE_SIZE * TEXTURE_SIZE;
    detail.userData.normalMeanVariance = Math.max(0, 1 - (meanX * meanX + meanZ * meanZ + meanUp * meanUp) / (count * count));
    for (const texture of [color, detail, foam]) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      // Preserve fine detail at grazing angles; Three.js clamps anisotropy to the device limit.
      texture.anisotropy = 4;
      texture.flipY = false;
      texture.needsUpdate = true;
    }
    color.colorSpace = THREE.SRGBColorSpace;
    detail.colorSpace = THREE.NoColorSpace;
    return {
      color,
      detail,
      foam
    };
  }
  function create(THREE) {
    /* Create shared sea-surface and cut-face materials using THREE.
Build procedural textures and standard lighting; water-motion adds animation. Inject model-coordinate sampling and correctly transformed double-sided normals.
Returns {top,cut,textures,dispose}; dispose is idempotent. */
    const textures = createTextures(THREE);
    const top = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.10,
      metalness: 0,
      side: THREE.DoubleSide
    });
    const cut = new THREE.MeshStandardMaterial({
      color: 0x4b7184,
      roughness: 0.7,
      side: THREE.DoubleSide
    });
    top.name = 'Noto sea surface';
    cut.name = 'Noto water cut and base';
    top.customProgramCacheKey = () => 'noto-water-directional-wavelets-v4';
    top.onBeforeCompile = shader => {
      /* Inject shared water textures into standard color, normal and roughness shading.
Parameter: shader is the Three.js shader/uniform container.
Pass model coordinates and normalized view-space bases, sample color/detail, and retain standard lighting and double-sided normals.
Updates the shader in place and retains a diagnostic reference. */
      // Model coordinates include global tile offsets; vertical exaggeration does not change texture phase or horizontal scale.
      // The reference sea level is 0 m. Normalize water bases so terrain exaggeration does not amplify ripples.
      Object.assign(shader.uniforms, {
        uNotoWaterColor: {
          value: textures.color
        },
        uNotoWaterDetail: {
          value: textures.detail
        },
        uNotoWaterScale: {
          value: TILE_SCALE_M
        }
      });
      const varyings = /* glsl */`
        varying vec2 vNotoWaterXZ;
        varying vec3 vNotoWaterBasisX;
        varying vec3 vNotoWaterBasisY;
        varying vec3 vNotoWaterBasisZ;
      `;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${varyings}`).replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vNotoWaterXZ = position.xz;
          vNotoWaterBasisX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
          vNotoWaterBasisY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
          vNotoWaterBasisZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
        `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', /* glsl */`
          #include <common>
          ${varyings}
          uniform sampler2D uNotoWaterColor;
          uniform sampler2D uNotoWaterDetail;
          uniform float uNotoWaterScale;
        `).replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          vec2 notoWaterUV = vNotoWaterXZ / uNotoWaterScale;
          vec4 notoWaterDetail = texture2D(uNotoWaterDetail, notoWaterUV);
          diffuseColor.rgb *= texture2D(uNotoWaterColor, notoWaterUV).rgb;
        `).replace('#include <normal_fragment_begin>', /* glsl */`
          #include <normal_fragment_begin>
          vec3 notoWaterTangent = notoWaterDetail.rgb * 2.0 - 1.0;
          vec3 notoWaterNormal = normalize(
            vNotoWaterBasisX * notoWaterTangent.x +
            vNotoWaterBasisZ * notoWaterTangent.y +
            vNotoWaterBasisY * notoWaterTangent.z
          ) * faceDirection;
          normal = normalize(mix(normal, notoWaterNormal, 0.85));
        `).replace('#include <roughnessmap_fragment>', /* glsl */`
          #include <roughnessmap_fragment>
          roughnessFactor = clamp(notoWaterDetail.a, 0.045, 0.12);
        `);
      top.userData.notoShader = shader;
    };
    let disposed = false;
    return {
      top,
      cut,
      textures,
      dispose() {
        if (disposed) return;
        disposed = true;
        top.dispose();
        cut.dispose();
        textures.color.dispose();
        textures.detail.dispose();
        textures.foam.dispose();
      }
    };
  }
  global.NotoWaterMaterials = {
    create
  };
})(window);
