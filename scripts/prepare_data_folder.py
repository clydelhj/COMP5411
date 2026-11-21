"""Prepare a viewer data folder from an elevation GeoTIFF and two categorical GeoTIFFs."""
import argparse
import json
import math
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform as transform_points
from rasterio.windows import Window

import build_coastline_field as coast
import build_native_tiles as tiles
from classification_grids import write_classifications


def spatial_metadata(dem):
    affine = dem.transform
    if dem.count != 1 or min(dem.width, dem.height) < 2 or dem.dtypes[0].startswith('complex'):
        raise ValueError('The DEM must contain one real-valued band and at least two samples on each axis.')
    if not dem.crs or not dem.crs.is_projected or not math.isclose(dem.crs.linear_units_factor[1], 1):
        raise ValueError('Reproject the DEM into a projected coordinate system with metre units.')
    if affine.b or affine.d or affine.a <= 0 or affine.e >= 0 or not math.isclose(affine.a, -affine.e):
        raise ValueError('Use a north-up DEM with square pixels.')
    if dem.scales[0] != 1 or dem.offsets[0] != 0 or (dem.units[0] or '').lower() not in ('','m','meter','metre','meters','metres'):
        raise ValueError('Export band 1 as unscaled elevations in metres.')
    west, north = dem.xy(0, 0)
    east, south = dem.xy(dem.height-1, dem.width-1)
    center_e, center_n = (west+east)/2, (north+south)/2
    lon, lat = transform_points(dem.crs, 'EPSG:4326', [center_e], [center_n])
    return {
        'source': Path(dem.name).name, 'sourcePath': Path(dem.name).name,
        'crs': dem.crs.to_string(), 'sourceDatum': dem.crs.to_string(),
        'source_spacing_m': [affine.a, -affine.e], 'source_width': dem.width, 'source_height': dem.height,
        'width_m': east-west, 'height_m': north-south,
        'origin_easting': center_e, 'origin_northing': center_n,
        'display_centers': {'left':west, 'right':east, 'bottom':south, 'top':north},
        'crop_window': {'col_off':0, 'row_off':0, 'width':dem.width, 'height':dem.height},
        'geographicCenter': {'longitude':lon[0], 'latitude':lat[0]},
        'baseElevation': tiles.BASE_ELEVATION_M, 'quantization_m': tiles.QUANTIZATION_M,
    }


def write_terrain(dem, metadata, package, temporary):
    folder = package / 'terrain-1m'
    folder.mkdir()
    spacing = metadata['source_spacing_m'][0]
    grid_path = temporary / 'elevations.bin'
    stats = tiles.quantize_source(dem, Window(0, 0, dem.width, dem.height), grid_path)
    if stats['out_of_range_node_count']:
        raise ValueError('DEM elevations must fit the viewer range of -100.00 to 555.34 m. Mark missing data explicitly.')
    if not stats['valid_node_count']:
        raise ValueError('The DEM has no valid elevations.')
    metadata.update(stats)
    grid = np.memmap(grid_path, mode='r', dtype='<u2', shape=(dem.height, dem.width))
    try:
        levels, descriptors = tiles.build_tiles(grid, folder, 'terrain-1m', spacing, metadata, stats, 256)
        manifest = {
            'basePath': './data/terrain-1m', 'metadata':metadata, 'tileCells':256,
            'maxLevel':levels['maxLevel'], 'levels':levels['levels'], 'tiles':descriptors,
            'oceanMask':tiles.build_ocean_mask(grid, spacing),
        }
        text = json.dumps(manifest, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        (folder/'manifest.js').write_text('window.NOTO_TILESET = '+text+';\n', encoding='utf-8')

        # The coastline grid uses cell centres and samples the same quantized heights as the tiles.
        step = max(1, min(round(8/spacing), dem.width-1, dem.height-1))
        while True:
            row = np.minimum(np.arange(0, dem.height-1, step) + step//2, dem.height-1)
            col = np.minimum(np.arange(0, dem.width-1, step) + step//2, dem.width-1)
            samples = grid[np.ix_(row,col)]
            if np.any(samples != tiles.NODATA_U16) or step == 1:
                break
            step = max(1, step//2)
        heights = samples.astype(np.float32)*tiles.QUANTIZATION_M + tiles.BASE_ELEVATION_M
        heights[samples == tiles.NODATA_U16] = np.nan
        coast.build(manifest, heights, package/'shoreline-data.js', step)
    finally:
        grid._mmap.close()


def prepare(dem_path, geology_path, vegetation_path, output):
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f'Choose a new output folder: {output}')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.viewer-data-', dir=output.parent) as tmp:
        temporary = Path(tmp)
        package = temporary/'data'
        package.mkdir()
        with rasterio.open(dem_path) as dem:
            metadata = spatial_metadata(dem)
            write_classifications(package, geology_path, vegetation_path, dem, metadata)
            write_terrain(dem, metadata, package, temporary)
        package.rename(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dem', type=Path, required=True, help='North-up projected DEM, elevations in metres')
    parser.add_argument('--geology', type=Path, required=True, help='Rock and soil class IDs, 0–28')
    parser.add_argument('--vegetation', type=Path, required=True, help='Vegetation class IDs, 0–30')
    parser.add_argument('--output', type=Path, required=True, help='New local data folder')
    args = parser.parse_args()
    try:
        prepare(args.dem, args.geology, args.vegetation, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')
    print(f'Prepared {args.output}. Open Settings and choose this data folder.')


if __name__ == '__main__':
    main()
