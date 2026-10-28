/* Procedural atmosphere and bounded cloud-slab samples, shared by sky and water.
 * The caller owns time and frame scheduling. No external images, readback or render loop.
 */
(function registerSkyAtmosphere(global) {
  'use strict';

  const WIDTH = 1536;
  const HEIGHT = 384;
  const VOLUME_SIZE = 64;
  const UPDATE_INTERVAL = 0.2;
  const shaderDeclarations = /* glsl */`
    uniform sampler2D uSkyAtmosphereMap;
    uniform float uSkyAtmosphereEnabled;
    uniform vec3 uAtmosphereSunDirection;
    uniform vec3 uAtmosphereSunRadiance;
    vec2 atmosphereSkyUv(vec3 direction) {
      vec3 d = normalize(direction);
      return vec2(fract(atan(d.z,d.x)/6.28318530718+0.5),
        asin(clamp(d.y,0.0,1.0))/1.57079632679);
    }
    vec4 atmosphereSkySample(vec3 direction) {
      vec2 uv = atmosphereSkyUv(direction);
      vec2 gradientX = dFdx(uv);
      vec2 gradientY = dFdy(uv);
      // Longitude wraps at -X. Unwrap the derivatives before mip selection so
      // adjacent 0/1 samples do not request the atlas-wide average at that seam.
      gradientX.x -= round(gradientX.x);
      gradientY.x -= round(gradientY.x);
      return textureGrad(uSkyAtmosphereMap,uv,gradientX,gradientY);
    }
    float atmosphereCloudTransmission(vec3 direction) {
      if(uSkyAtmosphereEnabled<0.5) return 1.0;
      return atmosphereSkySample(direction).a;
    }
    vec3 atmosphereSkyColor(vec3 direction) {
      vec3 d = normalize(direction);
      vec4 sky = atmosphereSkySample(d);
      // Keep the small solar disk analytic: the cached atlas must not rasterize it into a square.
      float alignment = dot(d,uAtmosphereSunDirection);
      float edge = max(fwidth(alignment)*0.6,0.000002);
      float disk = smoothstep(cos(0.0062)-edge,cos(0.0062)+edge,alignment);
      disk *= smoothstep(-0.001,0.003,d.y);
      return sky.rgb+uAtmosphereSunRadiance*disk*sky.a;
    }
  `;
  const VERTEX = /* glsl */`
    precision highp float;
    in vec3 position;
    void main() { gl_Position=vec4(position.xy,0.0,1.0); }
  `;
  const FRAGMENT = /* glsl */`
    precision highp float;
    precision highp sampler3D;
    out vec4 atmosphere;
    uniform vec2 uResolution;
    uniform float uCloudTime;
    uniform vec3 uSunDirection;
    uniform vec3 uSunColor;
    uniform float uElevation;
    uniform float uWeather;
    uniform sampler3D uCloudVolume;
    const mat2 cloudRotation=mat2(0.8,0.6,-0.6,0.8);
    float hash(vec2 p) {
      vec3 q=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
      q+=dot(q,q.yzx+33.33);
      return fract((q.x+q.y)*q.z);
    }
    float noise(vec2 p) {
      vec2 i=floor(p),f=fract(p);
      f=f*f*f*(f*(f*6.0-15.0)+10.0);
      return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
        mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
    }
    float filteredNoise(vec2 p,float footprint) {
      // Suppress unresolved noise bands in the grazing horizon instead of sparkling as they drift.
      return mix(noise(p),0.5,smoothstep(0.22,0.75,footprint));
    }
    float density(vec2 point,float height) {
      if(height<=0.0||height>=1.0) return 0.0;
      vec2 p=point/1400.0;
      float macroFootprint=max(length(dFdx(p)),length(dFdy(p)))*0.24;
      float grouping=filteredNoise(p*0.24+vec2(17.3,8.5),macroFootprint);
      // Independent 5.8 km banks create large clear openings; local detail cannot fill every gap.
      float bank=smoothstep(mix(0.48,0.22,uWeather),mix(0.66,0.43,uWeather),grouping);
      // A small, continuously filtered 3D field forms vertically coherent puffs, not flat sheets.
      vec3 volume=vec3(point.x/10000.0,(1800.0+height*1400.0)/5000.0,point.y/10000.0);
      float field=texture(uCloudVolume,volume).r;
      float threshold=mix(0.40,0.30,uWeather);
      threshold+=pow(max(height-0.23,0.0),1.45)*0.32;
      float body=smoothstep(threshold,threshold+0.18,field)*bank;
      return body*smoothstep(0.0,0.18,height)*(1.0-smoothstep(0.72,1.0,height));
    }
    void main() {
      vec2 uv=gl_FragCoord.xy/uResolution;
      float azimuth=(uv.x-0.5)*6.28318530718;
      float elevation=uv.y*1.57079632679;
      vec3 direction=vec3(cos(azimuth)*cos(elevation),sin(elevation),sin(azimuth)*cos(elevation));
      float y=max(direction.y,0.0);
      float daylight=smoothstep(-12.0,9.0,uElevation);
      float sunset=(1.0-smoothstep(2.0,18.0,uElevation))*smoothstep(-13.0,-1.0,uElevation);
      vec3 dayZenith=vec3(0.035,0.205,0.405);
      vec3 dayHorizon=vec3(0.43,0.64,0.76);
      vec3 nightZenith=vec3(0.0011,0.0024,0.0062);
      vec3 nightHorizon=vec3(0.0045,0.008,0.019);
      float height=sqrt(y);
      vec3 sky=mix(mix(nightHorizon,nightZenith,height),mix(dayHorizon,dayZenith,height),daylight);
      vec2 sunHorizontal=normalize(uSunDirection.xz+vec2(0.00001));
      vec2 viewHorizontal=normalize(direction.xz+vec2(0.00001));
      float towardSun=pow(clamp(dot(sunHorizontal,viewHorizontal)*0.5+0.5,0.0,1.0),3.0);
      float horizon=exp(-y*7.5);
      // Warmth is directional and confined to low sun; the upper sky remains cool.
      vec3 duskHorizon=mix(vec3(0.34,0.16,0.25),vec3(1.04,0.40,0.24),towardSun);
      sky=mix(sky,duskHorizon,sunset*horizon*0.89);
      float solarAlignment=max(dot(direction,uSunDirection),0.0);
      float halo=pow(solarAlignment,12.0)*0.13+pow(solarAlignment,90.0)*0.20;
      sky+=mix(vec3(0.66,0.76,0.87),vec3(1.15,0.49,0.20),sunset)*halo*daylight;
      vec3 overcast=mix(vec3(0.005,0.009,0.018),vec3(0.27,0.34,0.41),daylight);
      sky=mix(sky,overcast,uWeather*0.42);

      vec2 wind=vec2(7.5,2.7)*uCloudTime;
      float dy=max(y,0.035);
      vec3 accumulated=vec3(0.0);
      float transmission=1.0;
      float hazeVisibility=smoothstep(0.018,0.12,y);
      // A fixed per-atlas-texel stagger breaks common height planes without frame-to-frame shimmer.
      float stagger=0.15+0.70*hash(floor(gl_FragCoord.xy)+vec2(71.3,43.1));
      for(int layer=0;layer<24;layer++) {
        float h=(float(layer)+stagger)/24.0;
        vec2 point=direction.xz*((1800.0+h*1400.0)/dy)+wind;
        float d=density(point,h);
        // The integral keeps its optical thickness when the sample count changes.
        float alpha=(1.0-exp(-d*mix(0.46,0.89,uWeather)*(8.0/24.0)/(0.35+dy)))*hazeVisibility;
        float towardDensity=density(point+uSunDirection.xz*520.0,h+uSunDirection.y*520.0/1400.0);
        float incident=exp(-towardDensity*mix(2.8,4.0,uWeather));
        float edgeLight=pow(1.0-d,2.0)*(0.15+0.85*pow(solarAlignment,7.0));
        float lit=clamp(incident*0.75+edgeLight*0.35,0.0,1.0);
        vec3 cloudShade=mix(vec3(0.10,0.15,0.23),vec3(0.80,0.85,0.90),lit);
        vec3 duskCloud=mix(vec3(0.15,0.075,0.16),vec3(1.03,0.38,0.25),clamp(lit*0.83+edgeLight*0.28,0.0,1.0));
        cloudShade=mix(cloudShade,duskCloud,sunset*0.90);
        cloudShade+=mix(vec3(0.11,0.14,0.16),vec3(0.55,0.16,0.09),sunset)*edgeLight;
        cloudShade=mix(vec3(0.002,0.004,0.009),cloudShade,daylight);
        cloudShade=mix(cloudShade,cloudShade*vec3(0.52,0.58,0.66),uWeather*0.5);
        accumulated+=cloudShade*alpha*transmission;
        transmission*=1.0-alpha;
      }
      // A separate thin, elongated high layer breaks up the cumulus scale without a tiled image.
      vec2 high=direction.xz*(5400.0/dy)/1500.0+wind/5000.0;
      float wisps=noise(cloudRotation*high*vec2(0.23,1.6));
      wisps=wisps*0.68+noise(high*vec2(0.8,5.2)+37.0)*0.32;
      float cirrus=smoothstep(0.56,0.77,wisps)*0.23*hazeVisibility*(1.0-uWeather*0.6);
      vec3 cirrusColor=mix(vec3(0.65,0.76,0.86),vec3(0.94,0.43,0.34),sunset)*daylight;
      vec3 distantSky=mix(sky,cirrusColor,cirrus);
      vec3 color=accumulated+distantSky*transmission;
      transmission*=1.0-cirrus;
      // The broad solar aureole is cloud-occluded here. The analytic disk uses the same alpha.
      color+=uSunColor*pow(solarAlignment,320.0)*0.32*daylight*transmission;
      atmosphere=vec4(max(color,vec3(0.0)),clamp(transmission,0.0,1.0));
    }
  `;

  function createCloudVolume(THREE) {
    // Build one deterministic, periodic 64-cubed field while loading. Subsequent sampling is GPU-only.
    const hash = (x, y, z) => {
      let value = Math.imul(x + 5411, 374761393) ^ Math.imul(y + 91, 668265263) ^ Math.imul(z + 37, 2147483647);
      value = Math.imul(value ^ (value >>> 13), 1274126177);
      return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
    };
    const grids = [4, 8, 16].map(count => {
      const pixels = new Float32Array(count * count * count);
      for (let z = 0; z < count; z++) {
        for (let y = 0; y < count; y++) {
          for (let x = 0; x < count; x++) {
            pixels[(z * count + y) * count + x] = hash(x, y, z);
          }
        }
      }
      return { count, pixels };
    });
    const ease = value => value * value * value * (value * (value * 6 - 15) + 10);
    const sample = (grid, x, y, z) => {
      const { count, pixels } = grid;
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      const fx = ease(x - ix), fy = ease(y - iy), fz = ease(z - iz);
      const x0 = ix % count, x1 = (ix + 1) % count,
        y0 = iy % count, y1 = (iy + 1) % count,
        z0 = iz % count, z1 = (iz + 1) % count;
      const low0 = (z0 * count + y0) * count, low1 = (z0 * count + y1) * count;
      const high0 = (z1 * count + y0) * count, high1 = (z1 * count + y1) * count;
      const a = pixels[low0 + x0] * (1 - fx) + pixels[low0 + x1] * fx;
      const b = pixels[low1 + x0] * (1 - fx) + pixels[low1 + x1] * fx;
      const c = pixels[high0 + x0] * (1 - fx) + pixels[high0 + x1] * fx;
      const d = pixels[high1 + x0] * (1 - fx) + pixels[high1 + x1] * fx;
      return (a * (1 - fy) + b * fy) * (1 - fz) + (c * (1 - fy) + d * fy) * fz;
    };
    const pixels = new Uint8Array(VOLUME_SIZE ** 3);
    const weights = [0.59, 0.28, 0.13];
    for (let z = 0; z < VOLUME_SIZE; z++) {
      for (let y = 0; y < VOLUME_SIZE; y++) {
        for (let x = 0; x < VOLUME_SIZE; x++) {
          let value = 0;
          for (let octave = 0; octave < grids.length; octave++) {
            const grid = grids[octave], scale = grid.count / VOLUME_SIZE;
            value += sample(grid, (x + 0.5) * scale, (y + 0.5) * scale, (z + 0.5) * scale) * weights[octave];
          }
          pixels[(z * VOLUME_SIZE + y) * VOLUME_SIZE + x] = Math.round(THREE.MathUtils.clamp((value - 0.20) * 1.6, 0, 1) * 255);
        }
      }
    }
    const volume = new THREE.Data3DTexture(pixels, VOLUME_SIZE, VOLUME_SIZE, VOLUME_SIZE);
    volume.name = 'Periodic cloud-puff volume';
    volume.format = THREE.RedFormat;
    volume.type = THREE.UnsignedByteType;
    volume.minFilter = THREE.LinearMipmapLinearFilter;
    volume.magFilter = THREE.LinearFilter;
    volume.wrapS = volume.wrapT = volume.wrapR = THREE.RepeatWrapping;
    volume.generateMipmaps = true;
    volume.unpackAlignment = 1;
    volume.needsUpdate = true;
    return volume;
  }

  function create({ THREE, renderer }) {
    const empty = new THREE.DataTexture(new Uint8Array([12, 23, 45, 255]), 1, 1);
    empty.needsUpdate = true;
    const uniforms = {
      uSkyAtmosphereMap: { value: empty },
      uSkyAtmosphereEnabled: { value: 0 },
      uAtmosphereSunDirection: { value: new THREE.Vector3(0.4, 0.6, -0.7).normalize() },
      uAtmosphereSunRadiance: { value: new THREE.Color(3.0, 2.7, 2.3) }
    };
    const values = {
      uResolution: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      uCloudTime: { value: 0 },
      uSunDirection: uniforms.uAtmosphereSunDirection,
      uSunColor: { value: new THREE.Color(1.0, 0.82, 0.64) },
      uElevation: { value: 30 },
      uWeather: { value: 0 }
    };
    const gl = renderer.getContext();
    let target = null, volume = null, geometry = null, material = null,
      quad = null, scene = null, camera = null;
    let disposed = false, failed = false, dirty = true, updates = 0,
      lastTime = null, lightingKey = '';
    let weather = 'clear', reason = null, type = null;

    function setLighting(state = {}) {
      if (disposed || failed) return;
      const key = JSON.stringify([state.direction, state.sunColor, state.sunIntensity, state.elevation, state.weather]);
      if (key === lightingKey) return;
      lightingKey = key;
      const elevation = Number.isFinite(state.elevation) ? state.elevation : 30;
      values.uElevation.value = elevation;
      if (state.direction?.length >= 3) uniforms.uAtmosphereSunDirection.value.fromArray(state.direction).normalize();
      weather = ['clear', 'cloudy', 'rainy'].includes(state.weather) ? state.weather : 'clear';
      values.uWeather.value = weather === 'rainy' ? 1 : weather === 'cloudy' ? 0.62 : 0;
      if (state.sunColor?.length >= 3) values.uSunColor.value.fromArray(state.sunColor);
      const daylight = THREE.MathUtils.smoothstep(elevation, -1.2, 1.0);
      // A sunset disk remains visible near zero solar elevation even when terrain direct light is weak.
      const diskColor = new THREE.Color(1.0, 0.58, 0.23)
        .lerp(new THREE.Color(1.0, 0.95, 0.85), THREE.MathUtils.smoothstep(elevation, 0, 24));
      uniforms.uAtmosphereSunRadiance.value.copy(diskColor).multiplyScalar(3.0 * daylight * (weather === 'rainy' ? 0.55 : 1));
      dirty = true;
    }

    function initialize() {
      if (target) return;
      const options = {
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: true
      };
      type = gl.getExtension('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
      function allocate() {
        const next = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { ...options, type });
        next.texture.name = 'Shared moving-cloud atmosphere';
        next.texture.wrapS = THREE.RepeatWrapping;
        next.texture.wrapT = THREE.ClampToEdgeWrapping;
        next.texture.colorSpace = THREE.LinearSRGBColorSpace;
        return next;
      }
      target = allocate();
      renderer.setRenderTarget(target);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && type === THREE.HalfFloatType) {
        target.dispose();
        type = THREE.UnsignedByteType;
        target = allocate();
        renderer.setRenderTarget(target);
      }
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Atmosphere framebuffer is incomplete');
      }
      volume = createCloudVolume(THREE);
      values.uCloudVolume = { value: volume };
      material = new THREE.RawShaderMaterial({
        name: 'Bounded procedural sky and cloud slabs',
        glslVersion: THREE.GLSL3,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: values,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        toneMapped: false
      });
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      quad = new THREE.Mesh(geometry, material);
      quad.frustumCulled = false;
      scene = new THREE.Scene();
      scene.add(quad);
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    function update(timeSeconds) {
      if (disposed || failed || !Number.isFinite(timeSeconds)) return false;
      const time = Math.max(0, timeSeconds);
      if (!dirty && lastTime !== null && time >= lastTime && time - lastTime < UPDATE_INTERVAL - 1e-6) return false;
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
        xrEnabled: renderer.xr?.enabled,
        shaderError: renderer.debug.onShaderError
      };
      try {
        if (renderer.xr) renderer.xr.enabled = false;
        renderer.autoClear = false;
        renderer.info.autoReset = false;
        renderer.debug.onShaderError = (context, program, vertex, fragment) => {
          saved.shaderError?.(context, program, vertex, fragment);
          throw new Error('Atmosphere shader failed to compile');
        };
        initialize();
        values.uCloudTime.value = time;
        renderer.setRenderTarget(target);
        renderer.setViewport(0, 0, WIDTH, HEIGHT);
        renderer.setScissorTest(false);
        renderer.render(scene, camera);
        uniforms.uSkyAtmosphereMap.value = target.texture;
        uniforms.uSkyAtmosphereEnabled.value = 1;
        dirty = false;
        lastTime = time;
        updates++;
        return true;
      } catch (error) {
        failed = true;
        reason = error?.message || String(error);
        uniforms.uSkyAtmosphereEnabled.value = 0;
        console.warn('Procedural atmosphere unavailable; retaining analytic sky:', reason);
        return false;
      } finally {
        renderer.setRenderTarget(saved.target, saved.cubeFace, saved.mipLevel);
        renderer.setViewport(saved.viewport);
        renderer.setScissor(saved.scissor);
        renderer.setScissorTest(saved.scissorTest);
        renderer.setClearColor(saved.clearColor, saved.clearAlpha);
        renderer.autoClear = saved.autoClear;
        renderer.info.autoReset = saved.infoAutoReset;
        Object.assign(renderer.info.render, saved.renderInfo);
        renderer.debug.onShaderError = saved.shaderError;
        if (renderer.xr) renderer.xr.enabled = saved.xrEnabled;
      }
    }

    return {
      uniforms,
      setLighting,
      update,
      getState: () => ({
        supported: !failed && !disposed,
        active: uniforms.uSkyAtmosphereEnabled.value === 1,
        mode: 'cached-procedural-cloud-sky',
        reason,
        width: WIDTH,
        height: HEIGHT,
        time: lastTime,
        updates,
        weather,
        updateHz: 1 / UPDATE_INTERVAL,
        cloudSamples: 24,
        noiseVolumeSize: VOLUME_SIZE,
        windMps: [7.5, 2.7],
        cloudBaseM: 1800,
        cloudThicknessM: 1400,
        estimatedTextureMiB: target
          ? (WIDTH * HEIGHT * (type === THREE.HalfFloatType ? 8 : 4) * 4 / 3 + VOLUME_SIZE ** 3 * 8 / 7) / 1048576
          : 0,
        format: type === THREE.HalfFloatType ? 'RGBA16F' : type ? 'RGBA8' : null
      }),
      dispose() {
        if (disposed) return;
        disposed = true;
        uniforms.uSkyAtmosphereEnabled.value = 0;
        uniforms.uSkyAtmosphereMap.value = empty;
        target?.dispose();
        volume?.dispose();
        geometry?.dispose();
        material?.dispose();
        empty.dispose();
      }
    };
  }
  global.NotoSkyAtmosphere = { create, shaderDeclarations };
})(window);
