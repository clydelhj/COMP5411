/*
 * Hybrid long-swell geometry and GPU spectral wind-sea shading share model coordinates and
 * the sleep-aware clock. Optical reference: Three.js Water.js (MIT), with local ocean optics.
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
      // The visual offshore backdrop is outside the measured crop, never a repeated map edge.
      if(any(greaterThan(abs(p),uSeaSize*0.5))) return 2048.0;
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
      return 1.30 * uSeaWeather * crest * smoothstep(16.0,24.0,distance)
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
      // Differentiate the displaced surface analytically. Only the narrow coastal
      // transition needs neighbouring distance samples; open water evaluates each swell once.
      vec2 edge = uSeaSize*0.5-abs(p);
      float edgeDistance = min(edge.x,edge.y);
      if(edgeDistance<=0.0) return vec3(0.0,1.0,0.0);
      float edgeT = clamp(edgeDistance/80.0,0.0,1.0);
      float edgeFade = edgeT*edgeT*(3.0-2.0*edgeT);
      vec2 edgeGradient = (edge.x<edge.y) ? vec2(-sign(p.x),0.0) : vec2(0.0,-sign(p.y));
      vec2 edgeFadeGradient = edgeGradient*(6.0*edgeT*(1.0-edgeT)/80.0);
      float distance = shoreDistance(p);
      float guard = 96.0+3.0*uSeaGrid;
      float shoreT = clamp((distance-guard)/120.0,0.0,1.0);
      float shoreFade = shoreT*shoreT*(3.0-2.0*shoreT);
      bool hasBreaker = distance>16.0 && distance<65.0;
      if(shoreFade<=0.0 && !hasBreaker) return vec3(0.0,1.0,0.0);
      vec2 shoreGradient = vec2(0.0);
      if((shoreT>0.0 && shoreT<1.0) || hasBreaker) {
        shoreGradient = vec2(
          shoreDistance(p+vec2(0.5,0.0))-shoreDistance(p-vec2(0.5,0.0)),
          shoreDistance(p+vec2(0.0,0.5))-shoreDistance(p-vec2(0.0,0.5)));
      }
      float fade = shoreFade*edgeFade;
      vec2 fadeGradient = shoreFade*edgeFadeGradient
        + edgeFade*(6.0*shoreT*(1.0-shoreT)/120.0)*shoreGradient;
      vec3 tangentX = vec3(1.0,0.0,0.0);
      vec3 tangentZ = vec3(0.0,0.0,1.0);
      if(shoreFade>0.0) {
        for(int i=0;i<3;i++) {
          vec4 w = uSeaWaves[i];
          float amplitude = w.z*uSeaWeather*smoothstep(1.5*uSeaGrid,4.0*uSeaGrid,w.y);
          if(amplitude>0.0) {
            vec2 d = vec2(cos(w.x),sin(w.x));
            float k = 6.28318530718/w.y;
            float phase = k*dot(d,p)-sqrt(9.81*k)*uSeaTime+w.w;
            float c = cos(phase), s = sin(phase);
            vec3 shape = vec3(0.55*d.x*c,s,0.55*d.y*c);
            vec3 derivative = vec3(-0.55*d.x*s,c,-0.55*d.y*s);
            tangentX += amplitude*(fadeGradient.x*shape+fade*k*d.x*derivative);
            tangentZ += amplitude*(fadeGradient.y*shape+fade*k*d.y*derivative);
          }
        }
      }
      if(hasBreaker) {
        float phase = surfPhase(p,distance);
        float q = 0.5+0.5*sin(phase);
        float crest = q*q*q*q;
        vec2 phaseGradient = 6.28318530718*(shoreGradient/48.0
          + vec2(0.019,0.013)*0.16*cos(p.x*0.019+p.y*0.013)
          + vec2(0.047,-0.031)*0.09*cos(p.x*0.047-p.y*0.031));
        vec2 crestGradient = 2.0*q*q*q*cos(phase)*phaseGradient;
        float riseT = clamp((distance-16.0)/8.0,0.0,1.0);
        float fallT = clamp((distance-25.0)/40.0,0.0,1.0);
        float rise = riseT*riseT*(3.0-2.0*riseT);
        float fall = 1.0-fallT*fallT*(3.0-2.0*fallT);
        float riseDerivative = 6.0*riseT*(1.0-riseT)/8.0;
        float fallDerivative = -6.0*fallT*(1.0-fallT)/40.0;
        vec2 breakerGradient = 1.30*uSeaWeather*(edgeFade*(crestGradient*rise*fall
          + crest*(riseDerivative*fall+rise*fallDerivative)*shoreGradient)
          + crest*rise*fall*edgeFadeGradient);
        tangentX.y += breakerGradient.x;
        tangentZ.y += breakerGradient.y;
      }
      return normalize(cross(tangentZ,tangentX));
    }
  `;
  const SKY_GLSL = (global.NotoSkyAtmosphere?.shaderDeclarations || /* glsl */`
    uniform float uSkyAtmosphereEnabled;
    vec3 atmosphereSkyColor(vec3 direction) { return vec3(0.0); }
    float atmosphereCloudTransmission(vec3 direction) { return 1.0; }
  `) + /* glsl */`
    uniform vec3 uSeaSky;
    uniform vec3 uSeaSunDirection;
    uniform float uSeaDaylight;
    uniform float uSeaCloudiness;
    vec3 seaSkyColor(vec3 direction) {
      if(uSkyAtmosphereEnabled>0.5) return atmosphereSkyColor(direction);
      float skyHeight = sqrt(clamp(direction.y,0.0,1.0));
      vec3 horizonSky = uSeaSky*vec3(1.02,1.05,1.06);
      vec3 zenithSky = uSeaSky*vec3(0.34,0.57,0.86);
      vec3 sky = mix(horizonSky,zenithSky,skyHeight);
      sky = mix(sky,uSeaSky*0.78,uSeaCloudiness*0.68);
      float warmth = (1.0-smoothstep(0.08,0.4,uSeaSunDirection.y))*uSeaDaylight;
      return mix(sky,sky*vec3(1.16,0.94,0.78),warmth*(1.0-skyHeight)*0.45);
    }
  `;
  const CLOUD_GLSL = global.NotoCloudLayers?.shaderDeclarations || /* glsl */`
    vec3 worldCloudReflection(vec3 origin,vec3 ray,vec3 background) { return background; }
    float worldCloudSunTransmission(vec3 origin,vec3 ray) { return 1.0; }
  `;
  const SURFACE_GLSL = SKY_GLSL + CLOUD_GLSL + /* glsl */`
    uniform vec3 uSeaSunColor;
    uniform float uSeaSunIntensity;
    uniform sampler2D uOceanSpectrumLarge;
    uniform sampler2D uOceanSpectrumSmall;
    uniform vec2 uOceanSpectrumSize;
    uniform float uOceanSpectrumEnabled;
    uniform vec4 uSeaPhaseCharts[44];
    uniform sampler2D uSeaReflection;
    uniform mat4 uSeaReflectionMatrix;
    uniform float uSeaReflectionEnabled;
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
    float seaHash(vec2 point) {
      vec3 q = fract(vec3(point.xyx)*vec3(0.1031,0.1030,0.0973));
      q += dot(q,q.yzx+33.33);
      return fract((q.x+q.y)*q.z);
    }
    float seaWorldNoise(vec2 point) {
      vec2 cell = floor(point), t = fract(point);
      t = t*t*t*(t*(t*6.0-15.0)+10.0);
      return mix(mix(seaHash(cell),seaHash(cell+vec2(1.0,0.0)),t.x),
        mix(seaHash(cell+vec2(0.0,1.0)),seaHash(cell+1.0),t.x),t.y);
    }
    float seaFilteredWorldNoise(vec2 point) {
      float footprint = max(length(dFdx(point)),length(dFdy(point)));
      return mix(seaWorldNoise(point),0.5,smoothstep(0.35,1.1,footprint));
    }
    vec4 seaWindField(sampler2D field, vec2 point, float period, int chartBase, float seed) {
      // A continuous world-space selector crossfades overlapping phase charts.
      // At an index boundary the outgoing chart is exactly the incoming one.
      float selector = seaFilteredWorldNoise(point/(period*7.3)+vec2(seed,seed*0.37))*9.0;
      float phase = floor(selector), blend = smoothstep(0.15,0.85,fract(selector));
      vec4 aChart = uSeaPhaseCharts[chartBase+int(phase)];
      vec4 bChart = uSeaPhaseCharts[chartBase+int(phase)+1];
      mat2 aRotation = mat2(aChart.x,aChart.y,-aChart.y,aChart.x);
      mat2 bRotation = mat2(bChart.x,bChart.y,-bChart.y,bChart.x);
      vec2 dx = dFdx(point)/period, dy = dFdy(point)/period;
      // Explicit chart derivatives exclude discrete phase changes from mip selection.
      vec4 a = textureGrad(field,aRotation*(point/period)+aChart.zw,aRotation*dx,aRotation*dy);
      vec4 b = textureGrad(field,bRotation*(point/period)+bChart.zw,bRotation*dx,bRotation*dy);
      // Sampled gradients belong to the rotated chart; return them to model X/Z.
      a.rg = a.rg*aRotation;
      b.rg = b.rg*bRotation;
      return mix(a,b,blend);
    }
    vec3 seaMicroField(vec2 point, float period, int chartBase, float seed) {
      float selector = seaFilteredWorldNoise(point/(period*8.9)+vec2(seed*0.13,seed))*8.0;
      float phase = floor(selector), blend = smoothstep(0.15,0.85,fract(selector));
      vec4 aChart = uSeaPhaseCharts[chartBase+int(phase)];
      vec4 bChart = uSeaPhaseCharts[chartBase+int(phase)+1];
      mat2 aRotation = mat2(aChart.x,aChart.y,-aChart.y,aChart.x);
      mat2 bRotation = mat2(bChart.x,bChart.y,-bChart.y,bChart.x);
      vec2 dx = dFdx(point)/period, dy = dFdy(point)/period;
      vec3 a = textureGrad(uNotoWaterDetail,aRotation*(point/period)+aChart.zw,aRotation*dx,aRotation*dy).rgb*2.0-1.0;
      vec3 b = textureGrad(uNotoWaterDetail,bRotation*(point/period)+bChart.zw,bRotation*dx,bRotation*dy).rgb*2.0-1.0;
      vec2 slopeA = (a.xy/max(a.z,0.25))*aRotation;
      vec2 slopeB = (b.xy/max(b.z,0.25))*bRotation;
      // Averaged unit normals shorten as unresolved angular detail enters their mip.
      float variance = mix(max(0.0,1.0-dot(a,a)),max(0.0,1.0-dot(b,b)),blend);
      return vec3(mix(slopeA,slopeB,blend),variance);
    }
  `;
  function createPhaseCharts(THREE) {
    // Four field groups share a small immutable table: cos, sin and a 2D phase offset.
    // Preparing these 704 bytes once removes phase hashes and trigonometry from every fragment.
    const fract = value => value - Math.floor(value);
    const hash = (x, y) => {
      let qx = fract(x * 0.1031), qy = fract(y * 0.1030), qz = fract(x * 0.0973);
      const dot = qx * (qy + 33.33) + qy * (qz + 33.33) + qz * (qx + 33.33);
      qx += dot;
      qy += dot;
      qz += dot;
      return fract((qx + qy) * qz);
    };
    const charts = [];
    for (const seed of [7.31, 29.17, 47.13, 83.71]) {
      for (let phase = 0; phase < 11; phase++) {
        const angle = (hash(phase, seed) - 0.5) * 0.70;
        charts.push(new THREE.Vector4(Math.cos(angle), Math.sin(angle),
          hash(phase + 17, seed) * 31, hash(phase + 83, seed) * 31));
      }
    }
    return charts;
  }
  async function create(THREE, source, materials, coastalField = null, spectrum = null) {
    /*
     * Connect the precomputed coast and shared animation to water materials. Parameters: THREE is
     * the namespace; source contains the field extent, cell size and compressed distance; materials
     * contains top/cut materials; coastalField optionally supplies the already decoded shared
     * field. Decode offset 16-bit signed distances into filterable RG channels. Inject matching
     * displacement into top and sides; spectrum optionally supplies two GPU wind-sea fields.
     * Evaluate absorption, reflection, foam and fine waves in the fragment stage. Expose
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
    // A complete neutral fallback keeps the same shader usable on devices without float FFT targets.
    const neutralSpectrum = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    neutralSpectrum.needsUpdate = true;
    const uniforms = {
      uSeaPhaseCharts: { value: createPhaseCharts(THREE) },
      uSkyAtmosphereMap: { value: neutralSpectrum },
      uSkyAtmosphereEnabled: { value: 0 },
      uCloudColumnLow: { value: neutralSpectrum },
      uCloudColumnHigh: { value: neutralSpectrum },
      uWorldCloudsEnabled: { value: 0 },
      uSeaReflection: { value: neutralSpectrum },
      uSeaReflectionMatrix: { value: new THREE.Matrix4() },
      uSeaReflectionEnabled: { value: 0 },
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
      uSeaSunDirection: { value: new THREE.Vector3(0.35, 0.78, 0.52).normalize() },
      uSeaSunColor: { value: new THREE.Color(0xfff4e3) },
      uSeaSunIntensity: { value: 3 },
      uSeaDaylight: { value: 1 },
      uSeaCloudiness: { value: 0 },
      ...(spectrum?.uniforms || {
        uOceanSpectrumLarge: { value: neutralSpectrum },
        uOceanSpectrumSmall: { value: neutralSpectrum },
        uOceanSpectrumSize: { value: new THREE.Vector2(1024, 173) },
        uOceanSpectrumEnabled: { value: 0 }
      }),
      uSeaWaves: {
        value: WAVES.map(w => new THREE.Vector4(...w))
      }
    };
    const original = materials.top.onBeforeCompile;
    materials.top.name = 'Noto spectral wind sea and long swell';
    materials.top.userData.temporalReactive = true;
    materials.top.customProgramCacheKey = () => 'noto-water-filtered-wind-v7';
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
      shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>');
      // RGB in the legacy color texture is uniformly white; appearance now comes from optics.
      shader.fragmentShader = shader.fragmentShader.replace('diffuseColor.rgb *= texture2D(uNotoWaterColor, notoWaterUV).rgb;', '');
      shader.fragmentShader = shader.fragmentShader.replace('vNotoWaterXZ / uNotoWaterScale', '(vNotoWaterXZ + vec2(uSeaTime*0.7, uSeaTime*0.25)) / uNotoWaterScale');
      shader.fragmentShader = shader.fragmentShader.replace('vec3 notoWaterTangent = notoWaterDetail.rgb * 2.0 - 1.0;', `
        vec2 slopes = microSlopes*uSeaWeather;
        if(uOceanSpectrumEnabled>0.5) {
          // Spectrum RG stores physical height gradients; normal components have the opposite sign.
          // A bounded facet gain keeps sub-grid wind waves legible on the regional terrain mesh.
          slopes = -(oceanLarge.rg*1.25+oceanSmall.rg*2.35) + microSlopes*0.85*microFilter;
        }
        vec3 nSea = normalize(vSeaNormal);
        // Filter subpixel facets while keeping their unresolved energy in roughness.
        slopes *= 1.0-foam*0.72;
        vec3 notoWaterTangent = normalize(vec3(nSea.x + slopes.x, nSea.z + slopes.y, nSea.y));`);
      shader.fragmentShader = shader.fragmentShader.replace('normal = normalize(mix(normal, notoWaterNormal, 0.85));', 'normal = notoWaterNormal;');
      shader.fragmentShader = shader.fragmentShader.replace('roughnessFactor = clamp(notoWaterDetail.a, 0.045, 0.12);', `
        float distanceToShore = shoreDistance(vNotoWaterXZ);
        vec2 foamP = vNotoWaterXZ;
        float seaFootprint = max(length(dFdx(foamP)),length(dFdy(foamP)));
        float cloudSunTransmission = worldCloudSunTransmission(vSeaWorldPosition,uSeaSunDirection);
        vec4 oceanLarge = vec4(0.0), oceanSmall = vec4(0.0);
        if(uOceanSpectrumEnabled>0.5) {
          oceanLarge = seaWindField(uOceanSpectrumLarge,foamP,uOceanSpectrumSize.x,0,7.31);
          oceanSmall = seaWindField(uOceanSpectrumSmall,foamP,uOceanSpectrumSize.y,11,29.17);
        }
        vec3 microWide = seaMicroField(foamP+vec2(uSeaTime*0.70,uSeaTime*0.25),96.0,22,47.13);
        vec3 microFine = seaMicroField(foamP+vec2(-uSeaTime*0.29,uSeaTime*0.18),13.7,33,83.71);
        float microFilter = 1.0-smoothstep(0.6,12.0,seaFootprint);
        vec2 microSlopes = microWide.xy*0.50+microFine.xy*0.50*microFilter;
        float microVariance = microWide.z*0.25+microFine.z*0.25;
        float foamPatch = seaFilteredWorldNoise((foamP-vec2(uSeaTime*1.35,uSeaTime*0.55))/197.0);
        float breakup = seaFilteredWorldNoise(seaRotation*(foamP-vec2(uSeaTime*0.8,uSeaTime*0.35))/53.0);
        float bubbles = seaFilteredWorldNoise((foamP+vec2(uSeaTime*0.45,-uSeaTime*0.27))/3.2);
        // Breaker energy follows the same moving crest as geometry, but foam coverage advects and tears.
        float phase = surfPhase(foamP,distanceToShore);
        float crest = pow(0.5+0.5*sin(phase),4.5);
        float shoreZone = smoothstep(0.0,2.0,distanceToShore) * (1.0-smoothstep(44.0,85.0,distanceToShore));
        float coverage = smoothstep(0.36,0.67,foamPatch*0.58+breakup*0.42);
        float lace = smoothstep(0.24,0.66,bubbles*0.70+breakup*0.30);
        float distantSurf = smoothstep(7.0,32.0,max(fwidth(distanceToShore),seaFootprint));
        crest = mix(crest,0.12,distantSurf);
        float wake = pow(0.5+0.5*sin(phase-0.95),3.0);
        float residue = (1.0-smoothstep(14.0,49.0,distanceToShore))*wake*coverage*0.30;
        float surfFoam = shoreZone*(crest*(0.05+coverage*0.95)*lace*1.85+residue);
        float oceanCrest = max(oceanLarge.b,oceanSmall.b*0.80);
        // Only compressed positive crests aerate; the proxy is deliberately sparse in calm weather.
        float crestWidth = max(fwidth(oceanCrest),0.002);
        float whitecaps = smoothstep(0.045-crestWidth,0.16+crestWidth,oceanCrest)*smoothstep(0.35,0.70,breakup*0.6+bubbles*0.4);
        whitecaps *= smoothstep(60.0,150.0,distanceToShore)*(0.32+0.58*max(0.0,uSeaWeather-0.7));
        float foam = clamp(max(surfFoam,whitecaps),0.0,0.94);
        // Shore distance is an optical-depth proxy, not surveyed bathymetry. Beer-Lambert attenuation
        // reveals a subdued coastal bed tint while offshore water keeps a deep blue-green body.
        float opticalDepth = clamp(0.6+max(distanceToShore,0.0)*0.10,0.6,70.0);
        vec3 transmission = exp(-vec3(0.38,0.085,0.048)*opticalDepth);
        vec3 deepBody = vec3(0.002,0.040,0.055);
        vec3 shallowBed = vec3(0.11,0.145,0.105);
        vec3 waterBody = mix(deepBody,shallowBed,transmission);
        waterBody += vec3(0.001,0.011,0.014)*clamp(oceanLarge.a+oceanSmall.a,0.0,1.8);
        diffuseColor.rgb = mix(waterBody,vec3(0.68,0.77,0.73),foam);
        // Preserve unresolved angular energy in the microfacet lobe instead of aliasing
        // the filtered mean normal into repeated highlights. Nearby resolved waves stay crisp.
        // Differentiate the normal that actually shades the pixel: spectrum gains,
        // capillary detail and the geometric swell all contribute to solar aliasing.
        vec2 shadingSlopes = microSlopes*uSeaWeather;
        if(uOceanSpectrumEnabled>0.5) {
          shadingSlopes = -(oceanLarge.rg*1.25+oceanSmall.rg*2.35)+microSlopes*0.85*microFilter;
        }
        shadingSlopes *= 1.0-foam*0.72;
        vec3 shadingNormal = normalize(normalize(vSeaNormal)+vec3(shadingSlopes.x,0.0,shadingSlopes.y));
        vec3 normalDx = dFdx(shadingNormal), normalDy = dFdy(shadingNormal);
        float resolvedVariance = max(dot(normalDx,normalDx),dot(normalDy,normalDy))/12.0;
        float lostVariance = smoothstep(0.8,18.0,seaFootprint)*0.00085
          +smoothstep(20.0,150.0,seaFootprint)*0.00075
          +min(microVariance*0.10,0.0015)+min(resolvedVariance,0.0045);
        float baseRoughness = 0.078+breakup*0.028+uSeaCloudiness*0.025;
        float filteredRoughness = pow(pow(baseRoughness,4.0)+lostVariance,0.25);
        roughnessFactor = mix(clamp(filteredRoughness,0.075,0.32),0.55,foam);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
        #include <lights_physical_fragment>
        material.specularColor = vec3(0.0204);`);
      // Attenuate only the solar directional light before its diffuse/specular terms
      // accumulate. Pointer spot/point lights retain their own complete contribution.
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        `getDirectionalLightInfo( directionalLight, directLight );
        directLight.color *= mix(1.0,cloudSunTransmission*0.72,
          smoothstep(0.995,0.9999,dot(inverseTransformDirection(directLight.direction,viewMatrix),uSeaSunDirection)));`
      ));
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        // The same sky/sun state drives Fresnel reflection, directional glint and crest scattering.
        // Terrain shadows and point-light highlights remain in the standard PBR lighting result.
        vec3 worldNormal = inverseTransformDirection(normal, viewMatrix);
        vec3 toCamera = normalize(cameraPosition-vSeaWorldPosition);
        vec3 reflected = reflect(-toCamera,worldNormal);
        float fresnel = 0.0204+0.9796*pow(1.0-clamp(dot(worldNormal,toCamera),0.0,1.0),5.0);
        vec3 skyReflection = worldCloudReflection(vSeaWorldPosition,reflected,seaSkyColor(reflected));
        float reflectedLandCoverage = 0.0;
        // A small cached coarse-terrain pass supplies actual coastal silhouettes; sky fills empty texels.
        if(uSeaReflectionEnabled>0.5) {
          vec4 projectedReflection = uSeaReflectionMatrix*vec4(vSeaWorldPosition,1.0);
          if(projectedReflection.w>0.0) {
            vec2 reflectionUv = projectedReflection.xy/projectedReflection.w;
            reflectionUv += worldNormal.xz*(0.005+roughnessFactor*0.018);
            if(all(greaterThan(reflectionUv,vec2(0.0))) && all(lessThan(reflectionUv,vec2(1.0)))) {
              // Mip-filter the coarse capture to suppress its raster/grid steps on a rough surface.
              vec4 terrainReflection = textureLod(uSeaReflection,reflectionUv,1.0+roughnessFactor*8.0);
              float reflectionEdge = smoothstep(0.0,0.035,min(min(reflectionUv.x,reflectionUv.y),min(1.0-reflectionUv.x,1.0-reflectionUv.y)));
              reflectedLandCoverage = terrainReflection.a*reflectionEdge;
              // Transparent clear texels have zero RGB: filtering already weights RGB by coverage.
              vec3 reflectedLand = terrainReflection.rgb/max(terrainReflection.a,0.0001);
              // Opaque reflected land also occludes the solar disk inside the shared environment.
              skyReflection = mix(skyReflection,reflectedLand,reflectedLandCoverage);
            }
          }
        }
        float shadowVisibility = getShadowMask();
        float forwardLight = pow(max(dot(toCamera,-uSeaSunDirection),0.0),4.0);
        float crestLight = clamp(oceanLarge.a*0.40+oceanSmall.a+0.15,0.0,1.0);
        vec3 scattering = vec3(0.004,0.055,0.062)*forwardLight*crestLight*uSeaSunIntensity*shadowVisibility*cloudSunTransmission;
        // The shared sky atlas contains the sun and its cloud occlusion. Do not add a
        // second screen-independent solar disk over reflected clouds and terrain.
        vec3 directHighlights = reflectedLight.directSpecular;
        vec3 bodyLighting = max(outgoingLight-directHighlights-reflectedLight.indirectSpecular,vec3(0.0));
        float reflectionWeight = fresnel*(1.0-foam*0.96);
        outgoingLight = bodyLighting*(1.0-reflectionWeight)
          +skyReflection*reflectionWeight+directHighlights+scattering*(1.0-foam);
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
      if (Math.abs(x) > source.widthM / 2 || Math.abs(z) > source.heightM / 2) return 2048;
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
      out[1] += 1.30 * uniforms.uSeaWeather.value * Math.pow(0.5 + 0.5 * Math.sin(phase), 4) * smooth(16, 24, distance) * (1 - smooth(25, 65, distance)) * smooth(0, 80, Math.min(source.widthM / 2 - Math.abs(x), source.heightM / 2 - Math.abs(z)));
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
      skyShaderDeclarations: SKY_GLSL,
      setCloudLayers(controller) {
        // Optical columns share the elevated cloud field, with world-position parallax on water.
        if (controller?.uniforms) Object.assign(uniforms, controller.uniforms);
      },
      setAtmosphere(controller) {
        // Sky and reflected clouds sample one shared linear environment atlas.
        if (controller?.uniforms) Object.assign(uniforms, controller.uniforms);
      },
      setReflection(controller) {
        // Uniform objects are shared by the main sea and its offshore horizon material.
        if (controller?.uniforms) Object.assign(uniforms, controller.uniforms);
      },
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
        uniforms.uSeaCloudiness.value = weather === 'rainy' ? 1 : weather === 'cloudy' ? 0.65 : 0;
        spectrum?.setWeather(weather);
      },
      // skyColor: the environment's current linear THREE.Color, including day/night brightness.
      setSky: skyColor => uniforms.uSeaSky.value.copy(skyColor),
      setLighting(state) {
        /* Synchronize model-space sun direction, linear color and irradiance with the environment.
         * The date/time approximation remains owned by environment.js; this controller only shades water.
         */
        const direction = state.sunDirection || state.direction;
        if (Array.isArray(direction) && direction.length === 3 && direction.every(Number.isFinite)) {
          uniforms.uSeaSunDirection.value.fromArray(direction).normalize();
        }
        const daylight = Number.isFinite(state.elevation) ? smooth(-6, 10, state.elevation) : 1;
        uniforms.uSeaDaylight.value = daylight;
        if (Array.isArray(state.sunColor) && state.sunColor.length === 3) {
          uniforms.uSeaSunColor.value.fromArray(state.sunColor);
        } else {
          uniforms.uSeaSunColor.value.set(0xffbe85).lerp(new THREE.Color(0xfff4e3), smooth(0, 30, state.elevation ?? 45));
        }
        const strength = state.weather === 'rainy' ? 0.35 : state.weather === 'cloudy' ? 0.9 : 3;
        uniforms.uSeaSunIntensity.value = Number.isFinite(state.sunIntensity)
          ? Math.max(0, state.sunIntensity)
          : strength * Math.max(0, Math.min(1, uniforms.uSeaSunDirection.value.y * 5));
        uniforms.uSeaCloudiness.value = state.weather === 'rainy' ? 1 : state.weather === 'cloudy' ? 0.65 : 0;
      },
      getState: () => ({
        time: uniforms.uSeaTime.value,
        gridM: uniforms.uSeaGrid.value,
        scaleY: uniforms.uSeaScaleY.value,
        maxAmplitudeM: 3.55 * uniforms.uSeaWeather.value,
        shoreCellM: source.cellM,
        shading: 'Fresnel reflection, spectral slopes, absorption and breaking foam',
        spectrum: spectrum?.getState() ?? { active: false, reason: 'No spectrum controller' }
      }),
      shoreAt,
      sample,
      dispose: () => {
        texture.dispose();
        neutralSpectrum.dispose();
      }
    };
  }
  global.NotoWaterMotion = {
    create
  };
})(window);
