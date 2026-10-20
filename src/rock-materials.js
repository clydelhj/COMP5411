/*
 * Noto Peninsula layered rock/soil materials. This module changes surface appearance without
 * displacing vertices. Geometry, DEM boundaries and land/water classification come from the
 * geometry module.
 */
(function registerNotoRockMaterials(global) {
  'use strict';

  // Blend widths are physical distances at the surface and within the volume, not material interpolation across empty cavities.
  // HORIZONTAL_BLEND_HALF_WIDTH_M: horizontal visual transition half-width, in metres.
  const HORIZONTAL_BLEND_HALF_WIDTH_M = 192;
  // VERTICAL_BLEND_HALF_WIDTH_M: vertical visual transition half-width, in metres.
  const VERTICAL_BLEND_HALF_WIDTH_M = 9.6;

  // MAX_BOREHOLES: maximum borehole count queried by the shader.
  const MAX_BOREHOLES = 16;
  // MAX_BOREHOLE_LAYERS: maximum supported layers per borehole.
  const MAX_BOREHOLE_LAYERS = 12;
  // MARINE_PLACEHOLDER_ID: source-data category used as a marine placeholder.
  const MARINE_PLACEHOLDER_ID = 20;
  // MARINE_RENDER_ID: fallback rock category for material queries involving the marine placeholder.
  const MARINE_RENDER_ID = 10;
  // The palette supplies category IDs, names and colors. Fallbacks keep the shader interface usable
  // when the optional palette is missing; this project supplies the full palette.
  const DEFAULT_PALETTE = [{
    id: 10,
    name: 'Neutral rock fallback',
    color: '#756a56',
    family: 'rock',
    roughness: 0.95
  }];
  const VERTEX_DECLARATIONS = /* glsl */`
    varying vec3 vNotoObjectPosition;
    varying vec3 vNotoObjectNormal;
    varying vec3 vNotoViewBasisX;
    varying vec3 vNotoViewBasisY;
    varying vec3 vNotoViewBasisZ;
  `;

  // Fragment lookup order: tile elevation, normalized depth, category volume, local borehole override.
  // Texture axes are X, depth and Z. Discrete categories use nearest sampling, never numeric ID interpolation.
  // Triplanar projections accumulate PBR properties using category weights across transition bands.
  const FRAGMENT_DECLARATIONS = /* glsl */`
    uniform sampler2DArray uNotoColorTexture;
    uniform sampler2DArray uNotoDetailTexture;
    uniform float uNotoMaterialScale[__PALETTE_CAPACITY__];
    uniform sampler3D uNotoLayerIds;
    uniform sampler2D uNotoHeights;
    uniform float uNotoWidth;
    uniform float uNotoHeight;
    uniform vec2 uNotoHeightOrigin;
    uniform vec2 uNotoHeightExtent;
    uniform int uNotoCols;
    uniform int uNotoRows;
    uniform int uNotoLevels;
    uniform int uNotoHeightCols;
    uniform int uNotoHeightRows;
    uniform vec2 uNotoHeightStep;
    uniform float uNotoSurfaceMode;
    uniform vec2 uNotoBlendWidth;
    uniform vec3 uNotoPalette[__PALETTE_CAPACITY__];
    uniform float uNotoPaletteRoughness[__PALETTE_CAPACITY__];
    uniform float uNotoPaletteFamily[__PALETTE_CAPACITY__];
    uniform vec4 uNotoBoreholeCenters[__BOREHOLE_COUNT__];
    uniform vec4 uNotoBoreholeLayers[__BOREHOLE_LAYER_COUNT__];
    varying vec3 vNotoObjectPosition;
    varying vec3 vNotoObjectNormal;
    varying vec3 vNotoViewBasisX;
    varying vec3 vNotoViewBasisY;
    varying vec3 vNotoViewBasisZ;

    // Gradients must be evaluated before categorical, non-uniform control flow.
    // Explicit texture gradients preserve mip selection inside the blend loops.
    vec3 notoPositionDx;
    vec3 notoPositionDy;

    float notoHeightAt(ivec2 cell) {
      ivec2 lastCell = ivec2(uNotoHeightCols - 1, uNotoHeightRows - 1);
      return texelFetch(uNotoHeights, clamp(cell, ivec2(0), lastCell), 0).r;
    }

    // Manual triangle interpolation avoids relying on linear filtering for a
    // float height DataTexture and clamps the shortened outer source row/col.
    float notoGroundHeight(vec2 localXZ) {
      vec2 domain = uNotoHeightExtent;
      vec2 normalized = clamp(
        (localXZ - uNotoHeightOrigin) / domain,
        vec2(0.0), vec2(1.0)
      );
      // Each tile uses its own physical step and may have a shortened final
      // interval at the tile edge.  Work in metres so edge samples are not
      // stretched into an extra nominal cell.
      vec2 physical = normalized * domain;
      vec2 regularEnd = uNotoHeightStep * vec2(
        float(uNotoHeightCols - 1), float(uNotoHeightRows - 1)
      );
      vec2 lowerPhysical = min(physical, regularEnd);
      ivec2 lower = ivec2(floor(lowerPhysical / uNotoHeightStep));
      lower = min(lower, ivec2(uNotoHeightCols - 2, uNotoHeightRows - 2));
      vec2 lowerOrigin = vec2(lower) * uNotoHeightStep;
      vec2 interval = max(
        min(uNotoHeightStep, domain - lowerOrigin),
        vec2(0.0001)
      );
      vec2 amount = clamp((physical - lowerOrigin) / interval, vec2(0.0), vec2(1.0));
      float h00 = notoHeightAt(ivec2(lower.x, lower.y));
      float h10 = notoHeightAt(ivec2(lower.x + 1, lower.y));
      float h01 = notoHeightAt(ivec2(lower.x, lower.y + 1));
      float h11 = notoHeightAt(ivec2(lower.x + 1, lower.y + 1));
      if (amount.x + amount.y <= 1.0) {
        return h00 + (h10 - h00) * amount.x + (h01 - h00) * amount.y;
      }
      return h11 + (h01 - h11) * (1.0 - amount.x) + (h10 - h11) * (1.0 - amount.y);
    }

    vec2 notoHash(vec2 p) {
      return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);
    }
    float notoNoise(vec2 p) {
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(notoHash(i).x,notoHash(i+vec2(1,0)).x,f.x),
                 mix(notoHash(i+vec2(0,1)).x,notoHash(i+vec2(1,1)).x,f.x),f.y);
    }
    vec4 notoTextureTap(sampler2DArray textureSampler, vec2 uv, int layer, vec2 dx, vec2 dy, float seed, bool detail) {
      vec2 random=notoHash(vec2(seed,float(layer)+13.0));
      float angle=random.x*6.2831853, c=cos(angle), s=sin(angle);
      mat2 rotation=mat2(c,-s,s,c);
      vec4 value=textureGrad(textureSampler,vec3(rotation*uv+random*37.0,float(layer)),rotation*dx*1.25,rotation*dy*1.25);
      // Rotate tangent slopes back to the projection plane; color and detail
      // use identical stochastic coordinates and interpolation weights.
      if(detail) value.xy=((value.xy*2.0-1.0)*rotation)*0.5+0.5;
      return value;
    }
    vec4 notoTextureSample(sampler2DArray textureSampler, vec2 uv, int layer, vec2 dx, vec2 dy, bool detail) {
      float k=notoNoise(uv*0.09+float(layer)*3.7)*7.0;
      float cell=floor(k), blend=smoothstep(0.15,0.85,fract(k));
      return mix(notoTextureTap(textureSampler,uv,layer,dx,dy,cell,detail),
                 notoTextureTap(textureSampler,uv,layer,dx,dy,cell+1.0,detail),blend);
    }

    // Project textures in unscaled model coordinates so vertical exaggeration does not change physical material scale.
    vec3 notoTriplanarColor(int layer, vec3 objectPosition, vec3 objectNormal) {
      float scale = max(uNotoMaterialScale[layer], 0.001);
      vec3 p = objectPosition / scale;
      vec3 weights = max(pow(abs(normalize(objectNormal)),vec3(4.0))-0.01,vec3(0.0));
      weights /= max(weights.x + weights.y + weights.z, 0.001);
      vec3 dx = notoPositionDx / scale;
      vec3 dy = notoPositionDy / scale;
      vec3 xProjection = (weights.x > 0.0 ? notoTextureSample(uNotoColorTexture, p.yz, layer, dx.yz, dy.yz, false).rgb : vec3(0.0));
      vec3 yProjection = (weights.y > 0.0 ? notoTextureSample(uNotoColorTexture, p.xz, layer, dx.xz, dy.xz, false).rgb : vec3(0.0));
      vec3 zProjection = (weights.z > 0.0 ? notoTextureSample(uNotoColorTexture, p.xy, layer, dx.xy, dy.xy, false).rgb : vec3(0.0));
      return xProjection * weights.x + yProjection * weights.y + zProjection * weights.z;
    }

    // Rotate OpenGL tangent-space normals back into object space for each projection. The projection plane matches the color texture;
    // only axes reversed by the signed UV orientation are flipped, keeping normal details aligned with color.
    vec3 notoAxisNormal(vec3 tangentNormal, int axis, float axisSign) {
      if (axis == 0) return vec3(tangentNormal.z * axisSign, tangentNormal.x, tangentNormal.y);
      if (axis == 1) return vec3(tangentNormal.x, tangentNormal.z * axisSign, tangentNormal.y);
      return vec3(tangentNormal.x, tangentNormal.y, tangentNormal.z * axisSign);
    }

    vec4 notoTriplanarDetail(int layer, vec3 objectPosition, vec3 objectNormal) {
      float scale = max(uNotoMaterialScale[layer], 0.001);
      vec3 p = objectPosition / scale;
      vec3 normalizedNormal = normalize(objectNormal);
      vec3 weights = max(pow(abs(normalizedNormal),vec3(4.0))-0.01,vec3(0.0));
      weights /= max(weights.x + weights.y + weights.z, 0.001);
      vec3 dx = notoPositionDx / scale;
      vec3 dy = notoPositionDy / scale;
      vec4 xSample = (weights.x > 0.0 ? notoTextureSample(uNotoDetailTexture, p.yz, layer, dx.yz, dy.yz, true) : vec4(0.5,0.5,1.0,1.0));
      vec4 ySample = (weights.y > 0.0 ? notoTextureSample(uNotoDetailTexture, p.xz, layer, dx.xz, dy.xz, true) : vec4(0.5,0.5,1.0,1.0));
      vec4 zSample = (weights.z > 0.0 ? notoTextureSample(uNotoDetailTexture, p.xy, layer, dx.xy, dy.xy, true) : vec4(0.5,0.5,1.0,1.0));
      vec3 xNormal = notoAxisNormal(xSample.rgb * 2.0 - 1.0, 0, normalizedNormal.x < 0.0 ? -1.0 : 1.0);
      vec3 yNormal = notoAxisNormal(ySample.rgb * 2.0 - 1.0, 1, normalizedNormal.y < 0.0 ? -1.0 : 1.0);
      vec3 zNormal = notoAxisNormal(zSample.rgb * 2.0 - 1.0, 2, normalizedNormal.z < 0.0 ? -1.0 : 1.0);
      vec3 objectDetailNormal = normalize(xNormal * weights.x + yNormal * weights.y + zNormal * weights.z);
      float roughness = xSample.a * weights.x + ySample.a * weights.y + zSample.a * weights.z;
      return vec4(objectDetailNormal, roughness);
    }

    vec3 notoMaterialTexture(float materialId, vec3 objectPosition, vec3 objectNormal) {
      int paletteIndex = int(clamp(materialId, 0.0, __PALETTE_MAX__));
      return notoTriplanarColor(paletteIndex, objectPosition, objectNormal);
    }

    vec3 notoGeologicColor(float materialId, vec3 objectPosition, vec3 objectNormal) {
      int paletteIndex = int(clamp(materialId, 0.0, __PALETTE_MAX__));
      vec3 paletteColor = uNotoPalette[paletteIndex];
      vec3 sampled = notoMaterialTexture(materialId, objectPosition, objectNormal);
      float luminance = dot(sampled, vec3(0.299, 0.587, 0.114));
      float normalizedLuminance = clamp(luminance / 0.52, 0.72, 1.28);
      float paletteLuminance = dot(paletteColor, vec3(0.299, 0.587, 0.114));
      vec3 paletteTint = clamp(paletteColor / max(paletteLuminance, 0.001), 0.55, 1.65);
      // Texture variation provides the main surface structure; category color is a tint hint.
      vec3 result = sampled * mix(vec3(1.0), paletteTint, 0.34);
      result *= 0.82 + 0.18 * normalizedLuminance;

      // These are tonal cues only; categorical boundaries still come solely
      // from the volume and borehole intervals.
      if (materialId == 8.0 || materialId == 11.0 || materialId == 13.0 || materialId == 19.0) {
        float bedding = sin(objectPosition.y * 0.62 + objectPosition.x * 0.004 + objectPosition.z * 0.003);
        float footprint=abs(notoPositionDx.y*0.62+notoPositionDx.x*0.004+notoPositionDx.z*0.003)
                       +abs(notoPositionDy.y*0.62+notoPositionDy.x*0.004+notoPositionDy.z*0.003);
        result *= 1.0 + 0.035 * bedding * (1.0-smoothstep(0.5,2.0,footprint));
      }
      return result;
    }

    // Construct continuous weights over discrete categories without interpolating category numbers.
    // objectPosition/objectNormal: unscaled metric model coordinates and the object-space normal.
    // color/detail/paletteRoughness: base color, tangent-space normal plus roughness, and palette roughness.
    void notoSurfaceProperties(
      vec3 objectPosition, vec3 objectNormal,
      out vec3 color, out vec4 detail, out float paletteRoughness
    ) {
      float ground = notoGroundHeight(objectPosition.xz);
      float depthMeters = uNotoSurfaceMode < 0.5 ? 0.0 :
        uNotoSurfaceMode > 1.5 ? max(ground + 100.0, 0.0) :
        max(ground - objectPosition.y, 0.0);
      float columnHeight = max(ground + 100.0, 1.0);
      vec3 lastNode = vec3(float(uNotoCols - 1), float(uNotoLevels - 1), float(uNotoRows - 1));
      vec3 normalized = vec3(
        (objectPosition.x + 0.5 * uNotoWidth) / uNotoWidth,
        depthMeters / columnHeight,
        (objectPosition.z + 0.5 * uNotoHeight) / uNotoHeight
      );
      vec3 lattice = clamp(normalized, vec3(0.0), vec3(1.0)) * lastNode;
      ivec3 nearest = ivec3(floor(lattice + 0.5));
      vec3 localOffset = lattice - vec3(nearest);
      vec3 cellMeters = vec3(uNotoWidth, columnHeight, uNotoHeight) / lastNode;
      vec3 halfWidth = min(
        vec3(uNotoBlendWidth.x, uNotoBlendWidth.y, uNotoBlendWidth.x) / cellMeters,
        vec3(0.9)
      );
      halfWidth = max(halfWidth, vec3(0.00001));


      // Integrate a smooth kernel over discrete category cells. Neighbor support cannot extend beyond adjacent cells.
      // Cap the effective transition range, merge duplicate categories and sample PBR once per category.
      // A uniform 3 x 3 x 3 neighbourhood has exactly one material at every
      // blend weight. Reuse that result without repeating the categorical kernel.
      vec2 centerClass = texelFetch(uNotoLayerIds, nearest, 0).rg;
      if (centerClass.g > 0.5) {
        int id = int(clamp(floor(centerClass.r * 255.0 + 0.5), 0.0, __PALETTE_MAX__));
        color = notoGeologicColor(float(id), objectPosition, objectNormal);
        detail = notoTriplanarDetail(id, objectPosition, objectNormal);
        paletteRoughness = uNotoPaletteRoughness[id];
      } else {
        int ids[__MAX_BLEND_MATERIALS__];
        float weights[__MAX_BLEND_MATERIALS__];
        int count = 0;
        // Integrate each 1D kernel once; its three weights sum to one.
        vec3 lo = smoothstep(-halfWidth, halfWidth, vec3(-0.5) - localOffset);
        vec3 hi = smoothstep(-halfWidth, halfWidth, vec3(0.5) - localOffset);
        vec3 wx = vec3(lo.x, hi.x - lo.x, 1.0 - hi.x);
        vec3 wy = vec3(lo.y, hi.y - lo.y, 1.0 - hi.y);
        vec3 wz = vec3(lo.z, hi.z - lo.z, 1.0 - hi.z);
        for (int corner = 0; corner < 27; corner++) {
          ivec3 offset = ivec3(corner % 3 - 1, (corner / 3) % 3 - 1, corner / 9 - 1);
          float weight = wx[offset.x + 1] * wy[offset.y + 1] * wz[offset.z + 1];
          if (weight <= 0.00001) continue;
          ivec3 node = clamp(nearest + offset, ivec3(0), ivec3(lastNode));
          int id = int(floor(texelFetch(uNotoLayerIds, node, 0).r * 255.0 + 0.5));
          id = clamp(id, 0, int(__PALETTE_MAX__));
          int slot = -1;
          for (int entry = 0; entry < __MAX_BLEND_MATERIALS__; entry++) {
            if (entry >= count) break;
            if (ids[entry] == id) {
              slot = entry;
              break;
            }
          }
          if (slot < 0) {
            slot = count;
            ids[slot] = id;
            weights[slot] = 0.0;
            count++;
          }
          weights[slot] += weight;
        }

        color = vec3(0.0);
        detail = vec4(0.0);
        paletteRoughness = 0.0;
        float totalWeight = 0.0;
        for (int entry = 0; entry < __MAX_BLEND_MATERIALS__; entry++) {
          if (entry >= count) break;
          int id = ids[entry];
          float weight = weights[entry];
          color += notoGeologicColor(float(id), objectPosition, objectNormal) * weight;
          detail += notoTriplanarDetail(id, objectPosition, objectNormal) * weight;
          paletteRoughness += uNotoPaletteRoughness[id] * weight;
          totalWeight += weight;
        }
        color /= max(totalWeight, 0.00001);
        detail /= max(totalWeight, 0.00001);
        paletteRoughness /= max(totalWeight, 0.00001);
      }

      // Borehole logs keep their original category/depth records; visual boundary blending does not rewrite the classification volume.
      // Cap each transition half-width at 40% of the thinner adjacent layer to preserve thin strata.
      for (int borehole = 0; borehole < __BOREHOLE_COUNT__; borehole++) {
        vec4 center = uNotoBoreholeCenters[borehole];
        if (center.w < 0.5) continue;
        float distanceMeters = length(objectPosition.xz - center.xy);
        float radiusHalfWidth = min(uNotoBlendWidth.x, max(center.z * 0.4, 0.0001));
        if (distanceMeters >= center.z + radiusHalfWidth) continue;
        float influence = 1.0 - smoothstep(
          center.z - radiusHalfWidth, center.z + radiusHalfWidth, distanceMeters
        );
        vec3 boreholeColor = vec3(0.0);
        vec4 boreholeDetail = vec4(0.0);
        float boreholeRoughness = 0.0;
        float coverage = 0.0;
        int base = borehole * __BOREHOLE_MAX_LAYERS__;
        for (int layer = 0; layer < __BOREHOLE_MAX_LAYERS__; layer++) {
          if (float(layer) >= center.w) break;
          vec4 interval = uNotoBoreholeLayers[base + layer];
          float thickness = interval.y - interval.x;
          if (thickness <= 0.0) continue;
          float intervalHalfWidth = min(uNotoBlendWidth.y, thickness * 0.4);
          float topHalfWidth = intervalHalfWidth;
          float bottomHalfWidth = intervalHalfWidth;
          // Both sides of a contact share the same narrow transition width; thin layers do not spread through thick neighbors.
          if (layer > 0) {
            vec4 previous = uNotoBoreholeLayers[base + layer - 1];
            if (abs(previous.y - interval.x) < 0.0001 && previous.y > previous.x) {
              topHalfWidth = min(topHalfWidth, (previous.y - previous.x) * 0.4);
            }
          }
          if (float(layer + 1) < center.w) {
            vec4 next = uNotoBoreholeLayers[base + layer + 1];
            if (abs(interval.y - next.x) < 0.0001 && next.y > next.x) {
              bottomHalfWidth = min(bottomHalfWidth, (next.y - next.x) * 0.4);
            }
          }
          topHalfWidth = max(topHalfWidth, 0.0001);
          bottomHalfWidth = max(bottomHalfWidth, 0.0001);
          float topWeight = interval.x <= 0.0 ? 1.0 : smoothstep(
            interval.x - topHalfWidth, interval.x + topHalfWidth, depthMeters
          );
          float bottomWeight = 1.0 - smoothstep(
            interval.y - bottomHalfWidth, interval.y + bottomHalfWidth, depthMeters
          );
          float weight = topWeight * bottomWeight;
          if (weight <= 0.00001) continue;
          int id = int(clamp(interval.z, 0.0, __PALETTE_MAX__));
          boreholeColor += notoGeologicColor(float(id), objectPosition, objectNormal) * weight;
          boreholeDetail += notoTriplanarDetail(id, objectPosition, objectNormal) * weight;
          boreholeRoughness += uNotoPaletteRoughness[id] * weight;
          coverage += weight;
        }
        if (coverage <= 0.00001) continue;
        float blend = influence * min(coverage, 1.0);
        color = mix(color, boreholeColor / coverage, blend);
        detail = mix(detail, boreholeDetail / coverage, blend);
        paletteRoughness = mix(paletteRoughness, boreholeRoughness / coverage, blend);
      }
      float normalLength = length(detail.xyz);
      detail.xyz = normalLength > 0.00001 ? detail.xyz / normalLength : normalize(objectNormal);
    }
  `;

  // 1. Discrete category and stratigraphic data.
  function colorHex(THREE, value, fallback) {
    /* Parse a color with THREE.Color, falling back to the supplied default on failure. Returns a THREE.Color. */
    try {
      return new THREE.Color(value || fallback);
    } catch (_) {
      return new THREE.Color(fallback);
    }
  }
  function createPalette(THREE, supplied, capacity) {
    /*
     * Build color, roughness and family arrays indexed by category ID. Initialize fallbacks, apply
     * valid supplied entries within capacity, and map marine placeholder 20 to rock category 10.
     * Return {colors,roughness,family,capacity}.
     */
    const result = Array.from({
      length: capacity
    }, () => new THREE.Color('#756a56'));
    const roughness = new Float32Array(capacity).fill(0.95);
    // Family encoding: rock=0, soil=1, sand=2.
    const family = new Float32Array(capacity);
    for (const entry of DEFAULT_PALETTE) {
      if (entry.id >= 0 && entry.id < capacity) {
        result[entry.id] = colorHex(THREE, entry.color, '#756a56');
        roughness[entry.id] = Number.isFinite(entry.roughness) ? entry.roughness : 0.95;
      }
    }
    for (const entry of Array.isArray(supplied) ? supplied : []) {
      const id = Number(entry.id ?? entry.material_id);
      if (!Number.isInteger(id) || id < 0 || id >= capacity) continue;
      result[id] = colorHex(THREE, entry.color, result[id]);
      if (Number.isFinite(Number(entry.roughness))) roughness[id] = Number(entry.roughness);
      const materialFamily = String(entry.family || '').toLowerCase();
      family[id] = materialFamily === 'sand' ? 2 : materialFamily === 'soil' ? 1 : 0;
    }
    // Source category 20 is a marine placeholder; display queries use category 10's rock palette.
    // Only normalize category data here; the palette supplies material properties.
    result[MARINE_PLACEHOLDER_ID].copy(result[MARINE_RENDER_ID]);
    roughness[MARINE_PLACEHOLDER_ID] = roughness[MARINE_RENDER_ID];
    family[MARINE_PLACEHOLDER_ID] = family[MARINE_RENDER_ID];
    return {
      colors: result,
      roughness,
      family,
      capacity
    };
  }
  function paletteCapacity(data) {
    /*
     * Find category capacity from both palette entries and compressed IDs, including GSJ tags
     * absent from the CSV. Return maximum ID plus one, covering the marine placeholder.
     */
    let maxId = DEFAULT_PALETTE.reduce((highest, entry) => Math.max(highest, entry.id), MARINE_PLACEHOLDER_ID);
    for (const entry of Array.isArray(data.palette) ? data.palette : []) {
      const id = Number(entry.id ?? entry.material_id);
      if (Number.isInteger(id)) maxId = Math.max(maxId, id);
    }
    // IDs are compact Uint8 values; scanning also includes GSJ tag categories absent from the CSV.
    if (data.ids && typeof data.ids.length === 'number') {
      for (let i = 0; i < data.ids.length; i++) {
        const id = Number(data.ids[i]);
        if (Number.isFinite(id)) maxId = Math.max(maxId, id);
      }
    }
    return Math.max(1, maxId + 1);
  }
  function createLayerTexture(THREE, data) {
    /*
     * Validate cols*rows*levels against category IDs, normalize marine placeholders and create a
     * nearest-filtered Data3DTexture. Return {cols,rows,levels,layerTexture}.
     */
    const metadata = data.metadata || {};
    const cols = Math.max(2, Math.floor(metadata.cols || 2));
    const rows = Math.max(2, Math.floor(metadata.rows || 2));
    const levels = Math.max(2, Math.floor(metadata.levels || 13));
    const expected = cols * rows * levels;
    const sourceIds = data.ids instanceof Uint8Array ? data.ids : new Uint8Array(data.ids || []);
    if (sourceIds.length !== expected) {
      throw new Error(`Layer volume mismatch: received ${sourceIds.length} IDs, expected ${expected} (${cols} × ${levels} × ${rows})`);
    }
    const ids = new Uint8Array(sourceIds);
    for (let index = 0; index < ids.length; index++) {
      if (ids[index] === MARINE_PLACEHOLDER_ID) ids[index] = MARINE_RENDER_ID;
    }
    // R stores the unchanged categorical ID; G certifies a homogeneous kernel.
    // Clamped edge neighbours match the shader's exact boundary convention.
    const packed = new Uint8Array(expected * 2);
    const seen = new Uint32Array(256);
    let maxBlendMaterials = 1;
    for (let z = 0; z < rows; z++) for (let y = 0; y < levels; y++) for (let x = 0; x < cols; x++) {
      const index = (z * levels + y) * cols + x;
      const id = ids[index];
      const stamp = index + 1;
      let unique = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const nz = Math.max(0, Math.min(rows - 1, z + dz));
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.max(0, Math.min(levels - 1, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.max(0, Math.min(cols - 1, x + dx));
            const neighbour = ids[(nz * levels + ny) * cols + nx];
            if (seen[neighbour] !== stamp) {
              seen[neighbour] = stamp;
              unique++;
            }
          }
        }
      }
      maxBlendMaterials = Math.max(maxBlendMaterials, unique);
      packed[index * 2] = id;
      packed[index * 2 + 1] = unique === 1 ? 255 : 0;
    }
    const layerTexture = new THREE.Data3DTexture(packed, cols, levels, rows);
    layerTexture.format = THREE.RGFormat;
    layerTexture.type = THREE.UnsignedByteType;
    layerTexture.minFilter = THREE.NearestFilter;
    layerTexture.magFilter = THREE.NearestFilter;
    layerTexture.wrapS = THREE.ClampToEdgeWrapping;
    layerTexture.wrapT = THREE.ClampToEdgeWrapping;
    layerTexture.wrapR = THREE.ClampToEdgeWrapping;
    layerTexture.generateMipmaps = false;
    layerTexture.unpackAlignment = 1;
    layerTexture.needsUpdate = true;
    return {
      cols,
      rows,
      levels,
      maxBlendMaterials,
      layerTexture
    };
  }
  function pairValue(value, fallbackX, fallbackY) {
    /*
     * Normalize scalar or two-component pixel spacing. Preserve valid signed values and use
     * per-axis fallbacks for invalid entries. Return [x,y].
     */
    if (Array.isArray(value)) {
      return [Number(value[0]) || fallbackX, Number(value[1]) || fallbackY];
    }
    if (Number.isFinite(Number(value))) {
      const number = Number(value);
      return [number, number];
    }
    return [fallbackX, fallbackY];
  }
  function createTileHeightTexture(THREE, heights, tileMetadata, globalMetadata) {
    /*
     * Build a tile elevation texture for depth queries. Validate row-major heights, resolve
     * origin/extent/spacing and create a floating-point DataTexture. Return the texture and
     * metadata for manual triangle interpolation in GLSL.
     */
    const tile = tileMetadata || {};
    const cols = Math.max(2, Math.floor(Number(tile.sample_cols)));
    const rows = Math.max(2, Math.floor(Number(tile.sample_rows)));
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      throw new Error('Tile metadata requires sample_cols and sample_rows');
    }
    const sourceHeights = heights instanceof Float32Array ? heights : new Float32Array(heights || []);
    const expectedHeightValues = cols * rows;
    if (sourceHeights.length !== expectedHeightValues) {
      throw new Error(`Tile height mismatch: received ${sourceHeights.length} values, expected ${expectedHeightValues} (${cols} × ${rows})`);
    }
    const origin = pairValue(tile.heightOrigin, 0, 0);
    const fallbackExtent = [Math.max(0.001, Number(tile.step) || 25) * (cols - 1), Math.max(0.001, Number(tile.step) || 25) * (rows - 1)];
    const extent = pairValue(tile.heightExtent, fallbackExtent[0], fallbackExtent[1]);
    if (!(extent[0] > 0 && extent[1] > 0)) throw new Error('Tile heightExtent must be positive');
    const globalSpacing = globalMetadata && (globalMetadata.display_spacing_m || globalMetadata.source_spacing_m);
    const sourceSpacing = pairValue(tile.source_spacing_m, 0, 0);
    // A scalar step is measured in source pixels; a two-component step directly specifies metres.
    const step = Array.isArray(tile.step) ? pairValue(tile.step, 0, 0) : [Number(tile.step || 1) * sourceSpacing[0], Number(tile.step || 1) * sourceSpacing[1]];
    const fallbackSpacing = pairValue(globalSpacing, extent[0] / (cols - 1), extent[1] / (rows - 1));
    const stepX = step[0] > 0 ? step[0] : sourceSpacing[0] > 0 ? sourceSpacing[0] : fallbackSpacing[0];
    const stepZ = step[1] > 0 ? step[1] : sourceSpacing[1] > 0 ? sourceSpacing[1] : fallbackSpacing[1];
    if (!(stepX > 0 && stepZ > 0)) throw new Error('Tile metadata requires a positive step or source_spacing_m');
    const heightTexture = new THREE.DataTexture(sourceHeights, cols, rows, THREE.RedFormat, THREE.FloatType);
    heightTexture.minFilter = THREE.NearestFilter;
    heightTexture.magFilter = THREE.NearestFilter;
    heightTexture.wrapS = THREE.ClampToEdgeWrapping;
    heightTexture.wrapT = THREE.ClampToEdgeWrapping;
    heightTexture.generateMipmaps = false;
    heightTexture.flipY = false;
    heightTexture.unpackAlignment = 1;
    heightTexture.needsUpdate = true;
    return {
      heightTexture,
      heightCols: cols,
      heightRows: rows,
      heightOriginX: origin[0],
      heightOriginZ: origin[1],
      heightExtentX: extent[0],
      heightExtentZ: extent[1],
      heightStepX: stepX,
      heightStepZ: stepZ
    };
  }
  function createHeightTexture(THREE, heights, tileMetadata, globalMetadata) {
    /*
     * Create tile height state through the shared height-texture helper. Inputs are THREE,
     * row-major heights, tile metadata and global metadata; returns the texture and sampling state.
     */
    return createTileHeightTexture(THREE, heights, tileMetadata, globalMetadata);
  }
  function createBoreholeUniforms(THREE, boreholes) {
    /*
     * Pack borehole centres, radii and depth intervals into shader arrays. Cap borehole/layer
     * counts at uniform limits and normalize marine placeholder IDs. Return the borehole uniform
     * bundle.
     */
    const source = Array.isArray(boreholes) ? boreholes.slice(0, MAX_BOREHOLES) : [];
    const boreholeCount = Math.max(1, source.length);
    const maxLayers = Math.max(1, Math.min(MAX_BOREHOLE_LAYERS, source.reduce((highest, borehole) => Math.max(highest, Array.isArray(borehole && borehole.layers) ? borehole.layers.length : 0), 0)));
    const centers = Array.from({
      length: boreholeCount
    }, () => new THREE.Vector4(0, 0, 0, 0));
    const layers = Array.from({
      length: boreholeCount * maxLayers
    }, () => new THREE.Vector4(0, 0, 0, 0));
    for (let i = 0; i < source.length; i++) {
      const borehole = source[i] || {};
      const layerList = Array.isArray(borehole.layers) ? borehole.layers : [];
      const count = Math.min(maxLayers, layerList.length);
      centers[i].set(Number(borehole.x) || 0, Number(borehole.z) || 0, Math.max(0, Number(borehole.radius) || 750), count);
      for (let j = 0; j < count; j++) {
        const layer = layerList[j] || {};
        let id = Number(layer.id);
        if (!Number.isFinite(id)) id = 0;
        if (id === MARINE_PLACEHOLDER_ID) id = MARINE_RENDER_ID;
        layers[i * maxLayers + j].set(Math.max(0, Number(layer.top) || 0), Math.max(0, Number(layer.bottom) || 0), id, 1);
      }
    }
    return {
      centers,
      layers,
      boreholeCount,
      maxLayers,
      layerCount: boreholeCount * maxLayers
    };
  }

  // 2. Shared texture arrays and surface materials.
  async function loadTextures(THREE, textureSources) {
    /*
     * Reuse preloaded color/detail DataArrayTextures and physical texture scales, or load them from
     * the supplied/global configuration. Return Promise<{color,detail,scales}>.
     */
    const source = textureSources || global.NOTO_MATERIAL_CONFIG;
    if (source && source.color && source.detail && source.scales) return source;
    if (!global.NotoMaterialTextures || typeof global.NotoMaterialTextures.load !== 'function') {
      throw new Error('Noto material texture loader is unavailable; include src/material-textures.js before src/rock-materials.js');
    }
    return global.NotoMaterialTextures.load(THREE, source);
  }
  function materialShader(THREE, shared, tile, mode) {
    /*
     * Create a MeshStandardMaterial for top (0), cut (1) or bottom (2). Inject classification,
     * borehole and height lookup; merge category weights; accumulate triplanar color, normals and
     * roughness; transform the blended normal into view space.
     */
    const palette = shared.palette;
    const borehole = shared.borehole;
    const fragmentDeclarations = FRAGMENT_DECLARATIONS.replaceAll('__MAX_BLEND_MATERIALS__', String(shared.maxBlendMaterials)).replaceAll('__PALETTE_CAPACITY__', String(palette.capacity)).replaceAll('__PALETTE_MAX__', `${Math.max(0, palette.capacity - 1)}.0`).replaceAll('__BOREHOLE_COUNT__', String(borehole.boreholeCount)).replaceAll('__BOREHOLE_LAYER_COUNT__', String(borehole.layerCount)).replaceAll('__BOREHOLE_MAX_LAYERS__', String(borehole.maxLayers));
    const uniforms = {
      uNotoColorTexture: {
        value: shared.textureSet.color
      },
      uNotoDetailTexture: {
        value: shared.textureSet.detail
      },
      uNotoMaterialScale: {
        value: Array.from(shared.textureScales)
      },
      uNotoLayerIds: {
        value: shared.layerTexture
      },
      uNotoHeights: {
        value: tile.heightTexture
      },
      uNotoWidth: {
        value: shared.width
      },
      uNotoHeight: {
        value: shared.height
      },
      uNotoHeightOrigin: {
        value: {
          x: tile.heightOriginX,
          y: tile.heightOriginZ
        }
      },
      uNotoHeightExtent: {
        value: {
          x: tile.heightExtentX,
          y: tile.heightExtentZ
        }
      },
      uNotoCols: {
        value: shared.cols
      },
      uNotoRows: {
        value: shared.rows
      },
      uNotoLevels: {
        value: shared.levels
      },
      uNotoHeightCols: {
        value: tile.heightCols
      },
      uNotoHeightRows: {
        value: tile.heightRows
      },
      uNotoHeightStep: {
        value: {
          x: tile.heightStepX,
          y: tile.heightStepZ
        }
      },
      uNotoSurfaceMode: {
        value: mode
      },
      uNotoBlendWidth: {
        value: new THREE.Vector2(HORIZONTAL_BLEND_HALF_WIDTH_M, VERTICAL_BLEND_HALF_WIDTH_M)
      },
      uNotoPalette: {
        value: palette.colors
      },
      uNotoPaletteRoughness: {
        value: Array.from(palette.roughness)
      },
      uNotoPaletteFamily: {
        value: Array.from(palette.family)
      },
      uNotoBoreholeCenters: {
        value: borehole.centers
      },
      uNotoBoreholeLayers: {
        value: borehole.layers
      }
    };
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide
    });
    material.userData = material.userData || {};
    material.userData.notoShared = shared;
    material.userData.notoTile = tile;
    material.name = mode === 0 ? 'Noto strata top' : mode === 1 ? 'Noto strata cut' : 'Noto strata bottom';
    material.customProgramCacheKey = () => `noto-strata-v9-grass-${mode}-${shared.maxBlendMaterials}-${palette.capacity}-${borehole.boreholeCount}-${borehole.maxLayers}-${Boolean(shared.groundCover)}-${Boolean(shared.grass)}`;
    material.onBeforeCompile = shader => {
      /*
       * Inject uniforms and rock-material chunks into a Three.js standard shader. Pass unscaled
       * object coordinates and the normal transform, preserve standard lighting, and retain the
       * compiled shader reference. Mutates shader in place.
       */
      // normalMatrix includes nonuniform scaling: do not normalize its columns separately. Apply faceDirection for double-sided normals.
      // Color arrays already use an sRGB internal format; do not repeat sRGB-to-linear conversion in the shader.
      Object.assign(shader.uniforms, uniforms);
      if (mode === 0 && shared.groundCover) {
        shader.uniforms.uNotoGroundCover = {
          value: shared.groundCover
        };
        shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'uniform sampler2D uNotoGroundCover;\nvoid main() {');
      }
      if (mode === 0 && shared.grass) {
        shader.uniforms.uGrassVisibility = shared.grassVisibility ?? { value: 1 };
        shader.uniforms.uGrassMask = { value: shared.grass.mask };
        shader.uniforms.uGrassColor = { value: shared.grass.color };
        shader.uniforms.uGrassNormal = { value: shared.grass.normal };
        shader.fragmentShader = shader.fragmentShader.replace('void main() {',
          'uniform float uGrassVisibility;\nuniform sampler2D uGrassMask;\nuniform sampler2D uGrassColor;\nuniform sampler2D uGrassNormal;\nvoid main() {');
      }
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n  vNotoObjectPosition = position;\n  vNotoObjectNormal = normalize( normal );\n  vNotoViewBasisX = normalMatrix * vec3( 1.0, 0.0, 0.0 );\n  vNotoViewBasisY = normalMatrix * vec3( 0.0, 1.0, 0.0 );\n  vNotoViewBasisZ = normalMatrix * vec3( 0.0, 0.0, 1.0 );`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${fragmentDeclarations}`);
      const colorCode = /* glsl */`
        vec3 notoSurfaceColor;
        vec4 notoSurfaceDetail;
        float notoSurfaceRoughness;
        notoPositionDx = dFdx(vNotoObjectPosition);
        notoPositionDy = dFdy(vNotoObjectPosition);
        notoSurfaceProperties(
          vNotoObjectPosition, vNotoObjectNormal,
          notoSurfaceColor, notoSurfaceDetail, notoSurfaceRoughness
        );
        diffuseColor.rgb *= notoSurfaceColor;
        ${mode === 0 && shared.groundCover ? `
          // Smooth only visual coverage attributes; use unexaggerated continuous vertex normals to expose steep slopes.
          vec2 coverUV = vec2(
            (vNotoObjectPosition.x + 0.5 * uNotoWidth) / uNotoWidth,
            (vNotoObjectPosition.z + 0.5 * uNotoHeight) / uNotoHeight
          );
          vec4 cover = texture2D(uNotoGroundCover, coverUV);
          // Broad aperiodic variation avoids the checker/sine beat pattern at grazing angles.
          float grain = 0.86 + 0.18*notoNoise(vNotoObjectPosition.xz/170.0)
            + 0.06*notoNoise(vNotoObjectPosition.xz/43.0);
          vec3 faceNormal = normalize(vNotoObjectNormal);
          // Fade cover across original slopes of 35 to 60 degrees; vertical exaggeration does not change rock-exposure rules.
          float slopeCoverage = smoothstep(0.5, 0.819152, abs(faceNormal.y));
          diffuseColor.rgb = mix(diffuseColor.rgb, cover.rgb * grain * clamp(dot(notoSurfaceColor,vec3(0.299,0.587,0.114))*2.0,0.65,1.25), cover.a * slopeCoverage ${shared.grass ? '* uGrassVisibility' : ''});
          ${shared.grass ? `
            // Grass covers only land tops; explicit gradients and mipmaps stabilize minification at grazing views.
            float grassCoverage = uGrassVisibility * texture2D(uGrassMask, coverUV).r * slopeCoverage
              * smoothstep(1.5, 3.0, vNotoObjectPosition.y);
            if (grassCoverage > 0.001) {
            vec2 grassUV = vNotoObjectPosition.xz / 3.5;
            vec2 grassDx = notoPositionDx.xz / 3.5, grassDy = notoPositionDy.xz / 3.5;
            float grassNoise = notoNoise(vNotoObjectPosition.xz / 29.0) * 7.0;
            float grassCell = floor(grassNoise), grassBlend = smoothstep(0.1, 0.9, fract(grassNoise));
            vec2 grassA = vec2(sin(grassCell * 12.7), cos(grassCell * 9.3)) * 37.0;
            vec2 grassB = vec2(sin((grassCell+1.0) * 12.7), cos((grassCell+1.0) * 9.3)) * 37.0;
            vec3 grassColor = mix(textureGrad(uGrassColor, grassUV + grassA, grassDx, grassDy).rgb,
              textureGrad(uGrassColor, grassUV + grassB, grassDx, grassDy).rgb, grassBlend);
            vec3 grassNormal = mix(textureGrad(uGrassNormal, grassUV + grassA, grassDx, grassDy).rgb,
              textureGrad(uGrassNormal, grassUV + grassB, grassDx, grassDy).rgb, grassBlend) * 2.0 - 1.0;
            grassCoverage *= 0.83 + 0.17 * notoNoise(vNotoObjectPosition.xz / 13.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, grassColor * vec3(0.84, 1.12, 0.78) * grain, grassCoverage);
            notoSurfaceDetail.xyz = normalize(mix(notoSurfaceDetail.xyz,
              normalize(faceNormal + vec3(grassNormal.x, 0.0, grassNormal.y) * 0.28), grassCoverage));
            notoSurfaceRoughness = mix(notoSurfaceRoughness, 0.95, grassCoverage);
            notoSurfaceDetail.w = mix(notoSurfaceDetail.w, 0.95, grassCoverage);
            }
          ` : ''}
        ` : ''}

      `;
      if (shader.fragmentShader.includes('#include <color_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${colorCode}`);
      } else {
        shader.fragmentShader = shader.fragmentShader.replace('void main() {', `void main() {\n${colorCode}`);
      }
      const normalCode = /* glsl */`
        vec3 notoDetailViewNormal = normalize(
          vNotoViewBasisX * notoSurfaceDetail.x +
          vNotoViewBasisY * notoSurfaceDetail.y +
          vNotoViewBasisZ * notoSurfaceDetail.z
        ) * faceDirection;
        float pixelFootprint=max(length(notoPositionDx),length(notoPositionDy));
        float resolvedDetail=1.0-smoothstep(2.0,16.0,pixelFootprint);
        normal = normalize(mix(normal, notoDetailViewNormal, 0.55*resolvedDetail));
      `;
      if (shader.fragmentShader.includes('#include <normal_fragment_begin>')) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${normalCode}`);
      }
      const roughnessCode = /* glsl */`
        roughnessFactor = clamp(mix(notoSurfaceRoughness, notoSurfaceDetail.a, 0.72), 0.35, 1.0);
      `;
      if (shader.fragmentShader.includes('#include <roughnessmap_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${roughnessCode}`);
      }
      // Receiver-plane depth change across a shadow texel prevents a sloping
      // terrain triangle from shadowing itself. Evaluate derivatives before
      // light visibility branches; detailed texture normals do not affect bias.
      const shadowSlope = /* glsl */`
        #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
          float notoShadowSlopeBias[NUM_DIR_LIGHT_SHADOWS];
          #pragma unroll_loop_start
          for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
            vec3 q = vDirectionalShadowCoord[i].xyz / vDirectionalShadowCoord[i].w;
            vec3 sx = dFdx(q), sy = dFdy(q);
            float determinant = sx.x*sy.y-sx.y*sy.x;
            vec2 gradient = vec2(sy.y*sx.z-sx.y*sy.z,sx.x*sy.z-sy.x*sx.z)
              / (abs(determinant)>1e-16 ? determinant : 1e-16);
            notoShadowSlopeBias[i] = clamp(dot(abs(gradient),
              1.0/directionalLightShadows[i].shadowMapSize)*1.5,0.0,0.0003);
          }
          #pragma unroll_loop_end
        #endif
      `;
      shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() {\n' + shadowSlope);
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('directionalLightShadow.shadowBias,', '(directionalLightShadow.shadowBias - notoShadowSlopeBias[i]),'));
      if (mode === 0 && shared.waterMotion) shared.waterMotion.decorateLand(shader);
      material.userData.notoShader = shader;
    };
    material.userData.notoMaterialMode = mode;
    material.userData.notoTextureScales = shared.textureScales;
    return material;
  }
  async function prepare(THREE, data, textures, groundCover = null) {
    /*
     * Prepare shared stratigraphic resources and return an asynchronous per-tile material factory.
     * Validate dimensions, create classification/palette/borehole resources, load texture arrays
     * and optionally use real vegetation ground cover. Returns createTile, dispose and shared
     * state.
     */
    if (!THREE || !data) throw new Error('NotoRockMaterials.prepare requires THREE and layer data');
    const metadata = data.metadata || {};
    const sharedLayer = createLayerTexture(THREE, data);
    const shared = {
      layerTexture: sharedLayer.layerTexture,
      cols: sharedLayer.cols,
      rows: sharedLayer.rows,
      levels: sharedLayer.levels,
      maxBlendMaterials: sharedLayer.maxBlendMaterials,
      width: Number(metadata.width_m),
      height: Number(metadata.height_m),
      groundCover,
      textureSet: null,
      textureScales: null,
      palette: null,
      borehole: null,
      disposed: false
    };
    if (!(shared.width > 0 && shared.height > 0)) {
      shared.layerTexture.dispose();
      throw new Error('Layer metadata requires positive global width_m and height_m');
    }
    try {
      shared.textureSet = await loadTextures(THREE, textures);
      const scaleSource = shared.textureSet.scales;
      shared.textureScales = new Float32Array(paletteCapacity(data));
      shared.textureScales.fill(12);
      if (scaleSource && typeof scaleSource.length === 'number') {
        shared.textureScales.set(Array.from(scaleSource).slice(0, shared.textureScales.length));
      }
      shared.palette = createPalette(THREE, data.palette, paletteCapacity(data));
      shared.borehole = createBoreholeUniforms(THREE, data.boreholes);
    } catch (error) {
      shared.layerTexture.dispose();
      throw error;
    }
    async function createTile(heights, tileMetadata) {
      /*
       * Create a tile-owned height texture and top/cut/bottom materials using shared resources.
       * Return Promise<{top,cut,bottom,dispose}> with an idempotent cleanup function.
       */
      if (shared.disposed) throw new Error('NotoRockMaterials factory has been disposed');
      const tile = createHeightTexture(THREE, heights, tileMetadata, metadata);
      const materials = {
        top: materialShader(THREE, shared, tile, 0),
        cut: materialShader(THREE, shared, tile, 1),
        bottom: materialShader(THREE, shared, tile, 2)
      };
      let disposed = false;
      // Release only tile-owned resources here; the factory owns shared textures and category data.
      materials.dispose = () => {
        if (disposed) return;
        disposed = true;
        materials.top.dispose();
        materials.cut.dispose();
        materials.bottom.dispose();
        tile.heightTexture.dispose();
      };
      return materials;
    }
    const factory = {
      createTile,
      // Release shared resources after all tiles stop using them. Repeated disposal is harmless.
      dispose() {
        if (shared.disposed) return;
        shared.disposed = true;
        shared.layerTexture.dispose();
        if (shared.textureSet.color) shared.textureSet.color.dispose();
        if (shared.textureSet.detail) shared.textureSet.detail.dispose();
      },
      shared
    };
    return factory;
  }

  // 3. Single-grid compatibility interface.
  async function create(THREE, data, textures, heights, metadata) {
    /*
     * Adapt a single full-region grid to the tiled material factory. Merge metadata, prepare shared
     * resources and call createTile with one synthetic tile. Return the same material bundle as the
     * tiled API.
     */
    const mergedData = Object.assign({}, data, {
      metadata: Object.assign({}, data && data.metadata || {}, metadata || {})
    });
    const factory = await prepare(THREE, mergedData, textures);
    const globalWidth = Number(mergedData.metadata.width_m);
    const globalHeight = Number(mergedData.metadata.height_m);
    const heightMetadata = metadata || mergedData.metadata;
    const tileMetadata = {
      sample_cols: heightMetadata.sample_cols || heightMetadata.cols,
      sample_rows: heightMetadata.sample_rows || heightMetadata.rows,
      step: heightMetadata.display_spacing_m || heightMetadata.source_spacing_m,
      source_spacing_m: heightMetadata.source_spacing_m || heightMetadata.display_spacing_m,
      heightOrigin: [-globalWidth / 2, -globalHeight / 2],
      heightExtent: [globalWidth, globalHeight]
    };
    return factory.createTile(heights, tileMetadata);
  }
  global.NotoRockMaterials = {
    prepare,
    create
  };
})(window);
