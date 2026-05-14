#!/usr/bin/env node

import { arch, platform } from "node:os";
import path from "node:path";
import url from "node:url";
import stream from "node:stream/promises";
import { createGzip, createZstdCompress } from "node:zlib";
import fs from "fs-extra";
import { globby } from "globby";
import cryptoRandomString from "crypto-random-string";
import bash from "dedent";
import archiver from "archiver";
import * as commander from "commander";
import process from "node:process";
import { spawn } from "node:child_process";

const archiveSeparator = "\nCAXACAXACAXA\n";
const trailerMagic = "CAXAIDX1";
const trailerSize = 32;

type PayloadCompression = "gzip" | "zstd";

const darwinSystemLibraryPrefixes = ["/System/Library/", "/usr/lib/"];
const linuxSystemLibraryPrefixes = ["/lib", "/lib64", "/usr/lib", "/usr/lib64"];

async function runUpx(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const upxProcess = spawn("upx", [...args, file], {
      stdio: "inherit",
    });

    upxProcess.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "UPX command not found. Please install UPX and ensure it is in your system's PATH.",
          ),
        );
      } else {
        reject(error);
      }
    });

    upxProcess.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`UPX process exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

const defaultExcludes = [
  ".*",
  "*.exe",
  "*.exe.sha256",
  "*.exe.sha512",
  "*.sha256",
  "*.sha512",
  "cdxgen*",
  "cdxgen-*",
  "cdxgen-secure*",
  "cdx-*",
  "cdxgen-arm64*",
  "cdx-arm64*",
  "*.yml",
  "*.sh",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "deno.json",
  "jsr.json",
  ".git/**",
  ".github/**",
  ".vscode/**",
  "**/*/*.env",
  "contrib/**",
  "docs/**",
  "test/**",
  "types/**",
  "bom.json",
  "biome.json",
  "jest.config.js",
];

interface Component {
  group: string | undefined;
  name: string;
  description?: string;
  license?: string;
  version?: string;
  purl: string;
  "bom-ref": string;
  author?: string;
  type?: string;
  scope?: string;
  cpe?: string;
  components?: Component[];
  properties?: Array<{
    name: string;
    value: string;
  }>;
  externalReferences?: Array<{
    url: string;
    type: string;
    comment?: string;
  }>;
}

interface DependencyGraphEntry {
  ref: string;
  dependsOn: string[];
}

interface TargetOptions {
  output: string;
  command: string[];
  metadataFile?: string;
  force?: boolean;
  identifier?: string;
  uncompressionMessage?: string;
}

interface CommonBuildOptions {
  input: string;
  exclude?: string[];
  includeNode?: boolean;
  stub?: string;
  compression?: PayloadCompression;
  upx?: boolean;
  upxArgs?: string[];
}

interface PortableNodeBundle {
  root: string;
}

function normalizeUpxArgs(args: string[]): string[] {
  return args
    .flatMap((arg) => arg.split(/\s+/))
    .filter((arg) => arg.length > 0);
}

function createIdentifier(output: string): string {
  return path.join(
    path.basename(path.basename(path.basename(output, ".exe"), ".app"), ".sh"),
    cryptoRandomString({ length: 10, type: "alphanumeric" }).toLowerCase(),
  );
}

function normalizeArchivePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function createPayloadTempPath(
  outputDirectory: string,
  compression: PayloadCompression,
): string {
  return path.join(
    outputDirectory,
    `.caxa-payload-${cryptoRandomString({ length: 12, type: "alphanumeric" }).toLowerCase()}.tar.${compression === "zstd" ? "zst" : "gz"}`,
  );
}

function resolveCompressionForOutput(
  output: string,
  requestedCompression?: PayloadCompression,
): PayloadCompression {
  if (requestedCompression) {
    return requestedCompression;
  }

  return output.endsWith(".sh") ? "gzip" : "zstd";
}

function assertCompressionSupported(
  output: string,
  compression: PayloadCompression,
): void {
  if (output.endsWith(".sh") && compression !== "gzip") {
    throw new Error(
      "Shell stub outputs (.sh) currently support gzip payloads only. Use --compression gzip.",
    );
  }
}

async function runCommandCapture(
  command: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      const cause =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `Required command '${command}' was not found in PATH.`
          : (error as Error).message;
      reject(new Error(cause));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

function rememberPortableDependency(
  seenDependencies: Map<string, string>,
  dependencyPath: string,
): void {
  const fileName = path.basename(dependencyPath);
  const existing = seenDependencies.get(fileName);
  if (existing && existing !== dependencyPath) {
    throw new Error(
      `Portable Node bundling found conflicting libraries with the same name '${fileName}': '${existing}' and '${dependencyPath}'.`,
    );
  }

  seenDependencies.set(fileName, dependencyPath);
}

async function resolveExistingPath(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  return fs.realpath(filePath).catch(() => filePath);
}

async function resolveDarwinDependencyReference(
  dependencyReference: string,
  currentFile: string,
  executablePath: string,
): Promise<string | undefined> {
  const normalizedReference = dependencyReference.trim();

  if (normalizedReference.startsWith("/")) {
    return resolveExistingPath(normalizedReference);
  }

  if (normalizedReference.startsWith("@loader_path/")) {
    return resolveExistingPath(
      path.join(
        path.dirname(currentFile),
        normalizedReference.slice("@loader_path/".length),
      ),
    );
  }

  if (normalizedReference.startsWith("@executable_path/")) {
    return resolveExistingPath(
      path.join(
        path.dirname(executablePath),
        normalizedReference.slice("@executable_path/".length),
      ),
    );
  }

  if (!normalizedReference.startsWith("@rpath/")) {
    return undefined;
  }

  const rpathOutput = await runCommandCapture("otool", ["-l", currentFile]);
  const lines = rpathOutput.split(/\r?\n/);
  const suffix = normalizedReference.slice("@rpath/".length);

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("cmd LC_RPATH")) {
      continue;
    }

    for (
      let cursor = index + 1;
      cursor < Math.min(index + 5, lines.length);
      cursor += 1
    ) {
      const match = lines[cursor].match(/^\s*path\s+(.+?)\s+\(offset /);
      if (!match) {
        continue;
      }

      const rawRpath = match[1].trim();
      const resolvedRpath = await resolveDarwinDependencyReference(
        rawRpath,
        currentFile,
        executablePath,
      );
      if (!resolvedRpath) {
        break;
      }

      const resolvedCandidate = await resolveExistingPath(
        path.join(resolvedRpath, suffix),
      );
      if (resolvedCandidate) {
        return resolvedCandidate;
      }
      break;
    }
  }

  const fallbackCandidates = [
    path.join(path.dirname(currentFile), "..", "lib", path.basename(suffix)),
    path.join(path.dirname(executablePath), "..", "lib", path.basename(suffix)),
  ];

  for (const candidate of fallbackCandidates) {
    const resolvedCandidate = await resolveExistingPath(candidate);
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
  }

  return undefined;
}

async function collectDarwinRuntimeLibraries(
  executablePath: string,
): Promise<string[]> {
  const pending = [await fs.realpath(executablePath)];
  const scanned = new Set<string>();
  const collected = new Map<string, string>();

  while (pending.length > 0) {
    const currentFile = pending.shift()!;
    if (scanned.has(currentFile)) {
      continue;
    }
    scanned.add(currentFile);

    const output = await runCommandCapture("otool", ["-L", currentFile]);
    const lines = output.split(/\r?\n/).slice(1);
    for (const line of lines) {
      const dependencyReference = line.trim().split(" ")[0];
      if (!dependencyReference) {
        continue;
      }

      const resolvedDependency = await resolveDarwinDependencyReference(
        dependencyReference,
        currentFile,
        executablePath,
      );
      if (!resolvedDependency) {
        continue;
      }

      if (
        darwinSystemLibraryPrefixes.some((prefix) =>
          resolvedDependency.startsWith(prefix),
        )
      ) {
        continue;
      }

      rememberPortableDependency(collected, resolvedDependency);
      pending.push(resolvedDependency);
    }
  }

  return [...collected.values()].sort();
}

async function collectLinuxRuntimeLibraries(
  executablePath: string,
): Promise<string[]> {
  const pending = [await fs.realpath(executablePath)];
  const scanned = new Set<string>();
  const collected = new Map<string, string>();

  while (pending.length > 0) {
    const currentFile = pending.shift()!;
    if (scanned.has(currentFile)) {
      continue;
    }
    scanned.add(currentFile);

    const output = await runCommandCapture("ldd", [currentFile]);
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("linux-vdso")) {
        continue;
      }
      if (trimmed.includes("=> not found")) {
        throw new Error(
          `Portable Node bundling failed because a shared library was missing: ${trimmed}`,
        );
      }

      let dependencyPath: string | undefined;
      if (trimmed.includes("=>")) {
        const candidate = trimmed.split("=>")[1]?.trim().split(" ")[0];
        if (candidate?.startsWith("/")) {
          dependencyPath = candidate;
        }
      } else if (trimmed.startsWith("/")) {
        dependencyPath = trimmed.split(" ")[0];
      }

      const resolvedDependency = await resolveExistingPath(dependencyPath);
      if (!resolvedDependency) {
        continue;
      }

      if (
        linuxSystemLibraryPrefixes.some((prefix) =>
          resolvedDependency.startsWith(prefix),
        )
      ) {
        continue;
      }

      rememberPortableDependency(collected, resolvedDependency);
      pending.push(resolvedDependency);
    }
  }

  return [...collected.values()].sort();
}

async function preparePortableNodeBundle({
  stagingParent,
  upx,
  upxArgs,
}: {
  stagingParent: string;
  upx: boolean;
  upxArgs: string[];
}): Promise<PortableNodeBundle> {
  const nodePath = await fs.realpath(process.execPath);
  const bundleRoot = path.join(
    stagingParent,
    `.caxa-node-${cryptoRandomString({ length: 12, type: "alphanumeric" }).toLowerCase()}`,
  );
  const binDir = path.join(bundleRoot, "node_modules", ".bin");
  await fs.ensureDir(binDir);

  if (process.platform === "win32") {
    const nodeDestination = path.join(binDir, path.basename(nodePath));
    await fs.copyFile(nodePath, nodeDestination);
    await fs.chmod(nodeDestination, 0o755);

    for (const entry of await fs.readdir(path.dirname(nodePath))) {
      if (!entry.toLowerCase().endsWith(".dll")) {
        continue;
      }
      await fs.copyFile(
        path.join(path.dirname(nodePath), entry),
        path.join(binDir, entry),
      );
    }

    if (upx) {
      await runUpx(nodeDestination, normalizeUpxArgs(upxArgs));
    }

    return { root: bundleRoot };
  }

  const wrapperName = path.basename(nodePath);
  const nodeRealDestination = path.join(binDir, `${wrapperName}-real`);
  const nodeLibDir = path.join(binDir, `${wrapperName}-libs`);
  await fs.ensureDir(nodeLibDir);
  await fs.copyFile(nodePath, nodeRealDestination);
  await fs.chmod(nodeRealDestination, 0o755);

  if (upx) {
    await runUpx(nodeRealDestination, normalizeUpxArgs(upxArgs));
  }

  const runtimeLibraries =
    process.platform === "darwin"
      ? await collectDarwinRuntimeLibraries(nodePath)
      : await collectLinuxRuntimeLibraries(nodePath);

  for (const libraryPath of runtimeLibraries) {
    await fs.copyFile(
      libraryPath,
      path.join(nodeLibDir, path.basename(libraryPath)),
    );
  }

  const envVariableName =
    process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  await fs.writeFile(
    path.join(binDir, wrapperName),
    bash`
      #!/usr/bin/env sh
      export CAXA_NODE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
      export ${envVariableName}="$CAXA_NODE_DIR/${wrapperName}-libs${`$`}{${envVariableName}:+:${`$`}{${envVariableName}}}"
      exec "$CAXA_NODE_DIR/${wrapperName}-real" "$@"
    ` + "\n",
    { mode: 0o755 },
  );

  return { root: bundleRoot };
}

async function appendDirectoryContentsToArchive(
  archive: archiver.Archiver,
  root: string,
): Promise<void> {
  const files = await globby(["**/*"], {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  });

  for (const file of files) {
    const absolutePath = path.join(root, file);
    archive.file(absolutePath, {
      name: normalizeArchivePath(file),
      stats: await fs.stat(absolutePath),
    });
  }
}

async function copyDirectoryContents(
  source: string,
  destination: string,
): Promise<void> {
  const files = await globby(["**/*"], {
    cwd: source,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  });

  for (const file of files) {
    const sourcePath = path.join(source, file);
    const destinationPath = path.join(destination, file);
    await fs.ensureDir(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath);
    const stats = await fs.stat(sourcePath);
    await fs.chmod(destinationPath, stats.mode);
  }
}

async function validateOutput(output: string, force: boolean): Promise<void> {
  if ((await fs.pathExists(output)) && !force)
    throw new Error(`Output already exists: ‘${output}’.`);
  if (process.platform === "win32" && !output.endsWith(".exe"))
    throw new Error("Windows executable must end in ‘.exe’.");

  await fs.ensureDir(path.dirname(output));
  await fs.remove(output);
}

async function collectFiles(
  input: string,
  exclude: string[],
): Promise<string[]> {
  return globby(["**/*"], {
    cwd: input,
    onlyFiles: true,
    dot: true,
    ignore: exclude,
    followSymbolicLinks: false,
  });
}

async function collectMetadata(
  input: string,
  files: string[],
  includeNode: boolean,
): Promise<{
  components: Component[];
  dependencies: DependencyGraphEntry[];
}> {
  const componentsWithRawDeps: Array<
    Component & {
      _rawDeps?: Record<string, string>;
    }
  > = [];
  const bomRefLookup = new Map<string, string>();

  if (includeNode) {
    componentsWithRawDeps.push(getRuntimeInformation());
  }

  for (const file of files) {
    if (path.basename(file) !== "package.json") {
      continue;
    }

    try {
      const pkg = await fs.readJson(path.join(input, file));
      if (!pkg.name || !pkg.version) {
        continue;
      }

      let name = pkg.name;
      let namespace = "";
      if (name.startsWith("@")) {
        const parts = name.split("/");
        namespace = parts[0];
        name = parts[1];
      }

      let purl = "pkg:npm/";
      let bomRef = "pkg:npm/";
      if (namespace) {
        purl += `${encodeURIComponent(namespace)}/`;
        bomRef += `${namespace}/`;
      }
      purl += `${name}@${pkg.version}`;
      bomRef += `${name}@${pkg.version}`;
      bomRefLookup.set(pkg.name, bomRef);

      const author = pkg.author;
      const authorString =
        author instanceof Object
          ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
              author.url ? ` (${author.url})` : ""
            }`
          : author;

      componentsWithRawDeps.push({
        group: namespace,
        name,
        description: pkg.description,
        license: pkg.license,
        version: pkg.version,
        purl,
        "bom-ref": bomRef,
        author: authorString,
        _rawDeps: pkg.dependencies,
      });
    } catch {
      // Ignore malformed package.json files.
    }
  }

  const dependencies: DependencyGraphEntry[] = [];
  const components: Component[] = [];

  for (const component of componentsWithRawDeps) {
    const childRefs: string[] = [];
    if (component._rawDeps) {
      for (const depName of Object.keys(component._rawDeps)) {
        const resolvedRef = bomRefLookup.get(depName);
        if (resolvedRef) {
          childRefs.push(resolvedRef);
        }
      }
    }

    const { _rawDeps, ...sanitizedComponent } = component;
    components.push(sanitizedComponent);

    if (childRefs.length > 0) {
      dependencies.push({
        ref: component["bom-ref"],
        dependsOn: childRefs,
      });
    }
  }

  return { components, dependencies };
}

