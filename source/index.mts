#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { arch, platform } from "node:os";
import path from "node:path";
import url from "node:url";
import stream from "node:stream/promises";
import { createGzip, createZstdCompress } from "node:zlib";
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

function randomToken(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  let token = "";

  for (const byte of bytes) {
    token += alphabet[byte % alphabet.length];
  }

  return token;
}

function stripIndent(
  strings: TemplateStringsArray,
  ...values: Array<string | number | undefined>
): string {
  const fullText = strings.reduce((result, stringPart, index) => {
    const value = index < values.length ? String(values[index] ?? "") : "";
    return result + stringPart + value;
  }, "");
  const lines = fullText.replace(/^\n/, "").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;

  return lines
    .map((line) => line.slice(minIndent))
    .join("\n")
    .trimEnd();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function removePath(targetPath: string): Promise<void> {
  await fsp.rm(targetPath, { recursive: true, force: true });
}

async function readJsonFile(filePath: string): Promise<any> {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function writeJsonFile(
  filePath: string,
  value: unknown,
  spaces = 0,
): Promise<void> {
  await fsp.writeFile(filePath, JSON.stringify(value, null, spaces), "utf8");
}

function isExcludedPath(relativePath: string, exclude: string[]): boolean {
  const normalizedPath = normalizeArchivePath(relativePath);
  const segments = normalizedPath.split("/");
  const ancestors: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }

  return exclude.some(
    (pattern) =>
      path.matchesGlob(normalizedPath, pattern) ||
      ancestors.some((ancestor) => path.matchesGlob(ancestor, pattern)),
  );
}

function shouldPruneDirectory(
  relativePath: string,
  exclude: string[],
): boolean {
  const normalizedPath = normalizeArchivePath(relativePath);

  return exclude.some(
    (pattern) =>
      path.matchesGlob(normalizedPath, pattern) ||
      path.matchesGlob(`${normalizedPath}/__caxa_probe__`, pattern),
  );
}

async function walkFiles(
  root: string,
  current: string,
  exclude: string[],
  files: string[],
): Promise<void> {
  const entries = await fsp.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizeArchivePath(
      path.relative(root, absolutePath),
    );

    if (entry.isDirectory()) {
      if (shouldPruneDirectory(relativePath, exclude)) {
        continue;
      }
      await walkFiles(root, absolutePath, exclude, files);
      continue;
    }

    if (isExcludedPath(relativePath, exclude)) {
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relativePath);
    }
  }
}

async function copyEntry(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const stats = await fsp.lstat(sourcePath);
  await ensureDir(path.dirname(destinationPath));

  if (stats.isSymbolicLink()) {
    const linkTarget = await fsp.readlink(sourcePath);
    await removePath(destinationPath);
    await fsp.symlink(linkTarget, destinationPath);
    return;
  }

  await fsp.copyFile(sourcePath, destinationPath);
  await fsp.chmod(destinationPath, stats.mode);
}

function normalizeUpxArgs(args: string[]): string[] {
  return args
    .flatMap((arg) => arg.split(/\s+/))
    .filter((arg) => arg.length > 0);
}

