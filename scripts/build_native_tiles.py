#!/usr/bin/env python3
"""Build native, quantized terrain tiles for the COMP 5411 viewer.

The source rasters are read in strips, then represented by a uint16 grid:
``0`` is -100 m and one count is 0.01 m.  This keeps the 1 m source out of
memory while producing deterministic, gzip-compressed JavaScript tile files.

Example::

    python build_native_tiles.py --source input.tif --spacing 1 \
        --output ../data/terrain-1m --name terrain-1m

The generated directory contains ``manifest.js`` and ``L{level}/{x}_{z}.js``
tile files.  A manifest is deliberately self-contained so the application can
load one resolution without reading GeoTIFF at run time.
"""

from __future__ import annotations

import argparse
import base64
import collections
import gzip
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np

try:
    import rasterio
    from rasterio.windows import Window
except ImportError as exc:  # pragma: no cover - a clear CLI error is enough
    raise SystemExit(
        "rasterio is required; use the bundled raster_deps directory as "
        "PYTHONPATH"
    ) from exc


# Input elevations are metres; quantize relative to the datum before writing unsigned 16-bit values.
BASE_ELEVATION_M = -100.0  # Elevation corresponding to uint16 zero, in metres.
QUANTIZATION_M = 0.01  # Elevation increment per integer count, in metres.
NODATA_U16 = np.uint16(65535)  # Reserved marker for missing or unrepresentable nodes.
TILE_CELLS = 256  # Default number of cells per tile side.
# Crop pixel-centre bounds for the COMP 5411 display region, in projected metres.
TARGET_LEFT_CENTER = -14767.5
TARGET_RIGHT_CENTER = 18457.5
TARGET_BOTTOM_CENTER = 147947.5
TARGET_TOP_CENTER = 171082.5


