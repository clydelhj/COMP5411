/* Matching analytic sky and a bounded offshore horizon; no external textures or scene renderer. */
(function registerOceanBackdrop(global) {
  'use strict';

  function create({ THREE, scene, terrain, camera, controls, metadata, motion, materials }) {
    /* The horizon is illustrative open water outside the DEM rectangle, not new bathymetry.
     * Fade it out in regional/interior views so the original model's cropped volume remains clear.
     * The shared sky function gives the visible background and reflected sky the same colors.
     */
    const skyGeometry = new THREE.BufferGeometry();
    skyGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const skyUniforms = {
      ...motion.uniforms,
      uSkyInverseProjection: { value: new THREE.Matrix4() },
      uSkyCameraWorld: { value: new THREE.Matrix4() }
    };
    const skyMaterial = new THREE.ShaderMaterial({
      name: 'Ocean-coherent analytic sky',
      uniforms: skyUniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: `varying vec2 vSkyUv;
        void main() { vSkyUv=position.xy*0.5+0.5; gl_Position=vec4(position.xy,0.999999,1.0); }`,
      fragmentShader: `${motion.skyShaderDeclarations}
        uniform mat4 uSkyInverseProjection; uniform mat4 uSkyCameraWorld;
        uniform vec3 uSeaSunColor; uniform float uSeaSunIntensity;
        varying vec2 vSkyUv;
        void main() {
          vec4 view=uSkyInverseProjection*vec4(vSkyUv*2.0-1.0,1.0,1.0);
          vec3 direction=normalize((uSkyCameraWorld*vec4(view.xyz/view.w,0.0)).xyz);
          vec3 color=seaSkyColor(direction);
          float alignment=dot(direction,uSeaSunDirection);
          float disk=smoothstep(0.99997,0.999992,alignment);
          float halo=pow(max(alignment,0.0),96.0)*0.025;
          color += uSeaSunColor*uSeaSunIntensity*(disk*2.0+halo);
          gl_FragColor=vec4(color,1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
    const sky = new THREE.Mesh(skyGeometry, skyMaterial);
    sky.name = 'Shared ocean and sky illumination';
    sky.frustumCulled = false;
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
    const opacity = { value: 0 };
    const decorate = materials.top.onBeforeCompile;
    horizonMaterial.onBeforeCompile = shader => {
      decorate(shader);
      shader.uniforms.uOceanBackdropOpacity = opacity;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uOceanBackdropOpacity;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        // Extend only crop edges that are already ocean; never invent a coast beside cropped land.
        vec2 cropEdge = clamp(vNotoWaterXZ,-uSeaSize*0.5+8.0,uSeaSize*0.5-8.0);
        if(shoreDistance(cropEdge)<0.0) discard;
        diffuseColor.a *= uOceanBackdropOpacity;
        #include <opaque_fragment>`);
    };
    horizonMaterial.customProgramCacheKey = () => `${materials.top.customProgramCacheKey()}-horizon-v1`;
    const width = metadata.width_m, height = metadata.height_m, margin = 80000;
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
    const viewMatrix = new THREE.Matrix4(), viewFrustum = new THREE.Frustum(), stripBounds = new THREE.Box3();
    let inView = false;
    return {
      update() {
        const coastal = smooth(-2500, -1200, motion.shoreAt(camera.position.x, camera.position.z));
        const near = 1 - smooth(8000, 14000, camera.position.distanceTo(controls.target));
        const low = 1 - smooth(2000, 4000, Math.max(0, camera.position.y));
        opacity.value = coastal * near * low;
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
        for (const mesh of horizon.children) mesh.geometry.dispose();
        horizonMaterial.dispose();
      }
    };
  }
  global.NotoOceanBackdrop = { create };
})(window);
