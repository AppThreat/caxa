Forked from caxa [3.0.1](https://github.com/leafac/caxa/releases/tag/v3.0.1) with the following changes:

- Updated packages.
- Added default excludes to ignore .git and some test directories.
- Removed broken unit tests from source/index.mts.
- Excluded build and binary stubs using .gitignore. The published package would include binary stubs not present in this git repository.

Original README below:

<h1 align="center">caxa</h1>
<h3 align="center">📦 Package Node.js applications into executable binaries 📦</h3>

### Why Package Node.js Applications into Executable Binaries?

- Simple deploys. Transfer the binary into a machine and run it.
- Let users test an application even if they don’t have Node.js installed.
- Simple installation story for command-line applications.
- It’s like the much-praised distribution story of [Go](https://golang.org) programs but for Node.js.

### Features

- Works on Windows, macOS (Intel & ARM), and Linux (Intel, ARM6, ARM7, ARM64).
- Simple to use. `npm install @appthreat/caxa` and call `caxa` from the command line. No need to declare which files to include; no need to bundle the application into a single file.
- Supports any kind of Node.js project, including those with native modules.
- Works with any Node.js version.
- Packages in seconds.
- Relatively small binaries. A “Hello World!” application is ~30MB, which is terrible if compared to Go’s ~2MB, and worse still if compared to C’s ~50KB, but best-in-class if compared to other packaging solutions for Node.js.
- Produces `.exe`s for Windows, simple binaries for macOS/Linux, and macOS Application Bundles (`.app`).
- Based on a simple but powerful idea. Implemented in ~200 lines of code.
- No magic. No traversal of `require()`s trying to find which files to include; no patches to Node.js source.

### Anti-Features

- Doesn’t patch the Node.js source code.
- Doesn’t build Node.js from source.
- Doesn’t support cross-compilation (for example, building a Windows executable from a macOS development machine).
- Doesn’t support packaging with a Node.js version different from the one that’s running caxa (for example, bundling Node.js 15 while running caxa with Node.js 14).
- Doesn’t hide your JavaScript source code in any way.

### Installation

```console
$ npm install --save-dev @appthreat/caxa
```

### Usage

#### Prepare the Project for Packaging

- Install any dependencies with `npm install` or `npm ci`.
- Build. For example, compile TypeScript with `tsc`, bundle with webpack, and whatever else you need to get the project ready to start. Typically this is the kind of thing that goes into an [npm `prepare` script](https://docs.npmjs.com/cli/v7/using-npm/scripts#prepare-and-prepublish), so the `npm ci` from the previous point may already have taken care of this.
- If there are files that shouldn’t be in the package, remove them from the directory. For example, you may wish to remove the `.git` directory.
- You don’t need to `npm dedupe --production`, because caxa will do that for you from within the build directory. (Otherwise, if you tried to `npm dedupe --production` you’d uninstall caxa, which should probably be in `devDependencies`.)
- It’s recommended that you run caxa on a Continuous Integration server. (GitHub Actions, for example, does a shallow fetch of the repository, so removing the `.git` directory becomes negligible—but you can always do that with the `--exclude` advanced option.)

#### Call caxa from the Command Line

```console
$ npx caxa --help
Usage: caxa [options] <command...>

Package Node.js applications into executable binaries

Arguments:
  command                                The command to run and optional arguments to pass to the command every time the executable is called. Paths must be absolute. The ‘{{caxa}}’ placeholder is substituted for the folder from which the package runs. The ‘node’ executable is available at ‘{{caxa}}/node_modules/.bin/node’. Use double quotes to delimit the command and each argument.

Options:
  -i, --input <input>                    [Required] The input directory to package.
  -o, --output <output>                  [Required] The path where the executable will be produced. On Windows, must end in ‘.exe’. In macOS and Linux, may have no extension to produce regular binary. In macOS and Linux, may end in ‘.sh’ to use the Shell Stub, which is a bit smaller, but depends on some tools being installed on the end-user machine, for example, ‘tar’, ‘tail’, and so forth. In macOS, may end in ‘.app’ to generate a macOS Application Bundle.
  -F, --no-force                         [Advanced] Don’t overwrite output if it exists.
  -e, --exclude <path...>                [Advanced] Paths to exclude from the build. The paths are passed to https://github.com/sindresorhus/globby and paths that match will be excluded. [Super-Advanced, Please don’t use] If you wish to emulate ‘--include’, you may use ‘--exclude "*" ".*" "!path-to-include" ...’. The problem with ‘--include’ is that if you change your project structure but forget to change the caxa invocation, then things will subtly fail only in the packaged version.
  -N, --no-include-node                  [Advanced] Don’t copy the Node.js executable to ‘{{caxa}}/node_modules/.bin/node’.
  -s, --stub <path>                      [Advanced] Path to the stub.
  --identifier <identifier>              [Advanced] Build identifier, which is part of the path in which the application will be unpacked.
  -B, --no-remove-build-directory        [Advanced] Remove the build directory after the build.
  -m, --uncompression-message <message>  [Advanced] A message to show when uncompressing, for example, ‘This may take a while to run the first time, please wait...’.
  -V, --version                          output the version number
  -h, --help                             display help for command

Examples:
  Windows:
  > caxa --input "examples/echo-command-line-parameters" --output "echo-command-line-parameters.exe" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"

  macOS/Linux:
  $ caxa --input "examples/echo-command-line-parameters" --output "echo-command-line-parameters" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"

  macOS/Linux (Shell Stub):
  $ caxa --input "examples/echo-command-line-parameters" --output "echo-command-line-parameters.sh" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"

  macOS (Application Bundle):
  $ caxa --input "examples/echo-command-line-parameters" --output "Echo Command Line Parameters.app" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.mjs" "some" "embedded arguments" "--an-option-thats-part-of-the-command"
```

Here’s [a real-world example of using caxa](https://github.com/courselore/courselore/blob/c0b541d63fc656986ebeab4af3f3dc9bc2909972/.github/workflows/main.yml). This example includes packaging for Windows, macOS, and Linux; distributing tags with GitHub Releases Assets; distributing Insiders Builds for every push with GitHub Actions Artifacts; and deploying a binary to a server with `rsync` (and publishing an npm package as well, but that’s beyond the scope of caxa).

#### Call caxa from TypeScript/JavaScript

Instead of calling caxa from the command line, you may prefer to write a program that builds your application, for example:

```typescript
import caxa from "caxa";

(async () => {
  await caxa({
    input: "examples/echo-command-line-parameters",
    output: "echo-command-line-parameters",
    command: [
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/index.mjs",
      "some",
      "embedded arguments",
    ],
  });
})();
```

You may need to inspect `process.platform` to determine which operating system you’re running and come up with the appropriate parameters.