async function writeMetadataFile({
  input,
  output,
  metadataFile,
  components,
  dependencies,
}: {
  input: string;
  output: string;
  metadataFile: string;
  components: Component[];
  dependencies: DependencyGraphEntry[];
}): Promise<void> {
  await fs.writeJson(
    path.join(path.dirname(output), metadataFile),
    {
      parentComponent: getParentComponent(input, output),
      components,
      dependencies,
    },
    { spaces: 0 },
  );
}

async function createPayloadArchive({
  input,
  files,
  destination,
  includeNode,
  compression,
  upx,
  upxArgs,
}: {
  input: string;
  files: string[];
  destination: string;
  includeNode: boolean;
  compression: PayloadCompression;
  upx: boolean;
  upxArgs: string[];
}): Promise<number> {
  const archive = archiver("tar");
  const outputStream = fs.createWriteStream(destination);
  const compressor =
    compression === "zstd" ? createZstdCompress() : createGzip();
  const completion = stream.pipeline(archive, compressor, outputStream);

  archive.on("warning", (warning) => {
    if ((warning as NodeJS.ErrnoException).code !== "ENOENT") {
      archive.emit("error", warning);
    }
  });

  const tempPathsCleanup: string[] = [];

  for (const file of files) {
    const absPath = path.join(input, file);
    const name = normalizeArchivePath(file);
    const stats = await fs.lstat(absPath);
    if (stats.isSymbolicLink()) {
      const linkTarget = await fs.readlink(absPath);
      archive.symlink(name, linkTarget);
    } else {
      archive.file(absPath, { name, stats });
    }
  }

  if (includeNode) {
    const bundle = await preparePortableNodeBundle({
      stagingParent: path.dirname(destination),
      upx,
      upxArgs,
    });
    tempPathsCleanup.push(bundle.root);
    await appendDirectoryContentsToArchive(archive, bundle.root);
  }

  await archive.finalize();
  await completion;

  for (const tempPath of tempPathsCleanup) {
    await fs.remove(tempPath);
  }

  return (await fs.stat(destination)).size;
}

