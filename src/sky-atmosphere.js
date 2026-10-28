/* Clear atmospheric illumination and the analytic sun, shared by sky and water.
 * Elevated cloud volumes are composed separately in world space.
 */
(function registerSkyAtmosphere(global) {
  'use strict';

  const WIDTH = 1024;
  const HEIGHT = 256;
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
    out vec4 atmosphere;
    uniform vec2 uResolution;
    uniform vec3 uSunDirection;
    uniform vec3 uSunColor;
    uniform float uElevation;
    uniform float uWeather;
    void main() {
      vec2 uv = gl_FragCoord.xy/uResolution;
      float azimuth = (uv.x-0.5)*6.28318530718;
      float elevation = uv.y*1.57079632679;
      vec3 direction = vec3(cos(azimuth)*cos(elevation),sin(elevation),sin(azimuth)*cos(elevation));
      float y = max(direction.y,0.0);
      float daylight = smoothstep(-12.0,9.0,uElevation);
      float sunset = (1.0-smoothstep(2.0,18.0,uElevation))*smoothstep(-13.0,-1.0,uElevation);
      vec3 dayZenith = vec3(0.035,0.205,0.405);
      vec3 dayHorizon = vec3(0.43,0.64,0.76);
      vec3 nightZenith = vec3(0.0011,0.0024,0.0062);
      vec3 nightHorizon = vec3(0.0045,0.008,0.019);
      float height = sqrt(y);
      vec3 sky = mix(mix(nightHorizon,nightZenith,height),mix(dayHorizon,dayZenith,height),daylight);
      vec2 sunHorizontal = normalize(uSunDirection.xz+vec2(0.00001));
      vec2 viewHorizontal = normalize(direction.xz+vec2(0.00001));
      float towardSun = pow(clamp(dot(sunHorizontal,viewHorizontal)*0.5+0.5,0.0,1.0),3.0);
      float horizon = exp(-y*7.5);
      vec3 duskHorizon = mix(vec3(0.34,0.16,0.25),vec3(1.04,0.40,0.24),towardSun);
      sky = mix(sky,duskHorizon,sunset*horizon*0.89);
      float solarAlignment = max(dot(direction,uSunDirection),0.0);
      float halo = pow(solarAlignment,12.0)*0.13+pow(solarAlignment,90.0)*0.20;
      sky += mix(vec3(0.66,0.76,0.87),vec3(1.15,0.49,0.20),sunset)*halo*daylight;
      vec3 overcast = mix(vec3(0.005,0.009,0.018),vec3(0.27,0.34,0.41),daylight);
      sky = mix(sky,overcast,uWeather*0.42);
      sky += uSunColor*pow(solarAlignment,320.0)*0.32*daylight;
      atmosphere = vec4(max(sky,vec3(0.0)),1.0);
    }
  `;

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
      uSunDirection: uniforms.uAtmosphereSunDirection,
      uSunColor: { value: new THREE.Color(1.0, 0.82, 0.64) },
      uElevation: { value: 30 },
      uWeather: { value: 0 }
    };
    const gl = renderer.getContext();
    let target = null, geometry = null, material = null,
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
        next.texture.name = 'Shared clear atmosphere';
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
      material = new THREE.RawShaderMaterial({
        name: 'Clear atmospheric illumination',
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
      if (!dirty && target) return false;
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
        renderer.setRenderTarget(target);
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
        mode: 'lighting-driven-clear-atmosphere',
        reason,
        width: WIDTH,
        height: HEIGHT,
        time: lastTime,
        updates,
        weather,
        updatePolicy: 'lighting-change',
        estimatedTextureMiB: target
          ? (WIDTH * HEIGHT * (type === THREE.HalfFloatType ? 8 : 4) * 4 / 3) / 1048576
          : 0,
        format: type === THREE.HalfFloatType ? 'RGBA16F' : type ? 'RGBA8' : null
      }),
      dispose() {
        if (disposed) return;
        disposed = true;
        uniforms.uSkyAtmosphereEnabled.value = 0;
        uniforms.uSkyAtmosphereMap.value = empty;
        target?.dispose();
        geometry?.dispose();
        material?.dispose();
        empty.dispose();
      }
    };
  }
  global.NotoSkyAtmosphere = { create, shaderDeclarations };
})(window);
