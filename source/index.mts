#!/usr/bin/env node

import path from "node:path";
import url from "node:url";
import os from "node:os";
import stream from "node:stream/promises";
import fs from "fs-extra";
import { globbySync } from "globby";
import cryptoRandomString from "crypto-random-string";
import bash from "dedent";
import archiver from "archiver";
import * as commander from "commander";
import dedent from "dedent";
import process from "node:process";

// Some default excludes
const defaultExcludes = [
  ".*",
  "*.exe",
  "*.exe.sha256",
  "*.sha256",
  "cdxgen",
  "cdxgen-slim",
  "cdx-verify",
  "cdxgen-arm64",
  "cdxgen-arm64-slim",
  "cdx-arm64-verify",
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
  filter = (() => {
    if (!exclude.length) {
      exclude = defaultExcludes;
    }
    const pathsToExclude = globbySync(exclude, {
      expandDirectories: false,
      onlyFiles: false,
    }).map((pathToExclude: string) => path.normalize(pathToExclude));
    return (pathToCopy: string) =>
      !pathsToExclude.includes(path.normalize(pathToCopy));
  })(),
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
  removeBuildDirectory = true,
  uncompressionMessage,
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
}): Promise<void> {
  if (!(await fs.pathExists(input)) || !(await fs.lstat(input)).isDirectory())
    throw new Error(`Input isn’t a directory: ‘${input}’.`);
  if ((await fs.pathExists(output)) && !force)
    throw new Error(`Output already exists: ‘${output}’.`);
  if (process.platform === "win32" && !output.endsWith(".exe"))
    throw new Error("Windows executable must end in ‘.exe’.");

  const buildDirectory = path.join(
    os.tmpdir(),
    "caxa/builds",
    cryptoRandomString({ length: 10, type: "alphanumeric" }).toLowerCase(),
  );
  await fs.copy(input, buildDirectory, { filter });
  if (includeNode) {
    const node = path.join(
      buildDirectory,
      "node_modules/.bin",
      path.basename(process.execPath),
    );
    await fs.ensureDir(path.dirname(node));
    await fs.copyFile(process.execPath, node);
  }

  await fs.ensureDir(path.dirname(output));
  await fs.remove(output);

  if (output.endsWith(".app")) {
    if (process.platform !== "darwin")
      throw new Error(
        "macOS Application Bundles (.app) are supported in macOS only.",
      );
    await fs.ensureDir(path.join(output, "Contents/Resources"));
    await fs.move(
      buildDirectory,
      path.join(output, "Contents/Resources/application"),
    );
    await fs.ensureDir(path.join(output, "Contents/MacOS"));
    const name = path.basename(output, ".app");
    await fs.writeFile(
      path.join(output, "Contents/MacOS", name),
      bash`
        #!/usr/bin/env sh
        open "$(dirname "$0")/../Resources/${name}"
      ` + "\n",
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(output, "Contents/Resources", name),
      bash`
        #!/usr/bin/env sh
        ${command
          .map(
            (part) =>
              `"${part.replace(
                /\{\{\s*caxa\s*\}\}/g,
                `$(dirname "$0")/application`,
              )}"`,
          )
          .join(" ")}
      ` + "\n",
      { mode: 0o755 },
    );
  } else if (output.endsWith(".sh")) {
    if (process.platform === "win32")
      throw new Error("The Shell Stub (.sh) isn’t supported in Windows.");
    let stub =
      bash`
        #!/usr/bin/env sh
        export CAXA_TEMPORARY_DIRECTORY="$(dirname $(mktemp))/caxa"
        export CAXA_EXTRACTION_ATTEMPT=-1
        while true
        do
          export CAXA_EXTRACTION_ATTEMPT=$(( CAXA_EXTRACTION_ATTEMPT + 1 ))
          export CAXA_LOCK="$CAXA_TEMPORARY_DIRECTORY/locks/${identifier}/$CAXA_EXTRACTION_ATTEMPT"
          export CAXA_APPLICATION_DIRECTORY="$CAXA_TEMPORARY_DIRECTORY/applications/${identifier}/$CAXA_EXTRACTION_ATTEMPT"
          if [ -d "$CAXA_APPLICATION_DIRECTORY" ]
          then
            if [ -d "$CAXA_LOCK" ]
            then
              continue
            else
              break
            fi
          else
            ${
              uncompressionMessage === undefined
                ? bash``
                : bash`echo "${uncompressionMessage}" >&2`
            }
            mkdir -p "$CAXA_LOCK"
            mkdir -p "$CAXA_APPLICATION_DIRECTORY"
            tail -n+{{caxa-number-of-lines}} "$0" | tar -xz -C "$CAXA_APPLICATION_DIRECTORY"
            rmdir "$CAXA_LOCK"
            break
          fi
        done
        exec ${command
          .map(
            (commandPart) =>
              `"${commandPart.replace(
                /\{\{\s*caxa\s*\}\}/g,
                `"$CAXA_APPLICATION_DIRECTORY"`,
              )}"`,
          )
          .join(" ")} "$@"
      ` + "\n";
    stub = stub.replace(
      "{{caxa-number-of-lines}}",
      String(stub.split("\n").length),
    );
    await fs.writeFile(output, stub, { mode: 0o755 });
    await appendTarballOfBuildDirectoryToOutput();
  } else {
    if (!(await fs.pathExists(stub)))
      throw new Error(
        `Stub not found (your operating system / architecture may be unsupported): ‘${stub}’`,
      );
    await fs.copyFile(stub, output);
    await fs.chmod(output, 0o755);
    await appendTarballOfBuildDirectoryToOutput();
    await fs.appendFile(
      output,
      "\n" + JSON.stringify({ identifier, command, uncompressionMessage }),
    );
  }

  if (removeBuildDirectory) await fs.remove(buildDirectory);

  async function appendTarballOfBuildDirectoryToOutput(): Promise<void> {
    const archive = archiver("tar", { gzip: true });
    const archiveStream = fs.createWriteStream(output, { flags: "a" });
    archive.pipe(archiveStream);
    archive.directory(buildDirectory, false);
    await archive.finalize();
    await stream.finished(archiveStream);
  }
}

if (url.fileURLToPath(import.meta.url) === (await fs.realpath(process.argv[1])))
  await commander.program
    .name("caxa")
    .description("Package Node.js applications into executable binaries")
    .requiredOption(
      "-i, --input <input>",
      "[Required] The input directory to package.",
    )
    .requiredOption(
      "-o, --output <output>",
      "[Required] The path where the executable will be produced. On Windows, must end in ‘.exe’. In macOS and Linux, may have no extension to produce regular binary. In macOS and Linux, may end in ‘.sh’ to use the Shell Stub, which is a bit smaller, but depends on some tools being installed on the end-user machine, for example, ‘tar’, ‘tail’, and so forth. In macOS, may end in ‘.app’ to generate a macOS Application Bundle.",
    )
    .option("-F, --no-force", "[Advanced] Don’t overwrite output if it exists.")
    .option(
      "-e, --exclude <path...>",
      `[Advanced] Paths to exclude from the build. The paths are passed to https://github.com/sindresorhus/globby and paths that match will be excluded. [Super-Advanced, Please don’t use] If you wish to emulate ‘--include’, you may use ‘--exclude "*" ".*" "!path-to-include" ...’. The problem with ‘--include’ is that if you change your project structure but forget to change the caxa invocation, then things will subtly fail only in the packaged version.`,
    )
    .option(
      "-N, --no-include-node",
      "[Advanced] Don’t copy the Node.js executable to ‘{{caxa}}/node_modules/.bin/node’.",
    )
    .option("-s, --stub <path>", "[Advanced] Path to the stub.")
    .option(
      "--identifier <identifier>",
      "[Advanced] Build identifier, which is part of the path in which the application will be unpacked.",
    )
    .option(
      "-B, --no-remove-build-directory",
      "[Advanced] Remove the build directory after the build.",
    )
    .option(
      "-m, --uncompression-message <message>",
      "[Advanced] A message to show when uncompressing, for example, ‘This may take a while to run the first time, please wait...’.",
    )
    .argument(
      "<command...>",
      "The command to run and optional arguments to pass to the command every time the executable is called. Paths must be absolute. The ‘{{caxa}}’ placeholder is substituted for the folder from which the package runs. The ‘node’ executable is available at ‘{{caxa}}/node_modules/.bin/node’. Use double quotes to delimit the command and each argument.",
    )
    .version(
      JSON.parse(
        await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
      ).version,
    )
    .addHelpText(
      "after",
      "\n" +
        dedent`
          Examples:
            Windows:
            > caxa --input "examples/echo-command-line-parameters" --output "echo-command-line-parameters.exe" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"

            macOS/Linux:
            $ caxa --input "examples/echo-command-line-parameters" --output "echo-command-line-parameters" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"

            macOS/Linux (Shell Stub):
            $ caxa --input "examples/echo-command-line-parameters" --output "echo-command-line-parameters.sh" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"

            macOS (Application Bundle):
            $ caxa --input "examples/echo-command-line-parameters" --output "Echo Command Line Parameters.app" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"
        `,
    )
    .action(
      async (
        command: string[],
        {
          input,
          output,
          force,
          exclude,
          includeNode,
          stub,
          identifier,
          removeBuildDirectory,
          uncompressionMessage,
        }: {
          input: string;
          output: string;
          force?: boolean;
          exclude?: string[];
          includeNode?: boolean;
          stub?: string;
          identifier?: string;
          removeBuildDirectory?: boolean;
          uncompressionMessage?: string;
        },
      ) => {
        try {
          await caxa({
            input,
            output,
            command,
            force,
            exclude,
            includeNode,
            stub,
            identifier,
            removeBuildDirectory,
            uncompressionMessage,
          });
        } catch (error: any) {
          console.error(error.message);
          process.exit(1);
        }
      },
    )
    .showHelpAfterError()
    .parseAsync();
