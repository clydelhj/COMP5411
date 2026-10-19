"""Derive display levels from existing native nodes, preserving elevations and NoData."""

from pathlib import Path
import argparse
import base64
import gzip
import json
import math
import re

import numpy as np

NODATA = np.uint16(65535)  # Original height NoData sentinel, not a physical elevation.


def read_payload(path: Path) -> dict:
    """Read a generated tile script without executing JavaScript. Match the fixed callback syntax and parse its second argument as JSON. Return rows, cols and compressed heights."""
    match = re.search(r'window\.NOTO_TILE_RECEIVE\("[^"\n]+",(\{.*\})\);', path.read_text(encoding='utf-8'), re.S)
    if not match:
        raise ValueError(f'Invalid tile payload: {path}')
    return json.loads(re.sub(r'"\s*\+\s*"', '', match.group(1)))


def add_levels(dataset: Path, output: Path, steps: list[int]) -> list[dict]:
    """Extract exact native nodes to generate display levels and a merged manifest.

    dataset contains read-only L0 input; output may be the same directory.
    steps contains unique positive native-pixel intervals. Select global row/column
    multiples and final endpoints, verify shared nodes and coverage, aggregate
    conservative bounds, and write tiles of at most 256 cells per side.
    Return per-level dimensions, verification counts, payload counts and sizes."""
    text = (dataset / 'manifest.js').read_text(encoding='utf-8')
    # Generated Base64 chunks only concatenate string literals; join them before safe JSON parsing.
    body = text.split('window.NOTO_TILESET = ', 1)[1].strip().removesuffix(';')
    manifest = json.loads(re.sub(r'"\s*\+\s*"', '', body))
    existing_steps = {int(level['step']) for level in manifest['levels']}
    if len(steps) != len(set(steps)) or any(step < 1 or step in existing_steps for step in steps):
        raise ValueError('New steps must be positive, unique and absent from existing levels.')
    for step in steps:
        if (output / f'S{step}').exists():
            raise FileExistsError(f'Output level already exists: S{step}')
    meta = manifest['metadata']
    source_rows, source_cols = meta['source_height'], meta['source_width']
    derived = {}
    for step in steps:
        row_axis = np.unique(np.append(np.arange(0, source_rows, step), source_rows - 1))
        col_axis = np.unique(np.append(np.arange(0, source_cols, step), source_cols - 1))
        grid = np.full((len(row_axis), len(col_axis)), NODATA, dtype='<u2')
        written = np.zeros(grid.shape, dtype=bool)
        derived[step] = {'rows': row_axis, 'cols': col_axis, 'grid': grid, 'written': written, 'checks': 0}
    native = {key: value for key, value in manifest['tiles'].items() if key.startswith('0/')}
    for index, (key, tile) in enumerate(native.items()):
        if tile.get('file'):
            payload = read_payload(dataset / tile['file'])
            raw = np.frombuffer(gzip.decompress(base64.b64decode(''.join(payload['heights']))), dtype='<u2').reshape(tile['rows'], tile['cols'])
        else:
            raw = None
        for data in derived.values():
            row_axis, col_axis, grid, written = data['rows'], data['cols'], data['grid'], data['written']
            rr = row_axis[(row_axis >= tile['r0']) & (row_axis <= tile['r1'])]
            cc = col_axis[(col_axis >= tile['c0']) & (col_axis <= tile['c1'])]
            if not len(rr) or not len(cc):
                continue
            ri, ci = np.searchsorted(row_axis, rr), np.searchsorted(col_axis, cc)
            nodes = raw[np.ix_(rr - tile['r0'], cc - tile['c0'])] if raw is not None else np.full((len(rr), len(cc)), NODATA, dtype='<u2')
            target = np.ix_(ri, ci)
            if np.any(written[target] & (grid[target] != nodes)):
                raise ValueError(f'Conflicting native shared nodes: {key}')
            data['checks'] += int(np.count_nonzero(written[target]))
            grid[target] = nodes
            written[target] = True
        if index % 2000 == 0:
            print(f'Read native tiles: {index + 1}/{len(native)}', flush=True)
    for data in derived.values():
        if not np.all(data['written']):
            raise ValueError('Native tiles did not cover every derived node.')
    results = []
    for step, data in derived.items():
        results.append(write_level(manifest, native, output, step, data))
    # Keep bitmap bytes unchanged and restore the string contract from segmented arrays.
    if isinstance(manifest['oceanMask']['bits'], list):
        manifest['oceanMask']['bits'] = ''.join(manifest['oceanMask']['bits'])
    manifest['levels'].sort(key=lambda level: level['step'])
    output.mkdir(parents=True, exist_ok=True)
    (output / 'manifest.js').write_text('// Generated terrain manifest.\n// Define window.NOTO_TILE_RECEIVE before loading tile files.\nwindow.NOTO_TILESET = ' + json.dumps(manifest, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8', newline='\n')
    return results


def write_level(manifest: dict, native: dict, output: Path, step: int, data: dict) -> dict:
    """Write one display level after verifying its sampled nodes. Tile the data, aggregate overlapping native bounds, write compressed payloads/descriptors and merge level metadata into manifest. Return generation statistics."""
    row_axis, col_axis, grid = data['rows'], data['cols'], data['grid']
    meta = manifest['metadata']
    source_rows, source_cols = meta['source_height'], meta['source_width']
    tile_cells = manifest.get('tileCells', 256)
    nx = math.ceil((len(col_axis) - 1) / tile_cells)
    nz = math.ceil((len(row_axis) - 1) / tile_cells)
    prefix = f'{step}m'
    generated = {}
    payload_count = 0
    for z in range(nz):
        rstart, rend = z * tile_cells, min((z + 1) * tile_cells, len(row_axis) - 1)
        for x in range(nx):
            cstart, cend = x * tile_cells, min((x + 1) * tile_cells, len(col_axis) - 1)
            r0, r1 = int(row_axis[rstart]), int(row_axis[rend])
            c0, c1 = int(col_axis[cstart]), int(col_axis[cend])
            covered = [native[f'0/{bx}/{bz}'] for bz in range(r0 // tile_cells, min(math.ceil(r1 / tile_cells), math.ceil((source_rows - 1) / tile_cells))) for bx in range(c0 // tile_cells, min(math.ceil(c1 / tile_cells), math.ceil((source_cols - 1) / tile_cells)))]
            has_land = any(tile['hasLand'] for tile in covered)
            all_valid = all(tile['kind'] == 'land' for tile in covered)
            mins = [tile['min'] for tile in covered if tile['min'] is not None]
            maxs = [tile['max'] for tile in covered if tile['max'] is not None]
            nodes = grid[rstart:rend + 1, cstart:cend + 1]
            key = f'{prefix}/{x}/{z}'
            tile = {'level': prefix, 'x': x, 'z': z, 'rows': nodes.shape[0], 'cols': nodes.shape[1], 'r0': r0, 'r1': r1, 'c0': c0, 'c1': c1, 'min': min(mins) if mins else None, 'max': max(maxs) if maxs else None, 'kind': 'land' if all_valid else 'mixed' if has_land else 'water', 'hasLand': has_land}
            if has_land:
                tile['file'] = f'S{step}/{x}_{z}.js'
                payload = {'rows': nodes.shape[0], 'cols': nodes.shape[1], 'step': step, 'r0': r0, 'r1': r1, 'c0': c0, 'c1': c1, 'heights': base64.b64encode(gzip.compress(nodes.tobytes(order='C'), compresslevel=9, mtime=0)).decode('ascii')}
                target = output / tile['file']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('// Generated display-level tile from native nodes.\n' + f'window.NOTO_TILE_RECEIVE({json.dumps(key)},{json.dumps(payload, separators=(",", ":"))});\n', encoding='utf-8', newline='\n')
                payload_count += 1
            generated[key] = tile
    manifest['tiles'].update(generated)
    manifest['levels'].append({'level': prefix, 'step': step, 'cols': len(col_axis), 'rows': len(row_axis), 'tilesX': nx, 'tilesZ': nz})
    result = {'step': step, 'sourceSpacingM': meta['source_spacing_m'], 'rows': len(row_axis), 'cols': len(col_axis), 'nativeNodes': int(grid.size), 'sharedNodeChecks': data['checks'], 'tileDescriptors': len(generated), 'payloadTiles': payload_count, 'bytes': sum(path.stat().st_size for path in (output / f'S{step}').glob('*.js')), 'originalSource': meta['source']}
    print(f'Generated {step} m display level: {payload_count} payloads', flush=True)
    return result


def main() -> None:
    """Parse dataset/output paths and sampling steps, generate display levels and print JSON statistics. Results are written to the selected output directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--steps', type=int, nargs='+', default=[3, 5, 6, 7])
    args = parser.parse_args()
    result = add_levels(args.dataset.resolve(), (args.output or args.dataset).resolve(), args.steps)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
