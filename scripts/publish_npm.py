"""Publish a verified archive with OIDC; verify public registry bytes afterwards."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

from release_gate import validate
from verify_release_artifact import verify

REGISTRY = "https://registry.npmjs.org/@originchain%2fsdk"


def publish_command(archive, dist_tag, dry_run=False):
    # npm interprets a bare directory/file pair as GitHub owner/repository.
    command = ["npm", "publish", str(Path(archive).resolve()), "--ignore-scripts",
               "--access", "public", "--tag", dist_tag]
    return command + (["--dry-run", "--json"] if dry_run else ["--provenance"])


def read_json(url):
    try:
        with urlopen(url, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def registry_hash(metadata):
    url = metadata["dist"]["tarball"]
    if not url.startswith("https://registry.npmjs.org/@originchain/sdk/-/"):
        raise ValueError("Unexpected registry tarball location")
    with urlopen(url, timeout=30) as response:
        return hashlib.sha256(response.read()).hexdigest()


def check_existing(metadata, digest, version):
    if metadata is None:
        return False
    if metadata.get("name") != "@originchain/sdk" or metadata.get("version") != version:
        raise ValueError("Registry package metadata mismatch")
    if registry_hash(metadata) != digest:
        raise ValueError("Version already exists with different bytes; refusing to continue")
    return True


def main():
    directory = Path(sys.argv[1])
    package = json.loads(Path("package.json").read_text())
    version = package["version"]
    release = validate(version, package, os.environ["GITHUB_REF"], os.environ["GITHUB_REPOSITORY"],
                       False)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    archive = verify(directory, package, commit)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    tags_before = (read_json(REGISTRY) or {}).get("dist-tags", {})
    existing = read_json(REGISTRY + "/" + version)
    resumed = check_existing(existing, digest, version)
    if not resumed:
        subprocess.run(publish_command(archive, release["dist_tag"]), check=True)
    for attempt in range(12):
        published = read_json(REGISTRY + "/" + version)
        if published is not None:
            break
        time.sleep(5)
    else:
        raise RuntimeError("Published version is not yet visible on the public registry")
    check_existing(published, digest, version)
    tags_after = read_json(REGISTRY)["dist-tags"]
    if tags_after.get(release["dist_tag"]) != version:
        raise ValueError("Published dist-tag does not identify the verified version")
    if release["dist_tag"] == "next" and tags_after.get("latest") != tags_before.get("latest"):
        raise ValueError("The latest dist-tag changed during preview publication; investigate")
    receipt = dict(release, source_commit=commit, archive=archive.name, sha256=digest,
                   registry_tarball=published["dist"]["tarball"], public_bytes_match=True,
                   resumed_existing_version=resumed, tags_before=tags_before, tags_after=tags_after)
    (directory / "npm-publication.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (directory / "SHA256SUMS.txt").write_text(f"{digest}  {archive.name}\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