async function appendFile(source: string, destination: string): Promise<void> {
  await stream.pipeline(
    fs.createReadStream(source),
    fs.createWriteStream(destination, { flags: "a" }),
  );
}

function createFooterBuffer({
  identifier,
  command,
  uncompressionMessage,
  compression,
}: {
  identifier: string;
  command: string[];
  uncompressionMessage?: string;
  compression: PayloadCompression;
}): Buffer {
  return Buffer.from(
    JSON.stringify({ identifier, command, uncompressionMessage, compression }),
    "utf8",
  );
}

function createTrailerBuffer({
  payloadOffset,
  payloadSize,
  footerSize,
}: {
  payloadOffset: number;
  payloadSize: number;
  footerSize: number;
}): Buffer {
  const trailer = Buffer.alloc(trailerSize);
  trailer.write(trailerMagic, 0, "utf8");
  trailer.writeBigUInt64LE(BigInt(payloadOffset), 8);
  trailer.writeBigUInt64LE(BigInt(payloadSize), 16);
  trailer.writeBigUInt64LE(BigInt(footerSize), 24);
  return trailer;
}

async function buildNativeOutput({
  output,
  force,
  metadataFile,
  identifier,
  command,
  uncompressionMessage,
  compression,
  input,
  components,
  dependencies,
  stub,
  upx,
  upxArgs,
  payloadPath,
  payloadSize,
}: {
  output: string;
  force: boolean;
  metadataFile: string;
  identifier: string;
  command: string[];
  uncompressionMessage?: string;
  compression: PayloadCompression;
  input: string;
  components: Component[];
  dependencies: DependencyGraphEntry[];
  stub: string;
  upx: boolean;
  upxArgs: string[];
  payloadPath: string;
  payloadSize: number;
}): Promise<void> {
  await validateOutput(output, force);
  await writeMetadataFile({
    input,
    output,
    metadataFile,
    components,
    dependencies,
  });

  if (!(await fs.pathExists(stub))) {
    throw new Error(
      `Stub not found (your operating system / architecture may be unsupported): ‘${stub}’`,
    );
  }

  await fs.copyFile(stub, output);
  await fs.chmod(output, 0o755);
  if (upx) {
    await runUpx(output, normalizeUpxArgs(upxArgs));
  }

  await fs.appendFile(output, archiveSeparator);
  const payloadOffset = (await fs.stat(output)).size;
  await appendFile(payloadPath, output);

  const footer = createFooterBuffer({
    identifier,
    command,
    uncompressionMessage,
    compression,
  });
  await fs.appendFile(output, footer);
  await fs.appendFile(
    output,
    createTrailerBuffer({
      payloadOffset,
      payloadSize,
      footerSize: footer.length,
    }),
  );
}

