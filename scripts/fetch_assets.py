"""Download and verify course assets, then install only permitted asset trees.

Python standard library only. No archive contents are executed. The manifest
pins the byte count and SHA-256 digest of every GitHub Release archive.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import sys
import tempfile
import time
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen
import zipfile


BLOCK = 4 * 1024 * 1024


class AssetError(Exception):
    """An asset could not be verified or safely installed."""


def read_manifest(path):
    """Validate archive names, groups, pinned hashes and release URLs."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise AssetError("Manifest root must be an object.")
    repository = payload.get("repository", "")
    release = payload.get("release", "")
    if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise AssetError("Manifest repository must be an owner/repository pair.")
    if not isinstance(release, str) or not release or "/" in release:
        raise AssetError("Manifest release must be a nonempty release tag.")
    expected_path = f"/{repository}/releases/download/{quote(release, safe='')}/"
    assets = payload.get("assets")
    if not isinstance(assets, list) or not assets:
        raise AssetError("Manifest does not contain any assets.")
    names = set()
    for asset in assets:
        if not isinstance(asset, dict):
            raise AssetError("Each manifest asset must be an object.")
        name = asset.get("name", "")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.zip", name):
            raise AssetError(f"Invalid ZIP archive name: {name!r}")
        if name.casefold() in names:
            raise AssetError(f"Duplicate archive name: {name}")
        names.add(name.casefold())
        if asset.get("group") not in ("runtime", "sources"):
            raise AssetError(f"Unknown asset group for {name}.")
        if type(asset.get("bytes")) is not int or asset["bytes"] <= 0:
            raise AssetError(f"Invalid pinned byte count for {name}.")
        digest = asset.get("sha256", "")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            raise AssetError(f"Invalid SHA-256 digest for {name}.")
        url = asset.get("url", "")
        if not isinstance(url, str):
            raise AssetError(f"Invalid download URL for {name}.")
        parts = urlsplit(url)
        if (parts.scheme != "https" or parts.netloc != "github.com"
                or parts.query or parts.fragment
                or not parts.path.startswith(expected_path)
                or unquote(parts.path[len(expected_path):]) != name):
            raise AssetError(f"Expected an HTTPS GitHub Release URL for {name}.")
    if not any(asset["group"] == "runtime" for asset in assets):
        raise AssetError("Manifest must include at least one runtime archive.")
    return assets


def verify_archive(path, asset):
    """Read an archive once to verify its exact length and SHA-256."""
    if not path.is_file():
        raise AssetError(f"Archive is missing: {path}")
    if path.stat().st_size != asset["bytes"]:
        raise AssetError(f"Byte count mismatch: {asset['name']}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(BLOCK), b""):
            digest.update(block)
    if digest.hexdigest().lower() != asset["sha256"].lower():
        raise AssetError(f"SHA-256 mismatch: {asset['name']}")


def inside_root(path, root):
    """Reject existing symlink/junction components and resolved escape paths."""
    if not path.resolve().is_relative_to(root):
        raise AssetError(f"Destination escapes the project: {path}")
    relative = path.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        try:
            attributes = current.lstat()
        except FileNotFoundError:
            continue
        # lstat exposes Windows reparse attributes on all supported Python
        # versions; containment alone misses junctions back into project code.
        reparse = getattr(attributes, "st_file_attributes", 0) & getattr(
            stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400
        )
        if stat.S_ISLNK(attributes.st_mode) or reparse:
            raise AssetError(f"Destination contains a link: {current}")


def allowed_member(parts, group):
    """Allow asset/input trees only; source code and Git metadata are excluded."""
    if group == "runtime":
        return (parts[0] == "data"
                or parts[:3] == ("assets", "material-library", "runtime")
                or parts[:3] == ("assets", "vegetation", "runtime"))
    return (parts[0] in ("gis", "noto_terrain_materials_package", "source-data")
            or (parts[:2] == ("assets", "material-library")
                and (len(parts) == 2 or parts[2].casefold() != "runtime"))
            or parts[:3] == ("assets", "vegetation", "source"))


def checked_members(archive, root, group):
    """Check the complete ZIP directory before creating any output files."""
    checked = []
    seen = {}
    entries = archive.infolist()
    for info in entries:
        name = info.orig_filename
        if (not name or "\x00" in name or "\\" in name
                or PurePosixPath(name).is_absolute()
                or PureWindowsPath(name).drive):
            raise AssetError(f"Unsafe archive path: {name!r}")
        raw_parts = name.rstrip("/").split("/")
        if any(part in ("", ".", "..") or ":" in part
               or part.rstrip(". ") != part or part.casefold() == ".git"
               for part in raw_parts):
            raise AssetError(f"Unsafe archive path: {name!r}")
        parts = tuple(raw_parts)
        # Windows device names must not become files even on another platform.
        if any(re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]",
                            part.split(".", 1)[0], flags=re.I) for part in parts):
            raise AssetError(f"Reserved archive path: {name!r}")
        mode = info.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise AssetError(f"Archive links or special files are forbidden: {name}")
        if info.flag_bits & 1:
            raise AssetError(f"Encrypted archive members are forbidden: {name}")
        is_dir = info.is_dir()
        key = "/".join(parts).casefold()
        if key in seen:
            raise AssetError(f"Duplicate archive path: {name}")
        seen[key] = is_dir
        if not allowed_member(parts, group):
            # ZIP tools may include harmless parent directory entries. They are
            # not installed; every actual file must pass the strict allowlist.
            if is_dir and parts in (("assets",), ("assets", "material-library"),
                                     ("assets", "vegetation")):
                continue
            raise AssetError(f"Path is outside the {group} asset trees: {name}")
        asset_roots = (("data",), ("gis",), ("source-data",),
                       ("noto_terrain_materials_package",),
                       ("assets", "material-library"),
                       ("assets", "material-library", "runtime"),
                       ("assets", "vegetation", "runtime"),
                       ("assets", "vegetation", "source"))
        if not is_dir and parts in asset_roots:
            raise AssetError(f"Expected an asset directory, not a root file: {name}")
        destination = root.joinpath(*parts)
        inside_root(destination, root)
        if destination.exists() and destination.is_dir() != is_dir:
            raise AssetError(f"Destination type conflict: {name}")
        checked.append((info, destination))
    for key in seen:
        parent = key
        while "/" in parent:
            parent = parent.rsplit("/", 1)[0]
            if parent in seen and not seen[parent]:
                raise AssetError(f"File used as an archive directory: {parent}")
    return checked


