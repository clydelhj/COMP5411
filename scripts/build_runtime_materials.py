"""Generate browser materials indexed by rock/soil class from licensed high-resolution assets."""

from pathlib import Path
import json

import numpy as np
from PIL import Image, ImageOps, ImageDraw, ImageFont


# COLOR_SIZE: runtime color-map edge length, in pixels.
# DETAIL_SIZE: normal/roughness-map edge length, in pixels.
# SOURCE_ROOT: project root directory (Path).
COLOR_SIZE = 2048
DETAIL_SIZE = 1024
SOURCE_ROOT = Path(__file__).resolve().parents[1]


def read_map(folder, token, size, mode):
    """Read the unique 4K source channel matching token from folder, resize with Lanczos to size*size, convert to the requested PIL mode and return a normalized 0..1 NumPy image array."""
    paths = list(folder.glob(f"*_{token}_4k.jpg"))
    if len(paths) != 1:
        raise ValueError(f"Expected one {token} map in {folder}")

    with Image.open(paths[0]) as im:
        return (
            np.asarray(
                im.convert(mode).resize((size, size), Image.Resampling.LANCZOS),
                dtype=np.float32,
            )
            / 255
        )


def build(root):
    """Generate images, configuration and a traceable manifest for 29 shared material layers. Read source mappings, blend color in linear space, normalize blended normals and pack roughness. IDs 0 and 20 retain bedrock fallbacks. Return browser configuration sorted by class ID."""
    library = root / "assets/material-library"
    destination = library / "runtime"
    destination.mkdir(exist_ok=True)
    catalog = {
        a["id"]: a
        for a in json.loads(
            (library / "catalog.json").read_text(encoding="utf-8-sig")
        )
    }
    source = json.loads(
        (library / "material-class-mapping.json").read_text(encoding="utf-8-sig")
    )
    classes = {a["class_id"]: a for a in source["classes"]}

    # Blend weights define appearance only, not mineral content or measured rock/soil proportions.
    weights_by_id = {
        4: [0.72, 0.28],
        9: [0.8, 0.2],
        15: [0.8, 0.2],
        16: [0.8, 0.2],
        23: [0.65, 0.35],
        24: [0.7, 0.3],
        25: [0.7, 0.3],
        27: [0.65, 0.35],
    }
    scales = {
        1: 18,
        2: 8,
        3: 12,
        4: 8,
        5: 8,
        6: 16,
        7: 8,
        8: 12,
        9: 8,
        10: 18,
        11: 16,
        12: 18,
        13: 24,
        14: 18,
        15: 8,
        16: 8,
        17: 12,
        18: 12,
        19: 18,
        21: 8,
        22: 8,
        23: 14,
        24: 12,
        25: 12,
        26: 8,
        27: 16,
        28: 12,
    }
    layers = []

    for class_id in range(29):
        effective_id = 10 if class_id in (0, 20) else class_id
        entry = classes[effective_id]
        assets = entry["texture_candidates"] or ["rock_boulder_cracked", "sandy_gravel"]
        weights = weights_by_id.get(effective_id, [1.0])
        if len(assets) != len(weights):
            raise ValueError(f"Missing blend weights: {class_id}")

        paths = [library / catalog[a]["folder"] for a in assets]
        prefix = f"class-{class_id:02d}"
        color = np.zeros((COLOR_SIZE, COLOR_SIZE, 3), dtype=np.float32)
        normal = np.zeros((DETAIL_SIZE, DETAIL_SIZE, 3), dtype=np.float32)
        rough = np.zeros((DETAIL_SIZE, DETAIL_SIZE), dtype=np.float32)

        for folder, weight in zip(paths, weights):
            srgb = read_map(folder, "diff", COLOR_SIZE, "RGB")
            linear = np.where(
                srgb <= 0.04045,
                srgb / 12.92,
                ((srgb + 0.055) / 1.055) ** 2.4,
            )
            color += weight * linear
            normal += weight * (
                read_map(folder, "nor_gl", DETAIL_SIZE, "RGB") * 2 - 1
            )
            rough += weight * read_map(folder, "rough", DETAIL_SIZE, "L")

        srgb = np.where(
            color <= 0.0031308,
            color * 12.92,
            1.055 * np.maximum(color, 0) ** (1 / 2.4) - 0.055,
        )
        Image.fromarray(np.uint8(np.clip(srgb * 255 + 0.5, 0, 255))).save(
            destination / f"{prefix}-color.jpg",
            quality=94,
            subsampling=0,
        )
        normal /= np.maximum(np.linalg.norm(normal, axis=2, keepdims=True), 1e-6)
        detail = np.concatenate(
            (normal * 0.5 + 0.5, np.clip(rough, 0.35, 1)[..., None]),
            axis=2,
        )
        Image.fromarray(np.uint8(np.clip(detail * 255 + 0.5, 0, 255))).save(
            destination / f"{prefix}-detail.png"
        )

        note = entry["note"]
        if class_id == 27:
            note = "Visual approximation combining fractured rock and sand/gravel, not a scan of cemented conglomerate."
        layers.append(
            {
                "id": class_id,
                "name": entry["name"] if class_id not in (0, 20) else "Bedrock fallback",
                "color": f"./assets/material-library/runtime/{prefix}-color.jpg",
                "detail": f"./assets/material-library/runtime/{prefix}-detail.png",
                "scaleM": scales[effective_id],
                "sources": assets,
                "weights": weights,
                "note": note,
            }
        )
        print(f"Built class {class_id}", flush=True)

    config = {"colorSize": COLOR_SIZE, "detailSize": DETAIL_SIZE, "layers": layers}
    (root / "data/material-texture-config.js").write_text(
        "// Category IDs match shared texture-array layers; generated by scripts/build_runtime_materials.py.\n"
        "window.NOTO_MATERIAL_CONFIG = "
        + json.dumps(config, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )
    (destination / "manifest.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # The overview shows 27 land classes by ID; English names are provided in the configuration.
    preview = Image.new("RGB", (1200, 7 * 230), (28, 30, 32))
    draw = ImageDraw.Draw(preview)
    font = ImageFont.load_default(size=18)
    for i, layer in enumerate(a for a in layers if a["id"] not in (0, 20)):
        with Image.open(root / layer["color"][2:]) as im:
            preview.paste(
                ImageOps.fit(im, (280, 195)),
                ((i % 4) * 300 + 10, (i // 4) * 230),
            )
        draw.text(
            ((i % 4) * 300 + 10, (i // 4) * 230 + 200),
            f"Class {layer['id']:02d}",
            font=font,
            fill="white",
        )
    preview.save(destination / "class-preview.jpg", quality=92)

    from package_material_images import package_images

    package_images(root, config)
    return config


if __name__ == "__main__":
    # Read local sources, generate runtime textures and save directly loadable configuration.
    build(SOURCE_ROOT)
