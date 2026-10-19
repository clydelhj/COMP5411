/*
 * Gerstner geometry, multiscale ripples, sky reflection and broken surf share model coordinates and
 * the sleep-aware clock.
 */
(function registerWaterMotion(global) {
  'use strict';

  // WAVES: [direction in radians, wavelength in metres, amplitude in metres, initial phase in radians]. Horizontal orbit amplitude is 0.55 times vertical amplitude.
  const WAVES = [[0.45, 512, 1.2, 0], [1.35, 192, 0.7, 1.7], [-0.55, 72, 0.35, 3.1]];
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const GLSL = /* glsl */`
    uniform sampler2D uShoreDistance;
    uniform vec2 uShoreExtent;
    uniform vec2 uSeaSize;
    uniform float uSeaTime;
    uniform float uSeaGrid;
    uniform float uSeaScaleY;
    uniform float uSeaWeather;
    uniform vec4 uSeaWaves[3];
    float shoreDistance(vec2 p) {
      vec2 uv = (p + uSeaSize * 0.5) / uShoreExtent;
      vec2 packed = texture2D(uShoreDistance, uv).rg * 255.0;
      return (packed.x + packed.y * 256.0 - 32768.0) / 8.0;
    }
    float surfPhase(vec2 p, float distance) {
      return 6.28318530718 * (distance / 48.0 + uSeaTime * 0.16
        + sin(p.x*0.019+p.y*0.013)*0.16 + sin(p.x*0.047-p.y*0.031)*0.09);
    }
    // Keep nonlinear displacement outside the extra contour refinements (<16 m)
    // and inside the uniformly fine surf strip (<65 m).
    float breakerHeight(vec2 p, float distance) {
      float crest = pow(0.5 + 0.5*sin(surfPhase(p,distance)), 4.0);
      return 0.95 * uSeaWeather * crest * smoothstep(16.0,24.0,distance)
        * (1.0-smoothstep(25.0,65.0,distance));
    }
    vec3 seaOffset(vec2 p) {
      // Restore long swell beyond the local refinement transition; nearshore crests use a uniformly fine coastal mesh.
      float guard = 96.0 + 3.0 * uSeaGrid;
      float shore = smoothstep(guard, guard + 120.0, shoreDistance(p));
      vec2 edge = uSeaSize * 0.5 - abs(p);
      float fade = shore * smoothstep(0.0, 80.0, min(edge.x, edge.y));
      vec3 offset = vec3(0.0);
      for (int i=0; i<3; i++) {
        vec4 w = uSeaWaves[i];
        vec2 d = vec2(cos(w.x), sin(w.x));
        float k = 6.28318530718 / w.y;
        float phase = k * dot(d, p) - sqrt(9.81*k) * uSeaTime + w.w;
        float a = w.z * uSeaWeather * fade * smoothstep(1.5*uSeaGrid, 4.0*uSeaGrid, w.y);
        offset += a * vec3(0.55*d.x*cos(phase), sin(phase), 0.55*d.y*cos(phase));
      }
      // The fine coastal strip resolves these shoreward-moving crests at every
      // terrain LOD. The exact contact and outer crop remain stationary.
      offset.y += breakerHeight(p, shoreDistance(p)) * smoothstep(0.0,80.0,min(edge.x,edge.y));
      return offset;
    }
    vec3 seaPoint(vec2 p) { return vec3(p.x,0.0,p.y) + seaOffset(p); }
    vec3 seaNormal(vec2 p) {
      // Central differences of the full displacement include shore gradients and horizontal orbits, keeping normals consistent with geometry.
      vec3 dx = seaPoint(p+vec2(0.5,0.0))-seaPoint(p-vec2(0.5,0.0));
      vec3 dz = seaPoint(p+vec2(0.0,0.5))-seaPoint(p-vec2(0.0,0.5));
      return normalize(cross(dz,dx));
    }
  `;
  const SURFACE_GLSL = /* glsl */`
    uniform vec3 uSeaSky;
    varying vec3 vSeaNormal;
    varying vec3 vSeaWorldPosition;
    // Rotate sampled slopes back to model coordinates when rotating UVs, keeping wave and highlight directions consistent.
    const mat2 seaRotation = mat2(0.8, 0.6, -0.6, 0.8);
    const mat2 swellRotation = mat2(0.28, -0.96, 0.96, 0.28);
    vec2 seaSlope(vec3 encoded) {
      vec3 n = encoded * 2.0 - 1.0;
      return n.xy / max(n.z, 0.25);
    }
    float seaNoise(vec2 uv) { return texture2D(uNotoWaterColor, uv).a; }
  `;
  async function create(THREE, source, materials, coastalField = null) {
    /*
     * Connect the precomputed coast and shared animation to water materials. Parameters: THREE is
     * the namespace; source contains the field extent, cell size and compressed distance; materials
     * contains top/cut materials; coastalField optionally supplies the already decoded shared
     * field. Decode offset 16-bit signed distances into filterable RG channels. Inject matching
     * displacement into top and sides; evaluate foam and fine waves in the fragment stage. Expose
     * clock, grid and weather updates without an independent animation loop. Returns
     * Promise<Object> with animation, numerical-query and disposal interfaces.
     */
    if (!source) throw new Error('Missing local shoreline data');
    let values = coastalField?.distances;
    if (!values) {
      const compressed = Uint8Array.from(atob(source.distances), c => c.charCodeAt(0));
      const bytes = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      values = new Uint16Array(bytes);
    }
    if (values.length !== source.rows * source.cols) throw new Error('Invalid shoreline distance dimensions');
    const pixels = new Uint8Array(values.length * 4);
    for (let i = 0; i < values.length; i++) {
      pixels[i * 4] = values[i] & 255;
      pixels[i * 4 + 1] = values[i] >> 8;
      pixels[i * 4 + 3] = 255;
    }
    const texture = new THREE.DataTexture(pixels, source.cols, source.rows, THREE.RGBAFormat);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const uniforms = {
      uShoreDistance: {
        value: texture
      },
      uShoreExtent: {
        value: new THREE.Vector2(source.cols * source.cellM, source.rows * source.cellM)
      },
      uSeaSize: {
        value: new THREE.Vector2(source.widthM, source.heightM)
      },
      uSeaTime: {
        value: 0
      },
      uSeaGrid: {
        value: 8
      },
      uSeaScaleY: {
        value: 5
      },
      uSeaWeather: {
        value: 1
      },
      uSeaSky: {
        value: new THREE.Color(0xb9dbe9)
      },
      uSeaWaves: {
        value: WAVES.map(w => new THREE.Vector4(...w))
      }
    };
    const original = materials.top.onBeforeCompile;
    materials.top.name = 'Noto Gerstner sea with shoreline foam';
    materials.top.customProgramCacheKey = () => 'noto-water-gerstner-surf-lod-v4';
    materials.top.defaultAttributeValues = {
      ...materials.top.defaultAttributeValues,
      notoSeaEdge: [0, 0, 0, 0]
    };
    materials.top.onBeforeCompile = shader => {
      original(shader);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL + '\nattribute vec4 notoSeaEdge;\nvarying vec3 vSeaNormal;\nvarying vec3 vSeaWorldPosition;');
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 offset = seaOffset(position.xz);
        vec2 edgeDirection = notoSeaEdge.zw - notoSeaEdge.xy;
        if (dot(edgeDirection, edgeDirection) > 0.000001) {
          float edgeMix = clamp(dot(position.xz - notoSeaEdge.xy, edgeDirection) / dot(edgeDirection, edgeDirection), 0.0, 1.0);
          offset = mix(seaOffset(notoSeaEdge.xy), seaOffset(notoSeaEdge.zw), edgeMix);
        }
        transformed += vec3(offset.x, offset.y/uSeaScaleY, offset.z);
        vSeaNormal = seaNormal(position.xz);
        vSeaWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      // The base sampler declaration must precede seaNoise, which references it.
      shader.fragmentShader = shader.fragmentShader.replace('uniform float uNotoWaterScale;', 'uniform float uNotoWaterScale;\n' + GLSL + SURFACE_GLSL);
      shader.fragmentShader = shader.fragmentShader.replace('vNotoWaterXZ / uNotoWaterScale', '(vNotoWaterXZ + vec2(uSeaTime*0.7, uSeaTime*0.25)) / uNotoWaterScale');
      shader.fragmentShader = shader.fragmentShader.replace('vec3 notoWaterTangent = notoWaterDetail.rgb * 2.0 - 1.0;', `
        vec2 p = vNotoWaterXZ;
        vec2 smallUV = seaRotation * (p + vec2(-uSeaTime*0.42,uSeaTime*0.28)) / 31.0;
        vec2 swellUV = swellRotation * (p + vec2(uSeaTime*2.1,uSeaTime*0.9)) / 576.0;
        vec2 capillaryUV = (p + vec2(uSeaTime*0.16,-uSeaTime*0.12)) / 7.0;
        vec2 slopes = seaSlope(notoWaterDetail.rgb)*0.72;
        slopes += seaSlope(texture2D(uNotoWaterDetail,smallUV).rgb)*seaRotation*0.32;
        slopes += seaSlope(texture2D(uNotoWaterDetail,swellUV).rgb)*swellRotation*0.48;
        slopes += seaSlope(texture2D(uNotoWaterDetail,capillaryUV).rgb)*0.18;
        vec3 nSea = normalize(vSeaNormal);
        // Subgrid waves remain in the normal field; mipmaps filter fine detail according to the pixel footprint.
        slopes *= uSeaWeather * (1.0 - foam*0.6);
        vec3 notoWaterTangent = normalize(vec3(nSea.x + slopes.x, nSea.z + slopes.y, nSea.y));`);
      shader.fragmentShader = shader.fragmentShader.replace('roughnessFactor = clamp(notoWaterDetail.a, 0.18, 0.34);', `
        float distanceToShore = shoreDistance(vNotoWaterXZ);
        vec2 foamP = vNotoWaterXZ;
        float foamPatch = seaNoise(foamP/310.0 + vec2(uSeaTime*0.002,0.0));
        float breakup = seaNoise(seaRotation*foamP/83.0 + vec2(0.0,uSeaTime*0.004));
        float bubbles = seaNoise(foamP/17.0 + vec2(uSeaTime*0.007,-uSeaTime*0.005));
        // Increasing phase moves crests shoreward. Large-scale warping and coverage noise break them into unequal surf patches.
        float phase = surfPhase(foamP,distanceToShore);
        float crest = pow(0.5+0.5*sin(phase),6.0);
        float footprint = max(fwidth(distanceToShore),1.0);
        float shoreZone = smoothstep(-0.5,2.0,distanceToShore) * (1.0-smoothstep(28.0,70.0,distanceToShore));
        float coverage = smoothstep(0.32,0.68,foamPatch*0.65+breakup*0.35);
        float lace = smoothstep(0.28,0.64,bubbles*0.7+breakup*0.3);
        // Blend subpixel surf into low-coverage residual foam to avoid jagged white lines in distant views.
        crest = mix(crest,0.2,smoothstep(10.0,45.0,footprint));
        float residue = (1.0-smoothstep(6.0,35.0,distanceToShore))*pow(0.5+0.5*sin(phase-0.8),2.0)*breakup*0.32;
        float foam = clamp(shoreZone*(crest*(0.35+coverage*0.65)*lace*1.65+residue),0.0,0.9);
        diffuseColor.rgb = mix(diffuseColor.rgb,vec3(0.72,0.82,0.79),foam);
        roughnessFactor = mix(clamp(notoWaterDetail.a,0.18,0.34),0.65,foam);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        // Approximate sky reflection without an extra scene pass; follow day/night and weather colors. Standard lighting supplies sun highlights.
        vec3 worldNormal = inverseTransformDirection(normal, viewMatrix);
        vec3 toCamera = normalize(cameraPosition-vSeaWorldPosition);
        vec3 reflected = reflect(-toCamera,worldNormal);
        float fresnel = 0.02+0.98*pow(1.0-clamp(dot(worldNormal,toCamera),0.0,1.0),5.0);
        float skyHeight = pow(clamp(reflected.y,0.0,1.0),0.4);
        vec3 skyReflection = uSeaSky * mix(vec3(1.15),vec3(0.32,0.52,0.72),skyHeight);
        float reflectionWeight = fresnel*(1.0-foam*0.95);
        outgoingLight = outgoingLight*(1.0-reflectionWeight)+skyReflection*reflectionWeight;
        #include <opaque_fragment>`);
      materials.top.userData.notoShader = shader;
    };
    materials.cut.customProgramCacheKey = () => 'noto-water-cut-gerstner-v2';
    materials.cut.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL).replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 offset = seaOffset(position.xz)*clamp(1.0+position.y/100.0,0.0,1.0);
          transformed += vec3(offset.x,offset.y/uSeaScaleY,offset.z);`);
    };
    function shoreAt(x, z) {
      /* Bilinearly query shore distance on the CPU using the same pixel-centre convention as the texture.
Parameters: x/z are unexaggerated model metres.
Convert to pixel indices, clamp and interpolate four samples. Returns approximate metres, positive on the sea side. */
      const u = Math.max(0, Math.min(source.cols - 1, (x + source.widthM / 2) / source.cellM - 0.5));
      const v = Math.max(0, Math.min(source.rows - 1, (z + source.heightM / 2) / source.cellM - 0.5));
      const c = Math.floor(u),
        r = Math.floor(v),
        tx = u - c,
        tz = v - r;
      const sample = (i, j) => (values[Math.min(source.rows - 1, j) * source.cols + Math.min(source.cols - 1, i)] - 32768) / 8;
      return (sample(c, r) * (1 - tx) + sample(c + 1, r) * tx) * (1 - tz) + (sample(c, r + 1) * (1 - tx) + sample(c + 1, r + 1) * tx) * tz;
    }
    function sample(x, z, time = uniforms.uSeaTime.value) {
      /*
       * Evaluate the same three-component Gerstner and nearshore-crest displacement as GLSL for
       * diagnostics. Inputs: model x/z in metres and animation time in seconds. Apply shoreline,
       * outer-boundary and grid attenuation, then sum bounded orbital displacements. Returns
       * [dx,dy,dz] in physical metres, without vertical exaggeration.
       */
      const grid = uniforms.uSeaGrid.value,
        guard = 96 + 3 * grid;
      const fade = smooth(guard, guard + 120, shoreAt(x, z)) * smooth(0, 80, Math.min(source.widthM / 2 - Math.abs(x), source.heightM / 2 - Math.abs(z)));
      const out = [0, 0, 0];
      for (const [angle, length, height, phase0] of WAVES) {
        const dx = Math.cos(angle),
          dz = Math.sin(angle),
          k = 2 * Math.PI / length;
        const phase = k * (dx * x + dz * z) - Math.sqrt(9.81 * k) * time + phase0;
        const a = height * uniforms.uSeaWeather.value * fade * smooth(1.5 * grid, 4 * grid, length);
        out[0] += a * 0.55 * dx * Math.cos(phase);
        out[1] += a * Math.sin(phase);
        out[2] += a * 0.55 * dz * Math.cos(phase);
      }
      const distance = shoreAt(x, z);
      const phase = 2 * Math.PI * (distance / 48 + time * 0.16 + Math.sin(x * 0.019 + z * 0.013) * 0.16 + Math.sin(x * 0.047 - z * 0.031) * 0.09);
      out[1] += 0.95 * uniforms.uSeaWeather.value * Math.pow(0.5 + 0.5 * Math.sin(phase), 4) * smooth(16, 24, distance) * (1 - smooth(25, 65, distance)) * smooth(0, 80, Math.min(source.widthM / 2 - Math.abs(x), source.heightM / 2 - Math.abs(z)));
      return out;
    }
    function decorateLand(shader) {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL);
      // Wash-up changes the actual land material, after its geology/vegetation
      // mix and before lighting. It therefore follows the shore, not the screen.
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
        float shoreLandDistance = shoreDistance(vNotoObjectPosition.xz);
        if (shoreLandDistance > -10.0 && vNotoObjectPosition.y*uSeaScaleY < 2.2) {
        float wash = pow(0.5+0.5*sin(surfPhase(vNotoObjectPosition.xz,0.0)-0.35),2.0);
        float wet = (1.0-smoothstep(0.0,10.0,-shoreLandDistance))
          * (1.0-smoothstep(0.5,2.2,vNotoObjectPosition.y*uSeaScaleY));
        float washFront = (1.0-smoothstep(1.0+wash*3.0,2.5+wash*3.0,-shoreLandDistance))
          * (1.0-smoothstep(0.15+wash,0.4+wash*1.4,vNotoObjectPosition.y*uSeaScaleY));
        float washGrain = smoothstep(0.25,0.78,
          notoNoise(vNotoObjectPosition.xz*0.38+vec2(uSeaTime*0.11,-uSeaTime*0.08))*0.65
          +notoNoise(vNotoObjectPosition.xz*1.3)*0.35);
        float washFoam = wet*washFront*wash*washGrain*0.7;
        diffuseColor.rgb = mix(diffuseColor.rgb*mix(1.0,0.67,wet),vec3(0.72,0.82,0.79),washFoam);
        roughnessFactor = mix(roughnessFactor,0.38,wet*(1.0-washFoam));
        }
        #include <lights_physical_fragment>`);
    }
    return {
      uniforms,
      shaderDeclarations: GLSL,
      decorateLand,
      advance: seconds => {
        uniforms.uSeaTime.value += seconds;
      },
      setView: (grid, scale) => {
        uniforms.uSeaGrid.value = Math.max(8, grid);
        uniforms.uSeaScaleY.value = scale;
      },
      setWeather: weather => {
        uniforms.uSeaWeather.value = weather === 'rainy' ? 1.3 : weather === 'cloudy' ? 1.05 : 0.85;
      },
      // skyColor: the environment's current linear THREE.Color, including day/night brightness.
      setSky: skyColor => uniforms.uSeaSky.value.copy(skyColor),
      getState: () => ({
        time: uniforms.uSeaTime.value,
        gridM: uniforms.uSeaGrid.value,
        scaleY: uniforms.uSeaScaleY.value,
        maxAmplitudeM: 3.2 * uniforms.uSeaWeather.value,
        shoreCellM: source.cellM
      }),
      shoreAt,
      sample,
      dispose: () => texture.dispose()
    };
  }
  global.NotoWaterMotion = {
    create
  };
})(window);
