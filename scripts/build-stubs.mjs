#!/usr/bin/env node

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const stubsDirectory = path.join(workspaceRoot, "stubs");

const buildMatrix = [
  { goos: "windows", goarch: "amd64", output: "stub--win32--x64" },
  { goos: "windows", goarch: "arm64", output: "stub--win32--arm64" },
  { goos: "darwin", goarch: "amd64", output: "stub--darwin--x64" },
  { goos: "darwin", goarch: "arm64", output: "stub--darwin--arm64" },
  { goos: "linux", goarch: "amd64", output: "stub--linux--x64" },
  { goos: "linux", goarch: "arm64", output: "stub--linux--arm64" },
  { goos: "linux", goarch: "arm", output: "stub--linux--arm" },
];

async function removeExistingStubs() {
  const entries = await readdir(stubsDirectory);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith("stub--"))
      .map((entry) => rm(path.join(stubsDirectory, entry), { force: true })),
  );
}

async function runGoBuild({ goos, goarch, output }) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "go",
      [
        "build",
        "-C",
        "stubs",
        "-ldflags",
        "-s -w",
        "-o",
        output,
        "stub.go",
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOOS: goos,
          GOARCH: goarch,
        },
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `go build failed for GOOS=${goos} GOARCH=${goarch} with exit code ${code}`,
        ),
      );
    });
  });
}

await removeExistingStubs();
for (const buildTarget of buildMatrix) {
  await runGoBuild(buildTarget);
}
