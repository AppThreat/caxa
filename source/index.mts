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

export default async function caxa({
  input,
  output,
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
  const files = await globby(["**/*", ...exclude.map((e) => `!${e}`)], {
    cwd: input,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  });

  interface Component {
    group: string;
    name: string;
    version: string;
    purl: string;
    _rawDeps?: Record<string, string>;
  }

  interface DependencyGraphEntry {
    ref: string;
    dependsOn: string[];
  }

  const components: Component[] = [];
  const purlLookup = new Map<string, string>();

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

          components.push({
            group: namespace,
            name: name,
            version: pkg.version,
            purl: purl,
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
    path.join(path.dirname(output), "binary-metadata.json"),
    {
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
      archive.file(nodePath, { name: nodeDest });
    }

    await archive.finalize();
    await stream.finished(outputStream);
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

    await appendApplicationPayload(output);

    await fs.appendFile(
      output,
      "\n" + JSON.stringify({ identifier, command, uncompressionMessage }),
    );
  }
  if (upx && !output.endsWith(".app") && !output.endsWith(".sh")) {
    const processedArgs = upxArgs
      .flatMap((arg) => arg.split(/\s+/))
      .filter((arg) => arg.length > 0);
    await runUpx(output, processedArgs);
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