export function getParentComponent(input: string, output: string) {
  const purlQualifierString = `?arch=${arch()}&platform=${platform()}`;
  if (!fs.existsSync(path.join(input, "package.json"))) {
    const parentName = path.basename(output).replace(path.extname(output), "");
    return {
      group: "",
      name: parentName,
      version: undefined,
      purl: `pkg:generic/${parentName}${purlQualifierString}`,
      "bom-ref": `pkg:generic/${parentName}`,
      type: "application",
    };
  }
  const packageJsonAsString = fs.readFileSync(
    path.join(input, "package.json"),
    "utf-8",
  );
  const packageJson = JSON.parse(packageJsonAsString);
  const name = packageJson.name;
  const version = packageJson.version;
  const author = packageJson.author;
  const authorString =
    author instanceof Object
      ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
          author.url ? ` (${author.url})` : ""
        }`
      : author;
  return {
    group: "",
    name,
    version,
    purl: `pkg:generic/${name.replace(/^@/, "%40")}@${version}${purlQualifierString}`,
    "bom-ref": `pkg:generic/${name}@${version}`,
    description: packageJson.description,
    license: packageJson.license,
    author: authorString,
    type: "application",
  };
}

/**
 * Get information about the runtime.
 *
 * @returns {Object} Object containing the name and version of the runtime
 */
export function getRuntimeInformation() {
  const runtimeInfo: any = {
    group: undefined,
    name: undefined,
    version: undefined,
    purl: undefined,
    bomRef: undefined,
    scope: "required",
    properties: [
      {
        name: "internal:is_executable",
        value: "true",
      },
    ],
  };
  // @ts-ignore
  if (globalThis.Deno?.version?.deno) {
    runtimeInfo.name = "deno";
    // @ts-ignore
    runtimeInfo.version = globalThis.Deno.version.deno;
    runtimeInfo.purl = `pkg:generic/denoland/${runtimeInfo.name}@${runtimeInfo.version}`;
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
    runtimeInfo.cpe = `cpe:2.3:a:deno:deno:${runtimeInfo.version}:*:*:*:-:*:*:*`;
    // @ts-ignore
  } else if (globalThis.Bun?.version) {
    runtimeInfo.name = "bun";
    // @ts-ignore
    runtimeInfo.version = globalThis.Bun.version;
    runtimeInfo.purl = `pkg:generic/oven-sh/${runtimeInfo.name}@${runtimeInfo.version}`;
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
  } else if (globalThis.process?.versions?.node) {
    runtimeInfo.name = "node";
    runtimeInfo.version = globalThis.process.versions.node;
    runtimeInfo.purl = `pkg:generic/nodejs/${runtimeInfo.name}@${runtimeInfo.version}`;
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
    runtimeInfo.cpe = `cpe:2.3:a:nodejs:node.js:${runtimeInfo.version}:*:*:*:-:*:*:*`;
    const report = process.report.getReport();
    // @ts-ignore
    const nodeSourceUrl = report?.header?.release?.sourceUrl;
    if (nodeSourceUrl) {
      runtimeInfo.externalReferences = [
        {
          url: nodeSourceUrl,
          type: "source-distribution",
          comment: "Node.js release url",
        },
      ];
    }
    // Collect the bundled components in node.js
    // @ts-ignore
    if (report?.header?.componentVersions) {
      const nodeBundledComponents = [];
      for (const [name, version] of Object.entries(
        // @ts-ignore
        report.header.componentVersions,
      )) {
        if (name === "node") {
          continue;
        }
        const apkg = {
          name,
          version,
          description: `Bundled with Node.js ${runtimeInfo.version}`,
          type: "library",
          scope: "excluded",
          purl: `pkg:generic/${name}@${version}`,
          "bom-ref": `pkg:generic/${name}@${version}`,
          properties: [
            {
              name: "internal:is_shared_library",
              value: "true",
            },
          ],
        };
        if (nodeSourceUrl) {
          // @ts-ignore
          apkg.externalReferences = [
            {
              url: nodeSourceUrl,
              type: "source-distribution",
              comment: "Node.js release url",
            },
          ];
        }
        nodeBundledComponents.push(apkg);
      }
      if (nodeBundledComponents.length) {
        runtimeInfo.components = nodeBundledComponents;
      }
    }
    // @ts-ignore
    if (report.sharedObjects) {
      const osSharedObjects = [];
      // @ts-ignore
      for (const aso of report.sharedObjects) {
        const name = path.basename(aso);
        if (name === "node") {
          continue;
        }
        const apkg = {
          name,
          type: "library",
          scope: "excluded",
          purl: `pkg:generic/${name}#${aso}`,
          "bom-ref": `pkg:generic/${name}`,
          properties: [
            {
              name: "internal:is_shared_library",
              value: "true",
            },
          ],
        };
        osSharedObjects.push(apkg);
      }
      if (osSharedObjects.length) {
        runtimeInfo.components = osSharedObjects;
      }
    }
  }
  return runtimeInfo;
}

