#!/usr/bin/env node

import path from "node:path";
import url from "node:url";
import stream from "node:stream/promises";
import fs from "fs-extra";
import { globby } from "globby";
import cryptoRandomString from "crypto-random-string";
import bash from "dedent";
import archiver from "archiver";
import * as commander from "commander";
import process from "node:process";
import { spawn } from "node:child_process";

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
    runtime: undefined,
    purl: undefined,
    scope: "required",
  };
  // @ts-ignore
  if (globalThis.Deno?.version?.deno) {
    runtimeInfo.name = "deno";
    runtimeInfo.runtime = "Deno";
    // @ts-ignore
    runtimeInfo.version = globalThis.Deno.version.deno;
    runtimeInfo.purl = `pkg:generic/${runtimeInfo.name}@${runtimeInfo.version}`;
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
    // @ts-ignore
  } else if (globalThis.Bun?.version) {
    runtimeInfo.name = "bun";
    runtimeInfo.runtime = "Bun";
    // @ts-ignore
    runtimeInfo.version = globalThis.Bun.version;
    runtimeInfo.purl = `pkg:generic/${runtimeInfo.name}@${runtimeInfo.version}`;
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
  } else if (globalThis.process?.versions?.node) {
    runtimeInfo.name = "node";
    runtimeInfo.runtime = "Node.js";
    runtimeInfo.version = globalThis.process.versions.node;
    runtimeInfo.purl = `pkg:generic/${runtimeInfo.name}@${runtimeInfo.version}`;
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
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

export default async function caxa({
  input,
  output,
  command,
  metadataFile = "binary-metadata.json",
  force = true,
  exclude = defaultExcludes,
  includeNode = true,
  stub = url.fileURLToPath(
    new URL(
      `../stubs/stub--${process.platform}--${process.arch}`,
      import.meta.url,
    ),
  ),
  identifier = path.join(
    path.basename(path.basename(path.basename(output, ".exe"), ".app"), ".sh"),
    cryptoRandomString({ length: 10, type: "alphanumeric" }).toLowerCase(),
  ),
  uncompressionMessage,
  upx = false,
  upxArgs = [],
}: {
  input: string;
  output: string;
  command: string[];
  metadataFile: string;
  force?: boolean;
  exclude?: string[];
  filter?: fs.CopyFilterSync | fs.CopyFilterAsync;
  includeNode?: boolean;
  stub?: string;
  identifier?: string;
  removeBuildDirectory?: boolean;
  uncompressionMessage?: string;
  upx?: boolean;
  upxArgs?: string[];
}): Promise<void> {
  if (!(await fs.pathExists(input)) || !(await fs.lstat(input)).isDirectory())
    throw new Error(`Input isn’t a directory: ‘${input}’.`);
  if ((await fs.pathExists(output)) && !force)
    throw new Error(`Output already exists: ‘${output}’.`);
  if (process.platform === "win32" && !output.endsWith(".exe"))
    throw new Error("Windows executable must end in ‘.exe’.");

  await fs.ensureDir(path.dirname(output));
  await fs.remove(output);

  if (!exclude) exclude = defaultExcludes;
  const files = await globby(["**/*"], {
    cwd: input,
    onlyFiles: true,
    dot: true,
    ignore: exclude,
    followSymbolicLinks: false,
  });

  interface Component {
    group: string;
    name: string;
    description: string;
    license: string;
    version: string;
    purl: string;
    author: string;
    _rawDeps?: Record<string, string>;
  }

  interface DependencyGraphEntry {
    ref: string;
    dependsOn: string[];
  }
  const parentName = path.basename(output).replace(path.extname(output), "");
  const parentComponent = {
    group: "",
    name: parentName,
    version: undefined,
    purl: `pkg:generic/${parentName}`,
    "bom-ref": `pkg:generic/${parentName}`,
  };
  const components: Component[] = [];
  const purlLookup = new Map<string, string>();
  if (includeNode) {
    const runtimeInfo = getRuntimeInformation();
    components.push(runtimeInfo);
  }
  for (const file of files) {
    if (path.basename(file) === "package.json") {
      try {
        const pkg = await fs.readJson(path.join(input, file));
        if (pkg.name && pkg.version) {
          let name = pkg.name;
          let namespace = "";
          if (name.startsWith("@")) {
            const parts = name.split("/");
            namespace = parts[0];
            name = parts[1];
          }

          let purl = "pkg:npm/";
          if (namespace) {
            purl += `${encodeURIComponent(namespace)}/`;
          }
          purl += `${name}@${pkg.version}`;
          purlLookup.set(pkg.name, purl);
          const author = pkg.author;
          const authorString =
            author instanceof Object
              ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
                  author.url ? ` (${author.url})` : ""
                }`
              : author;
          components.push({
            group: namespace,
            name: name,
            description: pkg.description,
            license: pkg.license,
            version: pkg.version,
            purl: purl,
            author: authorString,
            _rawDeps: pkg.dependencies,
          });
        }
      } catch (e) {
        // Ignore
      }
    }
  }

  const dependencies: DependencyGraphEntry[] = [];

  for (const comp of components) {
    const childPurls: string[] = [];
    if (comp._rawDeps) {
      for (const depName of Object.keys(comp._rawDeps)) {
        const resolvedPurl = purlLookup.get(depName);
        if (resolvedPurl) {
          childPurls.push(resolvedPurl);
        }
      }
      delete comp._rawDeps;
    }
    if (childPurls.length > 0) {
      dependencies.push({
        ref: comp.purl,
        dependsOn: childPurls,
      });
    }
  }
  await fs.writeJson(
    path.join(path.dirname(output), metadataFile),
    {
      parentComponent,
      components,
      dependencies,
    },
    { spaces: 0 },
  );

  const appendApplicationPayload = async (destination: string, prefix = "") => {
    const archive = archiver("tar", {
      gzip: true,
    });
    const outputStream = fs.createWriteStream(destination, { flags: "a" });
    const tempFilesCleanup: string[] = [];

    archive.pipe(outputStream);
    for (const file of files) {
      const absPath = path.join(input, file);
      let name = path.join(prefix, file);
      if (process.platform === "win32") {
        name = name.replace(/\\/g, "/");
      }
      const stats = await fs.lstat(absPath);
      if (stats.isSymbolicLink()) {
        const linkTarget = await fs.readlink(absPath);
        archive.symlink(name, linkTarget);
      } else {
        archive.file(absPath, { name, stats });
      }
    }

    if (includeNode) {
      const nodePath = process.execPath;
      let nodeDest = path.join(
        prefix,
        "node_modules",
        ".bin",
        path.basename(nodePath),
      );
      if (process.platform === "win32") {
        nodeDest = nodeDest.replace(/\\/g, "/");
      }

      if (upx) {
        const tempNodeName = `node-${cryptoRandomString({ length: 10 })}${process.platform === "win32" ? ".exe" : ""}`;
        const tempNodePath = path.join(path.dirname(output), tempNodeName);

        try {
          await fs.copyFile(nodePath, tempNodePath);
          await fs.chmod(tempNodePath, 0o755);

          const processedArgs = upxArgs
            .flatMap((arg) => arg.split(/\s+/))
            .filter((arg) => arg.length > 0);

          await runUpx(tempNodePath, processedArgs);

          archive.file(tempNodePath, { name: nodeDest });
          tempFilesCleanup.push(tempNodePath);
        } catch (err) {
          throw new Error(
            `Failed to compress Node.js binary: ${(err as Error).message}`,
          );
        }
      } else {
        archive.file(nodePath, { name: nodeDest });
      }
    }

    await archive.finalize();
    await stream.finished(outputStream);

    for (const tempFile of tempFilesCleanup) {
      await fs.remove(tempFile);
    }
  };

  if (output.endsWith(".app")) {
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
      const nodeDest = path.join(
        appDest,
        "node_modules",
        ".bin",
        path.basename(process.execPath),
      );
      await fs.ensureDir(path.dirname(nodeDest));
      await fs.copyFile(process.execPath, nodeDest);
    }
  } else if (output.endsWith(".sh")) {
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
    await appendApplicationPayload(output);
  } else {
    if (!(await fs.pathExists(stub)))
      throw new Error(
        `Stub not found (your operating system / architecture may be unsupported): ‘${stub}’`,
      );

    await fs.copyFile(stub, output);
    await fs.chmod(output, 0o755);
    if (upx && !output.endsWith(".app") && !output.endsWith(".sh")) {
      const processedArgs = upxArgs
        .flatMap((arg) => arg.split(/\s+/))
        .filter((arg) => arg.length > 0);
      await runUpx(output, processedArgs);
    }
    await fs.appendFile(output, "\nCAXACAXACAXA\n");
    await appendApplicationPayload(output);
    await fs.appendFile(
      output,
      "\n" + JSON.stringify({ identifier, command, uncompressionMessage }),
    );
  }
}

if (url.fileURLToPath(import.meta.url) === (await fs.realpath(process.argv[1])))
  await commander.program
    .name("caxa")
    .description("Package Node.js applications into executable binaries")
    .requiredOption("-i, --input <input>", "Input directory to package.")
    .requiredOption(
      "-o, --output <output>",
      "Path where the executable will be produced.",
    )
    .option(
      "--metadata-file",
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
    .argument("<command...>", "Command to run.")
    .version(
      JSON.parse(
        await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
      ).version,
    )
    .action(async (command, opts) => {
      try {
        await caxa({ command, ...opts });
      } catch (error: any) {
        console.error(error.message);
        process.exit(1);
      }
    })
    .showHelpAfterError()
    .parseAsync();
