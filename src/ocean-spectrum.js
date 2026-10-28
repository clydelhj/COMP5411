/* Two bounded GPU wind-sea spectra. The viewer owns the clock and scheduling.
 * The Stockham butterfly is adapted from David Li's WebGL waves implementation:
 * https://github.com/dli/waves/blob/1313f464c2df7d1c69852577248b58fa29074c38/simulation.js
 * Only the transform organization is reused; spectrum setup, Three.js resource
 * ownership, gradient/crest output and scheduling are specific to this viewer.
 *
 * The MIT License (MIT)
 * Copyright (c) 2014 David Li (http://david.li)
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function registerOceanSpectrum(global) {
  'use strict';

  const RESOLUTION = 128;
  const UPDATE_INTERVAL = 1 / 20;
  const GRAVITY = 9.81;
  // Noncommensurate domains avoid an obvious shared repeat over the regional model.
  // Each cascade has a separate seed and directional spread, not a scrolled copy.
  const CASCADES = [
    { lengthM: 1024, rmsM: 0.72, speedMps: 12, angle: 0.45, seed: 5411 },
    { lengthM: 173, rmsM: 0.16, speedMps: 6.2, angle: 0.71, seed: 195411 }
  ];
  const VERTEX = `
    precision highp float;
    in vec3 position;
    void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;
  const EVOLVE = `
    precision highp float;
    precision highp sampler2D;
    out vec4 spectrum;
    uniform sampler2D uInitial;
    uniform int uResolution;
    uniform float uLength;
    uniform float uTime;
    vec2 multiplyComplex(vec2 a, vec2 b) {
      return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x);
    }
    void main() {
      ivec2 pixel = ivec2(gl_FragCoord.xy);
      ivec2 frequency = pixel;
      if (frequency.x >= uResolution/2) frequency.x -= uResolution;
      if (frequency.y >= uResolution/2) frequency.y -= uResolution;
      vec2 wave = 6.28318530718 * vec2(frequency) / uLength;
      float k = length(wave);
      if (k < 0.000001) { spectrum = vec4(0.0); return; }
      ivec2 opposite = ivec2((uResolution-pixel.x)%uResolution, (uResolution-pixel.y)%uResolution);
      vec2 h0 = texelFetch(uInitial, pixel, 0).rg;
      vec2 reverse = texelFetch(uInitial, opposite, 0).rg;
      float phase = -sqrt(9.81*k) * uTime;
      vec2 rotation = vec2(cos(phase), sin(phase));
      // The conjugate pair gives a real height field after the inverse transform.
      vec2 h = multiplyComplex(h0, rotation)
        + multiplyComplex(vec2(reverse.x, -reverse.y), vec2(rotation.x, -rotation.y));
      // The inverse transform uses +i*k*x. +i*h therefore moves particles
      // toward a positive crest; -i*h would incorrectly compress the trough.
      vec2 iH = vec2(-h.y, h.x);
      vec2 dx = iH * (wave.x/k) * 1.25;
      vec2 dz = iH * (wave.y/k) * 1.25;
      // One complex sequence packs real horizontal-X and height fields; the
      // other packs horizontal-Z. This needs one RGBA transform, not three.
      spectrum = vec4(dx + vec2(-h.y, h.x), dz);
    }
  `;
  const TRANSFORM = `
    precision highp float;
    precision highp sampler2D;
    out vec4 transformed;
    uniform sampler2D uInput;
    uniform int uResolution;
    uniform int uSubtransform;
    uniform bool uHorizontal;
    vec2 multiplyComplex(vec2 a, vec2 b) {
      return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x);
    }
    void main() {
      ivec2 pixel = ivec2(gl_FragCoord.xy);
      int index = uHorizontal ? pixel.x : pixel.y;
      int halfTransform = uSubtransform/2;
      int evenIndex = (index/uSubtransform)*halfTransform + index%halfTransform;
      ivec2 evenPixel = uHorizontal ? ivec2(evenIndex,pixel.y) : ivec2(pixel.x,evenIndex);
      ivec2 oddPixel = evenPixel + (uHorizontal ? ivec2(uResolution/2,0) : ivec2(0,uResolution/2));
      vec4 even = texelFetch(uInput, evenPixel, 0);
      vec4 odd = texelFetch(uInput, oddPixel, 0);
      float angle = 6.28318530718 * float(index) / float(uSubtransform);
      vec2 twiddle = vec2(cos(angle), sin(angle));
      // Normalize each butterfly to keep intermediates bounded. The final
      // gradient pass restores the Fourier-series scale once, by N squared.
      transformed = 0.5 * vec4(even.xy + multiplyComplex(twiddle,odd.xy),
        even.zw + multiplyComplex(twiddle,odd.zw));
    }
  `;
  const GRADIENT = `
    precision highp float;
    precision highp sampler2D;
    out vec4 field;
    uniform sampler2D uDisplacement;
    uniform int uResolution;
    uniform float uLength;
    uniform float uStrength;
    vec3 displacement(ivec2 pixel) {
      ivec2 wrapped = ivec2((pixel.x+uResolution)%uResolution,(pixel.y+uResolution)%uResolution);
      return texelFetch(uDisplacement,wrapped,0).rgb
        * float(uResolution*uResolution) * uStrength;
    }
    void main() {
      ivec2 pixel = ivec2(gl_FragCoord.xy);
      vec3 center = displacement(pixel);
      float inverseSpan = float(uResolution)/(2.0*uLength);
      vec3 dx = (displacement(pixel+ivec2(1,0))-displacement(pixel-ivec2(1,0))) * inverseSpan;
      vec3 dz = (displacement(pixel+ivec2(0,1))-displacement(pixel-ivec2(0,1))) * inverseSpan;
      float jacobian = (1.0+dx.x)*(1.0+dz.z)-dx.z*dz.x;
      float crest = (1.0-smoothstep(0.62,0.94,jacobian))
        * smoothstep(-0.05,0.16,center.y);
      vec3 tangentX = vec3(1.0+dx.x,dx.y,dx.z);
      vec3 tangentZ = vec3(dz.x,dz.y,1.0+dz.z);
      vec3 normal = cross(tangentZ,tangentX);
      // Express the full horizontally compressed surface normal as gradients.
      // Limit folded/singular crests: their compression already contributes foam.
      vec2 gradients = clamp(-normal.xz/max(normal.y,0.25),vec2(-1.4),vec2(1.4));
      // RG: effective physical gradients. B: compression/crest proxy. A: height m.
      // Gradients can be mip-filtered without averaging encoded unit normals.
      field = vec4(gradients,clamp(crest,0.0,1.0),center.y);
    }
  `;

  function initialSpectrum(THREE, cascade) {
    // Initial random coefficients are generated once; all subsequent transforms
    // and phase evolution are GPU work. These are visual wind-sea parameters.
    const values = new Float32Array(RESOLUTION * RESOLUTION * 4);
    let seed = cascade.seed;
    const random = () => {
      seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
      return (seed + 0.5) / 4294967296;
    };
    const windX = Math.cos(cascade.angle), windZ = Math.sin(cascade.angle);
    const windLength = cascade.speedMps * cascade.speedMps / GRAVITY;
    const cellM = cascade.lengthM / RESOLUTION;
    let energy = 0;
    for (let row = 0; row < RESOLUTION; row++) {
      for (let column = 0; column < RESOLUTION; column++) {
        const nx = column < RESOLUTION / 2 ? column : column - RESOLUTION;
        const nz = row < RESOLUTION / 2 ? row : row - RESOLUTION;
        const index = (row * RESOLUTION + column) * 4;
        // Nyquist derivatives are not paired with a distinct opposite frequency.
        if ((!nx && !nz) || column === RESOLUTION / 2 || row === RESOLUTION / 2) continue;
        const kx = 2 * Math.PI * nx / cascade.lengthM;
        const kz = 2 * Math.PI * nz / cascade.lengthM;
        const k = Math.hypot(kx, kz);
        const alignment = (kx * windX + kz * windZ) / k;
        const spread = 0.08 + 0.92 * Math.pow(Math.abs(alignment), 4);
        const direction = alignment >= 0 ? 1 : 0.18;
        const longDamping = Math.exp(-1 / ((k * windLength) ** 2));
        const shortDamping = Math.exp(-((k * cellM * 0.35) ** 2));
        const power = longDamping * shortDamping * spread * direction / (k ** 4);
        const gaussianRadius = Math.sqrt(-2 * Math.log(Math.max(1e-12, random())));
        const gaussianAngle = 2 * Math.PI * random();
        const amplitude = Math.sqrt(power * 0.5);
        const real = gaussianRadius * Math.cos(gaussianAngle) * amplitude;
        const imaginary = gaussianRadius * Math.sin(gaussianAngle) * amplitude;
        values[index] = real;
        values[index + 1] = imaginary;
        energy += real * real + imaginary * imaginary;
      }
    }
    // For conjugate-paired Fourier coefficients the spatial variance is twice
    // the h0 energy. Normalize both domains to meaningful metre-scale RMS height.
    const normalize = cascade.rmsM / Math.sqrt(Math.max(energy * 2, 1e-20));
    for (let i = 0; i < values.length; i += 4) {
      values[i] *= normalize;
      values[i + 1] *= normalize;
    }
    const texture = new THREE.DataTexture(values, RESOLUTION, RESOLUTION, THREE.RGBAFormat, THREE.FloatType);
    texture.name = `Ocean initial spectrum ${cascade.lengthM} m`;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  function create({ THREE, renderer }) {
    /* The caller supplies absolute sleep-aware water time to update(). The
     * module creates only textures/materials and never owns a frame loop.
     * Output gradients are model-X/model-Z derivatives in physical metres.
     */
    const gl = renderer.getContext();
    let reason = null;
    if (!gl || typeof gl.drawBuffers !== 'function') reason = 'WebGL2 is required';
    else if (!gl.getExtension('EXT_color_buffer_float')) reason = 'Float render targets are unavailable';
    const supported = reason === null;
    let active = false, disposed = false, dirty = true;
    let updates = 0, passes = 0, lastUpdateTime = null, weather = 'clear';
    let ping = null, pong = null, geometry = null, scene = null, camera = null, quad = null;
    let evolveMaterial = null, transformMaterial = null, gradientMaterial = null;
    const initial = [], outputs = [];
    const zero = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    zero.name = 'Ocean spectrum fallback';
    zero.minFilter = zero.magFilter = THREE.NearestFilter;
    zero.generateMipmaps = false;
    zero.needsUpdate = true;
    const uniforms = {
      uOceanSpectrumLarge: { value: zero },
      uOceanSpectrumSmall: { value: zero },
      uOceanSpectrumSize: { value: new THREE.Vector2(CASCADES[0].lengthM, CASCADES[1].lengthM) },
      uOceanSpectrumEnabled: { value: 0 }
    };
    const evolveUniforms = {
      uInitial: { value: null }, uResolution: { value: RESOLUTION },
      uLength: { value: 0 }, uTime: { value: 0 }
    };
    const transformUniforms = {
      uInput: { value: null }, uResolution: { value: RESOLUTION },
      uSubtransform: { value: 2 }, uHorizontal: { value: true }
    };
    const gradientUniforms = {
      uDisplacement: { value: null }, uResolution: { value: RESOLUTION },
      uLength: { value: 0 }, uStrength: { value: 0.85 }
    };

    function release() {
      ping?.dispose(); pong?.dispose();
      ping = pong = null;
      for (const texture of initial.splice(0)) texture.dispose();
      for (const target of outputs.splice(0)) target.dispose();
      geometry?.dispose(); geometry = null;
      evolveMaterial?.dispose(); transformMaterial?.dispose(); gradientMaterial?.dispose();
      evolveMaterial = transformMaterial = gradientMaterial = null;
      scene = camera = quad = null;
      uniforms.uOceanSpectrumLarge.value = uniforms.uOceanSpectrumSmall.value = zero;
      uniforms.uOceanSpectrumEnabled.value = 0;
      active = false;
    }

    function initialize() {
      if (ping) return;
      const base = { format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        generateMipmaps: false, depthBuffer: false, stencilBuffer: false };
      ping = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, { ...base, type: THREE.FloatType });
      pong = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, { ...base, type: THREE.FloatType });
      ping.texture.name = 'Ocean FFT ping'; pong.texture.name = 'Ocean FFT pong';
      for (const cascade of CASCADES) {
        initial.push(initialSpectrum(THREE, cascade));
        const target = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, {
          ...base, type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter,
          magFilter: THREE.LinearFilter, generateMipmaps: true
        });
        target.texture.wrapS = target.texture.wrapT = THREE.RepeatWrapping;
        target.texture.name = `Ocean spectral gradients ${cascade.lengthM} m`;
        outputs.push(target);
      }
      for (const target of [ping, pong, ...outputs]) {
        renderer.setRenderTarget(target);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Ocean spectrum framebuffer is incomplete');
      }
      const material = (name, fragmentShader, values) => new THREE.RawShaderMaterial({
        name, glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader,
        uniforms: values, depthTest: false, depthWrite: false,
        blending: THREE.NoBlending, toneMapped: false
      });
      evolveMaterial = material('OceanSpectrumEvolution', EVOLVE, evolveUniforms);
      transformMaterial = material('OceanStockhamInverseFFT', TRANSFORM, transformUniforms);
      gradientMaterial = material('OceanSpectralGradient', GRADIENT, gradientUniforms);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      quad = new THREE.Mesh(geometry, evolveMaterial);
      quad.frustumCulled = false;
      scene = new THREE.Scene(); scene.add(quad);
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    function draw(material, target) {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      passes++;
    }

    function update(timeSeconds) {
      if (!supported || reason || disposed || !Number.isFinite(timeSeconds)) return false;
      const time = Math.max(0, timeSeconds);
      if (!dirty && lastUpdateTime !== null && time >= lastUpdateTime && time - lastUpdateTime < UPDATE_INTERVAL - 1e-6) return false;
      const target = renderer.getRenderTarget();
      const cubeFace = renderer.getActiveCubeFace?.() || 0;
      const mipLevel = renderer.getActiveMipmapLevel?.() || 0;
      const autoClear = renderer.autoClear, autoReset = renderer.info.autoReset;
      const savedInfo = { ...renderer.info.render };
      const shaderError = renderer.debug.onShaderError;
      try {
        renderer.autoClear = false;
        renderer.info.autoReset = false;
        renderer.debug.onShaderError = (context, program, vertex, fragment) => {
          if (shaderError) shaderError(context, program, vertex, fragment);
          throw new Error('Ocean spectrum shader failed to compile');
        };
        initialize();
        evolveUniforms.uTime.value = time;
        for (let cascadeIndex = 0; cascadeIndex < CASCADES.length; cascadeIndex++) {
          const cascade = CASCADES[cascadeIndex];
          evolveUniforms.uInitial.value = initial[cascadeIndex];
          evolveUniforms.uLength.value = cascade.lengthM;
          draw(evolveMaterial, ping);
          let read = ping, write = pong;
          for (const horizontal of [true, false]) {
            transformUniforms.uHorizontal.value = horizontal;
            for (let size = 2; size <= RESOLUTION; size *= 2) {
              transformUniforms.uInput.value = read.texture;
              transformUniforms.uSubtransform.value = size;
              draw(transformMaterial, write);
              [read, write] = [write, read];
            }
          }
          gradientUniforms.uDisplacement.value = read.texture;
          gradientUniforms.uLength.value = cascade.lengthM;
          draw(gradientMaterial, outputs[cascadeIndex]);
        }
        uniforms.uOceanSpectrumLarge.value = outputs[0].texture;
        uniforms.uOceanSpectrumSmall.value = outputs[1].texture;
        uniforms.uOceanSpectrumEnabled.value = 1;
        active = true;
        dirty = false;
        lastUpdateTime = time;
        updates++;
        return true;
      } catch (error) {
        reason = error.message || String(error);
        release();
        console.warn('GPU ocean spectrum unavailable; retaining analytic water detail:', reason);
        return false;
      } finally {
        renderer.setRenderTarget(target, cubeFace, mipLevel);
        renderer.autoClear = autoClear;
        renderer.info.autoReset = autoReset;
        renderer.debug.onShaderError = shaderError;
        Object.assign(renderer.info.render, savedInfo);
      }
    }

    return {
      uniforms,
      update,
      setWeather(value) {
        const next = ['clear', 'cloudy', 'rainy'].includes(value) ? value : 'clear';
        if (next === weather) return;
        weather = next;
        gradientUniforms.uStrength.value = next === 'rainy' ? 1.3 : next === 'cloudy' ? 1.05 : 0.85;
        dirty = true;
      },
      getState: () => ({
        supported, active, reason, mode: active ? 'gpu-fft' : 'analytic-fallback',
        size: RESOLUTION, cascadeLengthsM: CASCADES.map(cascade => cascade.lengthM),
        time: lastUpdateTime, updates, passes, updateHz: 1 / UPDATE_INTERVAL,
        estimatedTextureMiB: ping ? ((2 + initial.length) * RESOLUTION * RESOLUTION * 16
          + outputs.length * RESOLUTION * RESOLUTION * 8 * 4 / 3) / (1024 * 1024) : 0,
        weather, sourceCommit: '1313f464c2df7d1c69852577248b58fa29074c38', sourceLicense: 'MIT'
      }),
      dispose() {
        if (disposed) return;
        release(); zero.dispose(); disposed = true;
      }
    };
  }
  global.NotoOceanSpectrum = { create };
})(window);
