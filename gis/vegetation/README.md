# Noto vegetation and satellite GIS layers

## Open in QGIS

Add `noto_vegetation_only_2024_10m_epsg6675.tif` for vegetation on a transparent background; nonvegetation classes are NoData 0. Add `noto_sentinel2_cloudless_2024_rgb_10m_epsg6675.tif` beneath it as the RGB reference. The original DEM is in `../../source-data/terrain/`.

The aligned layers use EPSG:6675, 3323 columns and 2314 rows, with pixel sizes about 9.9985 by 9.9978 m. Same-name QML files provide discrete category palettes; if needed, load them through Layer Properties / Symbology / Style. The full `noto_vegetation_2024_10m_epsg6675.tif` includes nonvegetation classes. Classification IDs use nearest-neighbor resampling, never continuous interpolation. Loading these layers does not modify the DEM. QGIS does not need the browser JavaScript files.

## Source data

- Vegetation: University of Tsukuba [2024JPN_v26.03_vegetation](https://pen.envr.tsukuba.ac.jp/~utlulc/archive/Japan/2024JPN_v26.03_vegetation.html), approximately 10 m, 30 classes for 2024, released 2026-03-13. `source/` contains original N37E136/N37E137 WGS84 GeoTIFFs and the publisher README.
- Satellite: EOxCloudless 2024 by EOX IT Services GmbH; contains modified Copernicus Sentinel data 2024. [WMTS capabilities](https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml), layer `s2cloudless-2024_3857`, matrix g/14. Original JPEG tiles are in `source/satellite-tiles/`; they are mosaicked and bilinearly reprojected to the shared grid.
- Satellite license: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), used for noncommercial course work. Attribution appears in the preview, GeoTIFF tags and source manifest. It is not the CC0 license used by plant models.

The annual cloudless RGB mosaic is a visual reference, not a single-date survey photograph or reflectance-analysis product. Vegetation data is a research product for academic use. National validation is not an independent accuracy estimate for this crop. Small patches, rare classes and date differences need care: the 2024 vegetation map and the post-earthquake DEM are not a contemporaneous individual-tree reconstruction.

The publisher's recommended citation is retained in `source/README_2024JPN_v26.03_vegetation.txt`. That bibliographic record does not imply that the associated paper's full text has been reviewed for this package.

## Mapping to the viewer

| Source class | Representation | Interpretation |
| --- | --- | --- |
| 18/19 deciduous broadleaf, 21 evergreen broadleaf | Broadleaf instances | tree_small_02 is Burkea africana, used as a generic form rather than a native Noto species |
| 20, 22-27 conifers, including cedar/cypress/pine | Conifer instances | fir_tree_01 tree A is a generic proxy, not a verified model of each mapped species |
| 8/9 orchards | Short broadleaf trees | Display heights 3-6 m; no measured varieties or planting rows |
| 28 bamboo and other woody categories | Short generic woody instances | Coverage follows the real class; current geometry is not an exact bamboo model |
| 5/6/7/10, 12-17 crops, grassland and wetland herbs | Ground cover and nearby grass | Five grass variants; no claim about particular crop or wetland species |
| Nearby forest understory | Fern instances | Four visual variants; the source map has no separate fern survey layer |
| 0/1/2/4/11/30 missing, water, built-up, solar, greenhouse, reef/tidal-flat | No plants or vegetation tint | Existing rock/soil/water remains visible; buildings are not modeled |
| 3 bare ground | Low grass on soil-family surfaces; exposed rock retains geological materials | Visual ground-cover extension; no trees and no alteration to the source map |

Source patches constrain coverage. Stable seeds generate representative positions, shapes, headings and sizes. Spacing stays 12 m while detail changes with distance; 3D drawing stops beyond 1500 m. These are not surveyed individual plants. Cover fades inside vegetation boundaries. Original slopes of 35-60 degrees progressively expose rock; slopes at or above 60 degrees use geological material alone. These display rules do not alter GIS classes or DEM elevations.

See `../../REBUILD.md` for offline rebuilding. CRS, transforms, dimensions and category data can be checked with rasterio/GDAL; no native QGIS UI acceptance is claimed.
