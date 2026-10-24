// Closed terrain geometry with a fixed bottom elevation.
// Coordinates are metres: x east, y up, z south. The parent object applies vertical exaggeration.
window.NotoVolume = (function createNotoVolume() {
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
    BASE_ELEVATION,
    workerSource: createNotoVolume.toString()
  };
})();