def install_archive(path, root, group):
    """Install checked files atomically inside the permitted project trees."""
    if group not in ("runtime", "sources"):
        raise AssetError(f"Unknown asset group: {group}")
    root = root.resolve()
    count = 0
    with zipfile.ZipFile(path) as archive:
        members = checked_members(archive, root, group)
        for info, destination in members:
            inside_root(destination, root)
            if info.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            inside_root(destination, root)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".asset-",
                                                 suffix=".tmp", delete=False) as target:
                    temporary = Path(target.name)
                    with archive.open(info) as source:
                        shutil.copyfileobj(source, target, length=BLOCK)
                os.replace(temporary, destination)
                temporary = None
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            count += 1
    return count


def obtain_archive(asset, cache, root):
    """Reuse a verified download or replace it with a pinned Release archive."""
    inside_root(cache, root)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / asset["name"]
    inside_root(target, root)
    if target.exists():
        try:
            verify_archive(target, asset)
            print(f"Using verified cache: {asset['name']}", flush=True)
            return target
        except AssetError as error:
            print(f"Cached archive will be replaced: {error}", flush=True)
    print(f"Downloading {asset['name']} ({asset['bytes'] / 1024**2:.1f} MiB)...", flush=True)
    temporary = None
    try:
        request = Request(asset["url"], headers={"User-Agent": "COMP5411-asset-fetch/1.0"})
        digest = hashlib.sha256()
        received = 0
        last_report = time.monotonic()
        with urlopen(request, timeout=60) as response:
            if urlsplit(response.url).scheme != "https":
                raise AssetError("Download redirected to a non-HTTPS URL.")
            with tempfile.NamedTemporaryFile(dir=cache, prefix=".download-",
                                             suffix=".part", delete=False) as output:
                temporary = Path(output.name)
                while True:
                    block = response.read(BLOCK)
                    if not block:
                        break
                    received += len(block)
                    if received > asset["bytes"]:
                        raise AssetError(f"Download exceeds pinned byte count: {asset['name']}")
                    digest.update(block)
                    output.write(block)
                    if time.monotonic() - last_report >= 2:
                        print(f"  {100 * received / asset['bytes']:.1f}%", flush=True)
                        last_report = time.monotonic()
        if received != asset["bytes"] or digest.hexdigest().lower() != asset["sha256"].lower():
            raise AssetError(f"Downloaded archive failed byte-count/SHA-256 verification: {asset['name']}")
        os.replace(temporary, target)
        temporary = None
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", action="store_true",
                        help="Install source-input archives as well as required runtime assets.")
    parser.add_argument("--archives-dir", type=Path,
                        help="Offline mode: read all selected ZIPs from this directory; do not download.")
    args = parser.parse_args(argv)
    try:
        assets = read_manifest(root / "assets-manifest.json")
        selected = [asset for asset in assets if args.sources or asset["group"] == "runtime"]
        if args.archives_dir is not None:
            archive_dir = args.archives_dir.resolve()
            # Verify the complete offline selection before writing any assets.
            for asset in selected:
                verify_archive(archive_dir / asset["name"], asset)
        for number, asset in enumerate(selected, 1):
            if args.archives_dir is None:
                path = obtain_archive(asset, root / ".asset-cache", root)
            else:
                path = archive_dir / asset["name"]
            print(f"[{number}/{len(selected)}] Installing verified {asset['name']}...", flush=True)
            count = install_archive(path, root, asset["group"])
            print(f"  Installed {count} files.", flush=True)
        print("Assets are ready. Run: python scripts/serve.py", flush=True)
        return 0
    except (AssetError, OSError, ValueError, KeyError, zipfile.BadZipFile,
            RuntimeError) as error:
        print(f"Asset installation failed: {error}", file=sys.stderr)
        if args.archives_dir is not None:
            print("Offline mode requires every selected archive with its manifest filename.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
