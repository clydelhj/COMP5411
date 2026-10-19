// Closed terrain geometry with a fixed bottom elevation.
// Coordinates are metres: x east, y up, z south. The parent object applies vertical exaggeration.
window.NotoVolume = (() => {
  // BASE_ELEVATION: physical model-base elevation, in metres.
  const BASE_ELEVATION = -100;
  function makeGeometry(THREE, positions, indices) {
    /* Create a Three.js BufferGeometry with normals and a bounding sphere.
Parameters: THREE is the namespace; positions is a flat XYZ array in metres; indices optionally supplies triangle indices.
Assign attributes, compute vertex normals and bounds, and return the geometry. */

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (indices) geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  // Boundary normals are averaged only from the normals computed at build
  // time.  Keeping that snapshot prevents a second synchronization pass from
  // averaging already-averaged values and makes repeated LOD updates stable.
  function synchronizeNormals(results) {
    /* Synchronize top-surface normals across tile boundaries in world coordinates.
Parameter: results contains geometry results with optional land.top boundary-normal caches.
Average the original cached normals at coincident boundary vertices, normalize and write back. Returns undefined. */

    const groups = new Map();
    const entries = [];
    const epsilon = 1e-4;
    for (const result of Array.isArray(results) ? results : []) {
      const geometry = result?.land?.top;
      if (!geometry?.attributes?.position || !geometry?.attributes?.normal) continue;
      const positions = geometry.attributes.position.array;
      const normals = geometry.attributes.normal.array;
      if (!geometry.userData) geometry.userData = {};
      const bounds = geometry.userData.notoBoundaryBounds;
      if (!bounds) continue;
      let indices = geometry.userData.notoBoundaryVertexIndices;
      let original = geometry.userData.notoOriginalBoundaryNormals;
      if (!indices || !original || original.length !== indices.length * 3) {
        const found = [];
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i],
            z = positions[i + 2];
          if (Math.abs(x - bounds.minX) <= epsilon || Math.abs(x - bounds.maxX) <= epsilon || Math.abs(z - bounds.minZ) <= epsilon || Math.abs(z - bounds.maxZ) <= epsilon) {
            found.push(i / 3);
          }
        }
        indices = Uint32Array.from(found);
        original = new Float32Array(indices.length * 3);
        for (let i = 0; i < indices.length; i++) {
          original.set(normals.slice(indices[i] * 3, indices[i] * 3 + 3), i * 3);
        }
        geometry.userData.notoBoundaryVertexIndices = indices;
        geometry.userData.notoOriginalBoundaryNormals = original;
      }
      for (let i = 0; i < indices.length; i++) {
        const vertex = indices[i];
        const offset = vertex * 3;
        const key = `${Math.round(positions[offset] / epsilon)}:${Math.round(positions[offset + 1] / epsilon)}:${Math.round(positions[offset + 2] / epsilon)}`;
        let group = groups.get(key);
        if (!group) {
          group = [];
          groups.set(key, group);
        }
        group.push({
          normals,
          original,
          index: vertex,
          originalIndex: i
        });
      }
      entries.push({
        geometry
      });
    }
    for (const group of groups.values()) {
      let nx = 0,
        ny = 0,
        nz = 0;
      for (const item of group) {
        const offset = item.originalIndex * 3;
        nx += item.original[offset];
        ny += item.original[offset + 1];
        nz += item.original[offset + 2];
      }
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      for (const item of group) {
        const offset = item.index * 3;
        item.normals[offset] = nx;
        item.normals[offset + 1] = ny;
        item.normals[offset + 2] = nz;
      }
    }
    for (const entry of entries) entry.geometry.attributes.normal.needsUpdate = true;
  }

  // Each top cell contributes a bottom face. Only exposed edges receive walls.
  // Separate wall vertices keep the vertical cut faces sharp under lighting.
  function closeSurface(THREE, topPositions, topIndices, validCells, rows, cols, adjacentSurface = null) {
    /* Build a closed top, bottom and exposed walls for valid surface cells.
Parameters: THREE is the namespace; topPositions is flat XYZ in metres; topIndices contains triangle indices; validCells is a row-major mask of (rows-1)*(cols-1) cells; rows map to Z and cols to X; adjacentSurface optionally supplies boundary elevations and clipping data.
Build the bottom and exposed walls, inserting shared sea-level intersections.
Returns geometries, edge counts and elevation statistics. */

    const cellCount = Math.max(0, (rows - 1) * (cols - 1));
    let fullMask = validCells && validCells.length === cellCount;
    if (fullMask) {
      for (let i = 0; i < cellCount; i++) {
        if (!validCells[i]) {
          fullMask = false;
          break;
        }
      }
    }
    // A complete tile has one rectangular bottom.  A perimeter fan retains
    // every boundary node needed by the cut walls while avoiding a dense
    // duplicate quad grid below the terrain.  The 2×2 case is exactly one
    // quad and therefore uses four corners and two triangles.
    let compactBottomPositions = null;
    let compactBottomIndices = null;
    if (fullMask && adjacentSurface?.compactBottom !== false) {
      const last = (rows - 1) * cols;
      const perimeter = [];
      for (let col = 0; col < cols; col++) perimeter.push(col);
      for (let row = 1; row < rows; row++) perimeter.push(row * cols + cols - 1);
      for (let col = cols - 2; col >= 0; col--) perimeter.push(last + col);
      for (let row = rows - 2; row >= 1; row--) perimeter.push(row * cols);
      if (perimeter.length === 4) {
        compactBottomPositions = new Float32Array(12);
        for (let i = 0; i < perimeter.length; i++) {
          const source = perimeter[i];
          compactBottomPositions[i * 3] = topPositions[source * 3];
          compactBottomPositions[i * 3 + 1] = BASE_ELEVATION;
          compactBottomPositions[i * 3 + 2] = topPositions[source * 3 + 2];
        }
        compactBottomIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);
      } else {
        const count = perimeter.length;
        compactBottomPositions = new Float32Array((count + 1) * 3);
        let cx = 0,
          cz = 0;
        for (const source of perimeter) {
          cx += topPositions[source * 3];
          cz += topPositions[source * 3 + 2];
        }
        compactBottomPositions[0] = cx / count;
        compactBottomPositions[1] = BASE_ELEVATION;
        compactBottomPositions[2] = cz / count;
        for (let i = 0; i < count; i++) {
          const source = perimeter[i];
          compactBottomPositions[(i + 1) * 3] = topPositions[source * 3];
          compactBottomPositions[(i + 1) * 3 + 1] = BASE_ELEVATION;
          compactBottomPositions[(i + 1) * 3 + 2] = topPositions[source * 3 + 2];
        }
        compactBottomIndices = new Uint32Array(count * 3);
        for (let i = 0; i < count; i++) {
          compactBottomIndices[i * 3] = 0;
          compactBottomIndices[i * 3 + 1] = i + 1;
          compactBottomIndices[i * 3 + 2] = 1 + (i + 1) % count;
        }
      }
    }
    let bottomPositions = null;
    let bottomIndices = null;
    if (!compactBottomPositions) {
      bottomPositions = topPositions.slice();
      for (let i = 1; i < bottomPositions.length; i += 3) {
        bottomPositions[i] = BASE_ELEVATION;
      }
      bottomIndices = topIndices.slice();
      for (let i = 0; i < bottomIndices.length; i += 3) {
        [bottomIndices[i + 1], bottomIndices[i + 2]] = [bottomIndices[i + 2], bottomIndices[i + 1]];
      }
    }
    const walls = [];
    const topCuts = new Map();
    const vertexCount = topPositions.length / 3;
    let boundaryEdges = 0;
    // Clip wall polygons at sea level so adjacent water and rock edges share vertices.
    function clipAtSea(polygon, above) {
      /* Clip an ordered XYZ polygon against sea level.
Parameters: polygon contains points in metres; above=true keeps y>=0, otherwise y<=0.
Retain points in the chosen half-space and linearly interpolate crossing edges.
Returns clipped points; the caller ignores polygons with fewer than three vertices. */

      const output = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i],
          b = polygon[(i + 1) % polygon.length];
        const inA = above ? a[1] >= 0 : a[1] <= 0;
        const inB = above ? b[1] >= 0 : b[1] <= 0;
        if (inA) output.push(a);
        if (inA !== inB) {
          const forward = a[0] < b[0] || a[0] === b[0] && a[2] < b[2];
          const p = forward ? a : b,
            q = forward ? b : a;
          const t = -p[1] / (q[1] - p[1]);
          output.push([p[0] + (q[0] - p[0]) * t, 0, p[2] + (q[2] - p[2]) * t]);
        }
      }
      return output;
    }
    function triangulate(polygon, cornerLevels) {
      /* Clean a wall polygon and append nondegenerate triangles.
Parameters: polygon contains XYZ points in metres; cornerLevels supplies endpoint x/z and shared elevation levels.
Remove consecutive duplicates, insert shared levels along vertical edges and triangulate around an interior centre. Updates walls in place. */

      const clean = polygon.filter((p, i) => {
        const previous = polygon[(i + polygon.length - 1) % polygon.length];
        return p.some((value, axis) => value !== previous[axis]);
      });
      if (clean.length < 3) return;
      const boundary = [];
      for (let i = 0; i < clean.length; i++) {
        const a = clean[i],
          b = clean[(i + 1) % clean.length];
        boundary.push(a);
        if (a[0] === b[0] && a[2] === b[2] && a[1] !== b[1]) {
          const corner = cornerLevels.find(p => p.x === a[0] && p.z === a[2]);
          const levels = [...new Set(corner?.levels || [])].filter(y => y > Math.min(a[1], b[1]) && y < Math.max(a[1], b[1])).sort((x, y) => b[1] > a[1] ? x - y : y - x);
          for (const y of levels) boundary.push([a[0], y, a[2]]);
        }
      }
      // An interior fan preserves collinear boundary vertices, unlike a corner fan.
      const center = [0, 0, 0];
      for (const p of boundary) for (let k = 0; k < 3; k++) center[k] += p[k] / boundary.length;
      for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i],
          b = boundary[(i + 1) % boundary.length];
        const u = a.map((v, k) => v - center[k]),
          v = b.map((x, k) => x - center[k]);
        const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        if (area > 1e-8) walls.push(...center, ...a, ...b);
      }
    }
    function addWall(a, b, neighborR, neighborC) {
      /* Build a wall along an edge not covered by a valid cell of the same type.
Parameters: a/b are endpoint indices; neighborR/neighborC identify the adjacent cell and may lie outside this tile.
Read the adjacent elevation, suppress internal walls, and clip land/water boundaries at sea level. Updates wall vertices and intersection records in place. */

      let ax = topPositions[a * 3],
        ay = topPositions[a * 3 + 1],
        az = topPositions[a * 3 + 2];
      let bx = topPositions[b * 3],
        by = topPositions[b * 3 + 1],
        bz = topPositions[b * 3 + 2];
      let lowerA = BASE_ELEVATION,
        lowerB = BASE_ELEVATION;
      const cornerLevels = [a, b].map(i => ({
        x: topPositions[i * 3],
        z: topPositions[i * 3 + 2],
        levels: [0, topPositions[i * 3 + 1], adjacentSurface?.positions[i * 3 + 1] ?? BASE_ELEVATION]
      }));
      function registerSeaCrossing(source) {
        /* Record the linear interpolation fraction where an edge crosses sea level.
Parameter: source is a flat XYZ array with elevation in the second component.
For endpoints with opposite elevation signs, calculate the y=0 fraction and register its undirected edge key in topCuts. */

        const low = Math.min(a, b),
          high = Math.max(a, b);
        const h0 = source[low * 3 + 1],
          h1 = source[high * 3 + 1];
        if (h0 * h1 < 0) {
          const t = h0 / (h0 - h1);
          topCuts.set(low * vertexCount + high, {
            low,
            high,
            t
          });
        }
      }
      registerSeaCrossing(topPositions);

      // The cell is outside this tile at an internal tile boundary.  Ask the
      // tile resolver whether its selected same-level neighbour owns the same
      // category.  A same-category edge is internal and must not become a
      // visible cut wall; a different category supplies the exact shared-end
      // heights for the canonical land/water transition.
      const outside = !(neighborR >= 0 && neighborC >= 0 && neighborR < rows - 1 && neighborC < cols - 1);
      if (outside && adjacentSurface && typeof adjacentSurface.externalEdge === 'function') {
        const external = adjacentSurface.externalEdge({
          a,
          b,
          neighborR,
          neighborC,
          topPositions,
          rows,
          cols
        });
        if (external && (external.same === true || external === true)) return;
        const externalHeights = Array.isArray(external?.heights) ? external.heights : Array.isArray(external) ? external : null;
        if (externalHeights && externalHeights.length >= 2 && Number.isFinite(Number(externalHeights[0])) && Number.isFinite(Number(externalHeights[1]))) {
          lowerA = Math.max(BASE_ELEVATION, Number(externalHeights[0]));
          lowerB = Math.max(BASE_ELEVATION, Number(externalHeights[1]));
          const cornerLevelsExternal = [a, b].map((index, point) => {
            const current = cornerLevels[point];
            const value = Number(externalHeights[point]);
            return {
              ...current,
              levels: [...current.levels, value]
            };
          });
          cornerLevels.splice(0, cornerLevels.length, ...cornerLevelsExternal);
          const gapA = ay - lowerA,
            gapB = by - lowerB;
          if (gapA <= 0 && gapB <= 0) return;
          if (gapA < 0 || gapB < 0) {
            const low = Math.min(a, b),
              high = Math.max(a, b);
            const g0 = a === low ? gapA : gapB,
              g1 = a === low ? gapB : gapA;
            if (g0 !== g1) {
              const t = g0 / (g0 - g1);
              const x = topPositions[low * 3] + (topPositions[high * 3] - topPositions[low * 3]) * t;
              const z = topPositions[low * 3 + 2] + (topPositions[high * 3 + 2] - topPositions[low * 3 + 2]) * t;
              if (gapA < 0) {
                ax = x;
                ay = 0;
                az = z;
                lowerA = 0;
              } else {
                bx = x;
                by = 0;
                bz = z;
                lowerB = 0;
              }
            }
          }
        }
      }

      // Adjacent volumes share a footprint edge, but no internal vertical faces.
      // Only the higher top surface owns the exposed height difference.
      const inside = neighborR >= 0 && neighborC >= 0 && neighborR < rows - 1 && neighborC < cols - 1;
      if (adjacentSurface && inside && adjacentSurface.cells[neighborR * (cols - 1) + neighborC]) {
        registerSeaCrossing(adjacentSurface.positions);
        lowerA = Math.max(BASE_ELEVATION, adjacentSurface.positions[a * 3 + 1]);
        lowerB = Math.max(BASE_ELEVATION, adjacentSurface.positions[b * 3 + 1]);
        const gapA = ay - lowerA,
          gapB = by - lowerB;
        if (gapA <= 0 && gapB <= 0) return;
        if (gapA < 0 || gapB < 0) {
          // Clip the edge at the exact intersection between land and water top.
          const low = Math.min(a, b),
            high = Math.max(a, b);
          const g0 = a === low ? gapA : gapB,
            g1 = a === low ? gapB : gapA;
          const t = g0 / (g0 - g1);
          const x = topPositions[low * 3] + (topPositions[high * 3] - topPositions[low * 3]) * t;
          const z = topPositions[low * 3 + 2] + (topPositions[high * 3 + 2] - topPositions[low * 3 + 2]) * t;
          // Both owners use the same canonical edge and the exact sea-plane height.
          const y = 0;
          if (gapA < 0) {
            ax = x;
            ay = y;
            az = z;
            lowerA = y;
          } else {
            bx = x;
            by = y;
            bz = z;
            lowerB = y;
          }
        }
      }
      const polygon = [[ax, ay, az], [ax, lowerA, az], [bx, lowerB, bz], [bx, by, bz]];
      if (Math.min(ay, by, lowerA, lowerB) < 0 && Math.max(ay, by, lowerA, lowerB) > 0) {
        triangulate(clipAtSea(polygon, false), cornerLevels);
        triangulate(clipAtSea(polygon, true), cornerLevels);
      } else {
        triangulate(polygon, cornerLevels);
      }
      boundaryEdges++;
    }
    const exists = (r, c) => r >= 0 && c >= 0 && r < rows - 1 && c < cols - 1 && validCells[r * (cols - 1) + c];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        if (!exists(r, c)) continue;
        const a = r * cols + c,
          b = a + 1,
          d = a + cols,
          e = d + 1;
        if (!exists(r - 1, c)) addWall(b, a, r - 1, c);
        if (!exists(r + 1, c)) addWall(d, e, r + 1, c);
        if (!exists(r, c - 1)) addWall(a, d, r, c - 1);
        if (!exists(r, c + 1)) addWall(e, b, r, c + 1);
      }
    }
    // Insert sea-plane edge intersections into the top triangles as well.
    // Bottom faces keep their original edges because no new bottom vertex is introduced.
    function conformTop() {
      /* Insert recorded sea-level intersections into top-surface triangles.
Takes no arguments; uses the enclosing geometry data.
Create shared crossing vertices, split affected triangles and merge position arrays.
Returns a BufferGeometry with normals and a bounding sphere. */

      if (!topCuts.size) return makeGeometry(THREE, topPositions, topIndices);
      const extra = [];
      const cuts = new Map();
      for (const [key, cut] of topCuts) {
        const point = [0, 1, 2].map(k => topPositions[cut.low * 3 + k] + (topPositions[cut.high * 3 + k] - topPositions[cut.low * 3 + k]) * cut.t);
        point[1] = 0;
        cuts.set(key, vertexCount + extra.length / 3);
        extra.push(...point);
      }
      const output = new Uint32Array(topIndices.length + topCuts.size * 18);
      let offset = 0;
      for (let i = 0; i < topIndices.length; i += 3) {
        const boundary = [];
        for (let j = 0; j < 3; j++) {
          const a = topIndices[i + j],
            b = topIndices[i + (j + 1) % 3];
          boundary.push(a);
          const split = cuts.get(Math.min(a, b) * vertexCount + Math.max(a, b));
          if (split !== undefined) boundary.push(split);
        }
        if (boundary.length === 3) {
          output.set(boundary, offset);
          offset += 3;
          continue;
        }
        const center = [0, 0, 0];
        for (const id of boundary) for (let k = 0; k < 3; k++) {
          center[k] += (id < vertexCount ? topPositions[id * 3 + k] : extra[(id - vertexCount) * 3 + k]) / boundary.length;
        }
        const centerId = vertexCount + extra.length / 3;
        extra.push(...center);
        for (let j = 0; j < boundary.length; j++) {
          output.set([centerId, boundary[j], boundary[(j + 1) % boundary.length]], offset);
          offset += 3;
        }
      }
      const positions = new Float32Array(topPositions.length + extra.length);
      positions.set(topPositions);
      positions.set(extra, topPositions.length);
      return makeGeometry(THREE, positions, output.slice(0, offset));
    }
    return {
      top: conformTop(),
      bottom: compactBottomPositions ? makeGeometry(THREE, compactBottomPositions, compactBottomIndices) : makeGeometry(THREE, bottomPositions, bottomIndices),
      walls: makeGeometry(THREE, new Float32Array(walls)),
      boundaryEdges,
      wallTriangles: walls.length / 9,
      baseElevation: BASE_ELEVATION
    };
  }

  // Four-connected flood fill excludes enclosed inland data holes.
  // This is a sea rendering assumption, not a measured shoreline.
  function seaMask(land, rows, cols) {
    /* Find ocean cells using a four-neighbour flood fill from the mask boundary.
Parameters: land is a row-major (rows-1)*(cols-1) cell mask; rows/cols are vertex counts.
Flood non-land boundary cells; enclosed inland NoData holes remain excluded.
Returns a Uint8Array ocean mask, a rendering assumption rather than a surveyed coastline. */

    const height = rows - 1,
      width = cols - 1;
    const sea = new Uint8Array(height * width);
    const queue = new Uint32Array(sea.length);
    let head = 0,
      tail = 0;
    function visit(r, c) {
      /* Enqueue an unvisited non-land cell for the ocean flood fill.
Parameters: r/c are cell row/column indices.
Skip out-of-range, land or visited cells; otherwise mark and enqueue. Updates the mask and queue in place. */

      if (r < 0 || c < 0 || r >= height || c >= width) return;
      const i = r * width + c;
      if (land[i] || sea[i]) return;
      sea[i] = 1;
      queue[tail++] = i;
    }
    for (let c = 0; c < width; c++) {
      visit(0, c);
      visit(height - 1, c);
    }
    for (let r = 0; r < height; r++) {
      visit(r, 0);
      visit(r, width - 1);
    }
    while (head < tail) {
      const i = queue[head++],
        r = Math.floor(i / width),
        c = i % width;
      visit(r - 1, c);
      visit(r + 1, c);
      visit(r, c - 1);
      visit(r, c + 1);
    }
    return sea;
  }
  function surfaceIndices(mask, rows, cols) {
    /* Expand a valid-cell mask into surface triangle indices.
Parameters: mask is row-major with (rows-1)*(cols-1) entries; rows/cols are vertex counts mapped to Z/X.
Split each valid quad along a fixed diagonal. Returns a Uint32Array containing six indices per valid cell. */

    let cellCount = 0;
    for (const cell of mask) cellCount += cell;
    const indices = new Uint32Array(cellCount * 6);
    let offset = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        if (!mask[r * (cols - 1) + c]) continue;
        const a = r * cols + c,
          b = a + 1,
          d = a + cols,
          e = d + 1;
        indices.set([a, d, b, b, d, e], offset);
        offset += 6;
      }
    }
    return indices;
  }
  return {
    closeSurface,
    makeGeometry,
    synchronizeNormals,
    seaMask,
    surfaceIndices,
    BASE_ELEVATION
  };
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJ3aW5kb3ciLCJOb3RvVm9sdW1lIiwiQkFTRV9FTEVWQVRJT04iLCJtYWtlR2VvbWV0cnkiLCJUSFJFRSIsInBvc2l0aW9ucyIsImluZGljZXMiLCJnZW9tZXRyeSIsIkJ1ZmZlckdlb21ldHJ5Iiwic2V0QXR0cmlidXRlIiwiQnVmZmVyQXR0cmlidXRlIiwic2V0SW5kZXgiLCJjb21wdXRlVmVydGV4Tm9ybWFscyIsImNvbXB1dGVCb3VuZGluZ1NwaGVyZSIsInN5bmNocm9uaXplTm9ybWFscyIsInJlc3VsdHMiLCJncm91cHMiLCJNYXAiLCJlbnRyaWVzIiwiZXBzaWxvbiIsInJlc3VsdCIsIkFycmF5IiwiaXNBcnJheSIsImxhbmQiLCJ0b3AiLCJhdHRyaWJ1dGVzIiwicG9zaXRpb24iLCJub3JtYWwiLCJhcnJheSIsIm5vcm1hbHMiLCJ1c2VyRGF0YSIsImJvdW5kcyIsIm5vdG9Cb3VuZGFyeUJvdW5kcyIsIm5vdG9Cb3VuZGFyeVZlcnRleEluZGljZXMiLCJvcmlnaW5hbCIsIm5vdG9PcmlnaW5hbEJvdW5kYXJ5Tm9ybWFscyIsImxlbmd0aCIsImZvdW5kIiwiaSIsIngiLCJ6IiwiTWF0aCIsImFicyIsIm1pblgiLCJtYXhYIiwibWluWiIsIm1heFoiLCJwdXNoIiwiVWludDMyQXJyYXkiLCJmcm9tIiwiRmxvYXQzMkFycmF5Iiwic2V0Iiwic2xpY2UiLCJ2ZXJ0ZXgiLCJvZmZzZXQiLCJrZXkiLCJyb3VuZCIsImdyb3VwIiwiZ2V0IiwiaW5kZXgiLCJvcmlnaW5hbEluZGV4IiwidmFsdWVzIiwibngiLCJueSIsIm56IiwiaXRlbSIsImh5cG90IiwiZW50cnkiLCJuZWVkc1VwZGF0ZSIsImNsb3NlU3VyZmFjZSIsInRvcFBvc2l0aW9ucyIsInRvcEluZGljZXMiLCJ2YWxpZENlbGxzIiwicm93cyIsImNvbHMiLCJhZGphY2VudFN1cmZhY2UiLCJjZWxsQ291bnQiLCJtYXgiLCJmdWxsTWFzayIsImNvbXBhY3RCb3R0b21Qb3NpdGlvbnMiLCJjb21wYWN0Qm90dG9tSW5kaWNlcyIsImNvbXBhY3RCb3R0b20iLCJsYXN0IiwicGVyaW1ldGVyIiwiY29sIiwicm93Iiwic291cmNlIiwiVWludDE2QXJyYXkiLCJjb3VudCIsImN4IiwiY3oiLCJib3R0b21Qb3NpdGlvbnMiLCJib3R0b21JbmRpY2VzIiwid2FsbHMiLCJ0b3BDdXRzIiwidmVydGV4Q291bnQiLCJib3VuZGFyeUVkZ2VzIiwiY2xpcEF0U2VhIiwicG9seWdvbiIsImFib3ZlIiwib3V0cHV0IiwiYSIsImIiLCJpbkEiLCJpbkIiLCJmb3J3YXJkIiwicCIsInEiLCJ0IiwidHJpYW5ndWxhdGUiLCJjb3JuZXJMZXZlbHMiLCJjbGVhbiIsImZpbHRlciIsInByZXZpb3VzIiwic29tZSIsInZhbHVlIiwiYXhpcyIsImJvdW5kYXJ5IiwiY29ybmVyIiwiZmluZCIsImxldmVscyIsIlNldCIsInkiLCJtaW4iLCJzb3J0IiwiY2VudGVyIiwiayIsInUiLCJtYXAiLCJ2IiwiYXJlYSIsImFkZFdhbGwiLCJuZWlnaGJvclIiLCJuZWlnaGJvckMiLCJheCIsImF5IiwiYXoiLCJieCIsImJ5IiwiYnoiLCJsb3dlckEiLCJsb3dlckIiLCJyZWdpc3RlclNlYUNyb3NzaW5nIiwibG93IiwiaGlnaCIsImgwIiwiaDEiLCJvdXRzaWRlIiwiZXh0ZXJuYWxFZGdlIiwiZXh0ZXJuYWwiLCJzYW1lIiwiZXh0ZXJuYWxIZWlnaHRzIiwiaGVpZ2h0cyIsIk51bWJlciIsImlzRmluaXRlIiwiY29ybmVyTGV2ZWxzRXh0ZXJuYWwiLCJwb2ludCIsImN1cnJlbnQiLCJzcGxpY2UiLCJnYXBBIiwiZ2FwQiIsImcwIiwiZzEiLCJpbnNpZGUiLCJjZWxscyIsImV4aXN0cyIsInIiLCJjIiwiZCIsImUiLCJjb25mb3JtVG9wIiwic2l6ZSIsImV4dHJhIiwiY3V0cyIsImN1dCIsImoiLCJzcGxpdCIsInVuZGVmaW5lZCIsImlkIiwiY2VudGVySWQiLCJib3R0b20iLCJ3YWxsVHJpYW5nbGVzIiwiYmFzZUVsZXZhdGlvbiIsInNlYU1hc2siLCJoZWlnaHQiLCJ3aWR0aCIsInNlYSIsIlVpbnQ4QXJyYXkiLCJxdWV1ZSIsImhlYWQiLCJ0YWlsIiwidmlzaXQiLCJmbG9vciIsInN1cmZhY2VJbmRpY2VzIiwibWFzayIsImNlbGwiXSwic291cmNlcyI6WyJtb2RlbC12b2x1bWUuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gR2VvbWV0cnkgaGVscGVycyBmb3IgY2xvc2luZyBhIHRlcnJhaW4gc3VyZmFjZSBhdCBhIGZpeGVkIGVsZXZhdGlvbi5cclxuLy8gVW5pdHMgYXJlIG1ldHJlcy4gVmVydGljYWwgZXhhZ2dlcmF0aW9uIGlzIGFwcGxpZWQgYnkgdGhlIHBhcmVudCBncm91cC5cclxud2luZG93Lk5vdG9Wb2x1bWUgPSAoKCkgPT4ge1xyXG4gIC8vIEJBU0VfRUxFVkFUSU9OOiDlsIHpl63mqKHlnovnmoTniannkIblupXpnaLpq5jnqIsgbnVtYmVy77yM5Y2V5L2N57Gz44CCXG4gIGNvbnN0IEJBU0VfRUxFVkFUSU9OID0gLTEwMDtcclxuXHJcbiAgZnVuY3Rpb24gbWFrZUdlb21ldHJ5KFRIUkVFLCBwb3NpdGlvbnMsIGluZGljZXMpIHtcbi8qKlxyXG4gICAgICog5qC55o2u5L2N572u5pWw57uE5ZKM5Y+v6YCJ57Si5byV5Yib5bu65bim5rOV57q/5LiO5YyF5Zu055CD55qEIFRocmVlLmpzIOWHoOS9leS9k+OAglxyXG4gICAgICpcclxuICAgICAqIOWPguaVsO+8mlxyXG4gICAgICogICBUSFJFRTogVGhyZWUuanMg5ZG95ZCN56m66Ze05a+56LGh44CCXHJcbiAgICAgKiAgIHBvc2l0aW9uczog5LiA57u05Z2Q5qCH5pWw57uE77yM5q+PIDMg6aG55L6d5qyh5Li66aG254K555qEIFjjgIFZ44CBWu+8jOWNleS9jeS4uuexs+OAglxyXG4gICAgICogICBpbmRpY2VzOiDlj6/pgInnmoTkuInop5LlvaLpobbngrnntKLlvJXmlbDnu4TjgIJcclxuICAgICAqXHJcbiAgICAgKiDnrpfms5XvvJpcclxuICAgICAqICAgMS4g6K6+572u5L2N572u5ZKM5Y+v6YCJ57Si5byV5bGe5oCn77yM5YaN6K6h566X6aG254K55rOV57q/5LiO5YyF5Zu055CD44CCXHJcbiAqXG4gKiDov5Tlm57vvJpcclxuICAgICAqICAgcmVzdWx0OiDliJ3lp4vljJblrozmiJDnmoQgQnVmZmVyR2VvbWV0cnnjgIJcclxuICAgICAqL1xuXG4gICAgY29uc3QgZ2VvbWV0cnkgPSBuZXcgVEhSRUUuQnVmZmVyR2VvbWV0cnkoKTtcclxuICAgIGdlb21ldHJ5LnNldEF0dHJpYnV0ZSgncG9zaXRpb24nLCBuZXcgVEhSRUUuQnVmZmVyQXR0cmlidXRlKHBvc2l0aW9ucywgMykpO1xyXG4gICAgaWYgKGluZGljZXMpIGdlb21ldHJ5LnNldEluZGV4KG5ldyBUSFJFRS5CdWZmZXJBdHRyaWJ1dGUoaW5kaWNlcywgMSkpO1xyXG4gICAgZ2VvbWV0cnkuY29tcHV0ZVZlcnRleE5vcm1hbHMoKTtcclxuICAgIGdlb21ldHJ5LmNvbXB1dGVCb3VuZGluZ1NwaGVyZSgpO1xyXG4gICAgcmV0dXJuIGdlb21ldHJ5O1xuICB9XG5cbiAgLy8gQm91bmRhcnkgbm9ybWFscyBhcmUgYXZlcmFnZWQgb25seSBmcm9tIHRoZSBub3JtYWxzIGNvbXB1dGVkIGF0IGJ1aWxkXG4gIC8vIHRpbWUuICBLZWVwaW5nIHRoYXQgc25hcHNob3QgcHJldmVudHMgYSBzZWNvbmQgc3luY2hyb25pemF0aW9uIHBhc3MgZnJvbVxuICAvLyBhdmVyYWdpbmcgYWxyZWFkeS1hdmVyYWdlZCB2YWx1ZXMgYW5kIG1ha2VzIHJlcGVhdGVkIExPRCB1cGRhdGVzIHN0YWJsZS5cbiAgZnVuY3Rpb24gc3luY2hyb25pemVOb3JtYWxzKHJlc3VsdHMpIHtcbi8qKlxyXG4gICAgICog5oyJ5LiW55WM5Z2Q5qCH5ZCM5q2l55u46YK755Om54mH6aG26Z2i6L6555WM6aG254K555qE5rOV57q/44CCXHJcbiAgICAgKlxyXG4gICAgICog5Y+C5pWw77yaXHJcbiAgICAgKiAgIHJlc3VsdHM6IOWcsOW9ouaehOW7uue7k+aenOaVsOe7hO+8m+avj+mhueeahCBgbGFuZC50b3BgIOWPr+WMheWQq+i+ueeVjOazlee6v+e8k+WtmOOAglxyXG4gICAgICpcclxuICAgICAqIOeul+azle+8mlxyXG4gICAgICogICAxLiDmlLbpm4bovrnnlYzpobbngrnvvIzku6XmnoTlu7rml7bkv53lrZjnmoTljp/lp4vms5Xnur/msYLljZXkvY3lubPlnYfmlrnlkJHlubblhpnlm57jgIJcclxuICpcbiAqIOi/lOWbnu+8mlxyXG4gICAgICogICB1bmRlZmluZWQ6IOWOn+S9jeabtOaWsOi+ueeVjOazlee6v+WxnuaAp+OAglxyXG4gICAgICovXG5cbiAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwKCk7XG4gICAgY29uc3QgZW50cmllcyA9IFtdO1xuICAgIGNvbnN0IGVwc2lsb24gPSAxZS00O1xuICAgIGZvciAoY29uc3QgcmVzdWx0IG9mIEFycmF5LmlzQXJyYXkocmVzdWx0cykgPyByZXN1bHRzIDogW10pIHtcbiAgICAgIGNvbnN0IGdlb21ldHJ5ID0gcmVzdWx0Py5sYW5kPy50b3A7XG4gICAgICBpZiAoIWdlb21ldHJ5Py5hdHRyaWJ1dGVzPy5wb3NpdGlvbiB8fCAhZ2VvbWV0cnk/LmF0dHJpYnV0ZXM/Lm5vcm1hbCkgY29udGludWU7XG4gICAgICBjb25zdCBwb3NpdGlvbnMgPSBnZW9tZXRyeS5hdHRyaWJ1dGVzLnBvc2l0aW9uLmFycmF5O1xuICAgICAgY29uc3Qgbm9ybWFscyA9IGdlb21ldHJ5LmF0dHJpYnV0ZXMubm9ybWFsLmFycmF5O1xuICAgICAgaWYgKCFnZW9tZXRyeS51c2VyRGF0YSkgZ2VvbWV0cnkudXNlckRhdGEgPSB7fTtcbiAgICAgIGNvbnN0IGJvdW5kcyA9IGdlb21ldHJ5LnVzZXJEYXRhLm5vdG9Cb3VuZGFyeUJvdW5kcztcbiAgICAgIGlmICghYm91bmRzKSBjb250aW51ZTtcbiAgICAgIGxldCBpbmRpY2VzID0gZ2VvbWV0cnkudXNlckRhdGEubm90b0JvdW5kYXJ5VmVydGV4SW5kaWNlcztcbiAgICAgIGxldCBvcmlnaW5hbCA9IGdlb21ldHJ5LnVzZXJEYXRhLm5vdG9PcmlnaW5hbEJvdW5kYXJ5Tm9ybWFscztcbiAgICAgIGlmICghaW5kaWNlcyB8fCAhb3JpZ2luYWwgfHwgb3JpZ2luYWwubGVuZ3RoICE9PSBpbmRpY2VzLmxlbmd0aCAqIDMpIHtcbiAgICAgICAgY29uc3QgZm91bmQgPSBbXTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwb3NpdGlvbnMubGVuZ3RoOyBpICs9IDMpIHtcbiAgICAgICAgICBjb25zdCB4ID0gcG9zaXRpb25zW2ldLCB6ID0gcG9zaXRpb25zW2kgKyAyXTtcbiAgICAgICAgICBpZiAoTWF0aC5hYnMoeCAtIGJvdW5kcy5taW5YKSA8PSBlcHNpbG9uIHx8IE1hdGguYWJzKHggLSBib3VuZHMubWF4WCkgPD0gZXBzaWxvblxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoeiAtIGJvdW5kcy5taW5aKSA8PSBlcHNpbG9uIHx8IE1hdGguYWJzKHogLSBib3VuZHMubWF4WikgPD0gZXBzaWxvbikge1xuICAgICAgICAgICAgZm91bmQucHVzaChpIC8gMyk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGluZGljZXMgPSBVaW50MzJBcnJheS5mcm9tKGZvdW5kKTtcbiAgICAgICAgb3JpZ2luYWwgPSBuZXcgRmxvYXQzMkFycmF5KGluZGljZXMubGVuZ3RoICogMyk7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5kaWNlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIG9yaWdpbmFsLnNldChub3JtYWxzLnNsaWNlKGluZGljZXNbaV0gKiAzLCBpbmRpY2VzW2ldICogMyArIDMpLCBpICogMyk7XG4gICAgICAgIH1cbiAgICAgICAgZ2VvbWV0cnkudXNlckRhdGEubm90b0JvdW5kYXJ5VmVydGV4SW5kaWNlcyA9IGluZGljZXM7XG4gICAgICAgIGdlb21ldHJ5LnVzZXJEYXRhLm5vdG9PcmlnaW5hbEJvdW5kYXJ5Tm9ybWFscyA9IG9yaWdpbmFsO1xuICAgICAgfVxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbmRpY2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHZlcnRleCA9IGluZGljZXNbaV07XG4gICAgICAgIGNvbnN0IG9mZnNldCA9IHZlcnRleCAqIDM7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke01hdGgucm91bmQocG9zaXRpb25zW29mZnNldF0gLyBlcHNpbG9uKX06JHtNYXRoLnJvdW5kKHBvc2l0aW9uc1tvZmZzZXQgKyAxXSAvIGVwc2lsb24pfToke01hdGgucm91bmQocG9zaXRpb25zW29mZnNldCArIDJdIC8gZXBzaWxvbil9YDtcbiAgICAgICAgbGV0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpO1xuICAgICAgICBpZiAoIWdyb3VwKSB7IGdyb3VwID0gW107IGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7IH1cbiAgICAgICAgZ3JvdXAucHVzaCh7bm9ybWFscywgb3JpZ2luYWwsIGluZGV4OiB2ZXJ0ZXgsIG9yaWdpbmFsSW5kZXg6IGl9KTtcbiAgICAgIH1cbiAgICAgIGVudHJpZXMucHVzaCh7Z2VvbWV0cnl9KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMudmFsdWVzKCkpIHtcbiAgICAgIGxldCBueCA9IDAsIG55ID0gMCwgbnogPSAwO1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGdyb3VwKSB7XG4gICAgICAgIGNvbnN0IG9mZnNldCA9IGl0ZW0ub3JpZ2luYWxJbmRleCAqIDM7XG4gICAgICAgIG54ICs9IGl0ZW0ub3JpZ2luYWxbb2Zmc2V0XTtcbiAgICAgICAgbnkgKz0gaXRlbS5vcmlnaW5hbFtvZmZzZXQgKyAxXTtcbiAgICAgICAgbnogKz0gaXRlbS5vcmlnaW5hbFtvZmZzZXQgKyAyXTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxlbmd0aCA9IE1hdGguaHlwb3QobngsIG55LCBueikgfHwgMTtcbiAgICAgIG54IC89IGxlbmd0aDsgbnkgLz0gbGVuZ3RoOyBueiAvPSBsZW5ndGg7XG4gICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZ3JvdXApIHtcbiAgICAgICAgY29uc3Qgb2Zmc2V0ID0gaXRlbS5pbmRleCAqIDM7XG4gICAgICAgIGl0ZW0ubm9ybWFsc1tvZmZzZXRdID0gbng7XG4gICAgICAgIGl0ZW0ubm9ybWFsc1tvZmZzZXQgKyAxXSA9IG55O1xuICAgICAgICBpdGVtLm5vcm1hbHNbb2Zmc2V0ICsgMl0gPSBuejtcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSBlbnRyeS5nZW9tZXRyeS5hdHRyaWJ1dGVzLm5vcm1hbC5uZWVkc1VwZGF0ZSA9IHRydWU7XG4gIH1cblxyXG4gIC8vIEVhY2ggdG9wIGNlbGwgY29udHJpYnV0ZXMgYSBib3R0b20gZmFjZS4gT25seSBleHBvc2VkIGVkZ2VzIHJlY2VpdmUgd2FsbHMuXHJcbiAgLy8gU2VwYXJhdGUgd2FsbCB2ZXJ0aWNlcyBrZWVwIHRoZSB2ZXJ0aWNhbCBjdXQgZmFjZXMgc2hhcnAgdW5kZXIgbGlnaHRpbmcuXHJcbiAgZnVuY3Rpb24gY2xvc2VTdXJmYWNlKFRIUkVFLCB0b3BQb3NpdGlvbnMsIHRvcEluZGljZXMsIHZhbGlkQ2VsbHMsIHJvd3MsIGNvbHMsIGFkamFjZW50U3VyZmFjZSA9IG51bGwpIHtcbi8qKlxyXG4gICAgICog5Li65pyJ5pWI5Zyw6KGo5Y2V5YWD55Sf5oiQ5bCB6Zet5L2T55qE6aG26Z2i44CB5bqV6Z2i5ZKM5aSW6Zyy5L6n5aOB44CCXHJcbiAgICAgKlxyXG4gICAgICog5Y+C5pWw77yaXHJcbiAgICAgKiAgIFRIUkVFOiBUaHJlZS5qcyDlkb3lkI3nqbrpl7Tlr7nosaHjgIJcclxuICAgICAqICAgdG9wUG9zaXRpb25zOiDkuIDnu7QgWFlaIOmhtueCueaVsOe7hO+8jOavjyAzIOmhueihqOekuuS4gOS4qumhtueCue+8jOWNleS9jeS4uuexs+OAglxyXG4gICAgICogICB0b3BJbmRpY2VzOiDpobbpnaLkuInop5LlvaLntKLlvJXmlbDnu4TvvIzmr48gMyDkuKrntKLlvJXnu4TmiJDkuIDkuKrkuInop5LlvaLjgIJcclxuICAgICAqICAgdmFsaWRDZWxsczog6KGM5LyY5YWI5Y2V5YWD5o6p56CB77yM6ZW/5bqm5Li6IGAocm93cyAtIDEpICogKGNvbHMgLSAxKWDjgIJcclxuICAgICAqICAgcm93czog6aG254K5572R5qC86KGM5pWw77yb6KGM6L205pig5bCE5Yiw5LiW55WMIFog6L2044CCXHJcbiAgICAgKiAgIGNvbHM6IOmhtueCuee9keagvOWIl+aVsO+8m+WIl+i9tOaYoOWwhOWIsOS4lueVjCBYIOi9tOOAglxyXG4gICAgICogICBhZGphY2VudFN1cmZhY2U6IOWPr+mAieebuOmCu+ihqOmdouaVsOaNru+8jOeUqOS6juWFseS6q+i+ueeVjOWPiuS+p+WjgeijgeWJquOAglxyXG4gICAgICpcclxuICAgICAqIOeul+azle+8mlxyXG4gICAgICogICAxLiDmnoTpgKDlupXpnaLvvIzpgY3ljobmnInmlYjljZXlhYPnlJ/miJDlpJbpnLLkvqflo4HvvIzlubblnKjmtbflubPpnaLmj5LlhaXlhbHkuqvkuqTngrnjgIJcclxuICpcbiAqIOi/lOWbnu+8mlxyXG4gICAgICogICByZXN1bHQ6IOWQq+mhtumdouOAgeW6lemdouOAgeS+p+WjgeWHoOS9leS9k+WPiui+ueaVsOOAgemrmOeoi+e7n+iuoeeahOWvueixoeOAglxyXG4gICAgICovXG5cbiAgICBjb25zdCBjZWxsQ291bnQgPSBNYXRoLm1heCgwLCAocm93cyAtIDEpICogKGNvbHMgLSAxKSk7XG4gICAgbGV0IGZ1bGxNYXNrID0gdmFsaWRDZWxscyAmJiB2YWxpZENlbGxzLmxlbmd0aCA9PT0gY2VsbENvdW50O1xuICAgIGlmIChmdWxsTWFzaykge1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjZWxsQ291bnQ7IGkrKykge1xuICAgICAgICBpZiAoIXZhbGlkQ2VsbHNbaV0pIHsgZnVsbE1hc2sgPSBmYWxzZTsgYnJlYWs7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgLy8gQSBjb21wbGV0ZSB0aWxlIGhhcyBvbmUgcmVjdGFuZ3VsYXIgYm90dG9tLiAgQSBwZXJpbWV0ZXIgZmFuIHJldGFpbnNcbiAgICAvLyBldmVyeSBib3VuZGFyeSBub2RlIG5lZWRlZCBieSB0aGUgY3V0IHdhbGxzIHdoaWxlIGF2b2lkaW5nIGEgZGVuc2VcbiAgICAvLyBkdXBsaWNhdGUgcXVhZCBncmlkIGJlbG93IHRoZSB0ZXJyYWluLiAgVGhlIDLDlzIgY2FzZSBpcyBleGFjdGx5IG9uZVxuICAgIC8vIHF1YWQgYW5kIHRoZXJlZm9yZSB1c2VzIGZvdXIgY29ybmVycyBhbmQgdHdvIHRyaWFuZ2xlcy5cbiAgICBsZXQgY29tcGFjdEJvdHRvbVBvc2l0aW9ucyA9IG51bGw7XG4gICAgbGV0IGNvbXBhY3RCb3R0b21JbmRpY2VzID0gbnVsbDtcbiAgICBpZiAoZnVsbE1hc2sgJiYgYWRqYWNlbnRTdXJmYWNlPy5jb21wYWN0Qm90dG9tICE9PSBmYWxzZSkge1xuICAgICAgY29uc3QgbGFzdCA9IChyb3dzIC0gMSkgKiBjb2xzO1xuICAgICAgY29uc3QgcGVyaW1ldGVyID0gW107XG4gICAgICBmb3IgKGxldCBjb2wgPSAwOyBjb2wgPCBjb2xzOyBjb2wrKykgcGVyaW1ldGVyLnB1c2goY29sKTtcbiAgICAgIGZvciAobGV0IHJvdyA9IDE7IHJvdyA8IHJvd3M7IHJvdysrKSBwZXJpbWV0ZXIucHVzaChyb3cgKiBjb2xzICsgY29scyAtIDEpO1xuICAgICAgZm9yIChsZXQgY29sID0gY29scyAtIDI7IGNvbCA+PSAwOyBjb2wtLSkgcGVyaW1ldGVyLnB1c2gobGFzdCArIGNvbCk7XG4gICAgICBmb3IgKGxldCByb3cgPSByb3dzIC0gMjsgcm93ID49IDE7IHJvdy0tKSBwZXJpbWV0ZXIucHVzaChyb3cgKiBjb2xzKTtcbiAgICAgIGlmIChwZXJpbWV0ZXIubGVuZ3RoID09PSA0KSB7XG4gICAgICAgIGNvbXBhY3RCb3R0b21Qb3NpdGlvbnMgPSBuZXcgRmxvYXQzMkFycmF5KDEyKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwZXJpbWV0ZXIubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBjb25zdCBzb3VyY2UgPSBwZXJpbWV0ZXJbaV07XG4gICAgICAgICAgY29tcGFjdEJvdHRvbVBvc2l0aW9uc1tpICogM10gPSB0b3BQb3NpdGlvbnNbc291cmNlICogM107XG4gICAgICAgICAgY29tcGFjdEJvdHRvbVBvc2l0aW9uc1tpICogMyArIDFdID0gQkFTRV9FTEVWQVRJT047XG4gICAgICAgICAgY29tcGFjdEJvdHRvbVBvc2l0aW9uc1tpICogMyArIDJdID0gdG9wUG9zaXRpb25zW3NvdXJjZSAqIDMgKyAyXTtcbiAgICAgICAgfVxuICAgICAgICBjb21wYWN0Qm90dG9tSW5kaWNlcyA9IG5ldyBVaW50MTZBcnJheShbMCwgMSwgMiwgMCwgMiwgM10pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgY291bnQgPSBwZXJpbWV0ZXIubGVuZ3RoO1xuICAgICAgICBjb21wYWN0Qm90dG9tUG9zaXRpb25zID0gbmV3IEZsb2F0MzJBcnJheSgoY291bnQgKyAxKSAqIDMpO1xuICAgICAgICBsZXQgY3ggPSAwLCBjeiA9IDA7XG4gICAgICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHBlcmltZXRlcikge1xuICAgICAgICAgIGN4ICs9IHRvcFBvc2l0aW9uc1tzb3VyY2UgKiAzXTtcbiAgICAgICAgICBjeiArPSB0b3BQb3NpdGlvbnNbc291cmNlICogMyArIDJdO1xuICAgICAgICB9XG4gICAgICAgIGNvbXBhY3RCb3R0b21Qb3NpdGlvbnNbMF0gPSBjeCAvIGNvdW50O1xuICAgICAgICBjb21wYWN0Qm90dG9tUG9zaXRpb25zWzFdID0gQkFTRV9FTEVWQVRJT047XG4gICAgICAgIGNvbXBhY3RCb3R0b21Qb3NpdGlvbnNbMl0gPSBjeiAvIGNvdW50O1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvdW50OyBpKyspIHtcbiAgICAgICAgICBjb25zdCBzb3VyY2UgPSBwZXJpbWV0ZXJbaV07XG4gICAgICAgICAgY29tcGFjdEJvdHRvbVBvc2l0aW9uc1soaSArIDEpICogM10gPSB0b3BQb3NpdGlvbnNbc291cmNlICogM107XG4gICAgICAgICAgY29tcGFjdEJvdHRvbVBvc2l0aW9uc1soaSArIDEpICogMyArIDFdID0gQkFTRV9FTEVWQVRJT047XG4gICAgICAgICAgY29tcGFjdEJvdHRvbVBvc2l0aW9uc1soaSArIDEpICogMyArIDJdID0gdG9wUG9zaXRpb25zW3NvdXJjZSAqIDMgKyAyXTtcbiAgICAgICAgfVxuICAgICAgICBjb21wYWN0Qm90dG9tSW5kaWNlcyA9IG5ldyBVaW50MzJBcnJheShjb3VudCAqIDMpO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvdW50OyBpKyspIHtcbiAgICAgICAgICBjb21wYWN0Qm90dG9tSW5kaWNlc1tpICogM10gPSAwO1xuICAgICAgICAgIGNvbXBhY3RCb3R0b21JbmRpY2VzW2kgKiAzICsgMV0gPSBpICsgMTtcbiAgICAgICAgICBjb21wYWN0Qm90dG9tSW5kaWNlc1tpICogMyArIDJdID0gMSArICgoaSArIDEpICUgY291bnQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGxldCBib3R0b21Qb3NpdGlvbnMgPSBudWxsO1xuICAgIGxldCBib3R0b21JbmRpY2VzID0gbnVsbDtcbiAgICBpZiAoIWNvbXBhY3RCb3R0b21Qb3NpdGlvbnMpIHtcbiAgICAgIGJvdHRvbVBvc2l0aW9ucyA9IHRvcFBvc2l0aW9ucy5zbGljZSgpO1xuICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBib3R0b21Qb3NpdGlvbnMubGVuZ3RoOyBpICs9IDMpIHtcbiAgICAgICAgYm90dG9tUG9zaXRpb25zW2ldID0gQkFTRV9FTEVWQVRJT047XG4gICAgICB9XG4gICAgICBib3R0b21JbmRpY2VzID0gdG9wSW5kaWNlcy5zbGljZSgpO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBib3R0b21JbmRpY2VzLmxlbmd0aDsgaSArPSAzKSB7XG4gICAgICAgIFtib3R0b21JbmRpY2VzW2kgKyAxXSwgYm90dG9tSW5kaWNlc1tpICsgMl1dID0gW2JvdHRvbUluZGljZXNbaSArIDJdLCBib3R0b21JbmRpY2VzW2kgKyAxXV07XG4gICAgICB9XG4gICAgfVxuXHJcbiAgICBjb25zdCB3YWxscyA9IFtdO1xyXG4gICAgY29uc3QgdG9wQ3V0cyA9IG5ldyBNYXAoKTtcclxuICAgIGNvbnN0IHZlcnRleENvdW50ID0gdG9wUG9zaXRpb25zLmxlbmd0aCAvIDM7XHJcbiAgICBsZXQgYm91bmRhcnlFZGdlcyA9IDA7XHJcbiAgICAvLyBDbGlwIHdhbGwgcG9seWdvbnMgYXQgc2VhIGxldmVsIHNvIGFkamFjZW50IHdhdGVyIGFuZCByb2NrIGVkZ2VzIHNoYXJlIHZlcnRpY2VzLlxyXG4gICAgZnVuY3Rpb24gY2xpcEF0U2VhKHBvbHlnb24sIGFib3ZlKSB7XG4vKipcclxuICAgICAgICog5bCGIFhZWiDlpJrovrnlvaLoo4HliarliLDmtbflubPpnaLkuIrmlrnmiJbkuIvmlrnvvIzlubbmj5LlhaXovrnnlYzkuqTngrnjgIJcclxuICAgICAgICpcclxuICAgICAgICog5Y+C5pWw77yaXHJcbiAgICAgICAqICAgcG9seWdvbjog5oyJ6L6555WM6aG65bqP5o6S5YiX55qE5LiJ57u054K55pWw57uE77yM5q+P54K55Li6IGBbeCwgeSwgel1gIOexs+OAglxyXG4gICAgICAgKiAgIGFib3ZlOiB0cnVlIOS/neeVmSB5ID49IDAg55qE6YOo5YiG77ybZmFsc2Ug5L+d55WZIHkgPD0gMCDnmoTpg6jliIbjgIJcclxuICAgICAgICpcclxuICAgICAgICog566X5rOV77yaXHJcbiAgICAgICAqICAgMS4g6YCQ6L655L+d55WZ55uu5qCH5Y2K5bmz6Z2i5YaF55qE6LW354K577yM5bm25a+56Leo6LaKIHk9MCDnmoTovrnkvZznur/mgKfmj5LlgLzjgIJcclxuICpcbiAqIOi/lOWbnu+8mlxyXG4gICAgICAgKiAgIHJlc3VsdDog6KOB5Ymq5ZCO55qEIFhZWiDngrnmlbDnu4TvvJvkuI3otrPkuInkuKrngrnml7bnlLHosIPnlKjmlrnlv73nlaXjgIJcclxuICAgICAgICovXG5cclxuICAgICAgY29uc3Qgb3V0cHV0ID0gW107XHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcG9seWdvbi5sZW5ndGg7IGkrKykge1xyXG4gICAgICAgIGNvbnN0IGEgPSBwb2x5Z29uW2ldLCBiID0gcG9seWdvblsoaSArIDEpICUgcG9seWdvbi5sZW5ndGhdO1xyXG4gICAgICAgIGNvbnN0IGluQSA9IGFib3ZlID8gYVsxXSA+PSAwIDogYVsxXSA8PSAwO1xyXG4gICAgICAgIGNvbnN0IGluQiA9IGFib3ZlID8gYlsxXSA+PSAwIDogYlsxXSA8PSAwO1xyXG4gICAgICAgIGlmIChpbkEpIG91dHB1dC5wdXNoKGEpO1xyXG4gICAgICAgIGlmIChpbkEgIT09IGluQikge1xyXG4gICAgICAgICAgY29uc3QgZm9yd2FyZCA9IGFbMF0gPCBiWzBdIHx8IChhWzBdID09PSBiWzBdICYmIGFbMl0gPCBiWzJdKTtcclxuICAgICAgICAgIGNvbnN0IHAgPSBmb3J3YXJkID8gYSA6IGIsIHEgPSBmb3J3YXJkID8gYiA6IGE7XHJcbiAgICAgICAgICBjb25zdCB0ID0gLXBbMV0gLyAocVsxXSAtIHBbMV0pO1xyXG4gICAgICAgICAgb3V0cHV0LnB1c2goW3BbMF0gKyAocVswXSAtIHBbMF0pICogdCwgMCwgcFsyXSArIChxWzJdIC0gcFsyXSkgKiB0XSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiBvdXRwdXQ7XHJcbiAgICB9XHJcbiAgICBmdW5jdGlvbiB0cmlhbmd1bGF0ZShwb2x5Z29uLCBjb3JuZXJMZXZlbHMpIHtcbi8qKlxyXG4gICAgICAgKiDmuIXnkIbkvqflo4HlpJrovrnlvaLlubblsIbpnZ7pgIDljJbkuInop5LlvaLpobbngrnov73liqDliLDkvqflo4HmlbDnu4TjgIJcclxuICAgICAgICpcclxuICAgICAgICog5Y+C5pWw77yaXHJcbiAgICAgICAqICAgcG9seWdvbjog5L6n5aOB6L6555WM55qEIFhZWiDngrnmlbDnu4TvvIzlnZDmoIfljZXkvY3kuLrnsbPjgIJcclxuICAgICAgICogICBjb3JuZXJMZXZlbHM6IOerr+eCuemrmOeoi+aPj+i/sOaVsOe7hO+8jOavj+mhueWQqyB444CBeiDlkowgbGV2ZWxz44CCXHJcbiAgICAgICAqXHJcbiAgICAgICAqIOeul+azle+8mlxyXG4gICAgICAgKiAgIDEuIOenu+mZpOi/nue7remHjeWkjeeCueOAgeihpeWFpeerluebtOi+ueS4iueahOWFseS6q+mrmOeoi++8jOWGjeaMieWGhemDqOaJh+W/g+WJluWIhuOAglxyXG4gKlxuICog6L+U5Zue77yaXHJcbiAgICAgICAqICAgdW5kZWZpbmVkOiDljp/kvY3lkJEgd2FsbHMg6L+95Yqg5LiJ6KeS5b2i6aG254K544CCXHJcbiAgICAgICAqL1xuXHJcbiAgICAgIGNvbnN0IGNsZWFuID0gcG9seWdvbi5maWx0ZXIoKHAsIGkpID0+IHtcclxuICAgICAgICBjb25zdCBwcmV2aW91cyA9IHBvbHlnb25bKGkgKyBwb2x5Z29uLmxlbmd0aCAtIDEpICUgcG9seWdvbi5sZW5ndGhdO1xyXG4gICAgICAgIHJldHVybiBwLnNvbWUoKHZhbHVlLCBheGlzKSA9PiB2YWx1ZSAhPT0gcHJldmlvdXNbYXhpc10pO1xyXG4gICAgICB9KTtcclxuICAgICAgaWYgKGNsZWFuLmxlbmd0aCA8IDMpIHJldHVybjtcclxuICAgICAgY29uc3QgYm91bmRhcnkgPSBbXTtcclxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbGVhbi5sZW5ndGg7IGkrKykge1xyXG4gICAgICAgIGNvbnN0IGEgPSBjbGVhbltpXSwgYiA9IGNsZWFuWyhpICsgMSkgJSBjbGVhbi5sZW5ndGhdO1xyXG4gICAgICAgIGJvdW5kYXJ5LnB1c2goYSk7XHJcbiAgICAgICAgaWYgKGFbMF0gPT09IGJbMF0gJiYgYVsyXSA9PT0gYlsyXSAmJiBhWzFdICE9PSBiWzFdKSB7XHJcbiAgICAgICAgICBjb25zdCBjb3JuZXIgPSBjb3JuZXJMZXZlbHMuZmluZChwID0+IHAueCA9PT0gYVswXSAmJiBwLnogPT09IGFbMl0pO1xyXG4gICAgICAgICAgY29uc3QgbGV2ZWxzID0gWy4uLm5ldyBTZXQoY29ybmVyPy5sZXZlbHMgfHwgW10pXVxyXG4gICAgICAgICAgICAuZmlsdGVyKHkgPT4geSA+IE1hdGgubWluKGFbMV0sIGJbMV0pICYmIHkgPCBNYXRoLm1heChhWzFdLCBiWzFdKSlcclxuICAgICAgICAgICAgLnNvcnQoKHgsIHkpID0+IChiWzFdID4gYVsxXSA/IHggLSB5IDogeSAtIHgpKTtcclxuICAgICAgICAgIGZvciAoY29uc3QgeSBvZiBsZXZlbHMpIGJvdW5kYXJ5LnB1c2goW2FbMF0sIHksIGFbMl1dKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgLy8gQW4gaW50ZXJpb3IgZmFuIHByZXNlcnZlcyBjb2xsaW5lYXIgYm91bmRhcnkgdmVydGljZXMsIHVubGlrZSBhIGNvcm5lciBmYW4uXHJcbiAgICAgIGNvbnN0IGNlbnRlciA9IFswLCAwLCAwXTtcclxuICAgICAgZm9yIChjb25zdCBwIG9mIGJvdW5kYXJ5KSBmb3IgKGxldCBrID0gMDsgayA8IDM7IGsrKykgY2VudGVyW2tdICs9IHBba10gLyBib3VuZGFyeS5sZW5ndGg7XHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYm91bmRhcnkubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICBjb25zdCBhID0gYm91bmRhcnlbaV0sIGIgPSBib3VuZGFyeVsoaSArIDEpICUgYm91bmRhcnkubGVuZ3RoXTtcclxuICAgICAgICBjb25zdCB1ID0gYS5tYXAoKHYsIGspID0+IHYgLSBjZW50ZXJba10pLCB2ID0gYi5tYXAoKHgsIGspID0+IHggLSBjZW50ZXJba10pO1xyXG4gICAgICAgIGNvbnN0IGFyZWEgPSBNYXRoLmh5cG90KHVbMV0gKiB2WzJdIC0gdVsyXSAqIHZbMV0sIHVbMl0gKiB2WzBdIC0gdVswXSAqIHZbMl0sIHVbMF0gKiB2WzFdIC0gdVsxXSAqIHZbMF0pO1xyXG4gICAgICAgIGlmIChhcmVhID4gMWUtOCkgd2FsbHMucHVzaCguLi5jZW50ZXIsIC4uLmEsIC4uLmIpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBmdW5jdGlvbiBhZGRXYWxsKGEsIGIsIG5laWdoYm9yUiwgbmVpZ2hib3JDKSB7XG4vKipcclxuICAgICAgICog5Li65LiA5Liq5pyq6KKr5ZCM57G75pyJ5pWI5Y2V5YWD6KaG55uW55qE572R5qC86L6555Sf5oiQ5L6n5aOB44CCXHJcbiAgICAgICAqXHJcbiAgICAgICAqIOWPguaVsO+8mlxyXG4gICAgICAgKiAgIGE6IOW9k+WJjei+ueesrOS4gOS4querr+eCueWcqOihjOS8mOWFiOmhtueCueaVsOe7hOS4reeahOe0ouW8leOAglxyXG4gICAgICAgKiAgIGI6IOW9k+WJjei+ueesrOS6jOS4querr+eCueWcqOihjOS8mOWFiOmhtueCueaVsOe7hOS4reeahOe0ouW8leOAglxyXG4gICAgICAgKiAgIG5laWdoYm9yUjog6L655aSW55u46YK75Y2V5YWD55qE6KGM57Si5byV77yM5Y+v6LaF5Ye65pys55Om54mH6IyD5Zu044CCXHJcbiAgICAgICAqICAgbmVpZ2hib3JDOiDovrnlpJbnm7jpgrvljZXlhYPnmoTliJfntKLlvJXvvIzlj6/otoXlh7rmnKznk6bniYfojIPlm7TjgIJcclxuICAgICAgICpcclxuICAgICAgICog566X5rOV77yaXHJcbiAgICAgICAqICAgMS4g6K+75Y+W55u46YK76KGo6Z2i6auY56iL77yM5raI6Zmk5ZCM57G75YaF5L6n5aOB77yM5bm25Zyo5rW35bmz6Z2i6KOB5Ymq5rC06ZmG5Lqk55WM44CCXHJcbiAqXG4gKiDov5Tlm57vvJpcclxuICAgICAgICogICB1bmRlZmluZWQ6IOWGmeWFpemXreWMheS4reeahOS+p+WjgemhtueCueWSjOa1t+W5s+mdouS6pOeCueihqOOAglxyXG4gICAgICAgKi9cblxuICAgICAgbGV0IGF4ID0gdG9wUG9zaXRpb25zW2EgKiAzXSwgYXkgPSB0b3BQb3NpdGlvbnNbYSAqIDMgKyAxXSwgYXogPSB0b3BQb3NpdGlvbnNbYSAqIDMgKyAyXTtcclxuICAgICAgbGV0IGJ4ID0gdG9wUG9zaXRpb25zW2IgKiAzXSwgYnkgPSB0b3BQb3NpdGlvbnNbYiAqIDMgKyAxXSwgYnogPSB0b3BQb3NpdGlvbnNbYiAqIDMgKyAyXTtcclxuICAgICAgbGV0IGxvd2VyQSA9IEJBU0VfRUxFVkFUSU9OLCBsb3dlckIgPSBCQVNFX0VMRVZBVElPTjtcclxuICAgICAgY29uc3QgY29ybmVyTGV2ZWxzID0gW2EsIGJdLm1hcChpID0+ICh7XHJcbiAgICAgICAgeDogdG9wUG9zaXRpb25zW2kgKiAzXSwgejogdG9wUG9zaXRpb25zW2kgKiAzICsgMl0sXHJcbiAgICAgICAgbGV2ZWxzOiBbMCwgdG9wUG9zaXRpb25zW2kgKiAzICsgMV0sIGFkamFjZW50U3VyZmFjZT8ucG9zaXRpb25zW2kgKiAzICsgMV0gPz8gQkFTRV9FTEVWQVRJT05dLFxyXG4gICAgICB9KSk7XHJcbiAgICAgIGZ1bmN0aW9uIHJlZ2lzdGVyU2VhQ3Jvc3Npbmcoc291cmNlKSB7XG4vKipcclxuICAgICAgICAgKiDorrDlvZXnvZHmoLzovrnnqb/ov4fmtbflubPpnaLnmoTnur/mgKfmj5LlgLzmr5TkvovjgIJcclxuICAgICAgICAgKlxyXG4gICAgICAgICAqIOWPguaVsO+8mlxyXG4gICAgICAgICAqICAgc291cmNlOiDkuIDnu7QgWFlaIOmhtueCueaVsOe7hO+8m+avjyAzIOmhueS4uuS4gOS4qumhtueCue+8jOmrmOeoi+aYr+esrOS6jOWIhumHj+OAglxyXG4gICAgICAgICAqXHJcbiAgICAgICAgICog566X5rOV77yaXHJcbiAgICAgICAgICogICAxLiDnq6/ngrnpq5jnqIvlvILlj7fml7bvvIzorqHnrpcgeT0wIOeahOS6pOeCueavlOS+i+W5tueZu+iusOaXoOWQkei+uemUruOAglxyXG4gKlxuICog6L+U5Zue77yaXHJcbiAgICAgICAgICogICB1bmRlZmluZWQ6IOWPr+iDveWQkSB0b3BDdXRzIOaWsOWinuiusOW9leOAglxyXG4gICAgICAgICAqL1xuXG4gICAgICAgIGNvbnN0IGxvdyA9IE1hdGgubWluKGEsIGIpLCBoaWdoID0gTWF0aC5tYXgoYSwgYik7XHJcbiAgICAgICAgY29uc3QgaDAgPSBzb3VyY2VbbG93ICogMyArIDFdLCBoMSA9IHNvdXJjZVtoaWdoICogMyArIDFdO1xyXG4gICAgICAgIGlmIChoMCAqIGgxIDwgMCkge1xyXG4gICAgICAgICAgY29uc3QgdCA9IGgwIC8gKGgwIC0gaDEpO1xyXG4gICAgICAgICAgdG9wQ3V0cy5zZXQobG93ICogdmVydGV4Q291bnQgKyBoaWdoLCB7bG93LCBoaWdoLCB0fSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XG4gICAgICByZWdpc3RlclNlYUNyb3NzaW5nKHRvcFBvc2l0aW9ucyk7XG5cbiAgICAgIC8vIFRoZSBjZWxsIGlzIG91dHNpZGUgdGhpcyB0aWxlIGF0IGFuIGludGVybmFsIHRpbGUgYm91bmRhcnkuICBBc2sgdGhlXG4gICAgICAvLyB0aWxlIHJlc29sdmVyIHdoZXRoZXIgaXRzIHNlbGVjdGVkIHNhbWUtbGV2ZWwgbmVpZ2hib3VyIG93bnMgdGhlIHNhbWVcbiAgICAgIC8vIGNhdGVnb3J5LiAgQSBzYW1lLWNhdGVnb3J5IGVkZ2UgaXMgaW50ZXJuYWwgYW5kIG11c3Qgbm90IGJlY29tZSBhXG4gICAgICAvLyB2aXNpYmxlIGN1dCB3YWxsOyBhIGRpZmZlcmVudCBjYXRlZ29yeSBzdXBwbGllcyB0aGUgZXhhY3Qgc2hhcmVkLWVuZFxuICAgICAgLy8gaGVpZ2h0cyBmb3IgdGhlIGNhbm9uaWNhbCBsYW5kL3dhdGVyIHRyYW5zaXRpb24uXG4gICAgICBjb25zdCBvdXRzaWRlID0gIShuZWlnaGJvclIgPj0gMCAmJiBuZWlnaGJvckMgPj0gMFxuICAgICAgICAmJiBuZWlnaGJvclIgPCByb3dzIC0gMSAmJiBuZWlnaGJvckMgPCBjb2xzIC0gMSk7XG4gICAgICBpZiAob3V0c2lkZSAmJiBhZGphY2VudFN1cmZhY2UgJiYgdHlwZW9mIGFkamFjZW50U3VyZmFjZS5leHRlcm5hbEVkZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY29uc3QgZXh0ZXJuYWwgPSBhZGphY2VudFN1cmZhY2UuZXh0ZXJuYWxFZGdlKHtcbiAgICAgICAgICBhLCBiLCBuZWlnaGJvclIsIG5laWdoYm9yQywgdG9wUG9zaXRpb25zLCByb3dzLCBjb2xzLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKGV4dGVybmFsICYmIChleHRlcm5hbC5zYW1lID09PSB0cnVlIHx8IGV4dGVybmFsID09PSB0cnVlKSkgcmV0dXJuO1xuICAgICAgICBjb25zdCBleHRlcm5hbEhlaWdodHMgPSBBcnJheS5pc0FycmF5KGV4dGVybmFsPy5oZWlnaHRzKVxuICAgICAgICAgID8gZXh0ZXJuYWwuaGVpZ2h0cyA6IChBcnJheS5pc0FycmF5KGV4dGVybmFsKSA/IGV4dGVybmFsIDogbnVsbCk7XG4gICAgICAgIGlmIChleHRlcm5hbEhlaWdodHMgJiYgZXh0ZXJuYWxIZWlnaHRzLmxlbmd0aCA+PSAyXG4gICAgICAgICAgJiYgTnVtYmVyLmlzRmluaXRlKE51bWJlcihleHRlcm5hbEhlaWdodHNbMF0pKVxuICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoZXh0ZXJuYWxIZWlnaHRzWzFdKSkpIHtcbiAgICAgICAgICBsb3dlckEgPSBNYXRoLm1heChCQVNFX0VMRVZBVElPTiwgTnVtYmVyKGV4dGVybmFsSGVpZ2h0c1swXSkpO1xuICAgICAgICAgIGxvd2VyQiA9IE1hdGgubWF4KEJBU0VfRUxFVkFUSU9OLCBOdW1iZXIoZXh0ZXJuYWxIZWlnaHRzWzFdKSk7XG4gICAgICAgICAgY29uc3QgY29ybmVyTGV2ZWxzRXh0ZXJuYWwgPSBbYSwgYl0ubWFwKChpbmRleCwgcG9pbnQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBjb3JuZXJMZXZlbHNbcG9pbnRdO1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBOdW1iZXIoZXh0ZXJuYWxIZWlnaHRzW3BvaW50XSk7XG4gICAgICAgICAgICByZXR1cm4gey4uLmN1cnJlbnQsIGxldmVsczogWy4uLmN1cnJlbnQubGV2ZWxzLCB2YWx1ZV19O1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvcm5lckxldmVscy5zcGxpY2UoMCwgY29ybmVyTGV2ZWxzLmxlbmd0aCwgLi4uY29ybmVyTGV2ZWxzRXh0ZXJuYWwpO1xuICAgICAgICAgIGNvbnN0IGdhcEEgPSBheSAtIGxvd2VyQSwgZ2FwQiA9IGJ5IC0gbG93ZXJCO1xuICAgICAgICAgIGlmIChnYXBBIDw9IDAgJiYgZ2FwQiA8PSAwKSByZXR1cm47XG4gICAgICAgICAgaWYgKGdhcEEgPCAwIHx8IGdhcEIgPCAwKSB7XG4gICAgICAgICAgICBjb25zdCBsb3cgPSBNYXRoLm1pbihhLCBiKSwgaGlnaCA9IE1hdGgubWF4KGEsIGIpO1xuICAgICAgICAgICAgY29uc3QgZzAgPSBhID09PSBsb3cgPyBnYXBBIDogZ2FwQiwgZzEgPSBhID09PSBsb3cgPyBnYXBCIDogZ2FwQTtcbiAgICAgICAgICAgIGlmIChnMCAhPT0gZzEpIHtcbiAgICAgICAgICAgICAgY29uc3QgdCA9IGcwIC8gKGcwIC0gZzEpO1xuICAgICAgICAgICAgICBjb25zdCB4ID0gdG9wUG9zaXRpb25zW2xvdyAqIDNdXG4gICAgICAgICAgICAgICAgKyAodG9wUG9zaXRpb25zW2hpZ2ggKiAzXSAtIHRvcFBvc2l0aW9uc1tsb3cgKiAzXSkgKiB0O1xuICAgICAgICAgICAgICBjb25zdCB6ID0gdG9wUG9zaXRpb25zW2xvdyAqIDMgKyAyXVxuICAgICAgICAgICAgICAgICsgKHRvcFBvc2l0aW9uc1toaWdoICogMyArIDJdIC0gdG9wUG9zaXRpb25zW2xvdyAqIDMgKyAyXSkgKiB0O1xuICAgICAgICAgICAgICBpZiAoZ2FwQSA8IDApIHsgYXggPSB4OyBheSA9IDA7IGF6ID0gejsgbG93ZXJBID0gMDsgfVxuICAgICAgICAgICAgICBlbHNlIHsgYnggPSB4OyBieSA9IDA7IGJ6ID0gejsgbG93ZXJCID0gMDsgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBBZGphY2VudCB2b2x1bWVzIHNoYXJlIGEgZm9vdHByaW50IGVkZ2UsIGJ1dCBubyBpbnRlcm5hbCB2ZXJ0aWNhbCBmYWNlcy5cbiAgICAgIC8vIE9ubHkgdGhlIGhpZ2hlciB0b3Agc3VyZmFjZSBvd25zIHRoZSBleHBvc2VkIGhlaWdodCBkaWZmZXJlbmNlLlxyXG4gICAgICBjb25zdCBpbnNpZGUgPSBuZWlnaGJvclIgPj0gMCAmJiBuZWlnaGJvckMgPj0gMCAmJiBuZWlnaGJvclIgPCByb3dzIC0gMSAmJiBuZWlnaGJvckMgPCBjb2xzIC0gMTtcclxuICAgICAgaWYgKGFkamFjZW50U3VyZmFjZSAmJiBpbnNpZGUgJiYgYWRqYWNlbnRTdXJmYWNlLmNlbGxzW25laWdoYm9yUiAqIChjb2xzIC0gMSkgKyBuZWlnaGJvckNdKSB7XHJcbiAgICAgICAgcmVnaXN0ZXJTZWFDcm9zc2luZyhhZGphY2VudFN1cmZhY2UucG9zaXRpb25zKTtcclxuICAgICAgICBsb3dlckEgPSBNYXRoLm1heChCQVNFX0VMRVZBVElPTiwgYWRqYWNlbnRTdXJmYWNlLnBvc2l0aW9uc1thICogMyArIDFdKTtcclxuICAgICAgICBsb3dlckIgPSBNYXRoLm1heChCQVNFX0VMRVZBVElPTiwgYWRqYWNlbnRTdXJmYWNlLnBvc2l0aW9uc1tiICogMyArIDFdKTtcclxuICAgICAgICBjb25zdCBnYXBBID0gYXkgLSBsb3dlckEsIGdhcEIgPSBieSAtIGxvd2VyQjtcclxuICAgICAgICBpZiAoZ2FwQSA8PSAwICYmIGdhcEIgPD0gMCkgcmV0dXJuO1xyXG4gICAgICAgIGlmIChnYXBBIDwgMCB8fCBnYXBCIDwgMCkge1xyXG4gICAgICAgICAgLy8gQ2xpcCB0aGUgZWRnZSBhdCB0aGUgZXhhY3QgaW50ZXJzZWN0aW9uIGJldHdlZW4gbGFuZCBhbmQgd2F0ZXIgdG9wLlxyXG4gICAgICAgICAgY29uc3QgbG93ID0gTWF0aC5taW4oYSwgYiksIGhpZ2ggPSBNYXRoLm1heChhLCBiKTtcclxuICAgICAgICAgIGNvbnN0IGcwID0gYSA9PT0gbG93ID8gZ2FwQSA6IGdhcEIsIGcxID0gYSA9PT0gbG93ID8gZ2FwQiA6IGdhcEE7XHJcbiAgICAgICAgICBjb25zdCB0ID0gZzAgLyAoZzAgLSBnMSk7XHJcbiAgICAgICAgICBjb25zdCB4ID0gdG9wUG9zaXRpb25zW2xvdyAqIDNdICsgKHRvcFBvc2l0aW9uc1toaWdoICogM10gLSB0b3BQb3NpdGlvbnNbbG93ICogM10pICogdDtcclxuICAgICAgICAgIGNvbnN0IHogPSB0b3BQb3NpdGlvbnNbbG93ICogMyArIDJdICsgKHRvcFBvc2l0aW9uc1toaWdoICogMyArIDJdIC0gdG9wUG9zaXRpb25zW2xvdyAqIDMgKyAyXSkgKiB0O1xyXG4gICAgICAgICAgLy8gQm90aCBvd25lcnMgdXNlIHRoZSBzYW1lIGNhbm9uaWNhbCBlZGdlIGFuZCB0aGUgZXhhY3Qgc2VhLXBsYW5lIGhlaWdodC5cclxuICAgICAgICAgIGNvbnN0IHkgPSAwO1xyXG4gICAgICAgICAgaWYgKGdhcEEgPCAwKSB7IGF4ID0geDsgYXkgPSB5OyBheiA9IHo7IGxvd2VyQSA9IHk7IH1cclxuICAgICAgICAgIGVsc2UgeyBieCA9IHg7IGJ5ID0geTsgYnogPSB6OyBsb3dlckIgPSB5OyB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHBvbHlnb24gPSBbW2F4LCBheSwgYXpdLCBbYXgsIGxvd2VyQSwgYXpdLCBbYngsIGxvd2VyQiwgYnpdLCBbYngsIGJ5LCBiel1dO1xyXG4gICAgICBpZiAoTWF0aC5taW4oYXksIGJ5LCBsb3dlckEsIGxvd2VyQikgPCAwICYmIE1hdGgubWF4KGF5LCBieSwgbG93ZXJBLCBsb3dlckIpID4gMCkge1xyXG4gICAgICAgIHRyaWFuZ3VsYXRlKGNsaXBBdFNlYShwb2x5Z29uLCBmYWxzZSksIGNvcm5lckxldmVscyk7XHJcbiAgICAgICAgdHJpYW5ndWxhdGUoY2xpcEF0U2VhKHBvbHlnb24sIHRydWUpLCBjb3JuZXJMZXZlbHMpO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHRyaWFuZ3VsYXRlKHBvbHlnb24sIGNvcm5lckxldmVscyk7XHJcbiAgICAgIH1cclxuICAgICAgYm91bmRhcnlFZGdlcysrO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZXhpc3RzID0gKHIsIGMpID0+IHIgPj0gMCAmJiBjID49IDAgJiYgciA8IHJvd3MgLSAxICYmIGMgPCBjb2xzIC0gMVxyXG4gICAgICAmJiB2YWxpZENlbGxzW3IgKiAoY29scyAtIDEpICsgY107XHJcbiAgICBmb3IgKGxldCByID0gMDsgciA8IHJvd3MgLSAxOyByKyspIHtcclxuICAgICAgZm9yIChsZXQgYyA9IDA7IGMgPCBjb2xzIC0gMTsgYysrKSB7XHJcbiAgICAgICAgaWYgKCFleGlzdHMociwgYykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IGEgPSByICogY29scyArIGMsIGIgPSBhICsgMSwgZCA9IGEgKyBjb2xzLCBlID0gZCArIDE7XHJcbiAgICAgICAgaWYgKCFleGlzdHMociAtIDEsIGMpKSBhZGRXYWxsKGIsIGEsIHIgLSAxLCBjKTtcclxuICAgICAgICBpZiAoIWV4aXN0cyhyICsgMSwgYykpIGFkZFdhbGwoZCwgZSwgciArIDEsIGMpO1xyXG4gICAgICAgIGlmICghZXhpc3RzKHIsIGMgLSAxKSkgYWRkV2FsbChhLCBkLCByLCBjIC0gMSk7XHJcbiAgICAgICAgaWYgKCFleGlzdHMociwgYyArIDEpKSBhZGRXYWxsKGUsIGIsIHIsIGMgKyAxKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgLy8gSW5zZXJ0IHNlYS1wbGFuZSBlZGdlIGludGVyc2VjdGlvbnMgaW50byB0aGUgdG9wIHRyaWFuZ2xlcyBhcyB3ZWxsLlxyXG4gICAgLy8gQm90dG9tIGZhY2VzIGtlZXAgdGhlaXIgb3JpZ2luYWwgZWRnZXMgYmVjYXVzZSBubyBuZXcgYm90dG9tIHZlcnRleCBpcyBpbnRyb2R1Y2VkLlxyXG4gICAgZnVuY3Rpb24gY29uZm9ybVRvcCgpIHtcbi8qKlxyXG4gICAgICAgKiDlsIblt7LorrDlvZXnmoTmtbflubPpnaLkuqTngrnmj5LlhaXpobbpnaLkuInop5LlvaLlubbliJvlu7rpobbpnaLlh6DkvZXkvZPjgIJcclxuICAgICAgICpcclxuICAgICAgICog5Y+C5pWw77ya5peg44CCXHJcbiAgICAgICAqXHJcbiAgICAgICAqIOeul+azle+8mlxyXG4gICAgICAgKiAgIDEuIOS4uuS6pOWPiei+ueWIm+W7uuWFseS6q+mhtueCue+8jOaLhuWIhuebuOWFs+S4ieinkuW9ouW5tuWQiOW5tuaWsOaXp+S9jee9ruaVsOe7hOOAglxyXG4gKlxuICog6L+U5Zue77yaXHJcbiAgICAgICAqICAgcmVzdWx0OiDlkKvmtbflubPpnaLkuqTngrnjgIHms5Xnur/lkozljIXlm7TnkIPnmoTpobbpnaIgQnVmZmVyR2VvbWV0cnnjgIJcclxuICAgICAgICovXG5cclxuICAgICAgaWYgKCF0b3BDdXRzLnNpemUpIHJldHVybiBtYWtlR2VvbWV0cnkoVEhSRUUsIHRvcFBvc2l0aW9ucywgdG9wSW5kaWNlcyk7XHJcbiAgICAgIGNvbnN0IGV4dHJhID0gW107XHJcbiAgICAgIGNvbnN0IGN1dHMgPSBuZXcgTWFwKCk7XHJcbiAgICAgIGZvciAoY29uc3QgW2tleSwgY3V0XSBvZiB0b3BDdXRzKSB7XHJcbiAgICAgICAgY29uc3QgcG9pbnQgPSBbMCwgMSwgMl0ubWFwKGsgPT4gdG9wUG9zaXRpb25zW2N1dC5sb3cgKiAzICsga11cclxuICAgICAgICAgICsgKHRvcFBvc2l0aW9uc1tjdXQuaGlnaCAqIDMgKyBrXSAtIHRvcFBvc2l0aW9uc1tjdXQubG93ICogMyArIGtdKSAqIGN1dC50KTtcclxuICAgICAgICBwb2ludFsxXSA9IDA7XHJcbiAgICAgICAgY3V0cy5zZXQoa2V5LCB2ZXJ0ZXhDb3VudCArIGV4dHJhLmxlbmd0aCAvIDMpO1xyXG4gICAgICAgIGV4dHJhLnB1c2goLi4ucG9pbnQpO1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IG91dHB1dCA9IG5ldyBVaW50MzJBcnJheSh0b3BJbmRpY2VzLmxlbmd0aCArIHRvcEN1dHMuc2l6ZSAqIDE4KTtcclxuICAgICAgbGV0IG9mZnNldCA9IDA7XHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdG9wSW5kaWNlcy5sZW5ndGg7IGkgKz0gMykge1xyXG4gICAgICAgIGNvbnN0IGJvdW5kYXJ5ID0gW107XHJcbiAgICAgICAgZm9yIChsZXQgaiA9IDA7IGogPCAzOyBqKyspIHtcclxuICAgICAgICAgIGNvbnN0IGEgPSB0b3BJbmRpY2VzW2kgKyBqXSwgYiA9IHRvcEluZGljZXNbaSArIChqICsgMSkgJSAzXTtcclxuICAgICAgICAgIGJvdW5kYXJ5LnB1c2goYSk7XHJcbiAgICAgICAgICBjb25zdCBzcGxpdCA9IGN1dHMuZ2V0KE1hdGgubWluKGEsIGIpICogdmVydGV4Q291bnQgKyBNYXRoLm1heChhLCBiKSk7XHJcbiAgICAgICAgICBpZiAoc3BsaXQgIT09IHVuZGVmaW5lZCkgYm91bmRhcnkucHVzaChzcGxpdCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChib3VuZGFyeS5sZW5ndGggPT09IDMpIHsgb3V0cHV0LnNldChib3VuZGFyeSwgb2Zmc2V0KTsgb2Zmc2V0ICs9IDM7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgY29uc3QgY2VudGVyID0gWzAsIDAsIDBdO1xyXG4gICAgICAgIGZvciAoY29uc3QgaWQgb2YgYm91bmRhcnkpIGZvciAobGV0IGsgPSAwOyBrIDwgMzsgaysrKSB7XHJcbiAgICAgICAgICBjZW50ZXJba10gKz0gKGlkIDwgdmVydGV4Q291bnQgPyB0b3BQb3NpdGlvbnNbaWQgKiAzICsga10gOiBleHRyYVsoaWQgLSB2ZXJ0ZXhDb3VudCkgKiAzICsga10pIC8gYm91bmRhcnkubGVuZ3RoO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjZW50ZXJJZCA9IHZlcnRleENvdW50ICsgZXh0cmEubGVuZ3RoIC8gMztcclxuICAgICAgICBleHRyYS5wdXNoKC4uLmNlbnRlcik7XHJcbiAgICAgICAgZm9yIChsZXQgaiA9IDA7IGogPCBib3VuZGFyeS5sZW5ndGg7IGorKykge1xyXG4gICAgICAgICAgb3V0cHV0LnNldChbY2VudGVySWQsIGJvdW5kYXJ5W2pdLCBib3VuZGFyeVsoaiArIDEpICUgYm91bmRhcnkubGVuZ3RoXV0sIG9mZnNldCk7XHJcbiAgICAgICAgICBvZmZzZXQgKz0gMztcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgcG9zaXRpb25zID0gbmV3IEZsb2F0MzJBcnJheSh0b3BQb3NpdGlvbnMubGVuZ3RoICsgZXh0cmEubGVuZ3RoKTtcclxuICAgICAgcG9zaXRpb25zLnNldCh0b3BQb3NpdGlvbnMpOyBwb3NpdGlvbnMuc2V0KGV4dHJhLCB0b3BQb3NpdGlvbnMubGVuZ3RoKTtcclxuICAgICAgcmV0dXJuIG1ha2VHZW9tZXRyeShUSFJFRSwgcG9zaXRpb25zLCBvdXRwdXQuc2xpY2UoMCwgb2Zmc2V0KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICB0b3A6IGNvbmZvcm1Ub3AoKSxcclxuICAgICAgYm90dG9tOiBjb21wYWN0Qm90dG9tUG9zaXRpb25zXG4gICAgICAgID8gbWFrZUdlb21ldHJ5KFRIUkVFLCBjb21wYWN0Qm90dG9tUG9zaXRpb25zLCBjb21wYWN0Qm90dG9tSW5kaWNlcylcbiAgICAgICAgOiBtYWtlR2VvbWV0cnkoVEhSRUUsIGJvdHRvbVBvc2l0aW9ucywgYm90dG9tSW5kaWNlcyksXG4gICAgICB3YWxsczogbWFrZUdlb21ldHJ5KFRIUkVFLCBuZXcgRmxvYXQzMkFycmF5KHdhbGxzKSksXHJcbiAgICAgIGJvdW5kYXJ5RWRnZXMsXHJcbiAgICAgIHdhbGxUcmlhbmdsZXM6IHdhbGxzLmxlbmd0aCAvIDksXHJcbiAgICAgIGJhc2VFbGV2YXRpb246IEJBU0VfRUxFVkFUSU9OLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIC8vIEZvdXItY29ubmVjdGVkIGZsb29kIGZpbGwgZXhjbHVkZXMgZW5jbG9zZWQgaW5sYW5kIGRhdGEgaG9sZXMuXHJcbiAgLy8gVGhpcyBpcyBhIHNlYSByZW5kZXJpbmcgYXNzdW1wdGlvbiwgbm90IGEgbWVhc3VyZWQgc2hvcmVsaW5lLlxyXG4gIGZ1bmN0aW9uIHNlYU1hc2sobGFuZCwgcm93cywgY29scykge1xuLyoqXHJcbiAgICAgKiDku47mjqnnoIHovrnnlYzov5vooYzlm5vpgrvmjqXms5vmtKrvvIzor4bliKvkuI7lpJbovrnnlYzov57pgJrnmoTmtbfln5/ljZXlhYPjgIJcclxuICAgICAqXHJcbiAgICAgKiDlj4LmlbDvvJpcclxuICAgICAqICAgbGFuZDog6KGM5LyY5YWI6ZmG5Zyw5Y2V5YWD5o6p56CB77yM6ZW/5bqm5Li6IGAocm93cyAtIDEpICogKGNvbHMgLSAxKWDjgIJcclxuICAgICAqICAgcm93czog6aG254K5572R5qC86KGM5pWw77yb5rW35Z+f5o6p56CB5pyJIHJvd3MgLSAxIOihjOOAglxyXG4gICAgICogICBjb2xzOiDpobbngrnnvZHmoLzliJfmlbDvvJvmtbfln5/mjqnnoIHmnIkgY29scyAtIDEg5YiX44CCXHJcbiAgICAgKlxyXG4gICAgICog566X5rOV77yaXHJcbiAgICAgKiAgIDEuIOS7jumdnumZhuWcsOi+ueeVjOWNleWFg+W8gOWni+Wbm+WQkeaJqeWxle+8jOWwgemXreWGhemZhiBOb0RhdGEg5rSe5LiN5Lya6KKr57qz5YWl44CCXHJcbiAqXG4gKiDov5Tlm57vvJpcclxuICAgICAqICAgcmVzdWx0OiBVaW50OEFycmF5IOa1t+Wfn+WNleWFg+aOqeegge+8m+i/meaYr+a4suafk+WBh+iuvu+8jOS4jeS7o+ihqOWunua1i+WyuOe6v+OAglxyXG4gICAgICovXG5cclxuICAgIGNvbnN0IGhlaWdodCA9IHJvd3MgLSAxLCB3aWR0aCA9IGNvbHMgLSAxO1xyXG4gICAgY29uc3Qgc2VhID0gbmV3IFVpbnQ4QXJyYXkoaGVpZ2h0ICogd2lkdGgpO1xyXG4gICAgY29uc3QgcXVldWUgPSBuZXcgVWludDMyQXJyYXkoc2VhLmxlbmd0aCk7XHJcbiAgICBsZXQgaGVhZCA9IDAsIHRhaWwgPSAwO1xyXG4gICAgZnVuY3Rpb24gdmlzaXQociwgYykge1xuLyoqXHJcbiAgICAgICAqIOWwhuiMg+WbtOWGheacquiuv+mXrueahOmdnumZhuWcsOWNleWFg+WKoOWFpea1t+Wfn+azm+a0qumYn+WIl+OAglxyXG4gICAgICAgKlxyXG4gICAgICAgKiDlj4LmlbDvvJpcclxuICAgICAgICogICByOiDljZXlhYPnvZHmoLzooYzntKLlvJXvvIzojIPlm7TkuLogMCDliLAgcm93cyAtIDLjgIJcclxuICAgICAgICogICBjOiDljZXlhYPnvZHmoLzliJfntKLlvJXvvIzojIPlm7TkuLogMCDliLAgY29scyAtIDLjgIJcclxuICAgICAgICpcclxuICAgICAgICog566X5rOV77yaXHJcbiAgICAgICAqICAgMS4g6Lez6L+H6LaK55WM44CB6ZmG5Zyw5oiW5bey6K6/6Zeu5Y2V5YWD77yb5YW25L2Z5Y2V5YWD5qCH6K6w5bm25YWl6Zif44CCXHJcbiAqXG4gKiDov5Tlm57vvJpcclxuICAgICAgICogICB1bmRlZmluZWQ6IOWOn+S9jeabtOaWsOa1t+Wfn+aOqeeggeWSjOmYn+WIl+OAglxyXG4gICAgICAgKi9cblxyXG4gICAgICBpZiAociA8IDAgfHwgYyA8IDAgfHwgciA+PSBoZWlnaHQgfHwgYyA+PSB3aWR0aCkgcmV0dXJuO1xyXG4gICAgICBjb25zdCBpID0gciAqIHdpZHRoICsgYztcclxuICAgICAgaWYgKGxhbmRbaV0gfHwgc2VhW2ldKSByZXR1cm47XHJcbiAgICAgIHNlYVtpXSA9IDE7XHJcbiAgICAgIHF1ZXVlW3RhaWwrK10gPSBpO1xyXG4gICAgfVxyXG4gICAgZm9yIChsZXQgYyA9IDA7IGMgPCB3aWR0aDsgYysrKSB7IHZpc2l0KDAsIGMpOyB2aXNpdChoZWlnaHQgLSAxLCBjKTsgfVxyXG4gICAgZm9yIChsZXQgciA9IDA7IHIgPCBoZWlnaHQ7IHIrKykgeyB2aXNpdChyLCAwKTsgdmlzaXQociwgd2lkdGggLSAxKTsgfVxyXG4gICAgd2hpbGUgKGhlYWQgPCB0YWlsKSB7XHJcbiAgICAgIGNvbnN0IGkgPSBxdWV1ZVtoZWFkKytdLCByID0gTWF0aC5mbG9vcihpIC8gd2lkdGgpLCBjID0gaSAlIHdpZHRoO1xyXG4gICAgICB2aXNpdChyIC0gMSwgYyk7IHZpc2l0KHIgKyAxLCBjKTsgdmlzaXQociwgYyAtIDEpOyB2aXNpdChyLCBjICsgMSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VhO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gc3VyZmFjZUluZGljZXMobWFzaywgcm93cywgY29scykge1xuLyoqXHJcbiAgICAgKiDlsIbmnInmlYjljZXlhYPmjqnnoIHlsZXlvIDkuLrlnLDooajkuInop5LlvaLntKLlvJXjgIJcclxuICAgICAqXHJcbiAgICAgKiDlj4LmlbDvvJpcclxuICAgICAqICAgbWFzazog6KGM5LyY5YWI5Y2V5YWD5o6p56CB77yM6ZW/5bqm5Li6IGAocm93cyAtIDEpICogKGNvbHMgLSAxKWDjgIJcclxuICAgICAqICAgcm93czog6aG254K5572R5qC86KGM5pWw77yb6KGM6L205a+55bqU5LiW55WMIFog6L2044CCXHJcbiAgICAgKiAgIGNvbHM6IOmhtueCuee9keagvOWIl+aVsO+8m+WIl+i9tOWvueW6lOS4lueVjCBYIOi9tOOAglxyXG4gICAgICpcclxuICAgICAqIOeul+azle+8mlxyXG4gICAgICogICAxLiDmr4/kuKrmnInmlYjlm5vovrnlvaLmjInlm7rlrprlr7nop5Lnur/mi4bliIbkuLrkuKTkuKrkuInop5LlvaLjgIJcclxuICpcbiAqIOi/lOWbnu+8mlxyXG4gICAgICogICByZXN1bHQ6IFVpbnQzMkFycmF577yM5q+P5Liq5pyJ5pWI5Y2V5YWD5a+55bqU5YWt5Liq6aG254K557Si5byV44CCXHJcbiAgICAgKi9cblxyXG4gICAgbGV0IGNlbGxDb3VudCA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IGNlbGwgb2YgbWFzaykgY2VsbENvdW50ICs9IGNlbGw7XHJcbiAgICBjb25zdCBpbmRpY2VzID0gbmV3IFVpbnQzMkFycmF5KGNlbGxDb3VudCAqIDYpO1xyXG4gICAgbGV0IG9mZnNldCA9IDA7XHJcbiAgICBmb3IgKGxldCByID0gMDsgciA8IHJvd3MgLSAxOyByKyspIHtcclxuICAgICAgZm9yIChsZXQgYyA9IDA7IGMgPCBjb2xzIC0gMTsgYysrKSB7XHJcbiAgICAgICAgaWYgKCFtYXNrW3IgKiAoY29scyAtIDEpICsgY10pIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IGEgPSByICogY29scyArIGMsIGIgPSBhICsgMSwgZCA9IGEgKyBjb2xzLCBlID0gZCArIDE7XHJcbiAgICAgICAgaW5kaWNlcy5zZXQoW2EsIGQsIGIsIGIsIGQsIGVdLCBvZmZzZXQpO1xyXG4gICAgICAgIG9mZnNldCArPSA2O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gaW5kaWNlcztcclxuICB9XHJcblxyXG4gIHJldHVybiB7Y2xvc2VTdXJmYWNlLCBtYWtlR2VvbWV0cnksIHN5bmNocm9uaXplTm9ybWFscywgc2VhTWFzaywgc3VyZmFjZUluZGljZXMsIEJBU0VfRUxFVkFUSU9OfTtcbn0pKCk7XG4iXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQUEsTUFBTSxDQUFDQyxVQUFVLEdBQUcsQ0FBQyxNQUFNO0VBQ3pCO0VBQ0EsTUFBTUMsY0FBYyxHQUFHLENBQUMsR0FBRztFQUUzQixTQUFTQyxZQUFZQSxDQUFDQyxLQUFLLEVBQUVDLFNBQVMsRUFBRUMsT0FBTyxFQUFFO0lBQ25EO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0lBRUksTUFBTUMsUUFBUSxHQUFHLElBQUlILEtBQUssQ0FBQ0ksY0FBYyxDQUFD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
