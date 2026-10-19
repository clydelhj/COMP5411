"""Extract the reference display classes and reconstruct preliminary rock columns.

Requires NumPy and pyproj. This builds display inputs, not an engineering model.
"""

from pathlib import Path
import argparse
import base64
import csv
import gzip
import json

import numpy as np
from pyproj import Transformer
from pmtiles.reader import Reader, MemorySource
import mapbox_vector_tile
from shapely.geometry import shape
from shapely import intersects_xy


# The generated preview combines low-resolution surface classes with wider
# regional geology. These constants describe display classification only.


def gsj_classes(package, xx, zz):
    """Sample GSJ vector geology on metric model grids xx/zz. Transform to EPSG:3857, read z12 geo_A polygons, map source legend codes to project IDs and test polygon coverage. Return the category grid (fallback 10) and source/tile metadata."""
    reader = Reader(
        MemorySource(
            (package / "geology/gsj_noto_1_50000_geological_map.pmtiles").read_bytes()
        )
    )
    project = Transformer.from_crs(6675, 3857, always_xy=True)
    mx, my = project.transform(xx + 1845, 159515 - zz)
    circumference = 40075016.68557849
    gx, gy = (mx + circumference / 2) / circumference * 4096, (
        circumference / 2 - my
    ) / circumference * 4096
    tx, ty = np.floor(gx).astype(int), np.floor(gy).astype(int)
    output = np.full(xx.shape, 10, dtype=np.uint8)
    mapping = {
        44: 17,
        34: 14,
        38: 14,
        39: 14,
        41: 14,
        46: 14,
        47: 14,
        26: 12,
        27: 12,
        35: 12,
        36: 12,
        42: 12,
        43: 12,
        25: 18,
        40: 18,
        15: 13,
        31: 13,
        37: 13,
        45: 13,
        32: 28,
        33: 27,
        20: 23,
        23: 23,
        29: 23,
        19: 24,
        22: 24,
        28: 24,
        24: 25,
        30: 25,
        1: 26,
        2: 2,
        3: 5,
        4: 26,
        5: 26,
        7: 26,
        8: 26,
        9: 26,
        10: 26,
        11: 26,
        12: 26,
        13: 26,
        14: 26,
    }
    legend = {}
    tile_count = 0

    for ix, iy in np.unique(np.stack([tx.ravel(), ty.ravel()], axis=1), axis=0):
        raw = reader.get(12, int(ix), int(iy))
        if not raw:
            continue

        layers = mapbox_vector_tile.decode(
            gzip.decompress(raw), default_options={"y_coord_down": True}
        )
        tile_count += 1
        layer = layers.get("geo_A")
        if not layer:
            continue

        rr, cc = np.where((tx == ix) & (ty == iy))
        px, py = (gx[rr, cc] - ix) * layer["extent"], (
            gy[rr, cc] - iy
        ) * layer["extent"]
        for feature in layer["features"]:
            props = feature["properties"]
            code = props["MAJOR_CODE"]
            if code not in mapping:
                continue

            geom = shape(feature["geometry"])
            if geom.geom_type not in ["Polygon", "MultiPolygon"]:
                continue

            hit = intersects_xy(geom, px, py)
            output[rr[hit], cc[hit]] = mapping[code]
            legend[code] = dict(
                materialId=mapping[code],
                symbol=props.get("SYMBOL_1", ""),
                sourceName=props.get("LEGEND05E", props.get("LEGEND03E", "")),
            )

    return output, dict(zoom=12, tiles=tile_count, sourceClasses=legend)


