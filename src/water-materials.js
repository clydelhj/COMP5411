/* Procedural tileable sea color, normal, roughness and foam-noise textures.
All water tiles share textures sampled in model x/z coordinates, so patterns do not restart at tile boundaries. */
(function registerNotoWaterMaterials(global) {
  'use strict';

  // TEXTURE_SIZE: integer edge length of each square runtime texture, in pixels.
  const TEXTURE_SIZE = 512;
  // TILE_SCALE_M: horizontal repeat length in metres, used as a visual scale.
  const TILE_SCALE_M = 96;
  // RIPPLE_COMPONENTS: integer frequencies, phase and amplitude; Array<[kx,kz,phase,amplitude]>.
  // Integer frequencies keep color and gradients periodic. These amplitudes do not displace vertices.
  const RIPPLE_COMPONENTS = [[5, 2, 0.4, 0.42], [9, 4, 1.2, 0.25], [13, -3, 2.1, 0.14], [21, 7, 0.8, 0.08], [-4, 11, 2.7, 0.12], [31, -8, 4.2, 0.035]];
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
  function createTextures(THREE) {
    /* Create seamless sea color and detail textures using THREE.
Warp a periodic wave field, then calculate gradients with periodic central differences. Color RGB stores water color and A stores foam noise; detail RGB/A stores normals/roughness.
Returns {color,detail} DataTextures with mipmaps: sRGB color and linear detail. */
    const colorPixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    const detailPixels = new Uint8Array(colorPixels.length);
    const heights = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);
    const tau = Math.PI * 2;
    for (let row = 0; row < TEXTURE_SIZE; row++) {
      for (let col = 0; col < TEXTURE_SIZE; col++) {
        const u = col / TEXTURE_SIZE;
        const v = row / TEXTURE_SIZE;
        const wu = u + 0.045 * Math.sin(tau * (2 * u + v)) + 0.018 * Math.sin(tau * (u - 3 * v));
        const wv = v + 0.04 * Math.sin(tau * (u - 2 * v) + 1.3);
        let height = 0;
        for (const [kx, kz, phase, amplitude] of RIPPLE_COMPONENTS) {
          const angle = tau * (kx * wu + kz * wv) + phase;
          height += Math.sin(angle) * amplitude;
        }
        heights[row * TEXTURE_SIZE + col] = height;
      }
    }
    const heightAt = (col, row) => heights[(row + TEXTURE_SIZE) % TEXTURE_SIZE * TEXTURE_SIZE + (col + TEXTURE_SIZE) % TEXTURE_SIZE];
    for (let row = 0; row < TEXTURE_SIZE; row++) {
      for (let col = 0; col < TEXTURE_SIZE; col++) {
        const u = col / TEXTURE_SIZE,
          v = row / TEXTURE_SIZE;
        const height = heightAt(col, row);
        const dx = (heightAt(col + 1, row) - heightAt(col - 1, row)) * TEXTURE_SIZE / (2 * TILE_SCALE_M);
        const dz = (heightAt(col, row + 1) - heightAt(col, row - 1)) * TEXTURE_SIZE / (2 * TILE_SCALE_M);
        const noise = periodicNoise(u, v, 4) * 0.55 + periodicNoise(u, v, 16) * 0.28 + periodicNoise(u, v, 64) * 0.17;
        const index = (row * TEXTURE_SIZE + col) * 4;
        const shade = 0.98 + height * 0.055;
        colorPixels[index] = Math.round(31 * shade);
        colorPixels[index + 1] = Math.round(92 * shade);
        colorPixels[index + 2] = Math.round(107 * shade);
        // Alpha stores linear scalar data, not material opacity. sRGB decoding only affects RGB.
        colorPixels[index + 3] = Math.round(noise * 255);
        // RGB encodes the tangent-space normal along +X,+Z,+Y, transformed back into object space when sampled.
        const length = Math.hypot(dx, dz, 1);
        detailPixels[index] = Math.round((-dx / length * 0.5 + 0.5) * 255);
        detailPixels[index + 1] = Math.round((-dz / length * 0.5 + 0.5) * 255);
        detailPixels[index + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
        detailPixels[index + 3] = Math.round((0.18 + noise * 0.10) * 255);
      }
    }
    const color = new THREE.DataTexture(colorPixels, TEXTURE_SIZE, TEXTURE_SIZE);
    const detail = new THREE.DataTexture(detailPixels, TEXTURE_SIZE, TEXTURE_SIZE);
    for (const texture of [color, detail]) {
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
      detail
    };
  }
  function create(THREE) {
    /* Create shared sea-surface and cut-face materials using THREE.
Build procedural textures and standard lighting; water-motion adds animation. Inject model-coordinate sampling and correctly transformed double-sided normals.
Returns {top,cut,textures,dispose}; dispose is idempotent. */
    const textures = createTextures(THREE);
    const top = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.24,
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
    top.customProgramCacheKey = () => 'noto-water-detail-v2';
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
          roughnessFactor = clamp(notoWaterDetail.a, 0.18, 0.34);
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
      }
    };
  }
  global.NotoWaterMaterials = {
    create
  };
})(window);
