import base64
import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import rasterio
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from prepare_data_folder import prepare


def write_band(path, values):
    with rasterio.open(path, "w", driver="GTiff", width=values.shape[1], height=values.shape[0],
                       count=1, dtype=values.dtype, crs="EPSG:32650",
                       transform=from_origin(780000, 2485000, 10, 10)) as dataset:
        dataset.write(values, 1)


class DataFolderTest(unittest.TestCase):
    def test_metric_shore_and_masked_elevations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dem, classes = root / "dem.tif", root / "classes.tif"
            write_band(classes, np.ones((20, 36), dtype="uint8"))
            height = np.full((20, 36), 84.25, dtype="float32")
            height[:, :8] = 2000
            write_band(dem, height)
            with self.assertRaisesRegex(ValueError, "range"):
                prepare(dem, classes, classes, root / "data")
            self.assertFalse((root / "data").exists())
            with rasterio.open(dem, "r+") as dataset:
                dataset.write_mask(np.where(height > 1000, 0, 255).astype("uint8"))
            prepare(dem, classes, classes, root / "data")
            geo = json.loads((root / "data/shoreline-data.js").read_text().split(" = ", 1)[1].strip()[:-1])
            samples = np.frombuffer(gzip.decompress(base64.b64decode(geo["distances"])), "<u2")
            distance = (samples.astype(float).reshape(geo["rows"], geo["cols"]) - 32768) / 8
            self.assertEqual(geo["cellM"], 10)
            self.assertEqual(geo["crs"], "EPSG:32650")
            self.assertGreater(distance[8, 2], 40)
            self.assertLess(distance[8, 18], -60)
            with self.assertRaises(FileExistsError):
                prepare(dem, classes, classes, root / "data")


if __name__ == "__main__":
    unittest.main()
