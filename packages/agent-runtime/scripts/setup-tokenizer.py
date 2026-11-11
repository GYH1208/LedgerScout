"""Install optional official offline encoder, verified assets, and license notices."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request

REVISION = "935817c66f5d6e64838f419692545f06787e485f"
BASE = "https://raw.githubusercontent.com/deepseek-ai/deepseek-recipe/" + REVISION + "/"
HASHES = {
    "v41": "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99",
    "v4": "97d2f31b020d18b5aee5c9b3d5b4efb10ea210f3fe3f7dffe3f1cd90542d6b19",
}
ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / ".runtime" / "tokenizer"


def download(relative, target, checksum=None):
    if checksum and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == checksum:
        return
    temporary = None
    try:
        with urllib.request.urlopen(BASE + relative, timeout=30) as response, tempfile.NamedTemporaryFile(dir=DEST, delete=False) as output:
            temporary = Path(output.name)
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > 30_000_000:
                    raise ValueError("Asset exceeds size limit")
                digest.update(chunk)
                output.write(chunk)
        if checksum and digest.hexdigest() != checksum:
            raise ValueError("Tokenizer checksum mismatch")
        os.replace(temporary, target)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    python = DEST / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    uv = shutil.which("uv")
    if not python.exists():
        if uv:
            subprocess.run([uv, "venv", "--python", "3.12", str(DEST)], check=True)
        elif sys.version_info >= (3, 10):
            subprocess.run([sys.executable, "-m", "venv", str(DEST)], check=True)
        else:
            raise RuntimeError("Install uv or run setup with Python 3.10+")
    install = [uv, "pip", "install", "--python", str(python)] if uv else [str(python), "-m", "pip", "install"]
    subprocess.run(install + ["--only-binary=:all:", "deepseek-recipe==0.2.0"], check=True)
    for name, checksum in HASHES.items():
        print("Verifying " + name + " tokenizer", flush=True)
        download("static/tokenizers/" + name + "/tokenizer.json", DEST / (name + ".json"), checksum)
    download("static/tokenizers/LICENSE", DEST / "TOKENIZER-LICENSE")
    download("LICENSE", DEST / "ENCODER-LICENSE")
    manifest = {"revision": REVISION, "package": "deepseek-recipe==0.2.0", "sha256": HASHES}
    with tempfile.NamedTemporaryFile(mode="w", dir=DEST, delete=False, encoding="utf8") as output:
        json.dump(manifest, output)
        temporary = output.name
    os.replace(temporary, DEST / "ready.json")
    print("Local DeepSeek tokenizer ready (v4 / v41). No API key required.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit("Tokenizer setup failed; rerun setup after checking Python and network access. Runtime estimates remain available.")
