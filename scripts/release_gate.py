"""Fail closed before running any release work."""
import json
import os
from pathlib import Path
import re
import subprocess


def validate(version, package, ref, repository, tag_exists):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?", version):
        raise ValueError("Version must be X.Y.Z or X.Y.Z-rc.N")
    if ref != "refs/heads/main" or repository != "originchaindb/originchaindb":
        raise ValueError("Releases must run from the canonical repository's main branch")
    if package.get("name") != "@originchain/sdk" or package.get("version") != version:
        raise ValueError("Requested package/version does not match SDK metadata")
    if package.get("repository", {}).get("url") != "git+https://github.com/originchaindb/originchaindb.git":
        raise ValueError("Repository metadata must match the trusted publisher")
    if tag_exists:
        raise ValueError("Tag already exists; inspect the existing release before retrying")
    preview = "-rc." in version
    return {"version": version, "dist_tag": "next" if preview else "latest"}


def main():
    version = os.environ.get("RELEASE_VERSION", "")
    result = validate(version, json.loads(Path("package.json").read_text()),
                      os.environ.get("GITHUB_REF"), os.environ.get("GITHUB_REPOSITORY"),
                      bool(subprocess.check_output(["git", "tag", "--list", "v" + version], text=True).strip()))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for key, value in result.items():
            output.write(f"{key}={value}\n")
    print(json.dumps(result))

if __name__ == "__main__":
    main()