def cli() -> argparse.Namespace:
    """Parse required source GeoTIFF, spacing, output and dataset-name arguments, plus optional tile-cell count. Return an argparse Namespace."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--spacing", required=True, type=float)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--tile-cells", type=int, default=TILE_CELLS)
    return parser.parse_args()


def close_enough(a: float, b: float, tolerance: float = 1e-4) -> bool:
    """Return abs(a-b) <= tolerance. Both values and the default 1e-4 absolute tolerance use the same units."""
    return abs(a - b) <= tolerance


def crop_window(ds: rasterio.DatasetReader, spacing: float) -> Tuple[Window, int, int]:
    """Compute a crop window aligned with project pixel-centre bounds. Validate requested metric spacing and north-up transform, derive integer offsets and check overlap. Return Window, row count and column count."""
    if not close_enough(ds.res[0], spacing) or not close_enough(ds.res[1], spacing):
        raise ValueError(
            f"source resolution {ds.res} does not match --spacing {spacing}"
        )
    if (
        ds.transform.b != 0
        or ds.transform.d != 0
        or ds.transform.a <= 0
        or ds.transform.e >= 0
    ):
        raise ValueError("expected a north-up raster")

    source_x0 = ds.transform.c + ds.transform.a / 2.0
    source_y0 = ds.transform.f + ds.transform.e / 2.0
    col0_float = (TARGET_LEFT_CENTER - source_x0) / spacing
    row0_float = (source_y0 - TARGET_TOP_CENTER) / (-ds.transform.e)
    col0 = int(round(col0_float))
    row0 = int(round(row0_float))
    cols = int(round((TARGET_RIGHT_CENTER - TARGET_LEFT_CENTER) / spacing)) + 1
    rows = int(round((TARGET_TOP_CENTER - TARGET_BOTTOM_CENTER) / spacing)) + 1
    if not close_enough(col0_float, col0) or not close_enough(row0_float, row0):
        raise ValueError(
            "the requested display bounds do not fall on source pixel centers"
        )
    if col0 < 0 or row0 < 0 or col0 + cols > ds.width or row0 + rows > ds.height:
        raise ValueError(
            f"crop ({col0}, {row0}, {cols}, {rows}) falls outside "
            f"source ({ds.width}, {ds.height})"
        )
    return Window(col0, row0, cols, rows), rows, cols


def valid_source_values(values: np.ndarray, nodata: float | None) -> np.ndarray:
    """Return a boolean validity mask for metric elevations: require finite values and exclude a finite NoData marker when supplied."""
    valid = np.isfinite(values)
    if nodata is not None and np.isfinite(nodata):
        valid &= values != nodata
    return valid


def quantize_source(
    ds: rasterio.DatasetReader,
    window: Window,
    output_path: Path,
    batch_rows: int = 512,
) -> Dict[str, float | int]:
    """Read the crop in batches (default 512 rows) into a little-endian uint16 memory map initialized to NoData. Quantize valid metre elevations, record range/count/overflow/error statistics and flush the file. Return statistics with elevations in metres."""
    rows, cols = int(window.height), int(window.width)
    grid = np.memmap(output_path, dtype="<u2", mode="w+", shape=(rows, cols))
    grid[:] = NODATA_U16
    stats: Dict[str, float | int] = {
        "valid_node_count": 0,
        "invalid_node_count": rows * cols,
        "elevation_min_m": math.inf,
        "elevation_max_m": -math.inf,
        "max_quantization_error_m": 0.0,
        "out_of_range_node_count": 0,
    }
    nodata = ds.nodata
    for local_r in range(0, rows, batch_rows):
        height = min(batch_rows, rows - local_r)
        read_window = Window(window.col_off, window.row_off + local_r, cols, height)
        values = ds.read(1, window=read_window, out_dtype="float32")
        valid = valid_source_values(values, nodata)
        q_float = np.rint(
            (values.astype(np.float64) - BASE_ELEVATION_M) / QUANTIZATION_M
        )
        in_range = (q_float >= 0.0) & (q_float < 65535.0)
        valid &= in_range
        stats["out_of_range_node_count"] = int(stats["out_of_range_node_count"]) + int(
            np.count_nonzero(valid_source_values(values, nodata) & ~in_range)
        )
        if np.any(valid):
            q = q_float[valid].astype("<u2")
            grid[local_r : local_r + height, :][valid] = q
            source_valid_values = values[valid].astype(np.float64)
            dequantized = q.astype(np.float64) * QUANTIZATION_M + BASE_ELEVATION_M
            error = np.max(np.abs(dequantized - source_valid_values))
            stats["max_quantization_error_m"] = max(
                float(stats["max_quantization_error_m"]), float(error)
            )
            stats["valid_node_count"] = int(stats["valid_node_count"]) + int(q.size)
            stats["elevation_min_m"] = min(
                float(stats["elevation_min_m"]), float(np.min(dequantized))
            )
            stats["elevation_max_m"] = max(
                float(stats["elevation_max_m"]), float(np.max(dequantized))
            )
    stats["invalid_node_count"] = rows * cols - int(stats["valid_node_count"])
    grid.flush()
    return stats


def apply_bounded_edge_repair(grid: np.memmap, spacing: float) -> int:
    """Close small crop-edge NoData gaps for display geometry only.

    grid is a little-endian uint16 memory map with 0.01 m quantization;
    spacing is metres. Inspect snapshots of the four original edges. Fill a
    missing run only if its first valid sample is within 25 physical metres
    and above 1 m elevation. Flush and return the number of changed nodes.
    The original GeoTIFF remains unchanged; the manifest records repairs."""
    rows, cols = grid.shape
    max_depth = max(1, int(round(25.0 / spacing)))
    repair_count = 0

    # Use snapshots so a corner repaired by one edge cannot influence another.
    top = np.array(grid[: max_depth + 1, :], copy=True)
    bottom = np.array(grid[max(0, rows - max_depth - 1) :, :], copy=True)
    left = np.array(grid[:, : max_depth + 1], copy=True)
    right = np.array(grid[:, max(0, cols - max_depth - 1) :], copy=True)

    def fill_edge(snapshot: np.ndarray, reverse: bool, setter) -> int:
        """Inspect an edge snapshot for bounded missing runs, optionally from its reverse end. If depth/elevation conditions pass, call setter per missing node. Return the number of confirmed writes."""
        repaired = 0
        depth_count, edge_count = snapshot.shape
        for edge_i in range(edge_count):
            sequence = snapshot[:, edge_i]
            if reverse:
                sequence = sequence[::-1]
            valid_indices = np.flatnonzero(sequence != NODATA_U16)
            if valid_indices.size == 0:
                continue
            depth = int(valid_indices[0])
            if depth == 0 or depth > max_depth:
                continue
            value = int(sequence[depth])
            if value <= int(round((1.0 - BASE_ELEVATION_M) / QUANTIZATION_M)):
                continue
            for d in range(depth):
                if setter(edge_i, d, value, reverse):
                    repaired += 1
        return repaired

    def set_top(edge_i: int, depth: int, value: int, reverse: bool) -> bool:
        """Write a quantized candidate to a northern edge node only if still NoData. edge_i is a column and depth is inward row offset; reverse is unused. Return whether changed."""
        del reverse
        if grid[depth, edge_i] == NODATA_U16:
            grid[depth, edge_i] = value
            return True
        return False

    def set_bottom(edge_i: int, depth: int, value: int, reverse: bool) -> bool:
        """Write a quantized candidate to a southern edge node only if still NoData. Convert inward depth to the row counted from north; edge_i is a column and reverse is unused. Return whether changed."""
        del reverse
        target_r = rows - 1 - depth
        if grid[target_r, edge_i] == NODATA_U16:
            grid[target_r, edge_i] = value
            return True
        return False

    def set_left(edge_i: int, depth: int, value: int, reverse: bool) -> bool:
        """Write a quantized candidate to a western edge node only if still NoData. edge_i is a row and depth is inward column offset; reverse is unused. Return whether changed."""
        del reverse
        if grid[edge_i, depth] == NODATA_U16:
            grid[edge_i, depth] = value
            return True
        return False

    def set_right(edge_i: int, depth: int, value: int, reverse: bool) -> bool:
        """Write a quantized candidate to an eastern edge node only if still NoData. Convert inward depth to the column counted from west; edge_i is a row and reverse is unused. Return whether changed."""
        del reverse
        target_c = cols - 1 - depth
        if grid[edge_i, target_c] == NODATA_U16:
            grid[edge_i, target_c] = value
            return True
        return False

    repair_count += fill_edge(top, False, set_top)
    repair_count += fill_edge(bottom, True, set_bottom)
    repair_count += fill_edge(left.T, False, set_left)
    repair_count += fill_edge(right.T, True, set_right)
    grid.flush()
    return repair_count


def axis_for_interval(start: int, end: int, step: int) -> np.ndarray:
    """Generate integer sample indices for closed interval [start,end] at step spacing, always including the final endpoint. Return a NumPy integer array."""
    values = np.arange(start, end + 1, step, dtype=np.int64)
    if values.size == 0 or int(values[-1]) != end:
        values = np.append(values, np.int64(end))
    return values


def level_shape(size: int, step: int) -> Tuple[np.ndarray, int]:
    """Construct a pyramid-level axis from a source node count and native-node step. Preserve both endpoints and calculate the tile count using TILE_CELLS. Return axis and count."""
    axis = axis_for_interval(0, size - 1, step)
    tile_span = TILE_CELLS * step
    tiles = max(1, math.ceil((size - 1) / tile_span))
    return axis, tiles


def b64gzip(data: bytes) -> str:
    """Encode bytes as deterministic gzip (level 6, mtime 0), then ASCII Base64. Return a string."""
    return base64.b64encode(
        gzip.compress(data, compresslevel=6, mtime=0)
    ).decode("ascii")


def wrapped_b64(value: str, width: int = 100) -> str:
    """Wrap Base64 text at the requested character width (default 100). Return newline-separated chunks."""
    # The JavaScript source remains readable in source control and avoids one
    # visually unbounded line per tile.
    return "\n".join(value[i : i + width] for i in range(0, len(value), width))


def write_tile(
    path: Path,
    tile_id: str,
    values: np.ndarray,
    step: int,
    r0: int,
    r1: int,
    c0: int,
    c1: int,
) -> None:
    """Write a JavaScript height-tile payload. Encode row-major values as little-endian uint16, gzip and Base64; include tile ID, dimensions, native step and inclusive r0/r1/c0/c1 bounds. Create parent directories and write UTF-8 with LF endings."""
    encoded = wrapped_b64(b64gzip(np.asarray(values, dtype="<u2").tobytes(order="C")))
    chunks = encoded.split("\n")
    heights = json.dumps(chunks[0])
    if len(chunks) > 1:
        heights += "\n" + "\n".join("+" + json.dumps(chunk) for chunk in chunks[1:])
    text = (
        "// Generated by build_native_tiles.py; uint16 LE, gzip, base64.\n"
        "window.NOTO_TILE_RECEIVE("
        + json.dumps(tile_id, separators=(",", ":"))
        + ",{\"rows\":"
        + str(int(values.shape[0]))
        + ",\"cols\":"
        + str(int(values.shape[1]))
        + ",\"step\":"
        + str(int(step))
        + ",\"r0\":"
        + str(int(r0))
        + ",\"r1\":"
        + str(int(r1))
        + ",\"c0\":"
        + str(int(c0))
        + ",\"c1\":"
        + str(int(c1))
        + ",\"heights\":"
        + heights
        + "});\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def tile_range(
    tile_index: int,
    tile_count: int,
    size: int,
    step: int,
) -> Tuple[int, int]:
    """Compute native start/end indices for a tile along one axis using TILE_CELLS and step. Clamp to the final source node. tile_count is retained for interface compatibility."""
    del tile_count
    start = tile_index * TILE_CELLS * step
    end = min((tile_index + 1) * TILE_CELLS * step, size - 1)
    return start, end


def finite_minmax(values: np.ndarray) -> Tuple[float | None, float | None]:
    """Find valid elevation bounds in a quantized array, excluding NODATA_U16. Decode and round to centimetres. Return (None,None) if no valid nodes remain."""
    valid = values[values != NODATA_U16]
    if valid.size == 0:
        return None, None
    return (
        round(
            float(np.min(valid).astype(np.float64) * QUANTIZATION_M + BASE_ELEVATION_M),
            2,
        ),
        round(
            float(np.max(valid).astype(np.float64) * QUANTIZATION_M + BASE_ELEVATION_M),
            2,
        ),
    )


def build_tiles(
    grid: np.memmap,
    output: Path,
    name: str,
    spacing: float,
    source_metadata: dict,
    stats: Dict[str, float | int],
    tile_cells: int,
) -> Tuple[dict, Dict[str, dict]]:
    """Generate multiresolution tiles from a quantized memory map. Build level axes/layouts, measure native coverage exactly, aggregate conservative coarser coverage and write non-water payloads. tile_cells controls this run; source_metadata/stats are retained but unused parameters. Return level metadata and tile descriptors."""
    global TILE_CELLS
    TILE_CELLS = tile_cells
    rows, cols = grid.shape
    max_level = 0
    while True:
        step = 2**max_level
        _, tx = level_shape(cols, step)
        _, tz = level_shape(rows, step)
        if tx <= 2 and tz <= 2:
            break
        max_level += 1
    # Keep one extra overview when both axes would otherwise end at a 2 x 2
    # tile grid.  This gives the 5 m crop a single overview tile, while the
    # 1 m crop intentionally stops at its useful 2 x 1 overview.
    if tx == 2 and tz == 2:
        max_level += 1

    levels: List[dict] = []
    descriptors: Dict[str, dict] = {}
    level_axes: Dict[int, Tuple[np.ndarray, np.ndarray, int, int]] = {}
    for level in range(max_level + 1):
        step = 2**level
        x_axis, tiles_x = level_shape(cols, step)
        z_axis, tiles_z = level_shape(rows, step)
        level_axes[level] = (x_axis, z_axis, tiles_x, tiles_z)
        levels.append(
            {
                "level": level,
                "step": step,
                "cols": int(x_axis.size),
                "rows": int(z_axis.size),
                "tilesX": int(tiles_x),
                "tilesZ": int(tiles_z),
            }
        )

    # Level 0 gives exact native coverage. Higher levels aggregate level-0
    # tile ranges for kind/hasLand/min/max while sampling only their LOD grid.
    level_zero: Dict[Tuple[int, int], dict] = {}
    for level in range(max_level + 1):
        x_axis, z_axis, tiles_x, tiles_z = level_axes[level]
        step = 2**level
        for z in range(tiles_z):
            r0, r1 = tile_range(z, tiles_z, rows, step)
            z_indices = axis_for_interval(r0, r1, step)
            for x in range(tiles_x):
                c0, c1 = tile_range(x, tiles_x, cols, step)
                x_indices = axis_for_interval(c0, c1, step)
                tile_nodes = np.asarray(grid[np.ix_(z_indices, x_indices)])
                native_valid = tile_nodes != NODATA_U16
                # For level 0 this is exact. For coarser levels, the full
                # source coverage is the corresponding rectangle of level-0
                # tiles, so a tiny valid island is retained in hasLand.
                if level == 0:
                    has_land = bool(np.any(native_valid))
                    all_valid = bool(np.all(native_valid))
                    tile_min, tile_max = finite_minmax(tile_nodes)
                else:
                    base_span = 2**level
                    base_x0 = x * base_span
                    base_z0 = z * base_span
                    base_x1 = min((x + 1) * base_span, level_axes[0][2])
                    base_z1 = min((z + 1) * base_span, level_axes[0][3])
                    covered = [
                        level_zero[(bx, bz)]
                        for bz in range(base_z0, base_z1)
                        for bx in range(base_x0, base_x1)
                    ]
                    has_land = any(d["hasLand"] for d in covered)
                    all_valid = all(d["kind"] == "land" for d in covered)
                    mins = [d["min"] for d in covered if d["min"] is not None]
                    maxs = [d["max"] for d in covered if d["max"] is not None]
                    tile_min = min(mins) if mins else None
                    tile_max = max(maxs) if maxs else None
                kind = "land" if all_valid else ("mixed" if has_land else "water")
                tile_id = f"{level}/{x}/{z}"
                descriptor = {
                    "level": level,
                    "x": x,
                    "z": z,
                    "rows": int(z_indices.size),
                    "cols": int(x_indices.size),
                    "r0": int(r0),
                    "r1": int(r1),
                    "c0": int(c0),
                    "c1": int(c1),
                    "min": tile_min,
                    "max": tile_max,
                    "kind": kind,
                    "hasLand": has_land,
                }
                if kind != "water":
                    descriptor["file"] = f"L{level}/{x}_{z}.js"
                descriptors[tile_id] = descriptor
                if level == 0:
                    level_zero[(x, z)] = descriptor
                if kind != "water":
                    write_tile(
                        output / f"L{level}" / f"{x}_{z}.js",
                        tile_id,
                        tile_nodes,
                        step,
                        r0,
                        r1,
                        c0,
                        c1,
                    )
        print(f"{name}: generated L{level} ({tiles_x} x {tiles_z} tiles)", flush=True)

    return {"maxLevel": max_level, "levels": levels}, descriptors


def build_ocean_mask(grid: np.memmap, spacing: float) -> dict:
    """Build an ocean mask from boundary-connected NoData. Sample at about 25 m; only cells with four valid corners are land. Flood nonland cells from the outer boundary with four-neighbor connectivity, pack little-endian bits and encode Base64. Return dimensions, step, counts and payload."""
    step_native = max(1, int(round(25.0 / spacing)))
    cols_axis = axis_for_interval(0, grid.shape[1] - 1, step_native)
    rows_axis = axis_for_interval(0, grid.shape[0] - 1, step_native)
    sample = np.asarray(grid[np.ix_(rows_axis, cols_axis)])
    valid = sample != NODATA_U16
    # A cell is land only when all four corner nodes are valid.  Flooding the
    # complement from the outer cell boundary preserves interior NoData holes
    # as unknown terrain instead of silently turning them into ocean.
    land_cells = valid[:-1, :-1] & valid[1:, :-1] & valid[:-1, 1:] & valid[1:, 1:]
    ocean = np.zeros(land_cells.shape, dtype=np.bool_)
    unknown = ~land_cells
    queue: collections.deque[int] = collections.deque()
    row_count, col_count = land_cells.shape

    def enqueue(r: int, c: int) -> None:
        """Mark an unvisited nonland cell as sea and append its flat row-major index to the flood queue. Updates the enclosing ocean mask and queue."""
        if unknown[r, c] and not ocean[r, c]:
            ocean[r, c] = True
            queue.append(r * col_count + c)

    for c in range(col_count):
        enqueue(0, c)
        enqueue(row_count - 1, c)
    for r in range(row_count):
        enqueue(r, 0)
        enqueue(r, col_count - 1)
    while queue:
        linear = queue.popleft()
        r, c = divmod(linear, col_count)
        if r:
            enqueue(r - 1, c)
        if r + 1 < row_count:
            enqueue(r + 1, c)
        if c:
            enqueue(r, c - 1)
        if c + 1 < col_count:
            enqueue(r, c + 1)

    packed = np.packbits(ocean.ravel(), bitorder="little").tobytes()
    return {
        "step": step_native,
        "rows": int(row_count),
        "cols": int(col_count),
        "bits": b64gzip(packed),
        "landCellCount": int(np.count_nonzero(land_cells)),
        "oceanCellCount": int(np.count_nonzero(ocean)),
        "encoding": "boundary-connected NoData cell mask; packed little-endian bits",
    }


def validate_tiles(
    grid: np.memmap,
    output: Path,
    descriptors: Dict[str, dict],
    level_meta: dict,
) -> dict:
    """Verify same-level row/column continuity and round-trip representative first/last payloads against the quantized source grid. Return continuity, decode and tile-count statistics."""
    by_level: Dict[int, List[dict]] = collections.defaultdict(list)
    for descriptor in descriptors.values():
        by_level[int(descriptor["level"])].append(descriptor)
    continuity_checks = 0
    for level, items in by_level.items():
        for descriptor in items:
            for other in items:
                if descriptor["z"] == other["z"] and descriptor["x"] + 1 == other["x"]:
                    if descriptor["c1"] != other["c0"]:
                        raise AssertionError(
                            f"x gap at L{level}: {descriptor} / {other}"
                        )
                    continuity_checks += 1
                if descriptor["x"] == other["x"] and descriptor["z"] + 1 == other["z"]:
                    if descriptor["r1"] != other["r0"]:
                        raise AssertionError(
                            f"z gap at L{level}: {descriptor} / {other}"
                        )
                    continuity_checks += 1

    candidates = [d for d in descriptors.values() if d["kind"] != "water"]
    roundtrip_checks = 0
    for descriptor in candidates[:1] + (candidates[-1:] if len(candidates) > 1 else []):
        step = 2 ** int(descriptor["level"])
        z_indices = axis_for_interval(descriptor["r0"], descriptor["r1"], step)
        x_indices = axis_for_interval(descriptor["c0"], descriptor["c1"], step)
        expected = np.asarray(grid[np.ix_(z_indices, x_indices)], dtype="<u2")
        tile_path = (
            output
            / f"L{descriptor['level']}"
            / f"{descriptor['x']}_{descriptor['z']}.js"
        )
        text = tile_path.read_text(encoding="utf-8")
        heights_section = text.split('"heights":', 1)[1].split("}", 1)[0]
        encoded = "".join(re.findall(r'"([^"]*)"', heights_section))
        actual = np.frombuffer(
            gzip.decompress(base64.b64decode(encoded)), dtype="<u2"
        ).reshape(expected.shape)
        if not np.array_equal(actual, expected):
            raise AssertionError(
                f"payload mismatch for {descriptor['level']}/{descriptor['x']}/"
                f"{descriptor['z']}"
            )
        roundtrip_checks += 1
    return {
        "continuityChecks": continuity_checks,
        "roundtripChecks": roundtrip_checks,
        "tileDescriptorCount": len(descriptors),
        "payloadTileCount": len(candidates),
        "maxLevel": int(level_meta["maxLevel"]),
    }


def write_manifest(
    output: Path,
    name: str,
    source: Path,
    spacing: float,
    window: Window,
    rows: int,
    cols: int,
    stats: Dict[str, float | int],
    level_meta: dict,
    descriptors: Dict[str, dict],
    ocean_mask: dict,
    edge_repair_pixels: int,
    tile_cells: int,
    raster_width: int,
    raster_height: int,
) -> None:
    """Write a self-contained manifest.js containing source/crop/quantization metadata, repair counts, levels, tile descriptors and the ocean mask. Serialize indented JSON with segmented Base64 strings, using UTF-8 and LF endings."""
    source_label = source.name
    if "JGD2024" in source_label:
        datum = "JGD2024 / EPSG:6675 alias"
    else:
        datum = "JGD2011 / EPSG:6675"
    metadata = {
        "source": source_label,
        "sourcePath": "./" + source.relative_to(Path(__file__).resolve().parents[1]).as_posix()
        if source.is_relative_to(Path(__file__).resolve().parents[1]) else source.name,
        "source_spacing_m": [spacing, spacing],
        "source_width": cols,
        "source_height": rows,
        "source_raster_width": raster_width,
        "source_raster_height": raster_height,
        "width_m": (cols - 1) * spacing,
        "height_m": (rows - 1) * spacing,
        "origin_easting": 1845.0,
        "origin_northing": 159515.0,
        "baseElevation": BASE_ELEVATION_M,
        "elevation_min_m": round(float(stats["elevation_min_m"]), 2),
        "elevation_max_m": round(float(stats["elevation_max_m"]), 2),
        "quantization_m": QUANTIZATION_M,
        "sourceDatum": datum,
        "crop_window": {
            "col_off": int(window.col_off),
            "row_off": int(window.row_off),
            "width": cols,
            "height": rows,
        },
        "display_centers": {
            "left": TARGET_LEFT_CENTER,
            "right": TARGET_RIGHT_CENTER,
            "bottom": TARGET_BOTTOM_CENTER,
            "top": TARGET_TOP_CENTER,
        },
        "valid_node_count": int(stats["valid_node_count"]),
        "invalid_node_count": int(stats["invalid_node_count"]),
        "max_quantization_error_m": round(float(stats["max_quantization_error_m"]), 6),
        "out_of_range_node_count": int(stats["out_of_range_node_count"]),
        "boundary_repair_pixels": int(edge_repair_pixels),
        "boundary_repair_max_m": 25,
        "boundary_repair_min_elevation_m": 1,
        "boundary_repair_is_source_edit": False,
    }
    manifest = {
        "basePath": f"./data/{name}",
        "metadata": metadata,
        "tileCells": tile_cells,
        "maxLevel": int(level_meta["maxLevel"]),
        "levels": level_meta["levels"],
        "tiles": descriptors,
        "oceanMask": ocean_mask,
        "generator": {
            "name": "build_native_tiles.py",
            "version": 1,
            "payload": "gzip+base64 uint16 little-endian",
        },
    }
    # Keep the manifest inspectable while retaining the 100-character source
    # chunks used by the tile payloads.  The replacement is a valid JavaScript
    # string-concatenation expression, so no runtime decoder special case is
    # needed.
    bits = manifest["oceanMask"]["bits"]
    manifest["oceanMask"]["bits"] = "__OCEAN_BITS_PLACEHOLDER__"
    manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2)
    bits_expression = json.dumps(bits[:100])
    if len(bits) > 100:
        bits_expression += "\n" + "\n".join(
            "      + " + json.dumps(bits[i : i + 100])
            for i in range(100, len(bits), 100)
        )
    manifest_json = manifest_json.replace(
        json.dumps("__OCEAN_BITS_PLACEHOLDER__"), bits_expression
    )
    text = (
        "// Generated terrain manifest for " + name + ".\n"
        "// Define window.NOTO_TILE_RECEIVE before loading tile files.\n"
        "window.NOTO_TILESET = "
        + manifest_json
        + ";\n"
    )
    (output / "manifest.js").write_text(text, encoding="utf-8", newline="\n")


def main() -> int:
    """Run source validation, crop quantization, bounded edge repair, tile/mask generation and manifest verification. Release the memory map and remove temporary files. Return the success exit code; invalid arguments or inputs raise SystemExit."""
    args = cli()
    if args.spacing <= 0:
        raise SystemExit("--spacing must be positive")
    if args.tile_cells < 1:
        raise SystemExit("--tile-cells must be positive")
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise SystemExit(f"source does not exist: {source}")
    if output == source or output in source.parents:
        raise SystemExit("output must not contain the source raster")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and any(output.iterdir()):
        raise SystemExit(
            "output must be empty; move the previous generated directory "
            "aside before rebuilding"
        )
    output.mkdir(parents=True, exist_ok=True)

    with rasterio.open(source) as ds:
        window, rows, cols = crop_window(ds, args.spacing)
        print(f"{args.name}: source {ds.width}x{ds.height}, crop {window}", flush=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{args.name}-",
            suffix=".u16",
            dir=output.parent,
        )
        os.close(fd)
        temp_path = Path(temp_name)
        try:
            stats = quantize_source(ds, window, temp_path)
            grid = np.memmap(temp_path, dtype="<u2", mode="r+", shape=(rows, cols))
            edge_repair_pixels = apply_bounded_edge_repair(grid, args.spacing)
            # Recompute validity-derived counts after the display-only repair.
            stats["valid_node_count"] = int(np.count_nonzero(grid != NODATA_U16))
            stats["invalid_node_count"] = rows * cols - int(stats["valid_node_count"])
            stats["elevation_min_m"], stats["elevation_max_m"] = finite_minmax(grid)
            levels, descriptors = build_tiles(
                grid,
                output,
                args.name,
                args.spacing,
                {"width": ds.width, "height": ds.height},
                stats,
                args.tile_cells,
            )
            ocean_mask = build_ocean_mask(grid, args.spacing)
            validation = validate_tiles(grid, output, descriptors, levels)
            metadata_source = {
                "width": ds.width,
                "height": ds.height,
                "transform": tuple(ds.transform),
                "crs": str(ds.crs),
            }
            write_manifest(
                output,
                args.name,
                source,
                args.spacing,
                window,
                rows,
                cols,
                stats,
                levels,
                descriptors,
                ocean_mask,
                edge_repair_pixels,
                args.tile_cells,
                ds.width,
                ds.height,
            )
            summary = {
                "name": args.name,
                "output": str(output),
                "nodes": rows * cols,
                "valid_nodes": int(stats["valid_node_count"]),
                "invalid_nodes": int(stats["invalid_node_count"]),
                "levels": levels["levels"],
                "max_level": levels["maxLevel"],
                "tile_descriptors": len(descriptors),
                "payload_tiles": validation["payloadTileCount"],
                "boundary_repair_pixels": edge_repair_pixels,
                "quantization_error_m": stats["max_quantization_error_m"],
                "ocean_mask": {
                    "rows": ocean_mask["rows"],
                    "cols": ocean_mask["cols"],
                    "step": ocean_mask["step"],
                    "ocean_cells": ocean_mask["oceanCellCount"],
                },
                "validation": validation,
                "source": metadata_source,
            }
            print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
        finally:
            try:
                mmap_handle = getattr(grid, "_mmap", None)
                del grid
                if mmap_handle is not None:
                    mmap_handle.close()
            except UnboundLocalError:
                pass
            import gc

            gc.collect()
            temp_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
