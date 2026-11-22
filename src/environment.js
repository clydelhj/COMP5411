/* Solar and lunar positions, weather lighting, local shadows and GPU rain. Dates and times use JST. */
(function registerEnvironment(global) {
  'use strict';

  const LATITUDE = 37.4375;
  const LONGITUDE = 137.1875;
  const MINUTES_PER_DAY = 1440;
  const DAY_PLAYBACK_MS = 10000;
  const LAST_SCENE_MINUTE = Date.UTC(2101, 0, 1) / 60000 - 1;
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
  function todayInJapan() {
    return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  }
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
  // Leading periodic terms of Meeus, Astronomical Algorithms, Tables 47.A–B.
  // The caller supplies a validated Japanese date/time and the scene's solar direction.
  function lunarPosition(date, time, sunDirection, latitude = LATITUDE, longitude = LONGITUDE) {
    const days = (Date.parse(`${date}T${time}:00+09:00`) - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const rad = Math.PI / 180;
    const { sin, cos } = Math;
    const meanLongitude = 218.31645 + 13.17639648 * days;
    const elongation = (297.85019 + 12.19074912 * days) * rad;
    const solarAnomaly = (357.52911 + 0.98560028 * days) * rad;
    const anomaly = (134.96340 + 13.06499295 * days) * rad;
    const argument = (93.27210 + 13.22935024 * days) * rad;
    const twiceElongation = 2 * elongation;
    const lon = rad * (meanLongitude + 6.289 * sin(anomaly) + 1.274 * sin(twiceElongation - anomaly)
      + 0.658 * sin(twiceElongation) + 0.214 * sin(2 * anomaly) - 0.185 * sin(solarAnomaly)
      - 0.114 * sin(2 * argument) + 0.059 * sin(twiceElongation - 2 * anomaly)
      + 0.057 * sin(twiceElongation - solarAnomaly - anomaly) + 0.053 * sin(twiceElongation + anomaly)
      + 0.046 * sin(twiceElongation - solarAnomaly) - 0.041 * sin(solarAnomaly - anomaly));
    const lat = rad * (5.128 * sin(argument) + 0.281 * sin(anomaly + argument)
      + 0.278 * sin(anomaly - argument) + 0.173 * sin(twiceElongation - argument)
      + 0.055 * sin(twiceElongation - anomaly + argument) + 0.046 * sin(twiceElongation - anomaly - argument)
      + 0.033 * sin(twiceElongation + argument) + 0.017 * sin(2 * anomaly + argument));
    const distanceKm = 385001 - 20905 * cos(anomaly) - 3699 * cos(twiceElongation - anomaly)
      - 2956 * cos(twiceElongation) - 570 * cos(2 * anomaly) + 246 * cos(twiceElongation - 2 * anomaly)
      - 205 * cos(twiceElongation - solarAnomaly) - 171 * cos(twiceElongation + anomaly);

    // Rotate ecliptic coordinates to equatorial, then into the observer's local frame.
    const tilt = (23.43929 - 0.0000003563 * days) * rad;
    const x = cos(lat) * cos(lon);
    const y = cos(lat) * sin(lon) * cos(tilt) - sin(lat) * sin(tilt);
    const z = cos(lat) * sin(lon) * sin(tilt) + sin(lat) * cos(tilt);
    const sidereal = (280.46061837 + 360.98564736629 * days + longitude) * rad;
    const observerLat = latitude * rad;
    const meridian = x * cos(sidereal) + y * sin(sidereal);
    const east = distanceKm * (y * cos(sidereal) - x * sin(sidereal));
    const north = distanceKm * (z * cos(observerLat) - meridian * sin(observerLat));
    // Subtract the spherical observer's offset for horizontal parallax.
    const up = distanceKm * (z * sin(observerLat) + meridian * cos(observerLat)) - 6371;
    const rangeKm = Math.hypot(east, up, north);
    const direction = [east / rangeKm, up / rangeKm, -north / rangeKm];
    const sunDot = direction[0] * sunDirection[0] + direction[1] * sunDirection[1] + direction[2] * sunDirection[2];
    return {
      moonDirection: direction,
      moonIllumination: clamp((1 - sunDot) / 2, 0, 1),
      moonAngularRadius: Math.asin(1737.4 / rangeKm)
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
    dateInput.value = solarPosition(dateInput.value, '12:00') ? dateInput.value : todayInJapan();
    timeInput.value = '720';
    const timeOutput = document.querySelector('#scene-time-value');
    const cycleButton = document.querySelector('#day-cycle');
    let cycle = null;
    const clockTime = () => {
      const minutes = Number(timeInput.value);
      return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    };
    const center = metadata.geographicCenter;
    let solar, moon, lastSkyTime;
    function updateEphemeris() {
      const date = dateInput.value, time = clockTime(), key = date + 'T' + time;
      if (key === lastSkyTime) return true;
      const nextSun = solarPosition(date, time, center?.latitude, center?.longitude);
      if (!nextSun) return false;
      solar = nextSun;
      moon = lunarPosition(date, time, solar.direction, center?.latitude, center?.longitude);
      lastSkyTime = key;
      return true;
    }
    updateEphemeris();
    let weather = 'clear',
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
      ends = new Float32Array(RAIN_COUNT * 2),
      motion = new Float32Array(RAIN_COUNT * 6);
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
      // Each streak has a stable fall speed, exposure length and wind response.
      const drop = [9 + random() * 6, 0.035 + random() * 0.02, 0.8 + random() * 0.4];
      motion.set(drop, i * 6);
      motion.set(drop, i * 6 + 3);
    }
    const rainGeometry = new THREE.BufferGeometry();
    rainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    rainGeometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    rainGeometry.setAttribute('aRainMotion', new THREE.BufferAttribute(motion, 3));
    const rainMaterial = new THREE.ShaderMaterial({
      uniforms: rainUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `attribute float aEnd; attribute vec3 aRainMotion;
        uniform float uRainTime; uniform vec3 uRainAnchor; varying float vRainAlpha;
        void main(){
          vec3 velocity=vec3(3.6*aRainMotion.z,-aRainMotion.x,-1.8*aRainMotion.z);
          vec3 extent=vec3(180.0,130.0,180.0);
          // Wrap a world-space trajectory into the visible local volume. Subtracting
          // the camera before wrapping keeps the same drop fixed in the world while panning.
          vec3 relative=mod(position+velocity*uRainTime-uRainAnchor+extent*0.5,extent)-extent*0.5;
          vec3 p=relative+uRainAnchor-velocity*(aRainMotion.y*aEnd);
          vec4 view=modelViewMatrix*vec4(p,1.0);
          // Fade before every wrap boundary, including the top/bottom recycle planes.
          float volume=(1.0-smoothstep(55.0,86.0,length(relative.xz)))
            *(1.0-smoothstep(45.0,62.0,abs(relative.y)));
          vRainAlpha=volume*smoothstep(1.0,8.0,-view.z)*mix(0.42,0.08,aEnd);
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
    function changed(playbackTick = false) {
      /*
       * Validate the calendar fields and apply settings. Invalid input preserves the last valid
       * scene; valid input updates lighting/weather and notifies the scheduler.
       */
      if (!updateEphemeris()) {
        label.textContent = 'Choose a valid date (2000–2100) and time.';
        return false;
      }
      weather = weatherInput.value;
      applyLighting();
      onChange(weather, playbackTick);
      return true;
    }
    function pauseDayCycle() {
      if (!cycle) return;
      cycle = null;
      cycleButton.textContent = 'Play';
      cycleButton.title = 'Play one day every 10 seconds';
      cycleButton.setAttribute('aria-label', 'Play day-night cycle');
    }
    cycleButton.addEventListener('click', () => {
      if (cycle) {
        pauseDayCycle();
        return;
      }
      if (!changed()) return;
      const now = performance.now();
      // Count the displayed JST calendar minutes on a UTC grid, independent of the browser's time zone.
      const startMinute = Date.parse(dateInput.value + 'T00:00:00Z') / 60000 + Number(timeInput.value);
      cycle = { startMinute, startMs: now, lastUpdateMs: now };
      cycleButton.textContent = 'Pause';
      cycleButton.title = 'Pause day-night cycle';
      cycleButton.setAttribute('aria-label', 'Pause day-night cycle');
    });
    function advanceDayCycle(now) {
      // Limit lighting and shadow updates to 20 Hz while keeping the clock tied to elapsed real time.
      if (!cycle || now - cycle.lastUpdateMs < 50) return false;
      cycle.lastUpdateMs = now;
      const elapsedMinutes = Math.floor((now - cycle.startMs) * MINUTES_PER_DAY / DAY_PLAYBACK_MS);
      const minute = Math.min(cycle.startMinute + elapsedMinutes, LAST_SCENE_MINUTE);
      dateInput.value = new Date(minute * 60000).toISOString().slice(0, 10);
      timeInput.value = String(minute % MINUTES_PER_DAY);
      if (minute === LAST_SCENE_MINUTE) pauseDayCycle();
      changed(true);
      return true;
    }
    function manualTimeChange() {
      pauseDayCycle();
      changed();
    }
    dateInput.addEventListener('change', manualTimeChange);
    timeInput.addEventListener('input', manualTimeChange);
    weatherInput.addEventListener('change', () => changed());
    function updateView(verticalScale) {
      /* Update the shadow projection for the current view and reuse it while stationary.
Parameter: verticalScale is the displayed terrain height multiplier.
Detect camera/scale changes, centre shadows on terrain near the target, and adjust coverage. Small movements update at most once per 120 ms; geometry, lighting or large camera changes update immediately.
Updates the rain anchor, light position and shadow flags in place. */
      rainUniforms.uRainAnchor.value.copy(camera.position);
      // Preserve visibility of the terrain being inspected in high regional views.
      // At ground level the weather preset retains its normal distance haze.
      const fogRange = PRESETS[weather].fog;
      const orbitDistance = camera.position.distanceTo(controls.target);
      scene.fog.near = Math.max(fogRange * 0.15, orbitDistance * 0.85);
      scene.fog.far = Math.max(fogRange, scene.fog.near + Math.max(fogRange * 0.85, orbitDistance));
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
      advanceDayCycle,
      pauseDayCycle,
      isDayCyclePlaying: () => cycle !== null,
      markDirty: () => {
        shadowDirty = true;
      },
      animate: seconds => {
        if (rain.visible && Number.isFinite(seconds) && seconds > 0) rainUniforms.uRainTime.value += seconds;
      },
      hasAnimation: () => rain.visible,
      getState: () => ({
        date: dateInput.value,
        time: clockTime(),
        timeZone: 'Asia/Tokyo (UTC+09:00)',
        weather,
        ...solar,
        ...moon,
        sunColor: sun.color.toArray(),
        sunIntensity: sun.intensity,
        hemisphereColor: hemisphere.color.toArray(),
        hemisphereGroundColor: hemisphere.groundColor.toArray(),
        hemisphereIntensity: hemisphere.intensity,
        skyColor: scene.fog.color.toArray(),
        cardBrightness: 0.09 + clamp((solar.elevation + 6) / 16, 0, 1) * (weather === 'clear' ? 0.91 : weather === 'cloudy' ? 0.68 : 0.45),
        shadowEnabled: sun.castShadow,
        shadowUpdates,
        shadowSpanM: span * 2,
        shadowMapSize: sun.shadow.mapSize.x,
        rainCount: rain.visible ? RAIN_COUNT : 0,
        rainTime: rainUniforms.uRainTime.value,
        rainMotion: 'world-anchored-wind-streaks',
        rainFallSpeedMps: [9, 15],
        rainExposureSeconds: [0.035, 0.055]
      }),
      dispose: () => {
        rainGeometry.dispose();
        rainMaterial.dispose();
        sun.shadow.map?.dispose();
      }
    };
  }
  global.NotoEnvironment = {
    todayInJapan,
    solarPosition,
    create
  };
})(window);
