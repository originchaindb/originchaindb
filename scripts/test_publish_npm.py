import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from publish_npm import check_existing, publish_command, registry_hash


class PublishTests(unittest.TestCase):
    def test_missing_version_needs_publish(self):
        self.assertFalse(check_existing(None, "abc", "0.7.0-rc.6"))

    @patch("publish_npm.registry_hash", return_value="abc")
    def test_identical_existing_archive_resumes(self, mocked):
        self.assertTrue(check_existing({"name": "@originchain/sdk", "version": "0.7.0-rc.6"}, "abc", "0.7.0-rc.6"))

    @patch("publish_npm.registry_hash", return_value="different")
    def test_existing_version_conflict_rejected(self, mocked):
        with self.assertRaises(ValueError):
            check_existing({"name": "@originchain/sdk", "version": "0.7.0-rc.6"}, "abc", "0.7.0-rc.6")

    def test_wrong_registry_metadata_rejected(self):
        with self.assertRaises(ValueError):
            check_existing({"name": "other", "version": "0.7.0-rc.6"}, "abc", "0.7.0-rc.6")

    def test_external_tarball_rejected(self):
        with self.assertRaises(ValueError):
            registry_hash({"dist": {"tarball": "https://example.org/sdk.tgz"}})

    def test_npm_treats_nested_archive_as_a_local_package(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "release-dist" / "sdk.tgz"
            target.parent.mkdir()
            with tarfile.open(target, "w:gz") as packed:
                data = json.dumps({"name": "@originchain/sdk", "version": "0.7.0-rc.6"}).encode()
                member = tarfile.TarInfo("package/package.json")
                member.size = len(data)
                packed.addfile(member, io.BytesIO(data))
            # Exercise npm's actual spec parser; the old relative path attempted
            # an SSH GitHub lookup instead of reading this archive.
            previous = Path.cwd()
            try:
                os.chdir(directory)
                command = publish_command("release-dist/sdk.tgz", "next", dry_run=True)
            finally:
                os.chdir(previous)
            command[0] = shutil.which("npm") or "npm"
            child_env = dict(os.environ, NPM_CONFIG_CACHE=str(Path(directory) / "cache"))
            result = subprocess.run(command, cwd=directory, capture_output=True, text=True, env=child_env, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            metadata = json.loads(result.stdout)
            self.assertIsInstance(metadata, dict)
            # npm 11.6 returns the report directly; npm 11.21 keys it by name.
            if set(metadata) == {"@originchain/sdk"}:
                metadata = metadata["@originchain/sdk"]
            self.assertIsInstance(metadata, dict)
            self.assertEqual(metadata["name"], "@originchain/sdk")
            self.assertEqual(metadata["version"], "0.7.0-rc.6")


if __name__ == "__main__":
    unittest.main()
