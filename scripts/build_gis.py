"""Rebuild aligned vegetation and satellite GIS layers from packaged local sources.

The DEM is never opened for writing. Categorical rasters use nearest-neighbor
resampling; RGB satellite tiles use bilinear resampling. No downloads occur.
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject


def build(root: Path, output: Path) -> None:
    """Write GIS rasters, QGIS styles and previews using the retained grid metadata."""
    inputs = root / "gis/vegetation"
    metadata = json.loads((inputs / "vegetation-metadata.json").read_text(encoding="utf-8"))
    source_manifest = json.loads((inputs / "SOURCE-MANIFEST.json").read_text(encoding="utf-8"))
    width, height = metadata["columns"], metadata["rows"]
    transform = from_bounds(*metadata["bounds"], width, height)
    output.mkdir(parents=True, exist_ok=True)
    classes = np.zeros((height, width), dtype=np.uint8)
    for member in source_manifest["vegetation"]["members"]:
        with rasterio.open(inputs / "source" / member) as source:
            projected = np.zeros_like(classes)
            reproject(
                rasterio.band(source, 1), projected,
                src_transform=source.transform, src_crs=source.crs, src_nodata=0,
                dst_transform=transform, dst_crs=metadata["crs"], dst_nodata=0,
                resampling=Resampling.nearest,
            )
            classes[projected > 0] = projected[projected > 0]

    categories = metadata["categories"]
    palette = {
        item["id"]: tuple(bytes.fromhex(item["color"][1:])) + (255 if item["id"] else 0,)
        for item in categories
    }
    profile = dict(
        driver="GTiff", width=width, height=height, count=1, dtype="uint8",
        crs=metadata["crs"], transform=transform, nodata=0, compress="DEFLATE", tiled=True,
    )
    tags = dict(
        SOURCE="Univ. Tsukuba 2024JPN_v26.03_vegetation", YEAR="2024",
        RESAMPLING="nearest", RELEASE="2026-03-13",
        SOURCE_URL=source_manifest["vegetation"]["page"],
    )
    vegetation = classes.copy()
    vegetation[np.isin(vegetation, metadata["excluded_from_plants"])] = 0
    entries = "".join(
        f'<paletteEntry value="{item["id"]}" color="{item["color"]}" '
        f'alpha="{255 if item["id"] else 0}" label="{item["name"]}"/>'
        for item in categories
    )
    style = (
        '<!DOCTYPE qgis PUBLIC "http://mrcc.com/qgis.dtd" "SYSTEM">'
        '<qgis version="3.40" styleCategories="AllStyleCategories"><pipe>'
        '<rasterrenderer type="paletted" band="1" opacity="0.75" alphaBand="-1">'
        f'<colorPalette>{entries}</colorPalette></rasterrenderer></pipe></qgis>'
    )
    for name, values in [
        ("noto_vegetation_2024_10m_epsg6675", classes),
        ("noto_vegetation_only_2024_10m_epsg6675", vegetation),
    ]:
        with rasterio.open(output / (name + ".tif"), "w", **profile) as target:
            target.write(values, 1)
            target.write_colormap(1, palette)
            target.update_tags(**tags)
            if values is vegetation:
                target.update_tags(DERIVATION="Non-vegetation classes masked as NoData 0")
            target.build_overviews([2, 4, 8, 16], Resampling.nearest)
        (output / (name + ".qml")).write_text(style, encoding="utf-8")

    names = {item["id"]: item["name"] for item in categories}
    metadata["category_counts"] = {
        names[int(key)]: int(count)
        for key, count in zip(*np.unique(classes, return_counts=True))
    }
    (output / "vegetation-metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    (output / "SOURCE-MANIFEST.json").write_text(json.dumps(source_manifest, indent=2), encoding="utf-8")
    color_lookup = np.array([palette[i][:3] for i in range(len(categories))], dtype=np.uint8)
    Image.fromarray(color_lookup[classes]).resize((1662, 1157), Image.Resampling.NEAREST).save(output / "vegetation-map.png")

    # WMTS g/14 uses the standard Web Mercator tile matrix.
    zoom = source_manifest["satellite"]["zoom"]
    count = 2 ** zoom
    west, south, east, north = metadata["wgs84_bounds"]
    def tile_x(longitude):
        return int((longitude + 180) / 360 * count)
    def tile_y(latitude):
        return int((1 - math.asinh(math.tan(math.radians(latitude))) / math.pi) / 2 * count)
    x0, x1, y0, y1 = tile_x(west), tile_x(east), tile_y(north), tile_y(south)
    mosaic = Image.new("RGB", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            path = inputs / "source/satellite-tiles" / f"{zoom}_{x}_{y}.jpg"
            with Image.open(path) as image:
                if image.size != (256, 256):
                    raise ValueError(f"Unexpected satellite tile dimensions: {path}")
                mosaic.paste(image.convert("RGB"), ((x - x0) * 256, (y - y0) * 256))
    mercator = 20037508.342789244
    span = mercator * 2 / count
    source_transform = from_bounds(
        -mercator + x0 * span, mercator - (y1 + 1) * span,
        -mercator + (x1 + 1) * span, mercator - y0 * span, *mosaic.size,
    )
    rgb = np.array(mosaic)
    satellite = np.zeros((3, height, width), dtype=np.uint8)
    for channel in range(3):
        reproject(
            rgb[:, :, channel], satellite[channel],
            src_transform=source_transform, src_crs="EPSG:3857",
            dst_transform=transform, dst_crs=metadata["crs"], resampling=Resampling.bilinear,
        )
    with rasterio.open(
        output / "noto_sentinel2_cloudless_2024_rgb_10m_epsg6675.tif", "w",
        **{**profile, "count": 3, "nodata": None, "photometric": "RGB"},
    ) as target:
        target.write(satellite)
        target.update_tags(
            ATTRIBUTION="EOxCloudless by EOX IT Services GmbH; contains modified Copernicus Sentinel data 2024",
            LICENSE="CC BY-NC-SA 4.0", SOURCE_URL="https://maps.eox.at/",
        )
        target.build_overviews([2, 4, 8, 16], Resampling.average)
    preview = Image.fromarray(np.moveaxis(satellite, 0, 2)).resize((1662, 1157), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(preview)
    draw.rectangle((0, preview.height - 22, preview.width, preview.height), fill=(20, 25, 20))
    draw.text((8, preview.height - 18), "EOxCloudless / EOX | Modified Copernicus Sentinel data 2024 | CC BY-NC-SA 4.0", fill="white")
    preview.save(output / "satellite-reference-attributed.jpg", quality=92)
    print(f"GIS layers written to {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="Defaults to <root>/gis/vegetation")
    args = parser.parse_args()
    build(args.root, args.output or args.root / "gis/vegetation")
