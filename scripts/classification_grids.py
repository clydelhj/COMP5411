"""Reproject categorical GeoTIFFs into the terrain viewer's geographic footprint."""

import argparse
import base64
import gzip
import json
import math
import re
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_bounds, from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, transform_bounds


# Keep the IDs, appearance and families used by the shipped materials and plants.
GEOLOGY = (
    ('Tuff breccia', '#a49883', 'rock', 0.89),
    ('Sand and gravel', '#b8a67b', 'sand', 0.89),
    ('Tuff', '#b4a38c', 'rock', 0.89),
    ('Sandy gravelly clay-like material', '#a08767', 'soil', 0.97),
    ('Sand', '#c8b37d', 'sand', 0.89),
    ('Weathered mudstone', '#9c876c', 'soil', 0.97),
    ('Gravelly clay', '#9c8262', 'soil', 0.97),
    ('Mudstone', '#756d61', 'rock', 0.89),
    ('Silt', '#a69a80', 'soil', 0.97),
    ('Bedrock (unclassified)', '#8d8b80', 'rock', 0.89),
    ('Marine siliceous mudstone', '#8b958c', 'rock', 0.89),
    ('Rhyolite-dacite and volcaniclastic rock', '#bcaaa0', 'rock', 0.89),
    ('Sandstone-mudstone assemblage', '#b49b7c', 'sand', 0.89),
    ('Andesite and volcaniclastic rock', '#71776e', 'rock', 0.89),
    ('Clay-bearing sand', '#bbaa82', 'soil', 0.97),
    ('Tuffaceous clay', '#a88e76', 'soil', 0.97),
    ('Dioritic rock', '#8e9391', 'rock', 0.89),
    ('Tuffaceous sandstone', '#b5a17e', 'sand', 0.89),
    ('Carbonaceous shale', '#555756', 'rock', 0.89),
    ('Marine solid placeholder', '#668e9e', 'rock', 0.89),
    ('Topsoil', '#706046', 'soil', 0.97),
    ('Cohesive soil', '#967d61', 'soil', 0.97),
    ('Siliceous siltstone', '#92998d', 'rock', 0.93),
    ('Diatomaceous siltstone', '#b0af95', 'rock', 0.93),
    ('Calcareous siltstone', '#aaa68e', 'rock', 0.93),
    ('Mixed surficial deposits', '#b5a27c', 'soil', 0.93),
    ('Conglomerate with sandstone', '#9e937d', 'rock', 0.93),
    ('Sandstone', '#bdaa83', 'sand', 0.93),
)
VEGETATION = (
    ('No data', '#000000'),
    ('Water', '#73b9d5'),
    ('Built-up', '#989898'),
    ('Bare', '#bda781'),
    ('Solar panels', '#8d718b'),
    ('Rice paddy', '#bfdc76'),
    ('Lotus paddy', '#a9dba3'),
    ('Herbaceous cropland', '#dbda83'),
    ('Deciduous orchard', '#adb857'),
    ('Evergreen orchard', '#86a95b'),
    ('Tea farm', '#669746'),
    ('Greenhouse', '#aeaeae'),
    ('Pasture', '#9fcf65'),
    ('Alpine meadow', '#b8cb70'),
    ('Tall grassland', '#a1bc45'),
    ('Short grassland', '#bbd279'),
    ('Dwarf bamboo', '#a2c951'),
    ('Wetland herbs', '#8bbfaa'),
    ('Subalpine deciduous broadleaf', '#499751'),
    ('Temperate deciduous broadleaf', '#4b9d49'),
    ('Deciduous conifer', '#608f65'),
    ('Evergreen broadleaf', '#1e7138'),
    ('Japanese stone pine', '#386a4b'),
    ('Subarctic evergreen conifer', '#326652'),
    ('Subalpine evergreen conifer', '#386551'),
    ('Cedar', '#346f51'),
    ('Cypress', '#437b58'),
    ('Pine', '#5c8449'),
    ('Bamboo', '#64a66c'),
    ('Mangrove', '#34735c'),
    ('Rock reef / tidal flat', '#9d927c'),
)


def terrain_reference(metadata, fallback_crs=None):
    centers = metadata["display_centers"]
    bounds = tuple(float(centers[k]) for k in ("left", "bottom", "right", "top"))
    if not all(map(math.isfinite, bounds)) or bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        raise ValueError("Terrain manifest has invalid projected bounds")
    crs = metadata.get("crs") or fallback_crs
    if not crs and "EPSG:6675" in metadata.get("sourceDatum", ""):
        crs = "EPSG:6675"  # The original distributed Noto manifest predates the crs field.
    if not crs:
        raise ValueError("Terrain manifest must identify its projected CRS")
    crs = CRS.from_user_input(crs)
    if not crs.is_projected or not math.isclose(crs.linear_units_factor[1], 1):
        raise ValueError("The terrain coordinate system must be projected in metres")
    return bounds, crs


