import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("package metadata declares public portable compatibility", () => {
  assert.equal(packageJson.engines.node, ">=22.19.0");
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.84.4");
  assert.equal(packageJson.peerDependencies["@oh-my-pi/pi-coding-agent"], ">=18.1.8");
  assert.deepEqual(packageJson.os, ["darwin", "linux", "win32"]);
  assert.deepEqual(packageJson.ompOrcaDispatch, {
    orca: ">=1.4.195",
    platforms: ["Windows", "Linux", "macOS"],
  });
  assert.equal(packageJson.bin["orca-task-dispatch"], "./bin/orca-task-dispatch.mjs");
  assert.equal(packageJson.publishConfig.access, "public");
});

test("package exports compiled Pi and OMP extension entrypoints while host manifests use source", () => {
  assert.deepEqual(packageJson.exports["./pi"], { types: "./dist/extensions/pi.d.ts", import: "./dist/extensions/pi.js" });
  assert.deepEqual(packageJson.exports["./omp"], { types: "./dist/extensions/omp.d.ts", import: "./dist/extensions/omp.js" });
  assert.deepEqual(packageJson.pi.extensions, ["./extensions/pi.ts"]);
  assert.deepEqual(packageJson.omp.extensions, ["./extensions/omp.ts"]);
});