export async function caxaBatch({
  input,
  targets,
  exclude = defaultExcludes,
  includeNode = true,
  stub = url.fileURLToPath(
    new URL(
      `../stubs/stub--${process.platform}--${process.arch}`,
      import.meta.url,
    ),
  ),
  compression = "zstd",
  upx = false,
  upxArgs = [],
}: CommonBuildOptions & {
  targets: TargetOptions[];
}): Promise<void> {
  if (!(await fs.pathExists(input)) || !(await fs.lstat(input)).isDirectory()) {
    throw new Error(`Input isn’t a directory: ‘${input}’.`);
  }
  if (targets.length === 0) {
    throw new Error("At least one target must be defined.");
  }

  for (const target of targets) {
    if (target.output.endsWith(".app") || target.output.endsWith(".sh")) {
      throw new Error(
        "Batch builds currently support native stub outputs only (not .app or .sh).",
      );
    }
    assertCompressionSupported(target.output, compression);
  }

  const files = await collectFiles(input, exclude);
  const { components, dependencies } = await collectMetadata(
    input,
    files,
    includeNode,
  );

  const payloadPath = createPayloadTempPath(
    path.dirname(targets[0].output),
    compression,
  );
  let payloadSize = 0;
  try {
    await fs.ensureDir(path.dirname(payloadPath));
    payloadSize = await createPayloadArchive({
      input,
      files,
      destination: payloadPath,
      includeNode,
      compression,
      upx,
      upxArgs,
    });

    for (const target of targets) {
      await buildNativeOutput({
        output: target.output,
        force: target.force ?? true,
        metadataFile: target.metadataFile ?? "binary-metadata.json",
        identifier: target.identifier ?? createIdentifier(target.output),
        command: target.command,
        uncompressionMessage: target.uncompressionMessage,
        compression,
        input,
        components,
        dependencies,
        stub,
        upx,
        upxArgs,
        payloadPath,
        payloadSize,
      });
    }
  } finally {
    await fs.remove(payloadPath);
  }
}