function createIdentifier(output: string): string {
  return path.join(
    path.basename(path.basename(path.basename(output, ".exe"), ".app"), ".sh"),
    randomToken(10),
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
    `.caxa-payload-${randomToken(12)}.tar.${compression === "zstd" ? "zst" : "gz"}`,
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

  if (!(await pathExists(filePath))) {
    return undefined;
  }

  return fsp.realpath(filePath).catch(() => filePath);
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
  const pending = [await fsp.realpath(executablePath)];
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
  const pending = [await fsp.realpath(executablePath)];
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
  const nodePath = await fsp.realpath(process.execPath);
  const bundleRoot = path.join(stagingParent, `.caxa-node-${randomToken(12)}`);
  const binDir = path.join(bundleRoot, "node_modules", ".bin");
  await ensureDir(binDir);

  if (process.platform === "win32") {
    const nodeDestination = path.join(binDir, path.basename(nodePath));
    await fsp.copyFile(nodePath, nodeDestination);
    await fsp.chmod(nodeDestination, 0o755);

    for (const entry of await fsp.readdir(path.dirname(nodePath))) {
      if (!entry.toLowerCase().endsWith(".dll")) {
        continue;
      }
      await fsp.copyFile(
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
  await ensureDir(nodeLibDir);
  await fsp.copyFile(nodePath, nodeRealDestination);
  await fsp.chmod(nodeRealDestination, 0o755);

  if (upx) {
    await runUpx(nodeRealDestination, normalizeUpxArgs(upxArgs));
  }

  const runtimeLibraries =
    process.platform === "darwin"
      ? await collectDarwinRuntimeLibraries(nodePath)
      : await collectLinuxRuntimeLibraries(nodePath);

  for (const libraryPath of runtimeLibraries) {
    await fsp.copyFile(
      libraryPath,
      path.join(nodeLibDir, path.basename(libraryPath)),
    );
  }

  const envVariableName =
    process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  await fsp.writeFile(
    path.join(binDir, wrapperName),
    stripIndent`
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
  const files = await collectFiles(root, []);

  for (const file of files) {
    const absolutePath = path.join(root, file);
    archive.file(absolutePath, {
      name: normalizeArchivePath(file),
      stats: await fsp.stat(absolutePath),
    });
  }
}

async function copyDirectoryContents(
  source: string,
  destination: string,
): Promise<void> {
  const files = await collectFiles(source, []);

  for (const file of files) {
    const sourcePath = path.join(source, file);
    const destinationPath = path.join(destination, file);
    await copyEntry(sourcePath, destinationPath);
  }
}

async function validateOutput(output: string, force: boolean): Promise<void> {
  if ((await pathExists(output)) && !force)
    throw new Error(`Output already exists: ‘${output}’.`);
  if (process.platform === "win32" && !output.endsWith(".exe"))
    throw new Error("Windows executable must end in ‘.exe’.");

  await ensureDir(path.dirname(output));
  await removePath(output);
}

async function collectFiles(
  input: string,
  exclude: string[],
): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(input, input, exclude, files);
  return files.sort((left, right) => left.localeCompare(right));
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
      const pkg = await readJsonFile(path.join(input, file));
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
  await writeJsonFile(
    path.join(path.dirname(output), metadataFile),
    {
      parentComponent: getParentComponent(input, output),
      components,
      dependencies,
    },
    0,
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
  const outputStream = createWriteStream(destination);
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
    const stats = await fsp.lstat(absPath);
    if (stats.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(absPath);
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
    await removePath(tempPath);
  }

  return (await fsp.stat(destination)).size;
}

async function appendFile(source: string, destination: string): Promise<void> {
  await stream.pipeline(
    createReadStream(source),
    createWriteStream(destination, { flags: "a" }),
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

  if (!(await pathExists(stub))) {
    throw new Error(
      `Stub not found (your operating system / architecture may be unsupported): ‘${stub}’`,
    );
  }

  await fsp.copyFile(stub, output);
  await fsp.chmod(output, 0o755);
  if (upx) {
    await runUpx(output, normalizeUpxArgs(upxArgs));
  }

  await fsp.appendFile(output, archiveSeparator);
  const payloadOffset = (await fsp.stat(output)).size;
  await appendFile(payloadPath, output);

  const footer = createFooterBuffer({
    identifier,
    command,
    uncompressionMessage,
    compression,
  });
  await fsp.appendFile(output, footer);
  await fsp.appendFile(
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
  if (!existsSync(path.join(input, "package.json"))) {
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
  const packageJsonAsString = readFileSync(
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
  if (!(await pathExists(input)) || !(await fsp.lstat(input)).isDirectory()) {
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
    await ensureDir(path.dirname(payloadPath));
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
    await removePath(payloadPath);
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
  filter?: unknown;
  includeNode?: boolean;
  stub?: string;
  identifier?: string;
  removeBuildDirectory?: boolean;
  uncompressionMessage?: string;
  compression?: PayloadCompression;
  upx?: boolean;
  upxArgs?: string[];
}): Promise<void> {
  if (!(await pathExists(input)) || !(await fsp.lstat(input)).isDirectory())
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

    await ensureDir(path.join(output, "Contents", "MacOS"));
    await ensureDir(path.join(output, "Contents", "Resources"));

    const name = path.basename(output, ".app");

    await fsp.writeFile(
      path.join(output, "Contents", "MacOS", name),
      stripIndent`
        #!/usr/bin/env sh
        open "$(dirname "$0")/../Resources/${name}"
      ` + "\n",
      { mode: 0o755 },
    );

    await fsp.writeFile(
      path.join(output, "Contents", "Resources", name),
      stripIndent`
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
    await ensureDir(appDest);

    for (const file of files) {
      const src = path.join(input, file);
      const dest = path.join(appDest, file);
      await copyEntry(src, dest);
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
        await removePath(bundle.root);
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
      stripIndent`
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
          
          ${uncompressionMessage ? `echo "${uncompressionMessage}" >&2` : ""}
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
    await fsp.writeFile(output, shellStub, { mode: 0o755 });
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
      await removePath(payloadPath);
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
      await removePath(payloadPath);
    }
  }
}

if (
  url.fileURLToPath(import.meta.url) === (await fsp.realpath(process.argv[1]))
)
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
        await fsp.readFile(new URL("../package.json", import.meta.url), "utf8"),
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

          const targets = await readJsonFile(opts.targetsFile);
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
