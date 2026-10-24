// Real vegetation classes constrain coverage; representative plants use stable seeded positions.
(function registerNotoVegetation(global) {
  'use strict';

  // TREE_CLASSES: source categories displayed as trees, including forest and orchards (Set<number>).
  const TREE_CLASSES = new Set([8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  // CONIFER_CLASSES: source categories displayed with conifer prototypes (Set<number>).
  const CONIFER_CLASSES = new Set([20, 22, 23, 24, 25, 26, 27]);
  // HERB_CLASSES: source categories displayed with nearby herbs, including herbaceous crops (Set<number>).
  const HERB_CLASSES = new Set([5, 6, 7, 10, 12, 13, 14, 15, 16, 17]);
  // BASE_SPACING_M: representative forest spacing in metres, not measured tree spacing.
  const BASE_SPACING_M = 12;
  // CHUNK_M: horizontal query-chunk size, in metres.
  const CHUNK_M = 512;
  // COVER_BLEND_M: visual fade width inside vegetation boundaries, in metres.
  const COVER_BLEND_M = 192;
  // DRAW_DISTANCE_M: drawing cutoff in metres; viewing distance never changes point spacing.
  const DRAW_DISTANCE_M = 1500;
  // TREE_HEIGHT_M: representative forest display heights, in metres.
  const TREE_HEIGHT_M = { broadleaf: [12, 22], conifer: [18, 30] };
  // ROOT_EMBED_M: slight ground penetration, in metres, to avoid contact gaps.
  const ROOT_EMBED_M = 0.12;
  // LIMITS: representative-tree/herb budgets per detail tier; automatic mode uses measured performance.
  const LIMITS = {
    nearTrees: 24,
    middleTrees: 240,
    farTrees: 60000,
    herbs: 240
  };
  async function unpack(value, Type) {
    /*
     * Decompress a Base64 gzip array and interpret its bytes with the supplied TypedArray
     * constructor. Return Promise<TypedArray> without executing data.
     */
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    const buffer = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return new Type(buffer);
  }
  function seedAt(i, j, salt = 0) {
    /*
     * Hash integer row/column indices and an optional salt into a stable value in [0,1). Seeds
     * remain consistent across pages, views and LOD changes.
     */
    let seed = Math.imul(i ^ 0x45d9f3b, 374761393) ^ Math.imul(j + salt * 1013, 668265263);
    seed = Math.imul(seed ^ seed >>> 13, 1274126177);
    return ((seed ^ seed >>> 16) >>> 0) / 4294967296;
  }
  function blurCoverChannel(values, scratch, columns, rows, radiusX, radiusZ) {
    /*
     * Smooth one premultiplied-color or alpha Float32Array channel in place using separable box
     * filters. scratch has the same rows*columns size; radii are cells. Repeated
     * horizontal/vertical running sums approximate a smooth kernel with edge clamping and linear
     * cost.
     */
    function axis(input, output, length, lines, stride, lineStep, radius) {
      /*
       * Filter one axis with a constant-time sliding sum. length/lines set dimensions;
       * stride/lineStep set memory offsets; radius sets the fixed window. Write output without
       * changing input, repeating edge samples.
       */
      const span = radius * 2 + 1;
      for (let line = 0; line < lines; line++) {
        const base = line * lineStep;
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += input[base + Math.max(0, Math.min(length - 1, k)) * stride];
        for (let p = 0; p < length; p++) {
          output[base + p * stride] = sum / span;
          sum += input[base + Math.min(length - 1, p + radius + 1) * stride] - input[base + Math.max(0, p - radius) * stride];
        }
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      axis(values, scratch, columns, rows, 1, columns, radiusX);
      axis(scratch, values, rows, columns, columns, 1, radiusZ);
    }
  }
  function coverDistances(classes, alphaTable, columns, rows, dx, dz) {
    /*
     * Estimate distance inside vegetated cells to nonvegetated boundaries. Use original Uint8
     * classes and per-class alpha, then two eight-neighbor chamfer passes with metric dx/dz. Return
     * Float32Array distances without changing ecological classes.
     */
    const distance = new Float32Array(classes.length);
    const diagonal = Math.hypot(dx, dz);
    for (let i = 0; i < classes.length; i++) distance[i] = alphaTable[classes[i]] ? COVER_BLEND_M + diagonal : 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      if (!distance[i]) continue;
      let value = distance[i];
      if (c) value = Math.min(value, distance[i - 1] + dx);
      if (r) {
        value = Math.min(value, distance[i - columns] + dz);
        if (c) value = Math.min(value, distance[i - columns - 1] + diagonal);
        if (c + 1 < columns) value = Math.min(value, distance[i - columns + 1] + diagonal);
      }
      distance[i] = value;
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = columns - 1; c >= 0; c--) {
      const i = r * columns + c;
      if (!distance[i]) continue;
      let value = distance[i];
      if (c + 1 < columns) value = Math.min(value, distance[i + 1] + dx);
      if (r + 1 < rows) {
        value = Math.min(value, distance[i + columns] + dz);
        if (c) value = Math.min(value, distance[i + columns - 1] + diagonal);
        if (c + 1 < columns) value = Math.min(value, distance[i + columns + 1] + diagonal);
      }
      distance[i] = value;
    }
    return distance;
  }
  async function prepareData(THREE, source) {
    /*
     * Prepare coverage queries and a ground-cover texture. Decompress source categories for
     * nearest-neighbor lookup, smooth premultiplied colors in linear space, and fade within
     * vegetation boundaries while keeping bare-cell alpha zero. Return Promise<Object> with
     * queries, texture and source metadata.
     */
    const classes = await unpack(source.classes, Uint8Array);
    if (classes.length !== source.columns * source.rows) throw new Error('Invalid vegetation raster size');
    const width = source.bounds[2] - source.bounds[0];
    const height = source.bounds[3] - source.bounds[1];
    const rgba = new Uint8Array(classes.length * 4);
    const coverColors = ['#24402d', '#38553a', '#788b4c'].map(value => new THREE.Color(value));
    const alphaTable = new Float32Array(256);
    const colorTable = new Float32Array(256 * 3);
    for (let id = 0; id < 256; id++) {
      const tree = TREE_CLASSES.has(id);
      if (!tree && !HERB_CLASSES.has(id)) continue;
      alphaTable[id] = (tree ? 190 : 130) / 255;
      const color = coverColors[CONIFER_CLASSES.has(id) ? 0 : tree ? 1 : 2];
      colorTable.set([color.r, color.g, color.b], id * 3);
    }
    const dx = width / source.columns,
      dz = height / source.rows;
    const radiusX = Math.max(1, Math.round(COVER_BLEND_M / (3 * dx)));
    const radiusZ = Math.max(1, Math.round(COVER_BLEND_M / (3 * dz)));
    const values = new Float32Array(classes.length),
      scratch = new Float32Array(classes.length);
    for (let i = 0; i < values.length; i++) values[i] = alphaTable[classes[i]];
    blurCoverChannel(values, scratch, source.columns, source.rows, radiusX, radiusZ);
    const smoothedAlpha = values.slice();
    const distance = coverDistances(classes, alphaTable, source.columns, source.rows, dx, dz);
    for (let i = 0; i < classes.length; i++) {
      if (!alphaTable[classes[i]]) continue;
      const t = Math.max(0, Math.min(1, (distance[i] - Math.min(dx, dz) / 2) / COVER_BLEND_M));
      rgba[i * 4 + 3] = Math.round(smoothedAlpha[i] * t * t * (3 - 2 * t) * 255);
    }
    // Smooth premultiplied color, then divide by smoothed alpha to prevent dark halos along bare ground.
    const color = new THREE.Color();
    for (let channel = 0; channel < 3; channel++) {
      for (let i = 0; i < values.length; i++) values[i] = colorTable[classes[i] * 3 + channel] * alphaTable[classes[i]];
      blurCoverChannel(values, scratch, source.columns, source.rows, radiusX, radiusZ);
      for (let i = 0; i < values.length; i++) {
        const linear = smoothedAlpha[i] > 1e-6 ? Math.max(0, values[i] / smoothedAlpha[i]) : 0;
        color.setRGB(linear, 0, 0).convertLinearToSRGB();
        rgba[i * 4 + channel] = Math.round(Math.min(1, color.r) * 255);
      }
    }
    const groundCover = new THREE.DataTexture(rgba, source.columns, source.rows);
    groundCover.colorSpace = THREE.SRGBColorSpace;
    groundCover.minFilter = THREE.LinearMipmapLinearFilter;
    groundCover.magFilter = THREE.LinearFilter;
    groundCover.generateMipmaps = true;
    groundCover.needsUpdate = true;
    function categoryAt(x, z) {
      /*
       * Query the source category at model-centred metric x/z coordinates (east/south). Convert to
       * projected raster indices and read the nearest category. Return zero outside bounds; never
       * interpolate class IDs.
       */
      const c = Math.floor((x + width / 2) / width * source.columns);
      const r = Math.floor((z + height / 2) / height * source.rows);
      return c < 0 || r < 0 || c >= source.columns || r >= source.rows ? 0 : classes[r * source.columns + c];
    }
    return {
      source,
      width,
      height,
      groundCover,
      categoryAt
    };
  }
  async function create({
    THREE,
    renderer,
    scene,
    camera,
    data,
    sampleHeight
  }) {
    /*
     * Create shared plant prototypes and reusable instance pools. Decompress geometry, load
     * embedded PBR images, bake distant cards on the renderer, then create tree/herb instances.
     * sampleHeight(x,z) returns displayed land height or null. Return update, markDirty, getState
     * and settings interfaces.
     */
    const group = new THREE.Group();
    group.name = 'Noto vegetation';
    scene.add(group);
    const timeUniform = {
      value: 0
    };
    const groundGrass = global.NotoGroundGrass.create({
      THREE, scene: group, camera, data: data.grass, sampleHeight, time: timeUniform
    });
    const libraries = new Map();
    const fadeCamera = {
      value: camera.position
    };
    const fadeDistance = {
      value: new THREE.Vector2(DRAW_DISTANCE_M - 300, DRAW_DISTANCE_M)
    };
    function configureFade(material) {
      /*
       * Inject a screen-door fade over the last part of the draw radius for detailed trees, herbs
       * and cards. Use each instance's root distance, preserving positions and density while
       * approaching the cutoff.
       */
      const original = material.onBeforeCompile.bind(material);
      const key = material.customProgramCacheKey.bind(material)();
      material.onBeforeCompile = shader => {
        /*
         * Extend a material's existing wind shader with instance-root distance and the terminal
         * fade. Update shader uniforms/chunks in place without changing instance positions.
         */
        original(shader);
        shader.uniforms.uPlantCamera = fadeCamera;
        shader.uniforms.uPlantFadeDistance = fadeDistance;
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
          uniform vec3 uPlantCamera;
          uniform vec2 uPlantFadeDistance;
          varying float vPlantFade;`);
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 plantFoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vPlantFade = 1.0 - smoothstep(uPlantFadeDistance.x, uPlantFadeDistance.y, distance(plantFoot, uPlantCamera));`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vPlantFade;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
          float plantThreshold = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
          if (vPlantFade < plantThreshold) discard;`);
      };
      material.customProgramCacheKey = () => key + '-plant-distance-fade-v1';
    }
    const textureLoader = new THREE.TextureLoader();
    const pools = [];
    for (const model of global.NOTO_VEGETATION_MODELS) {
      const materials = [];
      for (const entry of model.materials) {
        const maps = {};
        for (const key of ['color', 'normal', 'arm']) {
          if (!entry[key]) continue;
          const texture = await textureLoader.loadAsync(entry[key].url);
          texture.flipY = false; // The glTF UV orientation is handled by its texture transform; retain the glTF origin convention.
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.colorSpace = key === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
          maps[key] = texture;
        }
        const material = new THREE.MeshStandardMaterial({
          map: maps.color,
          normalMap: maps.normal,
          roughnessMap: maps.arm,
          roughness: 1,
          metalness: 0,
          side: THREE.DoubleSide,
          alphaTest: entry.leaf ? 0.4 : 0,
          normalScale: new THREE.Vector2(0.45, 0.45)
        });
        material.name = entry.name;
        if (entry.leaf) {
          material.onBeforeCompile = shader => {
            /*
             * Inject subtle leaf wind using a shared time uniform and stable spatial phase. Root
             * weight is zero. Update the shader without rewriting instance matrices or source
             * geometry.
             */
            shader.uniforms.uVegetationTime = timeUniform;
            shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uVegetationTime;');
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
              // Root displacement is zero. Small leaf motion does not move instance positions or source elevations.
              float plantPhase = instanceMatrix[3].x * 0.021 + instanceMatrix[3].z * 0.017;
              float sway = sin(uVegetationTime * 1.4 + plantPhase + position.y * 1.7);
              transformed.x += sway * min(max(position.y, 0.0) * 0.012, 0.08);`);
          };
          material.customProgramCacheKey = () => 'noto-vegetation-leaf-wind-v1';
        }
        configureFade(material);
        materials.push(material);
      }
      const variants = Math.max(...model.parts.map(p => p.variant)) + 1;
      const prototypes = Array.from({
        length: variants
      }, () => new THREE.Group());
      const variantBounds = Array.from({
        length: variants
      }, () => new THREE.Box3());
      const trunkGeometry = Array(variants).fill(null);
      const tree = ['broadleaf', 'conifer'].includes(model.key);
      for (const part of model.parts) {
        for (const packed of part.levels) {
          const geometry = new THREE.BufferGeometry();
          for (const key of ['position', 'normal', 'uv']) {
            geometry.setAttribute(key, new THREE.BufferAttribute(await unpack(packed[key], Float32Array), key === 'uv' ? 2 : 3));
          }
          geometry.setIndex(new THREE.BufferAttribute(await unpack(packed.index, Uint32Array), 1));
          geometry.computeBoundingBox();
          const limit = tree ? packed.level === 'near' ? LIMITS.nearTrees : LIMITS.middleTrees : LIMITS.herbs;
          const mesh = new THREE.InstancedMesh(geometry, materials[part.material], limit);
          mesh.count = 0;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const surfaceMaterial = materials[part.material];
          mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            map: surfaceMaterial.map,
            alphaTest: surfaceMaterial.alphaTest,
            side: THREE.DoubleSide
          });
          // Use matching leaf wind and distance fade in the depth pass so shadows follow the same geometry.
          mesh.customDepthMaterial.onBeforeCompile = surfaceMaterial.onBeforeCompile;
          mesh.customDepthMaterial.customProgramCacheKey = () => surfaceMaterial.customProgramCacheKey() + '-depth';
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.frustumCulled = false; // Chunk and instance selection already applies the current expanded frustum.
          group.add(mesh);
          pools.push({
            mesh,
            key: model.key,
            level: packed.level,
            variant: part.variant,
            limit
          });
          if (packed.level === 'near') {
            if (/trunk/i.test(model.materials[part.material].name)) trunkGeometry[part.variant] = geometry;
            variantBounds[part.variant].union(geometry.boundingBox);
            {
              const copy = new THREE.Mesh(geometry, materials[part.material].clone());
              // Prototype baking has no instanceMatrix, so omit the wind shader that depends on instances.
              copy.material.onBeforeCompile = () => {};
              copy.material.customProgramCacheKey = () => 'noto-vegetation-bake';
              prototypes[part.variant].add(copy);
            }
          }
        }
      }
      if (tree) for (let variant = 0; variant < variants; variant++) {
        // Source assets are crown-centered. Use the trunk base as the shared origin for every material and LOD.
        const trunk = trunkGeometry[variant] ?? prototypes[variant].children[0].geometry;
        const vertices = trunk.attributes.position.array;
        const baseY = trunk.boundingBox.min.y;
        let rootX = 0, rootZ = 0, count = 0;
        for (let i = 0; i < vertices.length; i += 3) if (vertices[i + 1] <= baseY + 0.1) {
          rootX += vertices[i];
          rootZ += vertices[i + 2];
          count++;
        }
        rootX /= count;
        rootZ /= count;
        variantBounds[variant].makeEmpty();
        for (const pool of pools) if (pool.key === model.key && pool.variant === variant) {
          const geometry = pool.mesh.geometry;
          geometry.translate(-rootX, -baseY, -rootZ);
          geometry.computeBoundingBox();
          if (pool.level === 'near') variantBounds[variant].union(geometry.boundingBox);
        }
      }
      const bounds = variantBounds[0],
        dimensions = bounds.getSize(new THREE.Vector3());
      const library = {
        model,
        prototypes,
        bounds,
        dimensions,
        variantBounds,
        variantDimensions: variantBounds.map(box => box.getSize(new THREE.Vector3())),
        variants
      };
      libraries.set(model.key, library);
      if (['broadleaf', 'conifer'].includes(model.key)) {
        for (let variant = 0; variant < variants; variant++) {
          const side = bakeCard(library, variant, false),
            top = bakeCard(library, variant, true);
          for (const overhead of [false, true]) {
            const geometry = cardGeometry(library.variantBounds[variant], overhead);
            const material = new THREE.MeshBasicMaterial({
              map: overhead ? top.texture : side.texture,
              alphaTest: 0.35,
              side: THREE.DoubleSide,
              toneMapped: false
            });
            configureFade(material);
            const mesh = new THREE.InstancedMesh(geometry, material, LIMITS.farTrees);
            mesh.count = 0;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.frustumCulled = false;
            group.add(mesh);
            pools.push({
              mesh,
              key: model.key,
              level: 'far',
              variant,
              limit: LIMITS.farTrees
            });
          }
        }
      }
    }
    function bakeCard(library, variant, overhead) {
      /*
       * Bake a distant image of an actual prototype to a WebGLRenderTarget without reading an
       * external-image canvas. Choose the shape variant and side/overhead camera, render on
       * transparency, then restore renderer state. The target is shared by distant instances.
       */
      const prototype = library.prototypes[variant];
      const bounds = library.variantBounds[variant];
      const d = library.variantDimensions[variant];
      const span = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), Math.abs(bounds.min.z), Math.abs(bounds.max.z)) * 2.1;
      const world = new THREE.Scene();
      world.add(prototype);
      world.add(new THREE.HemisphereLight(0xe4f1ff, 0x64634e, 2.1));
      const light = new THREE.DirectionalLight(0xfff2df, 2.6);
      light.position.set(-2, 3, 2);
      world.add(light);
      const height = overhead ? span : d.y * 1.04;
      const view = new THREE.OrthographicCamera(-span / 2, span / 2, height / 2, -height / 2, 0.01, d.y * 5 + span * 5);
      const centerY = bounds.min.y + d.y / 2;
      const target = new THREE.Vector3(0, centerY, 0);
      if (overhead) {
        view.position.set(0, d.y * 3, 0);
        view.up.set(0, 0, -1);
      } else view.position.set(0, centerY, span * 3);
      view.lookAt(target);
      const output = new THREE.WebGLRenderTarget(512, 512);
      const oldTarget = renderer.getRenderTarget();
      const oldColor = renderer.getClearColor(new THREE.Color()),
        oldAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(output);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(world, view);
      renderer.setRenderTarget(oldTarget);
      renderer.setClearColor(oldColor, oldAlpha);
      world.remove(prototype);
      return output;
    }
    function cardGeometry(bounds, overhead) {
      /*
       * Create metric distant-card geometry from prototype bounds: three crossed planes for side
       * views, or a canopy plane for overhead views. Preserve physical size and sample the baked
       * prototype image.
       */
      const dimensions = bounds.getSize(new THREE.Vector3());
      const span = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), Math.abs(bounds.min.z), Math.abs(bounds.max.z)) * 2.1;
      const geometry = new THREE.PlaneGeometry(span, overhead ? span : dimensions.y * 1.04);
      if (overhead) {
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(0, dimensions.y * 0.65, 0);
        return geometry;
      }
      // Match the bake camera center and padding so distant roots stay aligned.
      geometry.translate(0, bounds.min.y + dimensions.y / 2, 0);
      const second = geometry.clone();
      second.rotateY(Math.PI / 2);
      const merged = new THREE.BufferGeometry();
      for (const key of ['position', 'normal', 'uv']) {
        const a = geometry.getAttribute(key),
          b = second.getAttribute(key);
        merged.setAttribute(key, new THREE.BufferAttribute(new Float32Array([...a.array, ...b.array]), a.itemSize));
      }
      merged.setIndex([...geometry.index.array, ...second.index.array].map((v, i) => i < 6 ? v : v + 4));
      geometry.dispose();
      second.dispose();
      return merged;
    }
    const chunks = [];
    for (let z = -data.height / 2; z < data.height / 2; z += CHUNK_M) {
      for (let x = -data.width / 2; x < data.width / 2; x += CHUNK_M) chunks.push({
        x,
        z
      });
    }
    const matrix = new THREE.Matrix4(),
      quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3(),
      scale = new THREE.Vector3(),
      axis = new THREE.Vector3(0, 1, 0);
    const frustum = new THREE.Frustum(),
      projection = new THREE.Matrix4(),
      box = new THREE.Box3();
    let placementRevision = 0;
    let dirty = true,
      lastUpdate = -Infinity,
      lastCamera = new THREE.Vector3(Infinity, 0, 0),
      lastScale = 0;
    const lastRotation = new THREE.Quaternion();
    let state = {
      sourceYear: data.source.source_year,
      sourceResolutionM: data.source.pixel_size_m,
      nearTrees: 0,
      middleTrees: 0,
      farTrees: 0,
      herbs: 0,
      excludedClasses: data.source.excluded_from_plants,
      sampleInstances: []
    };
    let lastWindFrame = null;
    // Only nearby trees and herbs animate in wind; off or distant-only views have no independent wind animation.
    const hasAnimation = () => group.visible && state.nearTrees + state.middleTrees + state.herbs + groundGrass.getState().tufts > 0;
    function animate(now) {
      /*
       * Advance only the shared wind clock on an existing draw frame. Reset its baseline when no
       * nearby vegetation is visible and cap resumed steps at 50 ms. Does not recompute placement
       * or schedule a frame.
       */
      if (!hasAnimation()) {
        lastWindFrame = null;
        return;
      }
      if (lastWindFrame !== null) timeUniform.value += Math.min(Math.max(now - lastWindFrame, 0), 50) / 1000;
      lastWindFrame = now;
    }
    let detailMode = 'auto',
      automaticTier = 0;
    let grassVisible = true,
      treesVisible = true;
    // Finish camera snapshots instead of restarting on every pointer movement. Geometry and
    // settings invalidation cancel stale work; a newer camera view follows the completed pass.
    const PLACEMENT_BUDGET_MS = 3;
    let placementJob = null,
      invalidation = 0,
      lastPlacementMs = 0;
    const poolIndex = new Map();
    for (const pool of pools) {
      const key = `${pool.key}/${pool.level}/${pool.variant}`;
      if (!poolIndex.has(key)) poolIndex.set(key, []);
      poolIndex.get(key).push(pool);
    }
    function* sortByDistance(points) {
      // Bottom-up merge sort yields inside merge runs, avoiding a single blocking Array.sort.
      let input = points,
        output = new Array(points.length),
        work = 0;
      for (let width = 1; width < points.length; width *= 2) {
        for (let left = 0; left < points.length; left += width * 2) {
          const middle = Math.min(left + width, points.length);
          const right = Math.min(left + width * 2, points.length);
          let a = left, b = middle;
          for (let index = left; index < right; index++) {
            output[index] = b >= right || a < middle && input[a].distance <= input[b].distance ? input[a++] : input[b++];
            if ((++work & 255) === 0) yield;
          }
        }
        [input, output] = [output, input];
      }
      return input;
    }
    function cancelPlacement() {
      placementJob?.iterator.return();
      placementJob = null;
    }
    function update(now, verticalScale) {
      /* Spend a small CPU slice preparing a complete replacement. Displayed attributes remain
       * intact until commit, and true keeps the existing scene scheduler alive while work waits.
       */
      animate(now);
      group.visible = detailMode !== 'off' && (grassVisible || treesVisible);
      if (placementJob && (placementJob.invalidation !== invalidation || lastScale !== verticalScale)) cancelPlacement();
      if (!group.visible) {
        cancelPlacement();
        if (state.nearTrees + state.middleTrees + state.farTrees + state.herbs + groundGrass.getState().tufts) {
          pools.forEach(pool => { pool.mesh.count = 0; });
          groundGrass.hide();
          state = { ...state, nearTrees: 0, middleTrees: 0, farTrees: 0, herbs: 0, sampleInstances: [] };
          placementRevision++;
        }
        dirty = false;
        return false;
      }
      const changed = camera.position.distanceToSquared(lastCamera) > 4 || lastScale !== verticalScale || camera.quaternion.angleTo(lastRotation) > 0.002;
      if (!placementJob) {
        if (!dirty && !changed) return false;
        if (!dirty && now - lastUpdate < 250) return true;
        lastUpdate = now;
        lastCamera.copy(camera.position);
        lastRotation.copy(camera.quaternion);
        lastScale = verticalScale;
        dirty = false;
        camera.updateMatrixWorld();
        projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projection);
        const view = {
          position: camera.position.clone(),
          frustum: frustum.clone(),
          verticalScale,
          grassVisible,
          treesVisible,
          tier: detailMode === 'auto' ? automaticTier : detailMode === 'high' ? 0 : detailMode === 'medium' ? 1 : 2
        };
        placementJob = { iterator: preparePlacement(view), invalidation, elapsed: 0 };
      }
      const began = performance.now(), deadline = began + PLACEMENT_BUDGET_MS;
      let next;
      do {
        next = placementJob.iterator.next();
      } while (!next.done && performance.now() < deadline);
      placementJob.elapsed += performance.now() - began;
      if (!next.done) return true;
      lastPlacementMs = placementJob.elapsed;
      commitPlacement(next.value);
      placementJob = null;
      // Complete this snapshot before requesting another, even during continuous movement.
      return camera.position.distanceToSquared(lastCamera) > 4 || camera.quaternion.angleTo(lastRotation) > 0.002;
    }
    function* preparePlacement(view) {
      const candidates = [];
      const buffers = new Map();
      const { verticalScale, tier, grassVisible, treesVisible } = view;
      const viewPosition = view.position;
      const viewFrustum = view.frustum;
      let checked = 0;
      if (treesVisible) for (const chunk of chunks) {
        if ((++checked & 31) === 0) yield;
        box.min.set(chunk.x, -10, chunk.z);
        box.max.set(Math.min(chunk.x + CHUNK_M, data.width / 2), 500 * verticalScale + 35, Math.min(chunk.z + CHUNK_M, data.height / 2));
        if (!viewFrustum.intersectsBox(box)) continue;
        if (box.distanceToPoint(viewPosition) > DRAW_DISTANCE_M) continue;
        // All distance tiers use the same 12 m point grid. Change geometric detail, never thin the coordinates.
        const i0 = Math.ceil((chunk.x + data.width / 2) / BASE_SPACING_M);
        const j0 = Math.ceil((chunk.z + data.height / 2) / BASE_SPACING_M);
        const i1 = Math.ceil((box.max.x + data.width / 2) / BASE_SPACING_M);
        const j1 = Math.ceil((box.max.z + data.height / 2) / BASE_SPACING_M);
        for (let j = j0; j < j1; j++) {
          for (let i = i0; i < i1; i++) {
            if ((++checked & 31) === 0) yield;
            const seed = seedAt(i, j);
            const x = -data.width / 2 + (i + 0.25 + seed * 0.5) * BASE_SPACING_M;
            const z = -data.height / 2 + (j + 0.25 + seedAt(i, j, 1) * 0.5) * BASE_SPACING_M;
            const category = data.categoryAt(x, z);
            if (!TREE_CLASSES.has(category)) continue;
            const y = sampleHeight(x, z);
            if (y === null || !Number.isFinite(y)) continue;
            const key = CONIFER_CLASSES.has(category) ? 'conifer' : 'broadleaf';
            const range = TREE_HEIGHT_M[key];
            let plantHeight = range[0] + seed * (range[1] - range[0]);
            if (category === 8 || category === 9) plantHeight = 4 + seed * 4;
            if (category === 28) plantHeight = 6 + seed * 5;
            position.set(x, y + plantHeight / 2, z);
            if (!viewFrustum.containsPoint(position)) continue;
            position.y = y;
            const distance = viewPosition.distanceTo(position);
            if (distance > DRAW_DISTANCE_M) continue;
            candidates.push({
              x,
              y,
              z,
              key,
              category,
              seed,
              i,
              j,
              distance,
              plantHeight
            });
          }
        }
      }
      const sortedCandidates = yield* sortByDistance(candidates);
      const counts = {
        nearTrees: 0,
        middleTrees: 0,
        farTrees: 0,
        herbs: 0
      };
      const samples = [];
      const nearDistance = tier === 0 ? 90 : 0;
      const middleDistance = tier === 0 ? 650 : tier === 1 ? 300 : 0;
      for (const point of sortedCandidates) {
        if ((++checked & 31) === 0) yield;
        const level = point.distance < nearDistance && counts.nearTrees < LIMITS.nearTrees ? 'near' : point.distance < middleDistance && counts.middleTrees < LIMITS.middleTrees ? 'middle' : 'far';
        if (level === 'far' && counts.farTrees >= LIMITS.farTrees) continue;
        const library = libraries.get(point.key);
        const variant = Math.floor(seedAt(point.i, point.j, 2) * library.variants);
        point.variant = variant;
        const s = point.plantHeight / library.variantDimensions[variant].y;
        stageInstance(buffers, point, level, variant, s, s, s);
        counts[level === 'near' ? 'nearTrees' : level === 'middle' ? 'middleTrees' : 'farTrees']++;
        if (samples.length < 32) samples.push({
          ...point,
          level
        });
      }
      // Nearby herbs combine grass tufts and slightly longer-range ferns; both obey the same source coverage and land mask.
      const radius = 65,
        step = 3;
      const i0 = Math.floor((viewPosition.x - radius) / step),
        j0 = Math.floor((viewPosition.z - radius) / step);
      const herbs = [];
      if (grassVisible) for (let j = j0; j <= j0 + 2 * radius / step; j++) for (let i = i0; i <= i0 + 2 * radius / step; i++) {
        if ((++checked & 31) === 0) yield;
        const seed = seedAt(i, j, 7);
        const x = (i + seed) * step,
          z = (j + seedAt(i, j, 8)) * step;
        const category = data.categoryAt(x, z);
        const key = HERB_CLASSES.has(category) ? 'grass' : TREE_CLASSES.has(category) && seed > 0.7 ? 'fern' : null;
        if (!key) continue;
        const y = sampleHeight(x, z);
        if (y === null || !Number.isFinite(y)) continue;
        position.set(x, y + 0.3, z);
        const distance = viewPosition.distanceTo(position);
        if (distance > radius || !viewFrustum.containsPoint(position)) continue;
        herbs.push({
          x,
          y,
          z,
          key,
          category,
          seed,
          distance
        });
      }
      const sortedHerbs = yield* sortByDistance(herbs);
      for (const point of sortedHerbs.slice(0, LIMITS.herbs)) {
        if ((++checked & 31) === 0) yield;
        const library = libraries.get(point.key);
        const variant = Math.floor(point.seed * library.variants);
        const s = (point.key === 'grass' ? 1.1 : 1.4) + point.seed * 0.8;
        const herbLevel = tier === 0 ? 'near' : 'middle';
        stageInstance(buffers, point, herbLevel, variant, s, s, s);
        counts.herbs++;
        if (samples.length < 32) samples.push({
          ...point,
          level: herbLevel
        });
      }
      const grass = yield* groundGrass.prepareUpdate(verticalScale, tier, grassVisible, view);
      return { buffers, counts, samples, grass };
    }
    const plantColor = new THREE.Color();
    function stageInstance(buffers, point, level, variant, sx, sy, sz) {
      /* Stage matched component pools only. Reuse their scratch storage, growing lazily rather
       * than duplicating every far-tree pool at its maximum 60,000-instance capacity.
       */
      position.set(point.x, point.y - (TREE_CLASSES.has(point.category) && ['broadleaf', 'conifer'].includes(point.key) ? ROOT_EMBED_M : 0), point.z);
      quaternion.setFromAxisAngle(axis, point.seed * Math.PI * 2);
      scale.set(sx, sy, sz);
      matrix.compose(position, quaternion, scale);
      for (const pool of poolIndex.get(`${point.key}/${level}/${variant}`) ?? []) {
        let buffer = buffers.get(pool);
        if (!buffer) {
          buffer = pool.scratch ??= {
            count: 0,
            capacity: Math.min(256, pool.limit),
            matrices: new Float32Array(Math.min(256, pool.limit) * 16),
            colors: new Float32Array(Math.min(256, pool.limit) * 3)
          };
          buffer.count = 0;
          buffers.set(pool, buffer);
        }
        if (buffer.count >= pool.limit) continue;
        if (buffer.count >= buffer.capacity) {
          buffer.capacity = Math.min(pool.limit, buffer.capacity * 2);
          for (const [key, size] of [['matrices', 16], ['colors', 3]]) {
            const next = new Float32Array(buffer.capacity * size);
            next.set(buffer[key]);
            buffer[key] = next;
          }
        }
        const n = buffer.count++, tone = point.seed;
        buffer.matrices.set(matrix.elements, n * 16);
        buffer.colors[n * 3] = 0.88 + tone * 0.12;
        buffer.colors[n * 3 + 1] = 0.9 + tone * 0.1;
        buffer.colors[n * 3 + 2] = 0.84 + tone * 0.16;
      }
    }
    function commitPlacement(prepared) {
      // Keep attribute identities and upload only populated prefixes, not maximum pool capacity.
      for (const pool of pools) {
        const buffer = prepared.buffers.get(pool), mesh = pool.mesh;
        mesh.count = buffer?.count ?? 0;
        if (!mesh.count) continue;
        if (!mesh.instanceColor) {
          mesh.setColorAt(0, plantColor);
          mesh.material.needsUpdate = true;
        }
        for (const [attribute, values, size] of [
          [mesh.instanceMatrix, buffer.matrices, 16], [mesh.instanceColor, buffer.colors, 3]
        ]) {
          attribute.array.set(values.subarray(0, mesh.count * size));
          attribute.clearUpdateRanges();
          attribute.addUpdateRange(0, mesh.count * size);
          attribute.needsUpdate = true;
        }
      }
      groundGrass.commit(prepared.grass);
      state = { ...state, ...prepared.counts, sampleInstances: prepared.samples, groundCover: true };
      placementRevision++;
    }
    return {
      update,
      animate,
      hasAnimation,
      markDirty() {
        invalidation++;
        dirty = true;
      },
      setVisibility({ grass = grassVisible, trees = treesVisible }) {
        /* Toggle herbs and trees independently, preserving detail mode and seeded positions.
         * Update the existing instance pools on the next requested frame; no separate loop.
         */
        grassVisible = Boolean(grass);
        treesVisible = Boolean(trees);
        invalidation++;
        dirty = true;
      },
      setDetail(mode) {
        /*
         * Set vegetation mode to auto/high/medium/low/off and invalidate detail allocation. Point
         * positions and density stay fixed; disabling 3D plants preserves the ground-cover map.
         */
        if (!['auto', 'high', 'medium', 'low', 'off'].includes(mode)) return;
        detailMode = mode;
        invalidation++;
        dirty = true;
      },
      adjustAutomaticDetail(direction) {
        /*
         * Adjust automatic geometry tier from sustained performance: +1 lowers detail and -1
         * restores it within 0..2. Only auto mode changes; placement spacing and draw radius stay
         * fixed. Return whether the tier changed.
         */
        if (detailMode !== 'auto') return false;
        const next = Math.max(0, Math.min(2, automaticTier + direction));
        if (next === automaticTier) return false;
        automaticTier = next;
        invalidation++;
        dirty = true;
        return true;
      },
      setLighting: brightness => {
        // Distant cards contain baked directional lighting; synchronize overall day/weather brightness to avoid glowing trees at night.
        for (const pool of pools) if (pool.level === 'far') pool.mesh.material.color.setRGB(brightness, brightness, brightness);
      },
      getState: () => ({
        placementRevision,
        placementPending: Boolean(placementJob),
        placementBudgetMs: PLACEMENT_BUDGET_MS,
        lastPlacementMs,
        ...state,
        detailMode,
        automaticTier,
        grassVisible,
        treesVisible,
        treeHeightRangesM: TREE_HEIGHT_M,
        groundGrass: groundGrass.getState(),
        spacingM: BASE_SPACING_M,
        drawDistanceM: DRAW_DISTANCE_M,
        treeVariants: Object.fromEntries(['broadleaf', 'conifer'].map(key => [key, libraries.get(key).variants])),
        limits: {
          ...LIMITS
        }
      }),
      categoryAt: data.categoryAt
    };
  }
  global.NotoVegetation = {
    prepareData,
    create
  };
})(window);
