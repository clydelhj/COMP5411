"""Build the shared continuous coastline and coastal height extension from the DEM.

The source TIFF is read-only. Output is a display field, not a replacement DEM.
Requires NumPy, SciPy and rasterio. The optional sample cache separates raster
I/O from field processing when the two libraries use different Python runtimes.
"""
from pathlib import Path
import argparse
import base64
import gzip
import json
import re
import tempfile
import numpy as np


def manifest(path):
    """Read the generated JSON assignment without executing JavaScript."""
    text = path.read_text(encoding='utf-8').split('window.NOTO_TILESET = ', 1)[1]
    return json.loads(re.sub(r'"\s*\+\s*"', '', text.strip().removesuffix(';')))


def cache_signature(data, step):
    """Reject a cached sample grid after the DEM, crop or sampling step changes."""
    meta = data['metadata']
    source = Path(meta['sourcePath'])
    stat = source.stat()
    return json.dumps(dict(source=str(source.resolve()), bytes=stat.st_size,
                           modifiedNs=stat.st_mtime_ns, crop=meta['crop_window'],
                           width=meta['source_width'], height=meta['source_height'],
                           step=step, version=1), sort_keys=True)


def read_samples(data, cache, step, signature):
    """Sample source pixels at field-cell centres; cache display heights in metres."""
    import rasterio
    from rasterio.windows import Window
    meta = data['metadata']
    crop = meta['crop_window']
    rows = np.arange(step // 2, meta['source_height'], step)
    cols = np.arange(step // 2, meta['source_width'], step)
    values = np.full((len(rows), len(cols)), np.nan, dtype=np.float32)
    with rasterio.open(meta['sourcePath']) as ds:
        for start in range(0, len(rows), 64):
            subset = rows[start:start + 64]
            block = ds.read(1, window=Window(crop['col_off'], crop['row_off'] + int(subset[0]), crop['width'], int(subset[-1] - subset[0] + 1)), masked=True)
            values[start:start + len(subset)] = block[::step, cols].filled(np.nan)
    # The same bounded outer-crop display repair used by the terrain exporter.
    for edge in [values, values[::-1], values.T, values.T[::-1]]:
        snapshot = edge[:4].copy()
        for i in range(edge.shape[1]):
            valid = np.flatnonzero(np.isfinite(snapshot[:, i]))
            if valid.size and valid[0] * step <= 25 and snapshot[valid[0], i] > 1:
                edge[:valid[0], i] = snapshot[valid[0], i]
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, heights=values, signature=signature)
    print(f'DEM samples: {values.shape}, cache: {cache}', flush=True)
    return values


def build(data, values, output, step):
    """Write a signed distance field and nearest coastal heights for every LOD."""
    from scipy import ndimage
    valid = np.isfinite(values) & (values > -100) & (values < 555.35)
    # Seed only missing regions known to touch the original ocean mask; enclosed
    # inland NoData remains distinct from the ocean.
    source = data['oceanMask']
    bits = np.unpackbits(np.frombuffer(gzip.decompress(base64.b64decode(source['bits'])), np.uint8), bitorder='little')
    ocean = bits[:source['rows'] * source['cols']].reshape(source['rows'], source['cols']).astype(bool)
    rr = np.minimum(source['rows'] - 1, (np.arange(values.shape[0]) * step + step / 2).astype(int) // source['step'])
    cc = np.minimum(source['cols'] - 1, (np.arange(values.shape[1]) * step + step / 2).astype(int) // source['step'])
    seed = ocean[np.ix_(rr, cc)] & ~valid
    sea = ndimage.binary_propagation(seed, mask=~valid)
    distance = (ndimage.distance_transform_edt(sea) - ndimage.distance_transform_edt(~sea)) * step
    # Smooth the display contour in metres, independently of the selected LOD.
    distance = ndimage.gaussian_filter(distance.astype(np.float32), sigma=1.0, mode='nearest')
    nearest = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    filled = values[tuple(nearest)]
    # 512 m exceeds the largest wave fade band (362 m at the 128 m LOD).
    packed_distance = np.rint(np.clip(distance, -512, 512) * 8 + 32768).astype('<u2')
    packed_height = np.rint((np.maximum(0.02, filled) + 100) * 100).clip(0, 65534).astype('<u2')
    # Constant ocean heights outside the coastal band keep the asset compact.
    packed_height[np.abs(distance) > 300] = 10002
    encode = lambda a: base64.b64encode(gzip.compress(a.tobytes(), mtime=0)).decode('ascii')
    meta = data['metadata']
    result = dict(rows=values.shape[0], cols=values.shape[1], cellM=step, widthM=meta['width_m'], heightM=meta['height_m'],
                  method=f'DEM validity; ocean-connected missing regions; {step} m Gaussian-smoothed display distance; ocean positive',
                  source=meta['source'], smoothingM=step, contourToleranceM=0.03, maximumContourSegmentM=8,
                  distances=encode(packed_distance), coastalHeights=encode(packed_height))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('/* Generated display coastline. Source DEM is unchanged. */\nwindow.NOTO_SHORELINE = ' + json.dumps(result, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(json.dumps(dict(rows=result['rows'], cols=result['cols'], bytes=output.stat().st_size, oceanCells=int(sea.sum()), inlandMissing=int((~valid & ~sea).sum()))), flush=True)
    return result


def main():
    root = Path(__file__).resolve().parents[1]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, default=root / 'data/terrain-1m/manifest.js')
    p.add_argument('--dataset', type=Path, help='Terrain directory containing manifest.js')
    p.add_argument('--output', type=Path, default=root / 'data/shoreline-data.js')
    p.add_argument('--sample-cache', type=Path, help='Optional reusable NPZ; otherwise use a temporary file')
    p.add_argument('--sample-only', action='store_true')
    p.add_argument('--step', type=int, choices=[8], default=8)
    args = p.parse_args()
    if args.sample_only and not args.sample_cache:
        p.error('--sample-only requires --sample-cache')
    data = manifest(args.dataset / 'manifest.js' if args.dataset else args.manifest)
    signature = cache_signature(data, args.step)
    with tempfile.TemporaryDirectory(prefix='noto-coast-') as temporary:
        cache = args.sample_cache or Path(temporary) / 'samples.npz'
        if cache.exists():
            with np.load(cache) as saved:
                if 'signature' not in saved or saved['signature'].item() != signature:
                    raise ValueError('Sample cache does not match the source; use a new cache path')
                values = saved['heights']
        else:
            values = read_samples(data, cache, args.step, signature)
        if not args.sample_only:
            build(data, values, args.output, args.step)


if __name__ == '__main__':
    main()