def sample_classes(path, bounds, crs, *, geology):
    west, south, east, north = bounds
    width, height = east - west, north - south
    with rasterio.open(path) as source:
        if source.count != 1 or not source.crs or np.dtype(source.dtypes[0]).kind not in "ui":
            raise ValueError(f"{path}: expected one georeferenced integer class band with a CRS")
        footprint = transform_bounds(source.crs, crs, *source.bounds, densify_pts=21)
        if max(west, footprint[0]) >= min(east, footprint[2]) or max(south, footprint[1]) >= min(north, footprint[3]):
            raise ValueError(f"{path}: class raster does not overlap the terrain")
        if source.crs == crs:
            dx, dy = source.res
        else:
            suggested, _, _ = calculate_default_transform(
                source.crs, crs, source.width, source.height, *source.bounds
            )
            dx, dy = abs(suggested.a), abs(suggested.e)
        if not all(math.isfinite(v) and v > 0 for v in (dx, dy)):
            raise ValueError(f"{path}: cannot determine class pixel spacing")
        # The 3D material grid must fit the WebGL2 minimum 3D texture dimension.
        # Keep ground-cover texture allocations comparable to the shipped 3323 x 2314 raster.
        limit = 255 if geology else 4096
        scale = max(1.0, width / (limit * dx), height / (limit * dy))
        intervals_x = max(1, min(limit, round(width / (dx * scale))))
        intervals_y = max(1, min(limit, round(height / (dy * scale))))
        if geology:
            # Shader grid points include both end nodes; GDAL normally treats a raster's
            # outer east/south edge as exclusive. Nudge those samples just inside the extent.
            cols, rows = intervals_x + 1, intervals_y + 1
            margin_x = min(dx, width / intervals_x) * 1e-7
            margin_y = min(dy, height / intervals_y) * 1e-7
            step_x, step_y = (width - 2*margin_x) / intervals_x, (height - 2*margin_y) / intervals_y
            transform = from_origin(west + margin_x - step_x/2, north - margin_y + step_y/2, step_x, step_y)
        else:
            cols, rows = intervals_x, intervals_y
            transform = from_bounds(*bounds, cols, rows)
        with WarpedVRT(source, crs=crs, transform=transform, width=cols, height=rows,
                       resampling=Resampling.nearest, nodata=0) as warped:
            values = warped.read(1, masked=True).filled(0)
    maximum = len(GEOLOGY) if geology else len(VEGETATION) - 1
    invalid = (values < 0) | (values > maximum)
    if invalid.any():
        raise ValueError(f"{path}: unsupported class {values[invalid][0]}; see --list-codes")
    return values.astype(np.uint8, copy=False)


def encoded(values):
    return base64.b64encode(gzip.compress(values.tobytes(order="C"), compresslevel=9, mtime=0)).decode("ascii")


def write_classifications(output: Path, geology: Path | None, vegetation: Path | None, dem, metadata: dict):
    """Write the requested aligned classification wrappers. Unselected layers are preserved."""
    bounds, crs = terrain_reference(metadata, dem.crs if dem is not None else None)
    west, south, east, north = bounds
    width, height = east-west, north-south
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output, prefix=".classes-") as tmp:
        stage = Path(tmp)
        pending = []
        for kind, path in (("geology", geology), ("vegetation", vegetation)):
            if path is None:
                continue
            is_geology = kind == "geology"
            grid = sample_classes(path, bounds, crs, geology=is_geology)
            rows, cols = grid.shape
            if is_geology:
                layers = np.repeat(grid[:, np.newaxis, :], 2, axis=1)
                data = dict(
                    metadata=dict(rows=rows, cols=cols, levels=2, width_m=width, height_m=height,
                                  bounds=bounds, crs=crs.to_string(), source=path.name,
                                  reconstruction="Surface material class extended to the display base"),
                    palette=[dict(id=i, name=name, color=color, family=family, roughness=roughness)
                             for i,(name,color,family,roughness) in enumerate(GEOLOGY, start=1)],
                    boreholes=[], ids=encoded(layers)
                )
                name, variable = "strata-data.js", "NOTO_STRATA"
            else:
                data = dict(rows=rows, columns=cols, bounds=bounds, crs=crs.to_string(), source=path.name,
                            pixel_size_m=[width/cols, height/rows],
                            wgs84_bounds=transform_bounds(crs, "EPSG:4326", *bounds, densify_pts=21),
                            categories=[dict(id=i, name=name, color=color)
                                        for i,(name,color) in enumerate(VEGETATION)],
                            classes=encoded(grid))
                name, variable = "vegetation-data.js", "NOTO_VEGETATION"
            (stage/name).write_text(f"window.{variable} = " + json.dumps(data, separators=(",",":")) + ";\n",
                                    encoding="utf-8")
            pending.append(name)
        for name in pending:
            (stage/name).replace(output/name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="Prepared data folder with terrain-1m/manifest.js")
    parser.add_argument("--geology", type=Path, help="Single-band material-class GeoTIFF")
    parser.add_argument("--vegetation", type=Path, help="Single-band land-cover-class GeoTIFF")
    parser.add_argument("--list-codes", action="store_true", help="Print the class codes and exit")
    args = parser.parse_args()
    if args.list_codes:
        print("Geology\n 0  Unclassified")
        for i, entry in enumerate(GEOLOGY, start=1):
            print(f"{i:2}  {entry[0]}")
        print("\nVegetation")
        for i, entry in enumerate(VEGETATION):
            print(f"{i:2}  {entry[0]}")
        return
    if args.data is None or (args.geology is None and args.vegetation is None):
        parser.error("Specify --data and at least one of --geology or --vegetation")
    try:
        text = (args.data/"terrain-1m"/"manifest.js").read_text(encoding="utf-8")
        match = re.search(r'"metadata"\s*:\s*(?=\{)', text)
        if not match:
            raise ValueError("Terrain manifest has no metadata object")
        metadata, _ = json.JSONDecoder().raw_decode(text[match.end():])
        write_classifications(args.data, args.geology, args.vegetation, None, metadata)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(2, f"{parser.prog}: {error}\n")


if __name__ == "__main__":
    main()
