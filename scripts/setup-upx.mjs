import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const UPX_VERSION = "5.1.1";

const supportedArchives = {
  "linux/x64": {
    archive: `upx-${UPX_VERSION}-amd64_linux.tar.xz`,
    sha256: "1ff660454227861e00772f743f66b900072116b9dc24f6ee28b97cce88a7828a",
  },
  "linux/arm64": {
    archive: `upx-${UPX_VERSION}-arm64_linux.tar.xz`,
    sha256: "a307c2c821eeab47607ba5c232408b22ab884cca13884682508b98f7308b8443",
  },
  "win32/x64": {
    archive: `upx-${UPX_VERSION}-win64.zip`,
    sha256: "fa5380bca4c2718547aaa0134bc0d8a7fa27e102f0ac6371573d60d1c21d64de",
  },
  "win32/arm64": {
    archive: `upx-${UPX_VERSION}-win64.zip`,
    sha256: "fa5380bca4c2718547aaa0134bc0d8a7fa27e102f0ac6371573d60d1c21d64de",
  },
};

function findFile(dir, fileName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(entryPath, fileName);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
  }

  return undefined;
}

const target = supportedArchives[`${process.platform}/${process.arch}`];
if (!target) {
  console.log(
    `Skipping UPX setup for unsupported runner ${process.platform}/${process.arch}.`,
  );
  process.exit(0);
}

const downloadUrl = `https://github.com/upx/upx/releases/download/v${UPX_VERSION}/${target.archive}`;
const installRoot = path.resolve(".tools", `upx-${process.platform}-${process.arch}`);
const archivePath = path.join(installRoot, target.archive);
const extractDir = path.join(installRoot, "extract");

fs.rmSync(installRoot, { recursive: true, force: true });
fs.mkdirSync(installRoot, { recursive: true });
fs.mkdirSync(extractDir, { recursive: true });

console.log(`Downloading ${downloadUrl}`);
const response = await fetch(downloadUrl);
if (!response.ok) {
  throw new Error(`Failed to download UPX archive: ${response.status} ${response.statusText}`);
}

const archiveBuffer = Buffer.from(await response.arrayBuffer());
const actualHash = createHash("sha256").update(archiveBuffer).digest("hex");
if (actualHash !== target.sha256) {
  throw new Error(
    `UPX archive hash mismatch for ${target.archive}: expected ${target.sha256}, got ${actualHash}`,
  );
}

fs.writeFileSync(archivePath, archiveBuffer);
execFileSync("tar", ["-xf", archivePath, "-C", extractDir], { stdio: "inherit" });

const binaryName = process.platform === "win32" ? "upx.exe" : "upx";
const upxBinary = findFile(extractDir, binaryName);
if (!upxBinary) {
  throw new Error(`Unable to locate ${binaryName} after extracting ${target.archive}`);
}

if (process.platform !== "win32") {
  fs.chmodSync(upxBinary, 0o755);
}

if (process.env.GITHUB_PATH) {
  fs.appendFileSync(process.env.GITHUB_PATH, `${path.dirname(upxBinary)}${os.EOL}`);
}

console.log(`Installed UPX from ${target.archive}`);
execFileSync(upxBinary, ["--version"], { stdio: "inherit" });
