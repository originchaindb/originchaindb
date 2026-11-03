"""Verify the selected CI archive before installing or publishing it."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile


def verify(directory, package, commit):
    directory = Path(directory)
    proof = json.loads((directory / "package-verification.json").read_text())
    if proof.get("source_commit") != commit or proof.get("version") != package["version"]:
        raise ValueError("CI proof is for a different source/version")
    for key, expected in {"installed_files_match_build_and_source": True,
                          "esm_and_commonjs": "passed", "consumer_types": "passed",
                          "live_script_compiled_against_installed_package": True}.items():
        if proof.get(key) != expected:
            raise ValueError(f"CI proof lacks passing {key}")
    archives = list(directory.glob("*.tgz"))
    if len(archives) != 1 or archives[0].name != proof.get("archive"):
        raise ValueError("CI proof must identify exactly one archive")
    archive = archives[0]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != proof.get("sha256"):
        raise ValueError("Archive checksum does not match tested bytes")
    with tarfile.open(archive) as packed:
        if json.load(packed.extractfile("package/package.json")) != package:
            raise ValueError("Archived package metadata differs from checked out source")
    return archive


if __name__ == "__main__":
    archive = verify(sys.argv[1], json.loads(Path("package.json").read_text()),
                     subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip())
    print(f"Verified tested archive: {archive}")
