/* World-space layered clouds. The caller owns time, opaque scene depth and frame scheduling. */
(function registerCloudLayers(global) {
  'use strict';

  const NOISE_SIZE = 128;
  const MAP_SIZE = 512;
  const UPDATE_INTERVAL = 0.2;
  const HALF_EXTENT = 40000;
  const LAYERS = [[1800, 3200], [5000, 5700]];
  const VERTEX = `
    precision highp float;
    in vec3 position;
    out vec2 vUv;
    void main() { vUv=position.xy*0.5+0.5; gl_Position=vec4(position.xy,0.0,1.0); }
  `;
  const DENSITY = /* glsl */`
    precision highp sampler3D;
    uniform sampler3D uCloudNoise;
    uniform float uCloudTime;
    uniform float uCloudWeather;
    uniform vec3 uCloudSunDirection;
    uniform vec3 uCloudSunColor;
    uniform float uCloudDaylight;
    uniform float uCloudTwilight;
    float cloudHash(vec2 p) {
      vec3 q=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
      q+=dot(q,q.yzx+33.33);
      return fract((q.x+q.y)*q.z);
    }
    float cloudNoise2(vec2 p) {
      vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(cloudHash(i),cloudHash(i+vec2(1,0)),f.x),
        mix(cloudHash(i+vec2(0,1)),cloudHash(i+vec2(1)),f.x),f.y);
    }
    vec2 cloudLayer(int layer) { return layer==0?vec2(1800.0,3200.0):vec2(5000.0,5700.0); }
    // Visual extinction is per metre. Dense lower-bank cores should hide the landscape,
    // while the thinner upper deck retains its lighter optical character.
    float cloudExtinction(int layer) {
      return layer==0?mix(0.0060,0.0090,uCloudWeather):mix(0.0027,0.0040,uCloudWeather);
    }
    float cloudDensity(vec3 world,int layer,float lod) {
      vec2 heights=cloudLayer(layer);
      float h=(world.y-heights.x)/(heights.y-heights.x);
      if(h<=0.0||h>=1.0) return 0.0;
      vec2 wind=(layer==0?vec2(7.5,2.7):vec2(-4.1,5.8))*uCloudTime;
      vec2 p=world.xz+wind;
      float macro=cloudNoise2(p/6300.0+vec2(21.7+float(layer)*43.0,7.2));
      float bank=smoothstep(mix(0.39,0.18,uCloudWeather),mix(0.64,0.40,uCloudWeather),macro);
      // Weather-bank support fades irregularly inside the allocation bounds, without square edges.
      float boundary=33000.0+(macro-0.5)*9000.0;
      float edge=1.0-smoothstep(boundary-10000.0,boundary,length(world.xz*vec2(1.0,0.96)));
      if(bank*edge<0.002) return 0.0;
      vec3 uv=vec3(p.x/12000.0,(world.y+float(layer)*1737.0)/2600.0,p.y/12000.0);
      float field=textureLod(uCloudNoise,uv+vec3(float(layer)*0.31,0.0,0.17),lod).r;
      float vertical=smoothstep(0.0,0.13,h)*(1.0-smoothstep(0.64,1.0,h));
      float topErosion=pow(max(h-0.22,0.0),1.4)*0.22;
      float threshold=mix(layer==0?0.34:0.42,layer==0?0.25:0.33,uCloudWeather)+topErosion;
      if(field<threshold) return 0.0;
      // A finer independent field erodes the edge into puffs, while dense cores remain coherent.
      float erosion=textureLod(uCloudNoise,uv*3.13+vec3(0.37,0.11,0.71),lod+1.5).r;
      field-=(1.0-erosion)*0.105*(1.0-smoothstep(0.12,0.32,field-threshold));
      float puff=smoothstep(threshold,threshold+0.12,field);
      return puff*bank*vertical*edge*(layer==0?1.0:0.58);
    }
    float cloudShadowDensity(vec3 world,int layer,float lod) {
      vec2 heights=cloudLayer(layer);
      float h=(world.y-heights.x)/(heights.y-heights.x);
      if(h<=0.0||h>=1.0) return 0.0;
      vec2 p=world.xz+(layer==0?vec2(7.5,2.7):vec2(-4.1,5.8))*uCloudTime;
      vec3 uv=vec3(p.x/12000.0,(world.y+float(layer)*1737.0)/2600.0,p.y/12000.0);
      float field=textureLod(uCloudNoise,uv+vec3(float(layer)*0.31,0.0,0.17),lod).r;
      float threshold=mix(layer==0?0.34:0.42,layer==0?0.25:0.33,uCloudWeather)
        +pow(max(h-0.22,0.0),1.4)*0.22;
      return smoothstep(threshold,threshold+0.16,field)*smoothstep(0.0,0.13,h)
        *(1.0-smoothstep(0.64,1.0,h));
    }
    vec3 cloudLight(vec3 world,int layer,float density,vec3 viewDirection,float lod) {
      // Short along-sun probes approximate local optical thickness without a second long march.
      float nearby=cloudShadowDensity(world+uCloudSunDirection*360.0,layer,lod+0.7);
      float farther=cloudShadowDensity(world+uCloudSunDirection*900.0,layer,lod+1.1);
      float lighting=exp(-(nearby*1.7+farther)*clamp(0.25+density*0.9,0.25,1.0));
      float forward=pow(max(dot(viewDirection,uCloudSunDirection),0.0),8.0);
      float rim=pow(1.0-density,2.0)*(0.20+0.80*forward);
      float top=smoothstep(0.35,0.95,(world.y-cloudLayer(layer).x)/(cloudLayer(layer).y-cloudLayer(layer).x));
      float illumination=clamp(0.16+lighting*0.70+rim*0.22+top*0.06,0.0,1.0);
      vec3 day=mix(vec3(0.16,0.21,0.28),vec3(0.99,1.0,1.0),illumination);
      vec3 dusk=mix(vec3(0.16,0.075,0.16),vec3(1.04,0.48,0.29),illumination);
      vec3 color=mix(day,dusk,uCloudTwilight);
      color+=mix(vec3(0.04,0.06,0.08),vec3(0.22,0.075,0.03),uCloudTwilight)*rim;
      color=mix(vec3(0.002,0.004,0.009),color,uCloudDaylight);
      return color*mix(1.0,0.62,uCloudWeather);
    }
  `;
  const RAYMARCH = /* glsl */`
    precision highp float;
    precision highp sampler2D;
    in vec2 vUv;
    out vec4 clouds;
    uniform sampler2D uSceneDepth;
    uniform mat4 uInverseProjection;
    uniform mat4 uCameraWorld;
    uniform vec2 uJitterUv;
    uniform vec2 uCameraRange;
    ${DENSITY}
    float viewDepth(float depth) {
      if(depth>=0.99999994) return uCameraRange.y;
      return uCameraRange.x*uCameraRange.y/(uCameraRange.y-depth*(uCameraRange.y-uCameraRange.x));
    }
    vec2 layerInterval(vec3 origin,vec3 ray,vec2 layer,float maximum) {
      vec3 safe=sign(ray)*max(abs(ray),vec3(0.000001));
      safe+=vec3(lessThan(abs(safe),vec3(0.0000001)))*0.000001;
      vec3 a=(vec3(-40000.0,layer.x,-40000.0)-origin)/safe;
      vec3 b=(vec3(40000.0,layer.y,40000.0)-origin)/safe;
      vec3 lo=min(a,b),hi=max(a,b);
      return vec2(max(0.0,max(lo.x,max(lo.y,lo.z))),min(maximum,min(hi.x,min(hi.y,hi.z))));
    }
    void main() {
      vec4 view=uInverseProjection*vec4(vUv*2.0-1.0,1.0,1.0);
      vec3 viewRay=normalize(view.xyz/view.w);
      vec3 ray=normalize(mat3(uCameraWorld)*viewRay);
      vec3 origin=uCameraWorld[3].xyz;
      float angularFootprint=max(length(dFdx(ray)),length(dFdy(ray)));
      ivec2 depthSize=textureSize(uSceneDepth,0);
      vec2 depthUv=clamp(vUv+uJitterUv,0.5/vec2(depthSize),1.0-0.5/vec2(depthSize));
      // Conservative opaque depth prevents a low-resolution sample from crossing a foreground ridge.
      vec2 halfPixel=0.5/vec2(depthSize);
      float depth=min(min(texture(uSceneDepth,depthUv+vec2(-halfPixel.x,-halfPixel.y)).r,
        texture(uSceneDepth,depthUv+vec2(halfPixel.x,-halfPixel.y)).r),
        min(texture(uSceneDepth,depthUv+vec2(-halfPixel.x,halfPixel.y)).r,
        texture(uSceneDepth,depthUv+vec2(halfPixel.x,halfPixel.y)).r));
      float maximum=min(uCameraRange.y,viewDepth(depth)/max(0.0001,-viewRay.z));
      float jitter=0.18+0.64*cloudHash(floor(gl_FragCoord.xy)+vec2(51.7,23.9));
      vec3 result=vec3(0.0);float transmission=1.0;
      // Visit the nearest layer first whether the eye is below, inside, or above the deck.
      for(int order=0;order<2;order++) {
        int layer=ray.y>=0.0?order:1-order;
        vec2 interval=layerInterval(origin,ray,cloudLayer(layer),maximum);
        if(interval.y<=interval.x) continue;
        int count=layer==0?32:16;
        float stepSize=(interval.y-interval.x)/float(count);
        // High regional views cover many density voxels per pixel even along near-vertical rays.
        float footprint=max(stepSize,angularFootprint*interval.x);
        float lod=clamp(log2(max(1.0,footprint/90.0))*0.72,0.0,5.5);
        for(int step=0;step<32;step++) {
          if(step>=count||transmission<0.015) break;
          float distance=interval.x+(float(step)+jitter)*stepSize;
          vec3 world=origin+ray*distance;
          float d=cloudDensity(world,layer,lod);
          if(d<0.002) continue;
          float extinction=cloudExtinction(layer);
          float alpha=1.0-exp(-d*extinction*stepSize);
          // Ground-level horizon haze depends on horizontal air path. It must not erase a deck
          // merely because the eye is far above it; thin atmosphere permits an orbital overview.
          float observerHaze=1.0-smoothstep(6000.0,16000.0,origin.y);
          float horizontalDistance=distance*length(ray.xz);
          alpha*=1.0-smoothstep(18000.0,50000.0,horizontalDistance)*observerHaze;
          result+=cloudLight(world,layer,d,ray,lod)*alpha*transmission;
          transmission*=1.0-alpha;
        }
      }
      clouds=vec4(result,1.0-transmission);
    }
  `;
  const COMPOSITE = /* glsl */`
    precision highp float;
    precision highp sampler2D;
    in vec2 vUv;
    out vec4 result;
    uniform sampler2D uSceneColor;
    uniform sampler2D uSceneDepth;
    uniform sampler2D uCloudColor;
    uniform vec2 uCloudSize;
    uniform vec2 uJitterUv;
    uniform vec2 uCameraRange;
    float viewDepth(vec2 uv) {
      float d=texture(uSceneDepth,clamp(uv+uJitterUv,vec2(0.0),vec2(1.0))).r;
      return d>=0.99999994?uCameraRange.y:uCameraRange.x*uCameraRange.y/(uCameraRange.y-d*(uCameraRange.y-uCameraRange.x));
    }
    void main() {
      float center=viewDepth(vUv);
      vec2 p=vUv*uCloudSize-0.5;
      ivec2 base=ivec2(floor(p));vec2 f=fract(p);
      vec4 cloud=vec4(0.0);float sum=0.0;
      for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
        ivec2 pixel=clamp(base+ivec2(x,y),ivec2(0),ivec2(uCloudSize)-1);
        vec2 uv=(vec2(pixel)+0.5)/uCloudSize;
        float distance=viewDepth(uv);
        float weight=(x==0?1.0-f.x:f.x)*(y==0?1.0-f.y:f.y);
        weight*=exp(-abs(distance-center)/max(12.0,center*0.025));
        cloud+=texelFetch(uCloudColor,pixel,0)*weight;sum+=weight;
      }
      if(sum>0.00001)cloud/=sum;
      vec3 scene=texture(uSceneColor,vUv).rgb;
      result=vec4(cloud.rgb+scene*(1.0-cloud.a),1.0);
    }
  `;
  const COLUMN = /* glsl */`
    precision highp float;
    in vec2 vUv;
    out vec4 column;
    uniform int uLayer;
    ${DENSITY}
    void main() {
      vec2 layer=cloudLayer(uLayer);
      vec2 xz=(vUv-0.5)*80000.0;
      float stepSize=(layer.y-layer.x)/12.0;
      vec3 color=vec3(0.0);float transmission=1.0;
      for(int step=0;step<12;step++) {
        vec3 world=vec3(xz.x,layer.x+(float(step)+0.5)*stepSize,xz.y);
        float density=cloudDensity(world,uLayer,0.7);
        float alpha=1.0-exp(-density*cloudExtinction(uLayer)*stepSize);
        color+=cloudLight(world,uLayer,density,vec3(0.0,1.0,0.0),0.7)*alpha*transmission;
        transmission*=1.0-alpha;
      }
      column=vec4(color,1.0-transmission);
    }
  `;
  const shaderDeclarations = /* glsl */`
    uniform sampler2D uCloudColumnLow;
    uniform sampler2D uCloudColumnHigh;
    uniform float uWorldCloudsEnabled;
    vec4 worldCloudColumn(vec3 origin,vec3 ray,int layer) {
      if(ray.y<=0.0001)return vec4(0.0);
      float height=layer==0?2500.0:5350.0;
      float t=(height-origin.y)/ray.y;
      if(t<=0.0)return vec4(0.0);
      vec2 uv=(origin.xz+ray.xz*t)/80000.0+0.5;
      if(any(lessThan(uv,vec2(0.0)))||any(greaterThan(uv,vec2(1.0))))return vec4(0.0);
      vec4 cloud=layer==0?texture2D(uCloudColumnLow,uv):texture2D(uCloudColumnHigh,uv);
      float alpha=1.0-pow(max(0.0001,1.0-cloud.a),1.0/max(0.18,ray.y));
      cloud.rgb*=alpha/max(0.0001,cloud.a);cloud.a=alpha;
      return cloud;
    }
    vec3 worldCloudReflection(vec3 origin,vec3 ray,vec3 background) {
      if(uWorldCloudsEnabled<0.5)return background;
      vec4 low=worldCloudColumn(origin,ray,0),high=worldCloudColumn(origin,ray,1);
      vec3 behind=high.rgb+background*(1.0-high.a);
      return low.rgb+behind*(1.0-low.a);
    }
    float worldCloudSunTransmission(vec3 origin,vec3 ray) {
      if(uWorldCloudsEnabled<0.5)return 1.0;
      return (1.0-worldCloudColumn(origin,ray,0).a)*(1.0-worldCloudColumn(origin,ray,1).a);
    }
  `;

  function createNoise(THREE) {
    const hash = (x, y, z) => {
      let n = Math.imul(x + 5411, 374761393) ^ Math.imul(y + 91, 668265263) ^ Math.imul(z + 37, 2147483647);
      n = Math.imul(n ^ n >>> 13, 1274126177);
      return ((n ^ n >>> 16) >>> 0) / 4294967295;
    };
    const grids = [4, 8, 16, 32].map(count => {
      const values = new Float32Array(count ** 3);
      for (let z = 0; z < count; z++) {
        for (let y = 0; y < count; y++) {
          for (let x = 0; x < count; x++) {
            values[(z * count + y) * count + x] = hash(x, y, z);
          }
        }
      }
      return { count, values };
    });
    const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
    const sample = (grid, x, y, z) => {
      const { count, values } = grid;
      const ix = Math.floor(x),
        iy = Math.floor(y),
        iz = Math.floor(z);
      const fx = ease(x - ix),
        fy = ease(y - iy),
        fz = ease(z - iz);
      const x0 = ix % count,
        x1 = (ix + 1) % count,
        y0 = iy % count,
        y1 = (iy + 1) % count,
        z0 = iz % count,
        z1 = (iz + 1) % count;
      const a = values[(z0 * count + y0) * count + x0] * (1 - fx) + values[(z0 * count + y0) * count + x1] * fx;
      const b = values[(z0 * count + y1) * count + x0] * (1 - fx) + values[(z0 * count + y1) * count + x1] * fx;
      const c = values[(z1 * count + y0) * count + x0] * (1 - fx) + values[(z1 * count + y0) * count + x1] * fx;
      const d = values[(z1 * count + y1) * count + x0] * (1 - fx) + values[(z1 * count + y1) * count + x1] * fx;
      return (a * (1 - fy) + b * fy) * (1 - fz) + (c * (1 - fy) + d * fy) * fz;
    };
    const data = new Uint8Array(NOISE_SIZE ** 3);
    const weights = [0.53, 0.28, 0.13, 0.06];
    for (let z = 0; z < NOISE_SIZE; z++) {
      for (let y = 0; y < NOISE_SIZE; y++) {
        for (let x = 0; x < NOISE_SIZE; x++) {
          let value = 0;
          for (let band = 0; band < grids.length; band++) {
            const g = grids[band],
              scale = g.count / NOISE_SIZE;
            value += sample(g, (x + 0.5) * scale, (y + 0.5) * scale, (z + 0.5) * scale) * weights[band];
          }
          data[(z * NOISE_SIZE + y) * NOISE_SIZE + x] = Math.round(Math.min(1, Math.max(0, (value - 0.18) * 1.55)) * 255);
        }
      }
    }
    const texture = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
    texture.name = 'World cloud 128-cubed density';
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  }

  function create({ THREE, renderer }) {
    /* Own cloud density, reflection columns and post-process targets only. Scene textures belong
     * to the caller. All heights and bounds use physical world metres, independently of terrain scale.
     */
    const gl = renderer.getContext();
    const floating = Boolean(gl.getExtension('EXT_color_buffer_float'));
    const type = floating ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const empty = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    empty.needsUpdate = true;
    const uniforms = {
      uCloudColumnLow: { value: empty },
      uCloudColumnHigh: { value: empty },
      uWorldCloudsEnabled: { value: 0 }
    };
    const common = {
      uCloudNoise: { value: null },
      uCloudTime: { value: 0 },
      uCloudWeather: { value: 0 },
      uCloudSunDirection: { value: new THREE.Vector3(0.4, 0.6, -0.7).normalize() },
      uCloudSunColor: { value: new THREE.Color(1.0, 0.85, 0.65) },
      uCloudDaylight: { value: 1 },
      uCloudTwilight: { value: 0 }
    };
    const rayUniforms = {
      ...common,
      uSceneDepth: { value: null },
      uInverseProjection: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uJitterUv: { value: new THREE.Vector2() },
      uCameraRange: { value: new THREE.Vector2(0.5, 100000) }
    };
    const compositeUniforms = {
      uSceneColor: { value: null },
      uSceneDepth: rayUniforms.uSceneDepth,
      uCloudColor: { value: null },
      uCloudSize: { value: new THREE.Vector2() },
      uJitterUv: rayUniforms.uJitterUv,
      uCameraRange: rayUniforms.uCameraRange
    };
    const columnUniforms = { ...common, uLayer: { value: 0 } };
    const materials = [
      new THREE.RawShaderMaterial({
        name: 'World cloud ray integration',
        glslVersion: THREE.GLSL3,
        uniforms: rayUniforms,
        vertexShader: VERTEX,
        fragmentShader: RAYMARCH,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending
      }),
      new THREE.RawShaderMaterial({
        name: 'World cloud depth-aware composite',
        glslVersion: THREE.GLSL3,
        uniforms: compositeUniforms,
        vertexShader: VERTEX,
        fragmentShader: COMPOSITE,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending
      }),
      new THREE.RawShaderMaterial({
        name: 'World cloud optical columns',
        glslVersion: THREE.GLSL3,
        uniforms: columnUniforms,
        vertexShader: VERTEX,
        fragmentShader: COLUMN,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending
      })
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = new THREE.Mesh(geometry, materials[0]);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const frustum = new THREE.Frustum(),
      matrix = new THREE.Matrix4();
    const boxes = LAYERS.map(([low, high]) => new THREE.Box3(new THREE.Vector3(-HALF_EXTENT, low, -HALF_EXTENT), new THREE.Vector3(HALF_EXTENT, high, HALF_EXTENT)));
    let noise = null,
      columns = [],
      cloudTarget = null,
      finalTarget = null;
    let disposed = false,
      failed = false,
      reason = null,
      dirty = true,
      lightingKey = '';
    let time = 0,
      lastColumnTime = null,
      lastRayTime = null,
      lastRevision = null;
    let reflectionUpdates = 0,
      raymarchUpdates = 0,
      composites = 0,
      visible = false;
    const previousWorld = new THREE.Matrix4(),
      previousProjection = new THREE.Matrix4();

    function target(width, height, name, mipmaps = false) {
      const result = new THREE.WebGLRenderTarget(width, height, {
        type,
        format: THREE.RGBAFormat,
        minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: mipmaps
      });
      result.texture.name = name;
      result.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return result;
    }
    function preserve(callback) {
      const saved = {
        target: renderer.getRenderTarget(),
        face: renderer.getActiveCubeFace?.() ?? 0,
        mip: renderer.getActiveMipmapLevel?.() ?? 0,
        viewport: renderer.getViewport(new THREE.Vector4()),
        scissor: renderer.getScissor(new THREE.Vector4()),
        scissorTest: renderer.getScissorTest(),
        clearColor: renderer.getClearColor(new THREE.Color()),
        clearAlpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear,
        infoReset: renderer.info.autoReset,
        info: { ...renderer.info.render },
        xr: renderer.xr?.enabled,
        shaderError: renderer.debug.onShaderError
      };
      try {
        renderer.autoClear = false;
        renderer.info.autoReset = false;
        if (renderer.xr) {
          renderer.xr.enabled = false;
        }
        renderer.setScissorTest(false);
        renderer.debug.onShaderError = (context, program, vertex, fragment) => {
          saved.shaderError?.(context, program, vertex, fragment);
          throw new Error('World cloud shader compilation failed');
        };
        return callback();
      } finally {
        renderer.setRenderTarget(saved.target, saved.face, saved.mip);
        renderer.setViewport(saved.viewport);
        renderer.setScissor(saved.scissor);
        renderer.setScissorTest(saved.scissorTest);
        renderer.setClearColor(saved.clearColor, saved.clearAlpha);
        renderer.autoClear = saved.autoClear;
        renderer.info.autoReset = saved.infoReset;
        Object.assign(renderer.info.render, saved.info);
        renderer.debug.onShaderError = saved.shaderError;
        if (renderer.xr) {
          renderer.xr.enabled = saved.xr;
        }
      }
    }
    function draw(material, destination) {
      quad.material = material;
      renderer.setRenderTarget(destination);
      // setViewport uses logical pixels even for an offscreen target; target dimensions are physical.
      const ratio = renderer.getPixelRatio();
      renderer.setViewport(0, 0, destination.width / ratio, destination.height / ratio);
      renderer.render(scene, screenCamera);
    }
    function initialize() {
      if (noise) return;
      noise = createNoise(THREE);
      common.uCloudNoise.value = noise;
      columns = [
        target(MAP_SIZE, MAP_SIZE, 'Lower cloud optical columns', true),
        target(MAP_SIZE, MAP_SIZE, 'Upper cloud optical columns', true)
      ];
    }
    function disable(error) {
      failed = true;
      reason = error?.message || String(error);
      uniforms.uWorldCloudsEnabled.value = 0;
      console.warn('World clouds unavailable:', reason);
    }
    function setLighting(state = {}) {
      const key = JSON.stringify([state.direction, state.elevation, state.weather, state.sunColor]);
      if (key === lightingKey) return;
      lightingKey = key;
      if (state.direction?.length === 3) common.uCloudSunDirection.value.fromArray(state.direction).normalize();
      if (state.sunColor?.length === 3) common.uCloudSunColor.value.fromArray(state.sunColor);
      const elevation = Number.isFinite(state.elevation) ? state.elevation : 30;
      common.uCloudDaylight.value = THREE.MathUtils.smoothstep(elevation, -12, 9);
      common.uCloudTwilight.value = (1 - THREE.MathUtils.smoothstep(elevation, 2, 18)) * THREE.MathUtils.smoothstep(elevation, -13, -1);
      common.uCloudWeather.value = state.weather === 'rainy' ? 1 : state.weather === 'cloudy' ? 0.62 : 0;
      dirty = true;
      lastRayTime = null;
    }
    function setTime(seconds) {
      if (Number.isFinite(seconds)) time = Math.max(0, seconds);
      common.uCloudTime.value = time;
    }
    function update(seconds = time) {
      setTime(seconds);
      if (disposed || failed) return false;
      if (!dirty && lastColumnTime !== null && time >= lastColumnTime && time - lastColumnTime < UPDATE_INTERVAL - 0.000001) return false;
      try {
        preserve(() => {
          initialize();
          for (let layer = 0; layer < 2; layer++) {
            columnUniforms.uLayer.value = layer;
            draw(materials[2], columns[layer]);
          }
        });
        uniforms.uCloudColumnLow.value = columns[0].texture;
        uniforms.uCloudColumnHigh.value = columns[1].texture;
        uniforms.uWorldCloudsEnabled.value = 1;
        lastColumnTime = time;
        reflectionUpdates++;
        dirty = false;
        return true;
      } catch (error) {
        disable(error);
        return false;
      }
    }
    function hasVisibleVolume(camera) {
      if (disposed || failed) return false;
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(matrix);
      return boxes.some(box => frustum.intersectsBox(box));
    }
    function render({ colorTexture, depthTexture, camera, jitterUv, outputSize, sceneRevision = 0 }) {
      /* Inputs are linear scene color, device depth and an unjittered perspective camera.
       * jitterUv maps output UVs to the current depth buffer. sceneRevision invalidates cached
       * depth clipping after terrain/visibility changes. Returns an owned linear texture, or the
       * original input when no cloud layer intersects the view. The caller retains all inputs.
       */
      if (disposed || failed || !colorTexture || !depthTexture || !camera) return colorTexture;
      visible = hasVisibleVolume(camera);
      if (!visible) return colorTexture;
      const width = Math.floor(outputSize?.x ?? outputSize?.[0] ?? colorTexture.image?.width ?? 1);
      const height = Math.floor(outputSize?.y ?? outputSize?.[1] ?? colorTexture.image?.height ?? 1);
      if (width < 1 || height < 1 || width * height > 8 * 1024 * 1024 || width > renderer.capabilities.maxTextureSize || height > renderer.capabilities.maxTextureSize) return colorTexture;
      try {
        update(time);
        if (failed) return colorTexture;
        return preserve(() => {
          const desiredScale = camera.matrixWorld.elements[13] <= 10000 ? 0.65 : 0.5;
          const scale = Math.min(desiredScale, 1280 / width, 800 / height);
          const cloudWidth = Math.max(1, Math.ceil(width * scale)),
            cloudHeight = Math.max(1, Math.ceil(height * scale));
          let resized = false;
          if (!cloudTarget || cloudTarget.width !== cloudWidth || cloudTarget.height !== cloudHeight) {
            cloudTarget?.dispose();
            cloudTarget = target(cloudWidth, cloudHeight, 'World cloud adaptive-resolution integration');
            resized = true;
          }
          if (!finalTarget || finalTarget.width !== width || finalTarget.height !== height) {
            finalTarget?.dispose();
            finalTarget = target(width, height, 'Depth-aware cloud composite');
          }
          rayUniforms.uSceneDepth.value = depthTexture;
          rayUniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
          rayUniforms.uCameraWorld.value.copy(camera.matrixWorld);
          rayUniforms.uJitterUv.value.set(jitterUv?.x ?? jitterUv?.[0] ?? 0, jitterUv?.y ?? jitterUv?.[1] ?? 0);
          rayUniforms.uCameraRange.value.set(camera.near, camera.far);
          const moved = !previousWorld.equals(camera.matrixWorld) || !previousProjection.equals(camera.projectionMatrix);
          const refresh = resized || moved || lastRevision !== sceneRevision || lastRayTime === null || time < lastRayTime || time - lastRayTime >= UPDATE_INTERVAL - 0.000001;
          if (refresh) {
            draw(materials[0], cloudTarget);
            previousWorld.copy(camera.matrixWorld);
            previousProjection.copy(camera.projectionMatrix);
            lastRayTime = time;
            lastRevision = sceneRevision;
            raymarchUpdates++;
          }
          compositeUniforms.uSceneColor.value = colorTexture;
          compositeUniforms.uCloudColor.value = cloudTarget.texture;
          compositeUniforms.uCloudSize.value.set(cloudWidth, cloudHeight);
          draw(materials[1], finalTarget);
          composites++;
          return finalTarget.texture;
        });
      } catch (error) {
        disable(error);
        return colorTexture;
      }
    }
    return {
      uniforms,
      setLighting,
      setTime,
      update,
      render,
      hasVisibleVolume,
      getState: () => ({
        supported: !failed && !disposed,
        active: uniforms.uWorldCloudsEnabled.value === 1,
        mode: 'world-space-depth-composited-clouds',
        reason,
        time,
        visible,
        layerHeightsM: LAYERS.map(layer => [...layer]),
        layerWindMps: [[7.5, 2.7], [-4.1, 5.8]],
        halfExtentM: HALF_EXTENT,
        noiseVolumeSize: NOISE_SIZE,
        reflectionMapSize: MAP_SIZE,
        reflectionUpdates,
        raymarchUpdates,
        composites,
        updateHz: 1 / UPDATE_INTERVAL,
        raySteps: [32, 16],
        raymarchSize: cloudTarget ? [cloudTarget.width, cloudTarget.height] : [0, 0],
        nearRenderScale: 0.65,
        regionalRenderScale: 0.5,
        maximumRaymarchSize: [1280, 800],
        outputSize: finalTarget ? [finalTarget.width, finalTarget.height] : [0, 0],
        estimatedTextureMiB: ((noise ? NOISE_SIZE ** 3 * 8 / 7 : 0) + columns.length * MAP_SIZE ** 2 * (floating ? 8 : 4) * 4 / 3
          + (cloudTarget ? cloudTarget.width * cloudTarget.height * (floating ? 8 : 4) : 0)
          + (finalTarget ? finalTarget.width * finalTarget.height * (floating ? 8 : 4) : 0)) / 1048576
      }),
      dispose() {
        disposed = true;
        uniforms.uWorldCloudsEnabled.value = 0;
        noise?.dispose();
        columns.forEach(item => item.dispose());
        cloudTarget?.dispose();
        finalTarget?.dispose();
        geometry.dispose();
        materials.forEach(item => item.dispose());
        empty.dispose();
      }
    };
  }
  global.NotoCloudLayers = { create, shaderDeclarations };
})(window);
