"""Install a built candidate into a temporary application. No registry uploads."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"


def run(command, cwd, env=None):
    subprocess.run([str(value) for value in command], cwd=cwd, env=env, check=True)


with tempfile.TemporaryDirectory(prefix="originchaindb-install-") as temporary:
    app = Path(temporary)
    artifact = next(ARTIFACTS.glob("*.tgz"))
    (app / "package.json").write_text(json.dumps({"private": True}))
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm") or "npm"
    run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", artifact], app)
    run(
        [
            "node",
            "-e",
            "const {Client,BatchWriteError}=require('@originchain/sdk');const db=new Client({url:'https://example.invalid',token:'test'});for(const name of ['writeBatches','pages','scan'])if(typeof db.rows[name]!=='function')throw Error(name);if(!BatchWriteError)throw Error('missing error type');",
        ],
        app,
    )
print("Fresh package application passed: " + "typescript")
