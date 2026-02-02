import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "fs";
import path from "path";

test("caxa v2 e2e: globby exclude patterns and directories", async (t) => {
  const fixtureDir = path.resolve("test/e2e-fixture-excludes");
  const outputBin = path.resolve(
    "test-output-excludes" + (process.platform === "win32" ? ".exe" : ""),
  );
  const metadataPath = path.resolve("binary-metadata-excludes.json");

  if (fs.existsSync(fixtureDir))
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (fs.existsSync(outputBin)) fs.unlinkSync(outputBin);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);

  fs.mkdirSync(path.join(fixtureDir, "node_modules", "dummy-lib"), {
    recursive: true,
  });

  fs.mkdirSync(path.join(fixtureDir, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, "nested", "deep", "ignored"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "@appthreat/test-app",
      version: "2.5.0",
      description: "Test for explicit exclusions",
      dependencies: {
        "dummy-lib": "^1.0.1",
      },
    }),
  );

  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "dummy-lib", "package.json"),
    JSON.stringify({ name: "dummy-lib", version: "1.0.1" }),
  );

  fs.writeFileSync(
    path.join(fixtureDir, "src", "main.js"),
    "console.log('main');",
  );

  fs.writeFileSync(path.join(fixtureDir, "secrets", "api-key.txt"), "secret");
  fs.writeFileSync(path.join(fixtureDir, "secrets", "config.json"), "secret");
  fs.writeFileSync(path.join(fixtureDir, "debug.log"), "logfile");
  fs.writeFileSync(path.join(fixtureDir, "src", "error.log"), "nested logfile");
  fs.writeFileSync(
    path.join(fixtureDir, "nested", "deep", "ignored", "data.bin"),
    "deep data",
  );

  const runtimeScript = `
    const fs = require('fs');
    const path = require('path');

    function getAllFiles(dirPath, arrayOfFiles) {
      files = fs.readdirSync(dirPath);
      arrayOfFiles = arrayOfFiles || [];

      files.forEach(function(file) {
        if (fs.statSync(dirPath + "/" + file).isDirectory()) {
          arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
        } else {
          const relPath = path.relative(__dirname, path.join(dirPath, file)).replace(/\\\\/g, '/');
          arrayOfFiles.push(relPath);
        }
      });
      return arrayOfFiles;
    }

    console.log("CAXA_V2_RUNNING");
    
    try {
      const files = getAllFiles(__dirname);
      console.log("runtime_files::" + JSON.stringify(files));
    } catch(e) {
      console.error(e);
    }
  `;

  fs.writeFileSync(path.join(fixtureDir, "index.js"), runtimeScript);

  const excludes = `--exclude "secrets" "**/*.log" "nested/deep/ignored"`;

  const cmd = `node build/index.mjs -i "${fixtureDir}" -o "${outputBin}" ${excludes} -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.js"`;

  execSync(cmd, { stdio: "inherit" });

  if (fs.existsSync("binary-metadata.json")) {
    fs.renameSync("binary-metadata.json", metadataPath);
  }
  const metadataObj = JSON.parse(fs.readFileSync(metadataPath));
  assert.ok(metadataObj.parentComponent);
  assert.equal(
    metadataObj.parentComponent["bom-ref"],
    "pkg:generic/@appthreat/test-app@2.5.0",
  );
  assert.ok(metadataObj.components);
  assert.strictEqual(metadataObj.components[0].name, "node");
  assert.ok(metadataObj.components[0].version);
  assert.ok(metadataObj.dependencies);

  let filesFound = [];
  try {
    const binCmd = process.platform === "win32" ? outputBin : `"${outputBin}"`;
    const stdout = execSync(binCmd).toString();

    assert.match(
      stdout,
      /CAXA_V2_RUNNING/,
      "Binary did not produce expected output",
    );

    const match = stdout.match(/runtime_files::(.*)/);
    assert.ok(match, "Could not retrieve file list from binary execution");
    filesFound = JSON.parse(match[1]);
  } catch (e) {
    assert.fail("Binary execution failed");
  }

  assert.ok(
    filesFound.includes("package.json"),
    "package.json should be present",
  );
  assert.ok(filesFound.includes("index.js"), "index.js should be present");
  assert.ok(
    filesFound.includes("src/main.js"),
    "src/main.js should be present",
  );

  assert.strictEqual(
    filesFound.some((f) => f.startsWith("secrets/")),
    false,
    "Secrets directory should be excluded",
  );

  assert.strictEqual(
    filesFound.includes("debug.log"),
    false,
    "Root log file should be excluded",
  );
  assert.strictEqual(
    filesFound.includes("src/error.log"),
    false,
    "Nested log file should be excluded",
  );

  assert.strictEqual(
    filesFound.some((f) => f.includes("nested/deep/ignored/")),
    false,
    "Deeply nested ignored directory should be excluded",
  );

  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (fs.existsSync(outputBin)) fs.unlinkSync(outputBin);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
});
