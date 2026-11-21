/* Shared atmospheric illumination and the open-water horizon beyond the survey. */
(function registerOceanBackdrop(global) {
  'use strict';

  // Generalize the observed land/water distribution along the survey perimeter.
  // A broad inland edge stays dry; a single coastal texel cannot split the far horizon.
  function boundaryExposure(THREE, width, height, motion, hasOcean) {
    const count = 512, perimeter = 2 * (width + height);
    const samples = new Uint8Array(count), filtered = new Uint8Array(count);
    const inset = Math.min(0.5, width * 0.01, height * 0.01);
    if (hasOcean) {
      for (let i = 0; i < count; i++) {
        const s = (i + 0.5) / count * perimeter;
        let x, z;
        if (s < width) { x = s - width / 2; z = -height / 2; }
        else if (s < width + height) { x = width / 2; z = s - width - height / 2; }
        else if (s < 2 * width + height) { x = 1.5 * width + height - s; z = height / 2; }
        else { x = -width / 2; z = 2 * width + 1.5 * height - s; }
        x = THREE.MathUtils.clamp(x, -width / 2 + inset, width / 2 - inset);
        z = THREE.MathUtils.clamp(z, -height / 2 + inset, height / 2 - inset);
        samples[i] = motion.shoreAt(x, z) > 0 ? 1 : 0;
      }
      const radius = Math.max(2, Math.round(Math.min(width, height) * 0.25 / perimeter * count));
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let j = -radius; j <= radius; j++) sum += samples[(i + j + count) % count] * (radius + 1 - Math.abs(j));
        const fraction = sum / ((radius + 1) ** 2);
        filtered[i] = Math.round(255 * THREE.MathUtils.smoothstep(fraction, 0.015, 0.55));
      }
    }
    const texture = new THREE.DataTexture(filtered, count, 1, THREE.RedFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  const EXPOSURE_GLSL = /* glsl */`
    uniform vec2 uBackdropSize;
    uniform sampler2D uBoundaryExposure;
    float distantOceanCoverage(vec2 contact) {
      vec2 halfSize = uBackdropSize * 0.5;
      vec2 origin = clamp(cameraPosition.xz,-halfSize+halfSize*0.00001,halfSize-halfSize*0.00001);
      vec2 ray = contact-origin;
      vec2 signs = mix(vec2(-1.0),vec2(1.0),step(vec2(0.0),ray));
      vec2 t = (halfSize-signs*origin) / max(abs(ray),vec2(1e-8));
      vec2 edge = clamp(origin+min(t.x,t.y)*ray,-halfSize,halfSize);
      float w=uBackdropSize.x, h=uBackdropSize.y;
      float s = t.x<t.y
        ? (ray.x>0.0 ? w+halfSize.y+edge.y : 2.0*w+h+halfSize.y-edge.y)
        : (ray.y>0.0 ? w+h+halfSize.x-edge.x : halfSize.x+edge.x);
      return texture2D(uBoundaryExposure,vec2(s/(2.0*(w+h)),0.5)).r;
    }
  `;

  function create({ THREE, scene, terrain, camera, metadata, motion, materials, hasOcean = true }) {
    const width = metadata.width_m, height = metadata.height_m;
    const opacity = { value: 0 };
    const offshoreBlendM = { value: THREE.MathUtils.clamp(Math.min(width, height) * 0.12, 80, 2500) };
    const viewFar = { value: camera.far };
    const exposure = boundaryExposure(THREE, width, height, motion, hasOcean);
    const skyGeometry = new THREE.BufferGeometry();
    skyGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const skyUniforms = {
      ...motion.uniforms,
      uBackdropSize: { value: new THREE.Vector2(width, height) },
      uBoundaryExposure: { value: exposure },
      uBackdropOpacity: opacity,
      uOffshoreBlendM: offshoreBlendM,
      uSkyInverseProjection: { value: new THREE.Matrix4() },
      uSkyCameraWorld: { value: new THREE.Matrix4() }
    };
    const skyMaterial = new THREE.ShaderMaterial({
      name: 'Ocean-coherent atmospheric sky',
      uniforms: skyUniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: `varying vec2 vSkyUv;
        void main() { vSkyUv=position.xy*0.5+0.5; gl_Position=vec4(position.xy,0.999999,1.0); }`,
      fragmentShader: `${motion.skyShaderDeclarations}
        uniform mat4 uSkyInverseProjection; uniform mat4 uSkyCameraWorld;
        uniform vec3 uSeaSunColor; uniform float uSeaSunIntensity;
        ${EXPOSURE_GLSL}
        uniform float uBackdropOpacity; uniform float uOffshoreBlendM;
        varying vec2 vSkyUv;
        void main() {
          vec4 view=uSkyInverseProjection*vec4(vSkyUv*2.0-1.0,1.0,1.0);
          vec3 direction=normalize((uSkyCameraWorld*vec4(view.xyz/view.w,0.0)).xyz);
          vec3 color=seaSkyColor(direction);
          float alignment=dot(direction,uSeaSunDirection);
          float disk=smoothstep(0.99997,0.999992,alignment);
          float halo=pow(max(alignment,0.0),96.0)*0.025;
          // The shared sky atlas attenuates the analytic sun with its cloud coverage.
          if(uSkyAtmosphereEnabled<0.5) color += uSeaSunColor*uSeaSunIntensity*(disk*2.0+halo);
          // A ray-plane intersection has no far clip or rectangular outer edge.
          // World geometry draws over this background and owns the entire survey footprint.
          float horizonAA = max(fwidth(direction.y), 0.0003);
          if (uBackdropOpacity > 0.0 && direction.y < 0.0 && cameraPosition.y > 0.0) {
            float travel = cameraPosition.y / max(-direction.y, 1e-7);
            vec2 contact = cameraPosition.xz + travel * direction.xz;
            float outside = length(max(abs(contact) - uBackdropSize * 0.5, vec2(0.0)));
            float offshore = smoothstep(0.0, uOffshoreBlendM, outside);
            float water = smoothstep(0.0, horizonAA, -direction.y);
            vec3 flatReflection = vec3(direction.x, -direction.y, direction.z);
            vec3 distantWater = (color + atmosphereReflectedMoon(flatReflection,0.018)) * vec3(0.68, 0.79, 0.86);
            color = mix(color, distantWater, offshore * distantOceanCoverage(contact) * water * uBackdropOpacity);
          }
          gl_FragColor=vec4(color,1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
    const sky = new THREE.Mesh(skyGeometry, skyMaterial);
    sky.name = 'Shared ocean and sky illumination';
    sky.frustumCulled = false;
    skyMaterial.userData.temporalReactive = true;
    sky.renderOrder = -10000;
    sky.onBeforeRender = (_renderer, _scene, view) => {
      skyUniforms.uSkyInverseProjection.value.copy(view.projectionMatrixInverse);
      skyUniforms.uSkyCameraWorld.value.copy(view.matrixWorld);
    };
    scene.add(sky);

    const horizon = new THREE.Group();
    horizon.name = 'Illustrative distant offshore water';
    const horizonMaterial = materials.top.clone();
    horizonMaterial.name = 'Fading offshore horizon';
    horizonMaterial.transparent = true;
    horizonMaterial.depthWrite = false;
    horizonMaterial.defaultAttributeValues = materials.top.defaultAttributeValues;
    horizonMaterial.userData.temporalReactive = true;
    const decorate = materials.top.onBeforeCompile;
    horizonMaterial.onBeforeCompile = shader => {
      decorate(shader);
      shader.uniforms.uOceanBackdropOpacity = opacity;
      shader.uniforms.uOffshoreBlendM = offshoreBlendM;
      shader.uniforms.uBackdropViewFar = viewFar;
      shader.uniforms.uBackdropSize = skyUniforms.uBackdropSize;
      shader.uniforms.uBoundaryExposure = skyUniforms.uBoundaryExposure;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + EXPOSURE_GLSL + '\nuniform float uOceanBackdropOpacity, uOffshoreBlendM, uBackdropViewFar;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        // Follow the measured shoreline beside the crop. Extending a binary edge texel
        // indefinitely would turn a headland into a straight offshore strip.
        vec2 halfSize = uSeaSize * 0.5;
        vec2 inset = min(halfSize * 0.5, vec2(0.5));
        vec2 cropEdge = clamp(vNotoWaterXZ, -halfSize + inset, halfSize - inset);
        float outside = length(max(abs(vNotoWaterXZ) - halfSize, vec2(0.0)));
        float offshore = smoothstep(0.0, uOffshoreBlendM, outside);
        float edgeWater = smoothstep(-2.0, 2.0, shoreDistance(cropEdge));
        float detailFade = max(smoothstep(2.0, 4.0, outside / uOffshoreBlendM),
                               smoothstep(0.65, 0.95, vViewPosition.z / uBackdropViewFar) * offshore);
        diffuseColor.a *= uOceanBackdropOpacity * mix(edgeWater, distantOceanCoverage(vNotoWaterXZ), offshore) * (1.0 - detailFade);
        #include <opaque_fragment>`);
    };
    horizonMaterial.customProgramCacheKey = () => `${materials.top.customProgramCacheKey()}-horizon-v2`;
    const margin = 4 * offshoreBlendM.value;
    const strips = [
      [width + 2 * margin, margin, 0, -(height + margin) / 2],
      [width + 2 * margin, margin, 0, (height + margin) / 2],
      [margin, height, -(width + margin) / 2, 0],
      [margin, height, (width + margin) / 2, 0]
    ];
    for (const [w, h, x, z] of strips) {
      const geometry = new THREE.PlaneGeometry(w, h, 24, 12);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(x, 0, z);
      geometry.computeBoundingBox();
      const mesh = new THREE.Mesh(geometry, horizonMaterial);
      mesh.receiveShadow = false;
      horizon.add(mesh);
    }
    terrain.add(horizon);
    const smooth = (a, b, value) => {
      const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };
    const viewDirection = new THREE.Vector3();
    const viewMatrix = new THREE.Matrix4(), viewFrustum = new THREE.Frustum(), stripBounds = new THREE.Box3();
    let inView = false;
    return {
      update() {
        camera.getWorldDirection(viewDirection);
        const low = 1 - smooth(2500, 8000, camera.position.y);
        const oblique = 1 - smooth(0.40, 0.76, -viewDirection.y);
        opacity.value = hasOcean && camera.position.y > 0 ? low * oblique : 0;
        viewFar.value = camera.far;
        horizon.visible = opacity.value > 0.001;
        inView = false;
        if (horizon.visible) {
          camera.updateMatrixWorld();
          viewMatrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
          viewFrustum.setFromProjectionMatrix(viewMatrix);
          horizon.updateWorldMatrix(true,true);
          inView = horizon.children.some(mesh => viewFrustum.intersectsBox(stripBounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)));
        }
      },
      getState: () => ({ sky: true, horizonVisible: horizon.visible, horizonInView: inView, horizonOpacity: opacity.value, horizonMarginM: margin, horizonTriangles: 24 * 12 * 2 * strips.length }),
      dispose() {
        scene.remove(sky);
        terrain.remove(horizon);
        skyGeometry.dispose();
        skyMaterial.dispose();
        exposure.dispose();
        for (const mesh of horizon.children) mesh.geometry.dispose();
        horizonMaterial.dispose();
      }
    };
  }
  global.NotoOceanBackdrop = { create };
})(window);
