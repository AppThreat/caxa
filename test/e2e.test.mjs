import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";

test("caxa v3 e2e: globby exclude patterns and directories", async () => {
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

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "-o",
      outputBin,
      "--no-include-node",
      "--exclude",
      "secrets",
      "**/*.log",
      "nested/deep/ignored",
      "--",
      process.execPath,
      "{{caxa}}/index.js",
    ],
    { stdio: "inherit" },
  );

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
  assert.ok(
    metadataObj.components.some((component) => component.name === "dummy-lib"),
  );
  assert.ok(metadataObj.dependencies);

  let filesFound = [];
  try {
    const stdout = execFileSync(outputBin, [], { encoding: "utf8" });

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

test("caxa v3 e2e: portable bundled Node runtime with zstd payloads", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-portable-node");
  const outputBin = path.resolve(
    "test-output-portable-node" + (process.platform === "win32" ? ".exe" : ""),
  );
  const metadataPath = path.resolve("binary-metadata-portable-node.json");

  for (const candidate of [fixtureDir, outputBin, metadataPath]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "portable-node-app",
      version: "1.0.0",
    }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    [
      "console.log('PORTABLE_NODE_OK');",
      "console.log('EXEC_PATH::' + process.execPath.replace(/\\\\/g, '/'));",
      "console.log('VERSION::' + process.version);",
    ].join("\n"),
  );

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "-o",
      outputBin,
      "--compression",
      "zstd",
      "--",
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/index.js",
    ],
    { stdio: "inherit" },
  );

  if (fs.existsSync("binary-metadata.json")) {
    fs.renameSync("binary-metadata.json", metadataPath);
  }

  const stdout = execFileSync(outputBin, [], { encoding: "utf8" });
  assert.match(stdout, /PORTABLE_NODE_OK/);
  assert.match(stdout, /VERSION::v\d+/);

  const execPathMatch = stdout.match(/EXEC_PATH::(.*)/);
  assert.ok(execPathMatch, "Bundled Node execPath should be printed");
  assert.match(execPathMatch[1], /node_modules\/\.bin\//);

  const metadataObj = JSON.parse(fs.readFileSync(metadataPath));
  assert.ok(
    metadataObj.components.some((component) => component.name === "node"),
    "Bundled runtime metadata should include the Node component",
  );

  for (const candidate of [fixtureDir, outputBin, metadataPath]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
});

test("caxa batch mode: multiple native outputs share one payload build", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-batch");
  const outputOne = path.resolve(
    "test-output-batch-one" + (process.platform === "win32" ? ".exe" : ""),
  );
  const outputTwo = path.resolve(
    "test-output-batch-two" + (process.platform === "win32" ? ".exe" : ""),
  );
  const targetsFile = path.resolve("test/e2e-targets.json");
  const metadataOne = path.resolve("batch-one-metadata.json");
  const metadataTwo = path.resolve("batch-two-metadata.json");

  for (const candidate of [
    fixtureDir,
    outputOne,
    outputTwo,
    targetsFile,
    metadataOne,
    metadataTwo,
  ]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "batch-app",
      version: "1.0.0",
    }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "entry-one.js"),
    "console.log('BATCH_ONE_OK');",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "entry-two.js"),
    "console.log('BATCH_TWO_OK');",
  );
  fs.writeFileSync(
    targetsFile,
    JSON.stringify([
      {
        output: outputOne,
        metadataFile: path.basename(metadataOne),
        command: [process.execPath, "{{caxa}}/entry-one.js"],
      },
      {
        output: outputTwo,
        metadataFile: path.basename(metadataTwo),
        command: [process.execPath, "{{caxa}}/entry-two.js"],
      },
    ]),
  );

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "--no-include-node",
      "--targets-file",
      targetsFile,
    ],
    { stdio: "inherit" },
  );

  assert.ok(fs.existsSync(outputOne), "First batch output should exist");
  assert.ok(fs.existsSync(outputTwo), "Second batch output should exist");
  assert.ok(fs.existsSync(metadataOne), "First metadata file should exist");
  assert.ok(fs.existsSync(metadataTwo), "Second metadata file should exist");

  assert.match(
    execFileSync(outputOne, [], { encoding: "utf8" }),
    /BATCH_ONE_OK/,
  );
  assert.match(
    execFileSync(outputTwo, [], { encoding: "utf8" }),
    /BATCH_TWO_OK/,
  );

  for (const candidate of [
    fixtureDir,
    outputOne,
    outputTwo,
    targetsFile,
    metadataOne,
    metadataTwo,
  ]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
});
