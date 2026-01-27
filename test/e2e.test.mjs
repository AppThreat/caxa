import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "fs";
import path from "path";

test("caxa v2 e2e: build, run, and sbom metadata verification", async (t) => {
  const fixtureDir = path.resolve("test/fixture");
  const outputBin = path.resolve(
    "test-output" + (process.platform === "win32" ? ".exe" : ""),
  );
  const metadataPath = path.resolve("binary-metadata.json");

  if (fs.existsSync(fixtureDir))
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (fs.existsSync(outputBin)) fs.unlinkSync(outputBin);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);

  fs.mkdirSync(path.join(fixtureDir, "node_modules", "dummy-lib"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "@appthreat/test-app",
      version: "2.5.0",
      description: "Root package for testing PURL generation",
      dependencies: {
        "dummy-lib": "^1.0.1",
      },
    }),
  );

  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    'console.log("CAXA_V2_RUNNING");',
  );

  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "dummy-lib", "package.json"),
    JSON.stringify({
      name: "dummy-lib",
      version: "1.0.1",
    }),
  );

  console.log("Building binary...");
  try {
    const cmd = `node build/index.mjs -i "${fixtureDir}" -o "${outputBin}" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.js"`;
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    assert.fail("Build process failed with exit code " + e.status);
  }

  console.log("Verifying binary execution...");
  try {
    const binCmd = process.platform === "win32" ? outputBin : `"${outputBin}"`;
    const stdout = execSync(binCmd).toString();
    assert.match(
      stdout,
      /CAXA_V2_RUNNING/,
      "Binary did not produce expected output",
    );
  } catch (e) {
    assert.fail("Binary execution failed");
  }

  console.log("Verifying binary-metadata.json...");
  assert.ok(
    fs.existsSync(metadataPath),
    "binary-metadata.json was not created",
  );

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

  assert.strictEqual(
    typeof metadata,
    "object",
    "Metadata should be an object, not an array",
  );
  assert.ok(
    Array.isArray(metadata.components),
    "metadata.components should be an array",
  );
  assert.ok(
    Array.isArray(metadata.dependencies),
    "metadata.dependencies should be an array",
  );

  const components = metadata.components;
  const dependencies = metadata.dependencies;

  assert.ok(
    components.length >= 2,
    "Should find at least root package and one dependency",
  );

  const rootPkg = components.find(
    (c) => c.name === "test-app" && c.group === "@appthreat",
  );
  assert.ok(rootPkg, "Root package @appthreat/test-app not found in metadata");
  assert.strictEqual(
    rootPkg.purl,
    "pkg:npm/%40appthreat/test-app@2.5.0",
    "Scoped PURL incorrect",
  );

  const depPkg = components.find((c) => c.name === "dummy-lib");
  assert.ok(depPkg, "Dependency dummy-lib not found in metadata");
  assert.strictEqual(
    depPkg.purl,
    "pkg:npm/dummy-lib@1.0.1",
    "Dependency PURL incorrect",
  );

  const rootGraphNode = dependencies.find((d) => d.ref === rootPkg.purl);
  assert.ok(rootGraphNode, "Root package missing from dependency graph");

  assert.ok(
    rootGraphNode.dependsOn.includes(depPkg.purl),
    `Root package should depend on ${depPkg.purl}. Found: ${JSON.stringify(rootGraphNode.dependsOn)}`,
  );

  console.log("✅ E2E Test Passed");

  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (fs.existsSync(outputBin)) fs.unlinkSync(outputBin);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
});