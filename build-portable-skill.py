"""Build the complete Skill ZIP; verifies staged Node binaries and Unix execute bits."""
from hashlib import sha256
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent
skill = root / "skills" / "manage-cocopi2"
manifest = json.loads((skill / "references" / "runtime-manifest.json").read_text(encoding="utf-8"))
for relative, digest in manifest["nodeBinaries"].items():
    binary = skill / "bin" / relative
    if not binary.is_file():
        raise RuntimeError(f"Missing Node runtime: {binary}")
    actual = sha256(binary.read_bytes()).hexdigest()
    if actual != digest:
        raise RuntimeError(f"Node runtime SHA256 mismatch: {binary}")

output = root / "manage-cocopi2-portable-skill.zip"
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
    for item in sorted(skill.rglob("*")):
        if not item.is_file():
            continue
        name = (Path(skill.name) / item.relative_to(skill)).as_posix()
        if name.startswith("manage-cocopi2/bin/") and name.endswith("/node") or name == "manage-cocopi2/run.sh":
            mode = 0o100755
        else:
            mode = 0o100644
        info = zipfile.ZipInfo(name)
        info.create_system = 3  # POSIX mode bits survive normal unzip tools.
        info.external_attr = (mode << 16)
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, item.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
print(f"Built {output} ({output.stat().st_size} bytes)")
