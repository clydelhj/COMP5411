"""Rebuild vegetation runtime resources from packaged real classifications and 4K glTF sources."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import sys

import rasterio


def package_classes(root: Path) -> None:
    """Read the projected classification GeoTIFF and metadata, validate dimensions/CRS and compress unchanged categories deterministically. Write data/vegetation-data.js for file and HTTP pages. Leave GIS source rasters unchanged."""
    folder = root / "gis/vegetation"
    metadata = json.loads((folder / "vegetation-metadata.json").read_text(encoding="utf-8"))
    with rasterio.open(folder / "noto_vegetation_2024_10m_epsg6675.tif") as src:
        if src.crs.to_epsg() != 6675 or src.shape != (metadata["rows"], metadata["columns"]):
            raise ValueError("Vegetation raster does not match model metadata")
        classes = src.read(1)
    metadata["classes"] = base64.b64encode(
        gzip.compress(classes.tobytes(), compresslevel=9, mtime=0)
    ).decode()
    output = root / "data/vegetation-data.js"
    output.write_text(
        "// Generated: actual vegetation classes for 2024, EPSG:6675.\nwindow.NOTO_VEGETATION = "
        + json.dumps(metadata, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )


def main() -> None:
    """Package classifications and optionally rebuild models. --root sets the project, --models enables geometry rebuilding and --node selects Node. Use NumPy/Pillow to read glTF, then the bundled meshoptimizer to derive LODs and shape variants. Remove this run's .build directory only after success; retain failed intermediates for inspection."""
    parser = argparse.ArgumentParser(description="Rebuild local vegetation resources")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--models", action="store_true")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    root = args.root.resolve()
    package_classes(root)
    if args.models:
        scripts = Path(__file__).resolve().parent
        subprocess.run(
            [sys.executable, str(scripts / "prepare_vegetation_models.py"), "--root", str(root)],
            check=True,
        )
        subprocess.run(
            [args.node, str(scripts / "simplify_vegetation_models.mjs"), str(root)], check=True
        )
        subprocess.run(
            [args.node, str(scripts / "vary_vegetation_models.mjs"), str(root)], check=True
        )
        temporary = root / "assets/vegetation/.build"
        if temporary.resolve().parent != (root / "assets/vegetation").resolve():
            raise ValueError("Unexpected temporary directory")
        shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