def build(root):
    """Build an initial geological display volume from the reference model, geology map and borehole logs. Verify duplicate reference corners, reconstruct 13 layers by inverse-squared-distance category voting, fill outside coverage from regional geology and restore source surface classes. Transform in-region boreholes and assemble depth intervals. Write data/strata-data.js and print a summary."""
    package = root / "noto_terrain_materials_package"
    text = (package / "visualization/model_view.html").read_text(encoding="utf-8")
    offset = text.find("[", text.rfind("Plotly.newPlot("))
    traces, _ = json.JSONDecoder().raw_decode(text[offset:])
    surface = traces[0]
    assert surface["name"] == "Surface material"
    names = surface["colorbar"]["ticktext"] + ["Topsoil", "Cohesive soil"]
    colors = [
        "#a49883",
        "#b8a67b",
        "#b4a38c",
        "#a08767",
        "#c8b37d",
        "#9c876c",
        "#9c8262",
        "#756d61",
        "#a69a80",
        "#8d8b80",
        "#8b958c",
        "#bcaaa0",
        "#b49b7c",
        "#71776e",
        "#bbaa82",
        "#a88e76",
        "#8e9391",
        "#b5a17e",
        "#555756",
        "#668e9e",
        "#706046",
        "#967d61",
    ]
    soil_ids = {4, 6, 7, 9, 15, 16, 21, 22}
    sand_ids = {2, 5, 13, 18}
    palette = [
        dict(
            id=i + 1,
            name=name,
            color=colors[i],
            family=(
                "soil" if i + 1 in soil_ids else "sand" if i + 1 in sand_ids else "rock"
            ),
            roughness=0.97 if i + 1 in soil_ids else 0.89,
        )
        for i, name in enumerate(names)
    ]
    for name, color, family in [
        ("Siliceous siltstone", "#92998d", "rock"),
        ("Diatomaceous siltstone", "#b0af95", "rock"),
        ("Calcareous siltstone", "#aaa68e", "rock"),
        ("Mixed surficial deposits", "#b5a27c", "soil"),
        ("Conglomerate with sandstone", "#9e937d", "rock"),
        ("Sandstone", "#bdaa83", "sand"),
    ]:
        palette.append(
            dict(
                id=len(palette) + 1,
                name=name,
                color=color,
                family=family,
                roughness=0.93,
            )
        )

    # Reference coordinates have no EPSG origin. DEM texture registration estimates native offsets of row 58, column 2,
    # with reversed north/south row order. Retain this estimate without stretching the smaller reference extent.
    west = -14770 + (2 + 0.5) * 5
    north = 171085 - (58 + 0.5) * 5
    width, height = 28850.0, 17000.0
    south = north - height
    levels = 13
    anchors, columns = [], []

    for trace in traces[1:7]:
        x, y, z, ids = (np.asarray(trace[k]) for k in ["x", "y", "z", "surfacecolor"])
        assert x.shape[0] == levels and ids.shape == x.shape
        anchors.extend(np.stack([x[0] * 1000, y[0] * 1000], axis=1).tolist())
        columns.extend(ids.T.tolist())

    anchors, columns = np.asarray(anchors), np.asarray(columns, dtype=np.uint8)
    # Check that complete category profiles agree before merging coincident corners.
    anchors, unique, inverse = np.unique(
        anchors, axis=0, return_index=True, return_inverse=True
    )
    assert np.array_equal(
        columns, columns[unique][inverse]
    ), "Conflicting reference columns"
    columns = columns[unique]

    model_width, model_height = 33225.0, 23135.0
    cols, rows = 223, 156  # Approximately 150 m surface display spacing.
    x = np.linspace(-model_width / 2, model_width / 2, cols)
    z = np.linspace(-model_height / 2, model_height / 2, rows)
    xx, zz = np.meshgrid(x, z)
    local_x, local_y = xx + 1845 - west, 159515 - zz - south
    # Nearest-node sampling extends half a 150 m cell past the endpoints so the estimated 10 m west offset
    # does not leave a narrow unclassified strip.
    support = 75.0
    inside = (
        (local_x >= -support)
        & (local_x <= width + support)
        & (local_y >= -support)
        & (local_y <= height + support)
    )
    regional, gsj_info = gsj_classes(package, xx, zz)
    result = np.repeat(regional[:, None, :], levels, axis=1)
    targets = np.argwhere(inside)

    for start in range(0, len(targets), 256):
        rc = targets[start : start + 256]
        q = np.stack(
            [local_x[rc[:, 0], rc[:, 1]], local_y[rc[:, 0], rc[:, 1]]],
            axis=1,
        )
        d2 = ((q[:, None] - anchors[None]) ** 2).sum(axis=2)
        near = np.argpartition(d2, 7, axis=1)[:, :8]
        weights = 1 / np.maximum(np.take_along_axis(d2, near, axis=1), 1.0)
        sampled = columns[near]
        # Category IDs are discrete: accumulate inverse-distance votes per category and choose the highest score.
        scores = np.stack(
            [
                (weights[:, :, None] * (sampled == k)).sum(axis=1)
                for k in range(1, 21)
            ],
            axis=-1,
        )
        ids = scores.argmax(axis=-1).astype(np.uint8) + 1
        result[rc[:, 0], :, rc[:, 1]] = ids

    # Preserve the reference model's actual surface classes at their original resolution.
    rr, cc = np.where(inside)

    def nearest_axis(axis, values):
        """Find nearest reference-axis indices. axis is kilometres and values are metres. Convert axis to metres, locate left/right neighbors with searchsorted and choose the closer index, breaking ties to the left. Return integer indices."""
        axis = np.asarray(axis) * 1000
        right = np.clip(np.searchsorted(axis, values), 1, len(axis) - 1)
        return np.where(
            abs(values - axis[right - 1]) <= abs(values - axis[right]),
            right - 1,
            right,
        )

    ref_r = nearest_axis(surface["y"], local_y[rr, cc])
    ref_c = nearest_axis(surface["x"], local_x[rr, cc])
    result[rr, 0, cc] = np.asarray(surface["surfacecolor"], dtype=np.uint8)[
        ref_r, ref_c
    ]

    # The marine placeholder belongs to existing water geometry and is excluded from rock-shell categories.
    marine_placeholder = result == 20
    regional_columns = np.broadcast_to(regional[:, None, :], result.shape)
    result[marine_placeholder] = regional_columns[marine_placeholder]

    material_ids = {
        "Topsoil": 21,
        "Cohesive soil": 22,
        "Rock (unclassified)": 10,
        "Sand": 5,
        "Silt": 9,
        "Clayey sand": 15,
        "Tuffaceous sandstone": 18,
        "Carbonaceous shale": 19,
        "Gravelly clay (talus)": 7,
        "Gravelly clay": 7,
        "Weathered mudstone": 6,
        "Mudstone": 8,
    }
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:6675", always_xy=True)
    boreholes = {}
    with (
        package / "geotechnical/geotechnical_layering_summary.csv"
    ).open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if row["inside_project_domain"].lower() != "true":
                continue

            key = row["profile_id"]
            east, northing = transformer.transform(
                float(row["longitude_deg"]), float(row["latitude_deg"])
            )
            column = boreholes.setdefault(
                key,
                dict(
                    profile=key,
                    name=row["station_name"],
                    x=east - 1845,
                    z=159515 - northing,
                    radius=750,
                    recordedGroundElevation=float(row["ground_elevation_m"]),
                    layers=[],
                ),
            )
            layer = dict(
                top=float(row["top_depth_m"]),
                bottom=float(row["bottom_depth_m"]),
                id=material_ids[row["material_name"]],
            )
            assert layer["bottom"] > layer["top"] >= 0
            column["layers"].append(layer)

    for column in boreholes.values():
        column["layers"].sort(key=lambda a: a["top"])
        for a, b in zip(column["layers"], column["layers"][1:]):
            assert abs(a["bottom"] - b["top"]) < 1e-6

    metadata = dict(
        cols=cols,
        rows=rows,
        levels=levels,
        width_m=model_width,
        height_m=model_height,
        referenceWest=west,
        referenceSouth=south,
        referenceWidth=width,
        referenceHeight=height,
        referenceEdgeSupport_m=support,
        registration=(
            "Estimated DEM pattern fit: native row 58, col 2; "
            "north/south reversed"
        ),
        registrationCorrelation=0.99446,
        registrationElevationRMSE_m=4.255,
        reconstruction=(
            "8 nearest section columns, inverse squared distance categorical voting; "
            "13 normalized depth samples"
        ),
        outsideReference=(
            "GSJ map lithology extruded to base as a preliminary column; "
            "unmapped areas remain unclassified"
        ),
        gsj=gsj_info,
        boreholeInfluenceRadius_m=750,
        note="Preliminary rendering interpretation; not a measured 3D geological model",
    )
    payload = base64.b64encode(gzip.compress(result.tobytes(), mtime=0)).decode()
    out = root / "data/strata-data.js"
    with out.open("w", encoding="utf-8") as f:
        f.write(
            "// Generated by scripts/build_material_assets.py.\n"
            "window.NOTO_STRATA = {\n"
        )
        for key, value in [
            ("metadata", metadata),
            ("palette", palette),
            ("boreholes", list(boreholes.values())),
        ]:
            f.write(
                json.dumps(key)
                + ": "
                + json.dumps(value, ensure_ascii=False, indent=2)
                + ",\n"
            )
        f.write(
            '"ids": [\n'
            + ",\n".join(
                "  " + json.dumps(payload[i : i + 100])
                for i in range(0, len(payload), 100)
            )
            + "\n].join(\"\")\n};\n"
        )

    print(
        json.dumps(
            dict(
                grid=[cols, levels, rows],
                classes=np.unique(result).tolist(),
                boreholes=len(boreholes),
                layers=sum(len(b["layers"]) for b in boreholes.values()),
                fileBytes=out.stat().st_size,
                insideReferenceNodes=int(inside.sum()),
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    build(parser.parse_args().root)
