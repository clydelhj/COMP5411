/* Directional sky, clouds and analytic Sun and Moon shared by the sky and water. */
(function registerSkyAtmosphere(global) {
  'use strict';

  const WIDTH = 1024;
  const HEIGHT = 256;
  const CLOUD_UPDATE_INTERVAL = 0.25;
  const shaderDeclarations = /* glsl */`
    uniform sampler2D uSkyAtmosphereMap;
    uniform float uSkyAtmosphereEnabled;
    uniform vec3 uAtmosphereSunDirection;
    uniform vec3 uAtmosphereSunRadiance;
    uniform vec4 uMoonDisc;  // Unit direction and angular radius in radians.
    uniform vec4 uMoonLight; // Sunward tangent vector and its component toward the observer.
    uniform vec3 uMoonRadiance;
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
      // Directional sunlight is constant across fragments, so use the base mip.
      return textureLod(uSkyAtmosphereMap,atmosphereSkyUv(direction),0.0).a;
    }
    vec3 atmosphereMoon(vec3 d,float footprint) {
      float radius=uMoonDisc.w;
      if(radius<=0.0 || d.y<=0.0) return vec3(0.0);
      vec3 offset=d-uMoonDisc.xyz;
      float distance2=dot(offset,offset), radius2=radius*radius;
      float kernel2=3.0*radius2+4.0*footprint*footprint;
      if(distance2>=kernel2) return vec3(0.0);

      // For rough reflections one sample can cover the entire Moon. Spread its
      // illuminated area over a normalized angular kernel, conserving its flux.
      float phase=0.5*(1.0+uMoonLight.w);
      float kernel=1.0-distance2/kernel2;
      const float meanAlbedo=0.70;
      float unresolved=3.0*radius2/kernel2*kernel*kernel*phase*0.85*meanAlbedo
                      *smoothstep(-radius,radius,uMoonDisc.y);
      float relativeWidth=footprint/radius;
      if(relativeWidth>=1.25) return uMoonRadiance*unresolved;

      // Resolve the lit hemisphere on the apparent disc. Its bright limb
      // points toward the Sun, regardless of latitude or camera roll.
      vec3 p=(offset-uMoonDisc.xyz*dot(offset,uMoonDisc.xyz))/radius;
      float radial2=dot(p,p), z=sqrt(max(1.0-radial2,0.0));
      float incidence=dot(p,uMoonLight.xyz)+z*uMoonLight.w;
      float aa=clamp(0.5*relativeWidth,0.002,0.48);
      float disc=1.0-smoothstep(1.0-aa,1.0+aa,sqrt(radial2));
      float lit=smoothstep(-aa,aa,incidence)*(0.55+0.45*sqrt(max(incidence,0.0)));
      // A world-oriented tangent frame stays continuous from the horizon to the zenith.
      // Broad, soft markings suggest lunar maria at the few pixels the disc subtends.
      vec2 uv=p.xz-p.y*uMoonDisc.xz/(1.0+uMoonDisc.y);
      vec2 west=(uv-vec2(-0.27,0.04))/vec2(0.48,0.61);
      west.x+=0.46*west.y*west.y;
      vec2 north=(uv-vec2(0.18,0.33))/vec2(0.44,0.26);
      vec2 east=(uv-vec2(0.49,-0.07))/vec2(0.22,0.25);
      float basin=min(dot(west,west),min(dot(north,north),dot(east,east)));
      float albedo=mix(0.31,0.82,smoothstep(0.48-aa,1.20+aa,basin));
      float resolved=disc*lit*albedo*smoothstep(0.0,0.012,phase);
      return uMoonRadiance*mix(resolved,unresolved,smoothstep(0.45,1.25,relativeWidth));
    }
    vec3 atmosphereReflectedMoon(vec3 direction,float footprint) {
      vec3 moon=atmosphereMoon(direction,footprint);
      if(any(greaterThan(moon,vec3(0.0)))) moon*=atmosphereCloudTransmission(uMoonDisc.xyz);
      return moon;
    }
    vec3 atmosphereSkyColor(vec3 direction) {
      vec3 d = normalize(direction);
      vec4 sky = atmosphereSkySample(d);
      // Keep the small solar disk analytic: the cached atlas must not rasterize it into a square.
      float alignment = dot(d,uAtmosphereSunDirection);
      float edge = max(fwidth(alignment)*0.6,0.000002);
      float disk = smoothstep(cos(0.0062)-edge,cos(0.0062)+edge,alignment);
      disk *= smoothstep(-0.001,0.003,d.y);
      vec3 moon=atmosphereMoon(d,length(fwidth(d))*0.7);
      return sky.rgb+(uAtmosphereSunRadiance*disk+moon)*sky.a;
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
    uniform float uCloudTime;
    #include <background_clouds>
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
      vec4 cloud=skyBackgroundClouds(direction,uCloudTime,uWeather,daylight,sunset,uSunDirection);
      atmosphere=vec4(max(mix(sky,cloud.rgb,cloud.a),vec3(0.0)),1.0-cloud.a);
    }
  `;

  function create({ THREE, renderer }) {
    const empty = new THREE.DataTexture(new Uint8Array([12, 23, 45, 255]), 1, 1);
    empty.needsUpdate = true;
    const uniforms = {
      uSkyAtmosphereMap: { value: empty },
      uSkyAtmosphereEnabled: { value: 0 },
      uAtmosphereSunDirection: { value: new THREE.Vector3(0.4, 0.6, -0.7).normalize() },
      uAtmosphereSunRadiance: { value: new THREE.Color(3.0, 2.7, 2.3) },
      uMoonDisc: { value: new THREE.Vector4(0, -1, 0, 0) },
      uMoonLight: { value: new THREE.Vector4() },
      uMoonRadiance: { value: new THREE.Color(0, 0, 0) }
    };
    const values = {
      uResolution: { value: new THREE.Vector2(WIDTH, HEIGHT) },
      uSunDirection: uniforms.uAtmosphereSunDirection,
      uSunColor: { value: new THREE.Color(1.0, 0.82, 0.64) },
      uElevation: { value: 30 },
      uWeather: { value: 0 },
      uCloudTime: { value: 0 }
    };
    const gl = renderer.getContext();
    let target = null, geometry = null, material = null,
      quad = null, scene = null, camera = null;
    let disposed = false, failed = false, dirty = true, updates = 0,
      lastTime = null, lightingKey = '', moonKey = '';
    let weather = 'clear', reason = null, type = null;

    function setLighting(state = {}) {
      if (disposed) return;
      const key = JSON.stringify([state.direction, state.sunColor, state.sunIntensity, state.elevation, state.weather]);
      const lunarKey = JSON.stringify([state.moonDirection, state.moonIllumination, state.moonAngularRadius]);
      const skyChanged = key !== lightingKey;
      if (!skyChanged && lunarKey === moonKey) return;
      lightingKey = key;
      moonKey = lunarKey;
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
      uniforms.uMoonDisc.value.w = 0;
      if (state.moonDirection?.length === 3 && Number.isFinite(state.moonIllumination) && state.moonAngularRadius > 0) {
        const moon = new THREE.Vector3().fromArray(state.moonDirection).normalize();
        if (moon.y > -state.moonAngularRadius) {
          uniforms.uMoonDisc.value.set(moon.x, moon.y, moon.z, state.moonAngularRadius);
          const facing = THREE.MathUtils.clamp(2 * state.moonIllumination - 1, -1, 1);
          const sun = uniforms.uAtmosphereSunDirection.value;
          const tangent = sun.clone().addScaledVector(moon, -sun.dot(moon)).normalize()
            .multiplyScalar(Math.sqrt(1 - facing * facing));
          uniforms.uMoonLight.value.set(tangent.x, tangent.y, tangent.z, facing);
          const height = THREE.MathUtils.smoothstep(moon.y, 0, 0.24);
          const skyDaylight = THREE.MathUtils.smoothstep(elevation, -6, 14);
          uniforms.uMoonRadiance.value.setRGB(1.0, 0.61 + 0.34 * height, 0.38 + 0.51 * height)
            .multiplyScalar((0.34 + 0.88 * height) * (1 - 0.64 * skyDaylight) * (1 - 0.22 * values.uWeather.value));
        }
      }
      if (skyChanged) dirty = true;
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
        next.texture.name = 'Directional sky and clouds';
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
        name: 'Directional sky radiance',
        glslVersion: THREE.GLSL3,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT.replace('#include <background_clouds>', global.NotoCloudLayers.backgroundShader),
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
      // A fixed camera can reuse the atlas between wind updates. A lighting or weather
      // change refreshes immediately, even if the sleep-aware clock has not advanced.
      if (!dirty && lastTime !== null && time >= lastTime && time-lastTime < CLOUD_UPDATE_INTERVAL-1e-6) return false;
      values.uCloudTime.value = time;
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
        mode: 'directional-sky-with-clouds',
        reason,
        width: WIDTH,
        height: HEIGHT,
        time: lastTime,
        updates,
        weather,
        updatePolicy: 'lighting-change-or-cloud-drift',
        cloudUpdateHz: 1 / CLOUD_UPDATE_INTERVAL,
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
