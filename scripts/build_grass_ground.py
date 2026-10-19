"""Build offline web textures from existing CC0 grass sources without downloading or modifying originals."""
from pathlib import Path
from io import BytesIO
import argparse
import base64
import json
from PIL import Image


def build(root: Path, output_root: Path) -> None:
    source = root / 'assets/material-library/grass/grass_ground'
    images = {}
    for key, suffix in [('color', 'diff'), ('normal', 'nor_gl')]:
        with Image.open(source / f'grass_ground_{suffix}_4k.jpg') as image:
            image = image.convert('RGB').resize((1024, 1024), Image.Resampling.LANCZOS)
            buffer = BytesIO()
            image.save(buffer, format='JPEG', quality=90, subsampling=0)
            images[key] = 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')
    target = output_root / 'assets/vegetation/runtime/grass-ground.js'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('// Generated from existing Poly Haven grass_ground textures (CC0).\nwindow.NOTO_GRASS_TEXTURES = '
                      + json.dumps(images, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(f'Generated {target.name}: {target.stat().st_size} bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output-root', type=Path)
    args = parser.parse_args()
    build(args.source_root, args.output_root or args.source_root)
