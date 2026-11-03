import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from release_gate import validate
from verify_release_artifact import verify


PACKAGE = {"name": "@originchain/sdk", "version": "0.8.0-rc.1",
           "repository": {"url": "git+https://github.com/originchaindb/originchaindb.git"}}


class ReleaseGateTests(unittest.TestCase):
    def call(self, **changes):
        values = dict(version=PACKAGE["version"], package=copy.deepcopy(PACKAGE),
                      ref="refs/heads/main", repository="originchaindb/originchaindb",
                      tag_exists=False)
        values.update(changes)
        return validate(**values)

    def test_preview_uses_next(self):
        self.assertEqual(self.call(), {"version": "0.8.0-rc.1", "dist_tag": "next"})

    def test_stable_uses_latest(self):
        package = dict(PACKAGE, version="0.7.0")
        self.assertEqual(self.call(version="0.7.0", package=package),
                         {"version": "0.7.0", "dist_tag": "latest"})

    def test_unapproved_sources_and_existing_tag_rejected(self):
        for change in ({"ref": "refs/heads/preview"}, {"repository": "other/originchaindb"},
                       {"tag_exists": True}, {"version": "0.8.0"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.call(**change)

    def test_wrong_package_or_repository_rejected(self):
        for change in ({"name": "other"}, {"repository": {"url": "https://github.com/old/repo"}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.call(package=dict(PACKAGE, **change))

    def test_invalid_versions_rejected(self):
        for version in ("", "v0.7.0", "0.7", "0.7.0-beta.1", "0.7.0-rc.0", "01.7.0", "0.7.0;echo x"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.call(version=version)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.archive = self.directory / "sdk.tgz"
        with tarfile.open(self.archive, "w:gz") as packed:
            data = json.dumps(PACKAGE).encode()
            info = tarfile.TarInfo("package/package.json")
            info.size = len(data)
            packed.addfile(info, io.BytesIO(data))
        self.proof = {"source_commit": "abc", "version": PACKAGE["version"], "archive": "sdk.tgz",
                      "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                      "installed_files_match_build_and_source": True, "esm_and_commonjs": "passed",
                      "consumer_types": "passed", "live_script_compiled_against_installed_package": True}

    def check(self, **changes):
        (self.directory / "package-verification.json").write_text(json.dumps(dict(self.proof, **changes)))
        return verify(self.directory, PACKAGE, "abc")

    def test_untampered_archive_passes(self):
        self.assertEqual(self.check(), self.archive)

    def test_proof_tampering_rejected(self):
        for change in ({"source_commit": "def"}, {"version": "0.6.0"}, {"archive": "../sdk.tgz"},
                       {"sha256": "0" * 64}, {"consumer_types": "failed"},
                       {"live_script_compiled_against_installed_package": False}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(**change)

    def test_changed_archive_rejected(self):
        with self.archive.open("ab") as target:
            target.write(b"changed")
        with self.assertRaises(ValueError):
            self.check()

    def test_extra_archive_rejected(self):
        (self.directory / "extra.tgz").write_bytes(self.archive.read_bytes())
        with self.assertRaises(ValueError):
            self.check()

    def test_source_metadata_mismatch_rejected(self):
        self.check()
        with self.assertRaises(ValueError):
            verify(self.directory, dict(PACKAGE, description="different"), "abc")


if __name__ == "__main__":
    unittest.main()
