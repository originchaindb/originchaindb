// Called from the fresh consumer after runtime and declaration checks pass.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const [source, archive, output] = process.argv.slice(2);
const installed = path.dirname(path.dirname(require.resolve("@originchain/sdk")));
const files = [];
function walk(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) walk(path.join(directory, entry.name), relative + "/");
    else files.push(relative);
  }
}
walk(installed);
assert(files.includes("dist/index.d.ts") && files.includes("dist/index.cjs") && files.includes("dist/index.mjs"));
for (const name of files) {
  assert.deepEqual(fs.readFileSync(path.join(installed, name)), fs.readFileSync(path.join(source, name)), name);
}
const pkg = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
const proof = { source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
  version: pkg.version, archive: path.basename(archive),
  sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
  installed_files_match_build_and_source: true, compared_files: files.sort(),
  esm_and_commonjs: "passed", consumer_types: "passed", live_script_compiled_against_installed_package: true };
fs.writeFileSync(output, JSON.stringify(proof, null, 2) + "\n");
