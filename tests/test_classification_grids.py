import base64
import gzip
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from classification_grids import write_classifications


def write_raster(path, values, bounds, crs, *, mask=None, nodata=None):
    rows, cols = values.shape
    with rasterio.open(path, "w", driver="GTiff", height=rows, width=cols, count=1,
                       dtype=values.dtype, transform=from_bounds(*bounds, cols, rows),
                       crs=crs, nodata=nodata) as dst:
        dst.write(values, 1)
        if mask is not None:
            dst.write_mask(mask)


def load_wrapper(path, key):
    text = path.read_text(encoding="utf-8").partition(" = ")[2].strip().removesuffix(";")
    data = json.loads(text)
    raw = gzip.decompress(base64.b64decode(data[key]))
    return data, np.frombuffer(raw, dtype=np.uint8)


class ClassificationGrids(unittest.TestCase):
    def test_reproject_and_align_independent_layers(self):
        with TemporaryDirectory() as tmp:
            folder = Path(tmp)
            crs = "EPSG:3857"
            bounds = (1000, 2000, 1040, 2040)
            metadata = {"display_centers": dict(left=1000, bottom=2000, right=1040, top=2040), "crs": crs}
            geology = folder/"geology.tif"
            vegetation = folder/"cover.tif"
            write_raster(geology, np.array([[5, 8], [255, 21]], dtype=np.uint8), bounds, crs, nodata=255)
            write_raster(vegetation, np.array([[19, 25], [1, 99]], dtype=np.uint8),
                         transform_bounds(crs, "EPSG:4326", *bounds), "EPSG:4326",
                         mask=np.array([[255,255],[255,0]], dtype=np.uint8))
            write_classifications(folder, geology, vegetation, None, metadata)
            strata, ids = load_wrapper(folder/"strata-data.js", "ids")
            cover, plants = load_wrapper(folder/"vegetation-data.js", "classes")
            layer = ids.reshape(3, 2, 3)
            np.testing.assert_array_equal(layer[:, 0, :], layer[:, 1, :])
            np.testing.assert_array_equal(layer[:, 0, :][::2, ::2], [[5, 8], [0, 21]])
            np.testing.assert_array_equal(plants.reshape(cover["rows"],cover["columns"]), [[19,25],[1,0]])
            self.assertEqual(cover["bounds"], list(bounds))
            self.assertEqual(strata["metadata"]["bounds"], list(bounds))
            old_strata = (folder/"strata-data.js").read_bytes()
            old_cover = (folder/"vegetation-data.js").read_bytes()
            write_raster(vegetation, np.full((2,2), 168, dtype=np.uint8), bounds, crs,
                         mask=np.full((2,2), 255, dtype=np.uint8))
            with self.assertRaisesRegex(ValueError, "unsupported class"):
                write_classifications(folder, None, vegetation, None, metadata)
            self.assertEqual(old_strata, (folder/"strata-data.js").read_bytes())
            self.assertEqual(old_cover, (folder/"vegetation-data.js").read_bytes())


if __name__ == "__main__":
    unittest.main()