export default async function caxa({
  input,
  output,
  metadataFile = "binary-metadata.json",
  command,
  force = true,
  exclude = defaultExcludes,
  includeNode = true,
  stub = url.fileURLToPath(
    new URL(
      `../stubs/stub--${process.platform}--${process.arch}`,
      import.meta.url,
    ),
  ),
  identifier = createIdentifier(output),
  uncompressionMessage,
  compression = resolveCompressionForOutput(output),
  upx = false,
  upxArgs = [],
}: {
  input: string;
  output: string;
  metadataFile: string;
  command: string[];
  force?: boolean;
  exclude?: string[];
  filter?: fs.CopyFilterSync | fs.CopyFilterAsync;
  includeNode?: boolean;
  stub?: string;
  identifier?: string;
  removeBuildDirectory?: boolean;
  uncompressionMessage?: string;
  compression?: PayloadCompression;
  upx?: boolean;
  upxArgs?: string[];
}): Promise<void> {
  if (!(await fs.pathExists(input)) || !(await fs.lstat(input)).isDirectory())
    throw new Error(`Input isn’t a directory: ‘${input}’.`);

  if (!exclude) exclude = defaultExcludes;
  const files = await collectFiles(input, exclude);
  const { components, dependencies } = await collectMetadata(
    input,
    files,
    includeNode,
  );

  assertCompressionSupported(output, compression);

  if (output.endsWith(".app")) {
    await validateOutput(output, force);
    await writeMetadataFile({
      input,
      output,
      metadataFile,
      components,
      dependencies,
    });

    if (process.platform !== "darwin")
      throw new Error(
        "macOS Application Bundles (.app) are supported in macOS only.",
      );

    await fs.ensureDir(path.join(output, "Contents", "MacOS"));
    await fs.ensureDir(path.join(output, "Contents", "Resources"));

    const name = path.basename(output, ".app");

    await fs.writeFile(
      path.join(output, "Contents", "MacOS", name),
      bash`
        #!/usr/bin/env sh
        open "$(dirname "$0")/../Resources/${name}"
      ` + "\n",
      { mode: 0o755 },
    );

    await fs.writeFile(
      path.join(output, "Contents", "Resources", name),
      bash`
        #!/usr/bin/env sh
        ${command
          .map(
            (p) =>
              `"${p.replace(/\{\{\s*caxa\s*}}/g, `$(dirname "$0")/application`)}"`,
          )
          .join(" ")}
      ` + "\n",
      { mode: 0o755 },
    );

    const appDest = path.join(output, "Contents", "Resources", "application");
    await fs.ensureDir(appDest);

    for (const file of files) {
      const src = path.join(input, file);
      const dest = path.join(appDest, file);
      await fs.copy(src, dest);
    }

    if (includeNode) {
      const bundle = await preparePortableNodeBundle({
        stagingParent: path.dirname(output),
        upx,
        upxArgs,
      });
      try {
        await copyDirectoryContents(bundle.root, appDest);
      } finally {
        await fs.remove(bundle.root);
      }
    }
  } else if (output.endsWith(".sh")) {
    await validateOutput(output, force);
    await writeMetadataFile({
      input,
      output,
      metadataFile,
      components,
      dependencies,
    });

    if (process.platform === "win32")
      throw new Error("The Shell Stub (.sh) isn’t supported in Windows.");

    let shellStub =
      bash`
        #!/usr/bin/env sh
        export CAXA_TMP="$(dirname $(mktemp))/caxa"
        export CAXA_ID="${identifier}"
        while true
        do
          export CAXA_LOCK="$CAXA_TMP/locks/$CAXA_ID"
          export CAXA_APP="$CAXA_TMP/apps/$CAXA_ID"
          if [ -d "$CAXA_APP" ] && [ ! -d "$CAXA_LOCK" ]; then
             break
          fi
          
          ${uncompressionMessage ? bash`echo "${uncompressionMessage}" >&2` : ""}
          mkdir -p "$CAXA_LOCK" "$CAXA_APP"
          tail -n+{{lines}} "$0" | tar -xz -C "$CAXA_APP"
          rmdir "$CAXA_LOCK"
          break
        done
        exec ${command
          .map((p) => `"${p.replace(/\{\{\s*caxa\s*}}/g, `"$CAXA_APP"`)}"`)
          .join(" ")} "$@"
      ` + "\n";

    shellStub = shellStub.replace(
      "{{lines}}",
      String(shellStub.split("\n").length),
    );
    await fs.writeFile(output, shellStub, { mode: 0o755 });
    const payloadPath = createPayloadTempPath(
      path.dirname(output),
      compression,
    );
    try {
      await createPayloadArchive({
        input,
        files,
        destination: payloadPath,
        includeNode,
        compression,
        upx,
        upxArgs,
      });
      await appendFile(payloadPath, output);
    } finally {
      await fs.remove(payloadPath);
    }
  } else {
    const payloadPath = createPayloadTempPath(
      path.dirname(output),
      compression,
    );
    let payloadSize = 0;
    try {
      payloadSize = await createPayloadArchive({
        input,
        files,
        destination: payloadPath,
        includeNode,
        compression,
        upx,
        upxArgs,
      });
      await buildNativeOutput({
        output,
        force,
        metadataFile,
        identifier,
        command,
        uncompressionMessage,
        compression,
        input,
        components,
        dependencies,
        stub,
        upx,
        upxArgs,
        payloadPath,
        payloadSize,
      });
    } finally {
      await fs.remove(payloadPath);
    }
  }
}

