"""Read original glTF attributes and save reproducible simplification inputs and 2K/1K runtime textures."""

from pathlib import Path
import json, numpy as np, io, base64, shutil
from PIL import Image
import argparse

parser = argparse.ArgumentParser(
    description="Prepare local vegetation model arrays and runtime textures"
)
parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
args = parser.parse_args()
root = args.root.resolve()
source = root / "assets/vegetation/source"
runtime = root / "assets/vegetation/runtime"
runtime.mkdir(parents=True, exist_ok=True)
temporary = root / "assets/vegetation/.build"
temporary.mkdir(exist_ok=True)


def accessor(g, data, index):
    """Read a contiguous glTF accessor from its local binary buffer without another model loader. Resolve bufferView offsets/component type, reject sparse or interleaved layouts and reshape by count/vector width. Return an independent NumPy array so later changes cannot rewrite source bytes."""
    a = g["accessors"][index]
    v = g["bufferViews"][a["bufferView"]]
    dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "u1"}[a["componentType"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    offset = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    assert not a.get("sparse") and "byteStride" not in v
    return (
        np.frombuffer(data, dtype=dtype, count=a["count"] * n, offset=offset).reshape(-1, n).copy()
    )


# Main pipeline:
# 1. Read local 4K glTF geometry and materials.
# 2. Apply UV transforms and derive transparent foliage color and PBR textures.
# 3. Save offline simplification inputs without modifying source geometry.
models = []
for key, asset in [
    ("broadleaf", "tree_small_02"),
    ("conifer", "fir_tree_01"),
    ("grass", "grass_medium_02"),
    ("fern", "fern_02"),
]:
    folder = source / asset
    name = "fir_tree_01_a_4k.gltf" if key == "conifer" else asset + "_4k.gltf"
    g = json.loads((folder / name).read_text())
    data = (folder / g["buffers"][0]["uri"]).read_bytes()
    # The extracted conifer keeps only its referenced materials/images so the glTF opens independently.
    if key == "conifer":
        mi = sorted({p["material"] for p in g["meshes"][0]["primitives"]})
        mm = {o: n for n, o in enumerate(mi)}
        for p in g["meshes"][0]["primitives"]:
            p["material"] = mm[p["material"]]
        g["materials"] = [g["materials"][i] for i in mi]
        ti = set()
        for m in g["materials"]:
            if "normalTexture" in m:
                ti.add(m["normalTexture"]["index"])
            for v in m["pbrMetallicRoughness"].values():
                if isinstance(v, dict) and "index" in v:
                    ti.add(v["index"])
        ts = sorted(ti)
        tm = {o: n for n, o in enumerate(ts)}
        for m in g["materials"]:
            if "normalTexture" in m:
                m["normalTexture"]["index"] = tm[m["normalTexture"]["index"]]
            for v in m["pbrMetallicRoughness"].values():
                if isinstance(v, dict) and "index" in v:
                    v["index"] = tm[v["index"]]
        textures = [g["textures"][i] for i in ts]
        ii = sorted(set(t["source"] for t in textures))
        im = {o: n for n, o in enumerate(ii)}
        for t in textures:
            t["source"] = im[t["source"]]
        g["images"] = [g["images"][i] for i in ii]
        g["textures"] = textures
        (folder / name).write_text(json.dumps(g, indent=2))
        (folder / "fir_tree_01_4k.gltf").unlink(missing_ok=True)
    material_records = []
    for i, m in enumerate(g["materials"]):
        pbr = m["pbrMetallicRoughness"]
        record = {"name": m["name"], "leaf": m.get("alphaMode") in ["MASK", "BLEND"]}
        for kind, t in [
            ("color", pbr.get("baseColorTexture")),
            ("normal", m.get("normalTexture")),
            ("arm", pbr.get("metallicRoughnessTexture")),
        ]:
            if not t:
                continue
            path = folder / g["images"][g["textures"][t["index"]]["source"]]["uri"]
            size = 2048 if kind == "color" else 1024
            image = Image.open(path).convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
            if kind == "color" and record["leaf"]:
                # Black areas in the source RGB leaf atlas are background; derive alpha to avoid rectangular leaf edges.
                a = np.array(image)
                alpha = np.clip((a.max(axis=2).astype(float) - 7) / 15 * 255, 0, 255).astype(
                    "uint8"
                )
                image = Image.fromarray(np.dstack([a, alpha]), "RGBA")
            suffix = "png" if image.mode == "RGBA" else "jpg"
            name = f"{key}-{i}-{kind}.{suffix}"
            image.save(runtime / name, **({"quality": 92} if suffix == "jpg" else {}))
            record[kind] = {
                "file": name,
                "url": "data:image/"
                + ("jpeg" if suffix == "jpg" else "png")
                + ";base64,"
                + base64.b64encode((runtime / name).read_bytes()).decode(),
            }
        material_records.append(record)
    parts = []
    all_positions = []
    # Keep all grass/fern variants for near-view mixing; use one prototype per tree without source sample-array translation.
    for mesh_index, mesh in enumerate(g["meshes"]):
        for primitive_index, p in enumerate(mesh["primitives"]):
            pos = accessor(g, data, p["attributes"]["POSITION"]).astype("<f4")
            normal = accessor(g, data, p["attributes"]["NORMAL"]).astype("<f4")
            mat = g["materials"][p["material"]]
            t = mat["pbrMetallicRoughness"].get("baseColorTexture", {})
            uvkey = "TEXCOORD_" + str(t.get("texCoord", 0))
            uv = (
                accessor(g, data, p["attributes"][uvkey]).astype("<f4")
                if uvkey in p["attributes"]
                else np.zeros((len(pos), 2), dtype="<f4")
            )
            if uvkey not in p["attributes"] and t:
                # Source tree C has no trunk UVs; derive cylindrical coordinates only for the runtime copy.
                uv[:, 0] = np.arctan2(pos[:, 2], pos[:, 0]) / (2 * np.pi) + 0.5
                span = max(float(np.ptp(pos[:, 1])), 0.001)
                uv[:, 1] = (pos[:, 1] - pos[:, 1].min()) / span
            tx = t.get("extensions", {}).get("KHR_texture_transform", {})
            uv = uv * np.array(tx.get("scale", [1, 1]), dtype="<f4") + np.array(
                tx.get("offset", [0, 0]), dtype="<f4"
            )
            indices = accessor(g, data, p["indices"]).astype("<u4").ravel()
            # Centre each plant on its own root. Instances rotate only around Y; glTF coordinates are metres.
            prefix = f"{key}-{mesh_index}-{primitive_index}"
            for n, a in [("position", pos), ("normal", normal), ("uv", uv), ("index", indices)]:
                a.tofile(temporary / (prefix + "-" + n + ".bin"))
            parts.append(
                {
                    "prefix": prefix,
                    "material": p["material"],
                    "variant": mesh_index,
                    "vertices": len(pos),
                    "triangles": len(indices) // 3,
                }
            )
            all_positions.append(pos)
    values = np.concatenate(all_positions)
    lo = values.min(axis=0)
    hi = values.max(axis=0)
    # Recenter each mesh base when local variant coordinates include source sample offsets.
    model = {
        "key": key,
        "source_asset": asset,
        "height": float(hi[1] - lo[1]),
        "bounds": [lo.tolist(), hi.tolist()],
        "materials": material_records,
        "parts": parts,
    }
    models.append(model)
    print(
        key, "height", model["height"], "triangles", sum(p["triangles"] for p in parts), flush=True
    )
(temporary / "models.json").write_text(json.dumps(models), encoding="utf-8")
