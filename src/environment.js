/* Approximate solar position, weather lighting, local shadows and GPU rain for Noto. Dates and times use JST. */
(function registerEnvironment(global) {
  'use strict';

  const LATITUDE = 37.4375;
  const LONGITUDE = 137.1875;
  const PRESETS = {
    clear: {
      sky: 0xb8d9ed,
      ground: 0x7d8069,
      ambient: 1.4,
      sun: 3.0,
      fog: 100000,
      rain: false
    },
    cloudy: {
      sky: 0xa6b4bf,
      ground: 0x757b76,
      ambient: 1.65,
      sun: 0.9,
      fog: 38000,
      rain: false
    },
    rainy: {
      sky: 0x697f90,
      ground: 0x535e60,
      ambient: 1.15,
      sun: 0.35,
      fog: 14000,
      rain: true
    }
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function solarPosition(date, time, latitude = LATITUDE, longitude = LONGITUDE) {
    /* Compute the solar direction using NOAA's fractional-year approximation, without refraction or terrain occlusion.
Parameters: date is YYYY-MM-DD (2000-2100); time is HH:mm in JST (UTC+9, no DST); latitude and east longitude are degrees.
Parse the calendar explicitly, account for leap years, calculate declination/equation of time, then transform east/up/north into model x/y/z.
Returns elevation and azimuth in degrees and a unit direction vector, or null for invalid input. */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
    const [year, month, day] = date.split('-').map(Number),
      [hour, minute] = time.split(':').map(Number);
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (year < 2000 || year > 2100 || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day || hour > 23 || minute > 59) return null;
    const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
    const doy = (utc.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1;
    const g = 2 * Math.PI / days * (doy - 1 + (hour + minute / 60 - 12) / 24);
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const rad = Math.PI / 180,
      ha = ((hour * 60 + minute + eq + 4 * longitude - 540) / 4 - 180) * rad,
      lat = latitude * rad;
    const east = -Math.cos(dec) * Math.sin(ha);
    const up = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
    const north = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(ha);
    return {
      elevation: Math.asin(clamp(up, -1, 1)) / rad,
      azimuth: (Math.atan2(east, north) / rad + 360) % 360,
      direction: [east, up, -north]
    };
  }
  function create({
    THREE,
    renderer,
    scene,
    camera,
    controls,
    metadata,
    sampleHeight,
    capable,
    onChange
  }) {
    /* Create sunlight, weather, cached shadows and a fixed GPU rain population.
Parameters: THREE/renderer/scene/camera/controls are scene objects; metadata contains dimensions in metres; sampleHeight(x,z) returns displayed height or null; capable selects the initial device tier; onChange(weather) notifies the main scheduler.
Sun elevation and weather control sky, fog and lighting. Shadow coverage follows viewing distance and updates only when needed. Rain stays near the camera and uses a shader clock that freezes during sleep.
Returns view, animation, diagnostics and cleanup interfaces. */
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x656b62, 1.5);
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    scene.add(hemisphere, sun, sun.target);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    sun.shadow.autoUpdate = false;
    sun.shadow.mapSize.set(capable ? 2048 : 1024, capable ? 2048 : 1024);
    sun.shadow.bias = -0.000005;
    const dateInput = document.querySelector('#scene-date'),
      timeInput = document.querySelector('#scene-time');
    const weatherInput = document.querySelector('#scene-weather'),
      label = document.querySelector('#sun-position');
    dateInput.value = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
    timeInput.value = '720';
    const timeOutput = document.querySelector('#scene-time-value');
    const clockTime = () => {
      const minutes = Number(timeInput.value);
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    };
    let weather = 'clear',
      solar = solarPosition(dateInput.value, clockTime()),
      shadowDirty = true,
      shadowUpdates = 0,
      span = 0;
    const previousCamera = new THREE.Vector3(Infinity, 0, 0),
      previousTarget = new THREE.Vector3(Infinity, 0, 0);
    let previousScale = 0,
      lastShadowUpdate = -Infinity;
    const rainUniforms = {
      uRainTime: {
        value: 0
      },
      uRainAnchor: {
        value: new THREE.Vector3()
      },
      uRainColor: {
        value: new THREE.Color(0xa6c1d0)
      },
      uRainBrightness: {
        value: 1
      }
    };
    // RAIN_COUNT: fixed number of rain segments; no per-frame JavaScript particle allocation or movement.
    const RAIN_COUNT = capable ? 2200 : 1200;
    const positions = new Float32Array(RAIN_COUNT * 6),
      ends = new Float32Array(RAIN_COUNT * 2);
    let seed = 5411;
    const random = () => {
      seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < RAIN_COUNT; i++) {
      const p = [(random() - 0.5) * 180, random() * 130, (random() - 0.5) * 180];
      positions.set(p, i * 6);
      positions.set(p, i * 6 + 3);
      ends[i * 2 + 1] = 1;
    }
    const rainGeometry = new THREE.BufferGeometry();
    rainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    rainGeometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const rainMaterial = new THREE.ShaderMaterial({
      uniforms: rainUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `attribute float aEnd; uniform float uRainTime; uniform vec3 uRainAnchor; varying float vRainAlpha;
        void main(){
          vec3 p=position; p.y=70.0-mod(position.y+uRainTime*32.0,130.0);
          p.x += sin(position.y)*2.0; p += vec3(aEnd*0.16,-aEnd*1.8,0.0);
          vec4 view=modelViewMatrix*vec4(p+uRainAnchor,1.0);
          vRainAlpha=(1.0-smoothstep(60.0,110.0,length(p.xz)))*smoothstep(1.0,8.0,-view.z)*0.45;
          gl_Position=projectionMatrix*view;
        }`,
      fragmentShader: `uniform vec3 uRainColor; uniform float uRainBrightness; varying float vRainAlpha;
        void main(){gl_FragColor=vec4(uRainColor*uRainBrightness,vRainAlpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
    const rain = new THREE.LineSegments(rainGeometry, rainMaterial);
    rain.name = 'Noto local rain';
    rain.frustumCulled = false;
    rain.visible = false;
    scene.add(rain);
    function applyLighting() {
      /*
       * Apply the current valid date/time/weather to sunlight, sky and fog. Blend daylight by solar
       * elevation, invalidate shadows, and update the interface. Returns undefined.
       */
      timeOutput.value = clockTime();
      timeInput.setAttribute('aria-valuetext', `${clockTime()} GMT+9`);
      const p = PRESETS[weather],
        day = clamp((solar.elevation + 6) / 16, 0, 1),
        direct = clamp(solar.direction[1] * 5, 0, 1);
      const twilight = (1 - clamp((solar.elevation - 3) / 15, 0, 1))
        * clamp((solar.elevation + 12) / 12, 0, 1)
        * (weather === 'clear' ? 1 : weather === 'cloudy' ? 0.55 : 0.25);
      sun.intensity = p.sun * direct;
      sun.color.set(0xffbe85).lerp(new THREE.Color(0xfff4e3), clamp(solar.elevation / 30, 0, 1));
      sun.castShadow = solar.elevation > 0.5;
      hemisphere.intensity = 0.10 + p.ambient * day;
      hemisphere.color.set(0x23334e).lerp(new THREE.Color(p.sky), day);
      hemisphere.color.lerp(new THREE.Color(0xf1b8a2), twilight * 0.24);
      hemisphere.groundColor.set(p.ground);
      const sky = new THREE.Color(0x0b1222).lerp(new THREE.Color(p.sky), day);
      // Warm distant haze and ambient light agree with the directional twilight sky.
      sky.lerp(new THREE.Color(0xe8b2a5), twilight * 0.40);
      renderer.setClearColor(sky);
      scene.fog = new THREE.Fog(sky, p.fog * 0.15, p.fog);
      rain.visible = p.rain;
      rainUniforms.uRainBrightness.value = 0.2 + day * 0.8;
      label.textContent = `Sun: ${solar.elevation.toFixed(1)}° elevation · ${solar.azimuth.toFixed(1)}° azimuth${solar.elevation <= 0 ? ' · Night' : ''}`;
      shadowDirty = true;
    }
    function changed() {
      /*
       * Validate the calendar fields and apply settings. Invalid input preserves the last valid
       * scene; valid input updates lighting/weather and notifies the scheduler. Returns undefined.
       */
      const next = solarPosition(dateInput.value, clockTime());
      if (!next) {
        label.textContent = 'Choose a valid date (2000–2100) and time.';
        return;
      }
      solar = next;
      weather = weatherInput.value;
      applyLighting();
      onChange(weather);
    }
    for (const input of [dateInput, weatherInput]) input.addEventListener('change', changed);
    timeInput.addEventListener('input', changed);
    function updateView(verticalScale) {
      /* Update the shadow projection for the current view and reuse it while stationary.
Parameter: verticalScale is the displayed terrain height multiplier.
Detect camera/scale changes, centre shadows on terrain near the target, and adjust coverage. Small movements update at most once per 120 ms; geometry, lighting or large camera changes update immediately.
Updates the rain anchor, light position and shadow flags in place. */
      rainUniforms.uRainAnchor.value.copy(camera.position);
      const moved = previousCamera.distanceToSquared(camera.position) > 0.01 || previousTarget.distanceToSquared(controls.target) > 0.01 || previousScale !== verticalScale;
      if (!shadowDirty && !moved) return;
      const now = performance.now();
      const largeMove = Math.max(previousCamera.distanceTo(camera.position), previousTarget.distanceTo(controls.target)) > span * 0.08;
      if (!shadowDirty && !largeMove && previousScale === verticalScale && now - lastShadowUpdate < 120) return;
      lastShadowUpdate = now;
      previousCamera.copy(camera.position);
      previousTarget.copy(controls.target);
      previousScale = verticalScale;
      const focus = controls.target.clone();
      focus.x = clamp(focus.x, -metadata.width_m / 2, metadata.width_m / 2);
      focus.z = clamp(focus.z, -metadata.height_m / 2, metadata.height_m / 2);
      focus.y = sampleHeight(focus.x, focus.z) ?? Math.max(0, focus.y);
      span = clamp(camera.position.distanceTo(focus) * 1.2, 240, Math.max(metadata.width_m, metadata.height_m) * 0.9);
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(new THREE.Vector3(...solar.direction), 50000);
      const sc = sun.shadow.camera;
      sc.left = -span;
      sc.right = span;
      sc.top = span;
      sc.bottom = -span;
      sc.near = 1;
      sc.far = 100000;
      sc.updateProjectionMatrix();
      // Express the base offset in shadow texels, so zooming does not change
      // the acne/contact trade-off arbitrarily. Terrain adds its receiver slope.
      const shadowTexelM = span * 2 / sun.shadow.mapSize.x;
      sun.shadow.bias = -Math.max(0.1, shadowTexelM * 0.25) / (sc.far - sc.near);
      sun.shadow.normalBias = clamp(shadowTexelM * 0.4, 0.1, 4);
      sun.shadow.needsUpdate = renderer.shadowMap.needsUpdate = true;
      shadowUpdates++;
      shadowDirty = false;
    }
    applyLighting();
    return {
      updateView,
      markDirty: () => {
        shadowDirty = true;
      },
      animate: seconds => {
        if (rain.visible) rainUniforms.uRainTime.value += seconds;
      },
      hasAnimation: () => rain.visible,
      getState: () => ({
        date: dateInput.value,
        time: clockTime(),
        timeZone: 'Asia/Tokyo (UTC+09:00)',
        weather,
        ...solar,
        sunColor: sun.color.toArray(),
        sunIntensity: sun.intensity,
        skyColor: scene.fog.color.toArray(),
        cardBrightness: 0.09 + clamp((solar.elevation + 6) / 16, 0, 1) * (weather === 'clear' ? 0.91 : weather === 'cloudy' ? 0.68 : 0.45),
        shadowEnabled: sun.castShadow,
        shadowUpdates,
        shadowSpanM: span * 2,
        shadowMapSize: sun.shadow.mapSize.x,
        rainCount: rain.visible ? RAIN_COUNT : 0,
        rainTime: rainUniforms.uRainTime.value
      }),
      dispose: () => {
        rainGeometry.dispose();
        rainMaterial.dispose();
        sun.shadow.map?.dispose();
      }
    };
  }
  global.NotoEnvironment = {
    solarPosition,
    create
  };
})(window);
