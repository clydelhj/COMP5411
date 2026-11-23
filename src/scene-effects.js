/* Local flashlight and bounded GPU surf spray; no independent animation loop. */
(function registerSceneEffects(global) {
  'use strict';

  // Inputs are the shared scene, displayed height sampler and render scheduler.
  // Orbit inspection lights a terrain hit. The driving beam turns with the vehicle.
  function createFlashlight({
    THREE,
    scene,
    camera,
    renderer,
    metadata,
    sampleHeight,
    shore,
    wake,
    paused,
    firstPersonHeading
  }) {
    const button = document.querySelector('#flashlight-button');
    const light = new THREE.PointLight(0xfff1d2, 0, 1000, 2);
    light.name = 'Pointer flashlight';
    light.castShadow = false;
    const beam = new THREE.SpotLight(0xfff1d2, 720, 90, THREE.MathUtils.degToRad(27), 0.7, 2);
    const beamDrop = Math.tan(THREE.MathUtils.degToRad(9));
    beam.name = 'First-person flashlight';
    beam.visible = false;
    scene.add(light, beam, beam.target);
    const pointer = new THREE.Vector2(),
      ray = new THREE.Raycaster();
    const hit = new THREE.Vector3(),
      candidate = new THREE.Vector3();
    const oldCamera = new THREE.Matrix4(), oldProjection = new THREE.Matrix4();
    let enabled = false,
      dirty = true,
      oldScale = 0,
      oldTiles = null,
      radius = 0,
      hasHit = false;
    renderer.domElement.addEventListener('pointermove', event => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
      if (enabled && !paused() && firstPersonHeading() === null) {
        dirty = true;
        wake();
      }
    });
    button.addEventListener('click', event => {
      enabled = !enabled;
      button.setAttribute('aria-pressed', String(enabled));
      if (firstPersonHeading() !== null && event.detail > 0) renderer.domElement.focus({ preventScroll: true });
      dirty = true;
      wake();
    });
    // Intersect the displayed height field, not millions of mesh triangles.
    // Logarithmic ray steps find the nearest crossing, then bisection locates it.
    function ground(x, z) {
      if (Math.abs(x) > metadata.width_m / 2 || Math.abs(z) > metadata.height_m / 2) return null;
      const y = sampleHeight(x, z);
      return y ?? (shore.distance(x, z) >= 0 ? 0 : null);
    }
    function intersect(limit) {
      let previousT = 0,
        previousGap = null;
      for (let i = 0; i <= 144; i++) {
        const t = Math.expm1(i / 144 * Math.log1p(limit));
        ray.ray.at(t, candidate);
        const height = ground(candidate.x, candidate.z);
        const gap = height === null ? null : candidate.y - height;
        if (gap !== null && gap <= 0 && previousGap !== null && previousGap > 0) {
          let lo = previousT,
            hi = t;
          for (let j = 0; j < 18; j++) {
            const middle = (lo + hi) / 2;
            ray.ray.at(middle, candidate);
            const y = ground(candidate.x, candidate.z);
            if (y === null || candidate.y > y) lo = middle;else hi = middle;
          }
          ray.ray.at((lo + hi) / 2, hit);
          return true;
        }
        previousT = t;
        previousGap = gap;
      }
      return false;
    }
    return {
      update(scale, tiles) {
        if (!enabled) {
          const wasLit = light.intensity > 0 || beam.visible;
          light.intensity = 0;
          light.visible = true;
          beam.visible = false;
          hasHit = false;
          return wasLit;
        }
        const heading = firstPersonHeading();
        const wasDriving = beam.visible;
        beam.visible = heading !== null;
        light.visible = !beam.visible;
        if (beam.visible) {
          const yaw = THREE.MathUtils.degToRad(heading);
          ray.ray.origin.copy(camera.position);
          ray.ray.direction.set(Math.sin(yaw), -beamDrop, -Math.cos(yaw)).normalize();
          candidate.copy(ray.ray.origin).add(ray.ray.direction);
          const moved = !beam.position.equals(ray.ray.origin) || !beam.target.position.equals(candidate);
          beam.position.copy(ray.ray.origin);
          beam.target.position.copy(candidate);
          light.intensity = 0;
          return !wasDriving || moved;
        }
        camera.updateMatrixWorld();
        if (!dirty && !wasDriving && oldScale === scale && oldTiles === tiles &&
            oldCamera.equals(camera.matrixWorld) && oldProjection.equals(camera.projectionMatrix)) return false;
        dirty = false;
        oldScale = scale;
        oldTiles = tiles;
        oldCamera.copy(camera.matrixWorld);
        oldProjection.copy(camera.projectionMatrix);
        ray.setFromCamera(pointer, camera);
        const wasLit = light.intensity > 0;
        hasHit = intersect(Math.min(camera.far, 200000));
        if (!hasHit) {
          light.intensity = 0;
          return wasDriving || wasLit;
        }
        const nextRadius = THREE.MathUtils.clamp(camera.position.distanceTo(hit) * 0.12, 24, 360);
        candidate.copy(hit);
        candidate.y += nextRadius * 0.7;
        const moved = !light.position.equals(candidate) || nextRadius !== radius;
        radius = nextRadius;
        light.position.copy(candidate);
        light.distance = radius * 2.6;
        light.intensity = radius * radius * 2.4;
        return wasDriving || !wasLit || moved;
      },
      ready() {
        button.disabled = false;
      },
      getState() {
        // The driving beam lights rendered geometry directly. Only diagnostics need a terrain hit.
        const surfaceHit = beam.visible ? intersect(beam.distance) : hasHit;
        const radiusM = beam.visible && surfaceHit ? ray.ray.origin.distanceTo(hit) * Math.tan(beam.angle) : radius;
        return { enabled, hasHit: surfaceHit, target: surfaceHit ? hit.toArray() : null, radiusM: surfaceHit ? radiusM : 0 };
      },
      dispose() {
        scene.remove(light, beam, beam.target);
      }
    };
  }

  // Shore anchors are rebuilt only when tiles or the local camera neighbourhood
  // change; the shared water clock drives GPU motion and automatically sleeps.
  function createSurf({
    THREE,
    terrain,
    camera,
    renderer,
    field,
    motion
  }) {
    const MAX_POINTS = 7200;
    const positions = new Float32Array(MAX_POINTS * 3),
      directions = new Float32Array(MAX_POINTS * 2),
      seeds = new Float32Array(MAX_POINTS * 2);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aDirection', new THREE.BufferAttribute(directions, 2));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 2));
    geometry.setDrawRange(0, 0);
    const uniforms = {
      ...motion.uniforms,
      uSurfPixelScale: {
        value: 1
      },
      uSurfBrightness: {
        value: 1
      }
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `${motion.shaderDeclarations}
        attribute vec2 aDirection; attribute vec2 aSeed;
        uniform float uSurfPixelScale; varying float vAlpha;
        void main() {
          float cycle=fract(surfPhase(position.xz,4.0)/6.28318530718-0.25+aSeed.x*0.12);
          float age=cycle/0.16, life=1.15+aSeed.y*0.35;
          // Keep each emitted particle's wave-set strength fixed during its flight.
          float strength=surfStrength(position.xz,uSeaTime-age);
          vec3 p=position;
          p.xz += aDirection*(3.0+aSeed.x*2.0-age*1.4);
          p.xz += vec2(-aDirection.y,aDirection.x)*(aSeed.y-0.5)*(0.8+age*1.2);
          p.y=(0.12+max(0.0,(3.5+aSeed.y)*age-3.4*age*age)*sqrt(strength))*uSeaWeather/uSeaScaleY;
          vec4 view=modelViewMatrix*vec4(p,1.0);
          float size=(0.08+aSeed.x*0.18)*uSurfPixelScale/max(1.0,-view.z);
          // Subpixel spray loses coverage instead of becoming a row of equally bright
          // one-pixel beads. The fixed pool still uses the shared sleep-aware clock.
          vAlpha=(1.0-age/life)*(1.0-smoothstep(450.0,1500.0,-view.z))*smoothstep(0.25,0.75,strength)*0.55
            *smoothstep(0.35,1.2,size);
          gl_Position=projectionMatrix*view;
          gl_PointSize=clamp(size,0.5,4.5);
          if(age>life || view.z>-1.0) { vAlpha=0.0; gl_Position=vec4(2.0,2.0,2.0,1.0); }
        }`,
      fragmentShader: `uniform float uSurfBrightness; varying float vAlpha;
        void main() {
          float radius=length(gl_PointCoord-0.5)*2.0;
          if(radius>1.0 || vAlpha<=0.0) discard;
          gl_FragColor=vec4(vec3(0.78,0.87,0.85)*uSurfBrightness,vAlpha*(1.0-smoothstep(0.15,1.0,radius)));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
    const mesh = new THREE.Points(geometry, material);
    mesh.name = 'Coastal breaking spray';
    mesh.frustumCulled = false;
    terrain.add(mesh);
    const oldPosition = new THREE.Vector3(Infinity, 0, 0);
    let oldTiles = null,
      count = 0,
      rebuilds = 0;
    const hash = (x, z) => {
      const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      return n - Math.floor(n);
    };
    return {
      update(tiles, brightness) {
        uniforms.uSurfBrightness.value = brightness;
        uniforms.uSurfPixelScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
        if (tiles === oldTiles && oldPosition.distanceToSquared(camera.position) < 96 * 96) return;
        oldTiles = tiles;
        oldPosition.copy(camera.position);
        const candidates = [];
        for (const item of tiles.values()) {
          const segments = item.geometry.coastSegments;
          if (!segments) continue;
          for (let i = 0; i < segments.length; i += 4) {
            const x = (segments[i] + segments[i + 2]) / 2,
              z = (segments[i + 1] + segments[i + 3]) / 2;
            const distance = Math.hypot(x - camera.position.x, z - camera.position.z);
            if (distance < 1500 && hash(x, z) > 0.35) candidates.push({
              x,
              z,
              distance
            });
          }
        }
        candidates.sort((a, b) => a.distance - b.distance);
        count = 0;
        for (const {
          x,
          z
        } of candidates.slice(0, MAX_POINTS / 6)) {
          let dx = field.distance(x + 1, z) - field.distance(x - 1, z),
            dz = field.distance(x, z + 1) - field.distance(x, z - 1);
          const length = Math.hypot(dx, dz) || 1;
          dx /= length;
          dz /= length;
          for (let j = 0; j < 6; j++) {
            positions.set([x, 0, z], count * 3);
            directions.set([dx, dz], count * 2);
            seeds.set([hash(x + j * 7, z), hash(z - j * 11, x)], count * 2);
            count++;
          }
        }
        geometry.setDrawRange(0, count);
        for (const attribute of Object.values(geometry.attributes)) attribute.needsUpdate = true;
        rebuilds++;
      },
      getState: () => ({
        points: count,
        rebuilds
      }),
      dispose() {
        terrain.remove(mesh);
        geometry.dispose();
        material.dispose();
      }
    };
  }
  global.NotoSceneEffects = {
    createFlashlight,
    createSurf
  };
})(window);