if (url.fileURLToPath(import.meta.url) === (await fs.realpath(process.argv[1])))
  await commander.program
    .name("caxa")
    .description("Package Node.js applications into executable binaries")
    .requiredOption("-i, --input <input>", "Input directory to package.")
    .option(
      "-o, --output <output>",
      "Path where the executable will be produced.",
    )
    .option(
      "--targets-file <path>",
      "JSON file describing multiple native outputs to build from a single payload.",
    )
    .option(
      "--metadata-file <path>",
      "Metadata file name for capturing npm components and dependencies in the bundled binary.",
      "binary-metadata.json",
    )
    .option("-F, --no-force", "Don’t overwrite output if it exists.")
    .option("-e, --exclude <path...>", "Paths to exclude from the build.")
    .option("-N, --no-include-node", "Don’t copy the Node.js executable.")
    .option("-s, --stub <path>", "Path to the stub.")
    .option("--identifier <id>", "Build identifier.")
    .option(
      "-B, --no-remove-build-directory",
      "Ignored in v2 (streaming build).",
    )
    .option(
      "-m, --uncompression-message <msg>",
      "Message to show during extraction.",
    )
    .option("--upx", "Compress the output binary with UPX.")
    .option(
      "--upx-args <args...>",
      "Arguments to pass to UPX (e.g., '--best --lzma').",
    )
    .option(
      "-c, --compression <type>",
      "Payload compression for native outputs ('zstd' default) or shell outputs ('gzip' only).",
      (value) => {
        if (value !== "gzip" && value !== "zstd") {
          throw new commander.InvalidArgumentError(
            `Unsupported compression '${value}'. Expected 'gzip' or 'zstd'.`,
          );
        }
        return value;
      },
    )
    .argument("[command...]", "Command to run.")
    .version(
      JSON.parse(
        await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
      ).version,
    )
    .action(async (command, opts) => {
      try {
        if (opts.targetsFile) {
          if (opts.output || command.length > 0) {
            throw new Error(
              "Use either --targets-file or --output with a command, not both.",
            );
          }

          const targets = await fs.readJson(opts.targetsFile);
          if (!Array.isArray(targets)) {
            throw new Error("Targets file must contain a JSON array.");
          }

          await caxaBatch({
            input: opts.input,
            exclude: opts.exclude,
            includeNode: opts.includeNode,
            stub: opts.stub,
            compression: opts.compression,
            upx: opts.upx,
            upxArgs: opts.upxArgs,
            targets,
          });
          return;
        }

        if (!opts.output) {
          throw new Error("Missing required option ‘--output’.\n");
        }
        if (command.length === 0) {
          throw new Error("Missing required argument ‘command’.\n");
        }

        await caxa({ command, ...opts });
      } catch (error: any) {
        console.error(error.message);
        process.exit(1);
      }
    })
    .showHelpAfterError()
    .parseAsync();
