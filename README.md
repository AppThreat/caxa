# caxa

**Package Node.js applications into executable binaries.**

This is a high-performance fork of `caxa` (v3.0.1) maintained by AppThreat. Version 2.0 introduces significant architectural changes focused on build speed, runtime performance, and supply chain security.

### Key Improvements in v2

- **Streaming Builds**: Eliminated the intermediate build directory. Files are streamed directly from the source to the compressed archive, halving disk I/O during the packaging process.
- **Aggressive Binary Minimization**: When the `--upx` flag is used, caxa now compresses the bundled Node.js executable _before_ archiving it. This, combined with the compressed stub, results in significantly smaller final binaries (often reducing size by 30-50MB compared to standard builds).
- **High-Performance Decompression**: Switched the runtime stub to use SIMD-accelerated Gzip (`klauspost/compress/gzip`). This significantly reduces the "Time to First Hello World" compared to standard implementations.
- **Parallel Extraction & Smart Buffering**: The runtime stub now utilizes a worker pool to extract small files (like `node_modules`) concurrently, maximizing disk I/O saturation. Large files (>1MB) are streamed synchronously to prevent memory spikes.
- **Atomic Extraction**: Implemented a lock-based extraction mechanism in the runtime stub. This prevents corruption if the application process is killed during the initial extraction.
- **SBOM Ready**: Automatically generates a `binary-metadata.json` sidecar file containing a full dependency graph (components and relationship tree). This facilitates high-fidelity SBOM generation using tools like [cdxgen](https://github.com/cdxgen/cdxgen).

### How it Works

caxa does not compile Node.js from source or mess with V8 internals. It works by creating a self-extracting executable with a specific structure.

#### Binary Anatomy

Whether you use UPX or not, the final binary structure follows this layout:

```text
+-----------------------------+
|          Go Stub            |  <-- The executable entry point.
| (Native Code / UPX Packed)  |      Responsible for bootstrapping.
+-----------------------------+
|       \nCAXACAXACAXA\n      |  <-- Magic Separator (Plaintext).
+-----------------------------+
|     Application Payload     |  <-- Your project files + Node.js binary.
|        (tar + gzip)         |      Streamed directly to disk at runtime.
+-----------------------------+
|        JSON Config          |  <-- Metadata, Command arguments, & Build ID.
+-----------------------------+
```

1.  **Go Stub**: A pre-compiled Go binary. If `--upx` is used, this section is compressed.
2.  **Magic Separator**: A specific byte sequence that allows the Stub to locate the start of the payload, even if the Stub itself was modified by UPX.
3.  **Payload**: A Gzip-compressed TAR archive containing your application and the Node.js executable. **If `--upx` is enabled, the internal Node.js executable is also UPX-compressed**, drastically reducing the payload size.
4.  **Footer**: A JSON block at the very end of the file.

When executed, the Stub reads its own file content, scans for the Magic Separator to find the Payload, extracts it to a temporary directory (if not already cached), and executes the Node.js process with the arguments defined in the Footer.

### Features

- **Cross-Platform**: Supports Windows, macOS (Intel & ARM), and Linux (Intel, ARM64, ARMv6/7).
- **Zero Config**: No need to manually define assets.
- **Native Modules**: Fully supports projects with native C++ bindings (`.node` files).
- **No Magic**: Does not patch `require()`. Filesystem access works exactly as it does in a standard Node.js environment.
- **Double UPX Compression**: Optional post-build compression with [UPX](https://upx.github.io/). This compresses both the Go runtime stub **and** the bundled Node.js executable.

### Installation

```console
$ npm install --save-dev @appthreat/caxa
```

### Usage

#### 1. Prepare the Project

Ensure your project is built (e.g., TypeScript compiled to JavaScript) and dependencies are installed.

```bash
npm ci
npm run build
```

#### 2. Run caxa

Call `caxa` from the command line:

```console
$ npx caxa --input "." --output "my-app" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/index.js"
```

To create a smaller binary, use the --upx flag. You must have upx installed on your system.

```console
$ npx caxa --input "." --output "my-app" --upx --upx-args="--best" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/index.js"
```

pnpm is also supported. Below is how `cdxgen` SEA binaries gets created.

```
$ pnpm --package=@appthreat/caxa dlx caxa --input . --output cdxgen -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/bin/cdxgen.js"
```

### CLI Reference

```text
Usage: caxa [options] <command...>

Arguments:
  command                                The command to run. Paths must be absolute.
                                         The '{{caxa}}' placeholder is substituted for the extraction directory.
                                         The 'node' executable is available at '{{caxa}}/node_modules/.bin/node'.

Options:
  -i, --input <input>                    [Required] The input directory to package.
  -o, --output <output>                  [Required] The path where the executable will be produced.
                                         On Windows, must end in '.exe'.
  -F, --no-force                         Don't overwrite output if it exists.
  -e, --exclude <path...>                Paths to exclude from the build (glob patterns).
  -N, --no-include-node                  Don't copy the Node.js executable into the package.
  -s, --stub <path>                      Path to a custom stub.
  --identifier <identifier>              Build identifier used for the extraction path.
  -B, --no-remove-build-directory        [Legacy] Ignored in v2 due to streaming build architecture.
  -m, --uncompression-message <message>  A message to show to the user while uncompressing.
  --upx                                  Compress the output binary (and included Node.js) with UPX.
  --upx-args <args...>                   Arguments to pass to UPX (e.g., '--best --lzma').
  -V, --version                          output the version number
  -h, --help                             display help for command
```

### Programmatic Usage

You can invoke caxa directly from TypeScript or JavaScript build scripts.

```typescript
import caxa from "@appthreat/caxa";

(async () => {
  await caxa({
    input: ".",
    output: "bin/my-app",
    command: [
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/dist/index.js",
      "--custom-flag",
    ],
    exclude: ["*.log", "tmp/**"],
    upx: true,
    upxArgs: ["--best"],
  });
})();
```

### Runtime Behavior

#### Temporary Directory

By default, the application extracts to the system temporary directory (`os.tmpdir()` joined with `caxa`).

To override this location (e.g., for containerized environments with read-only `/tmp`), set the environment variable `CAXA_TEMP_DIR`:

```bash
export CAXA_TEMP_DIR=/var/opt/my-app
./my-app
```

#### Supply Chain Security

Every build produces a `binary-metadata.json` file alongside the executable. This file captures the full dependency graph of the packaged application, structured to align with SBOM standards.

Example `binary-metadata.json`:

```json
{
  "components": [
    {
      "group": "",
      "name": "my-app",
      "version": "1.0.0",
      "purl": "pkg:npm/my-app@1.0.0"
    },
    {
      "group": "",
      "name": "commander",
      "version": "12.0.0",
      "purl": "pkg:npm/commander@12.0.0"
    }
  ],
  "dependencies": [
    {
      "ref": "pkg:npm/my-app@1.0.0",
      "dependsOn": ["pkg:npm/commander@12.0.0"]
    }
  ]
}
```

### Anti-Features

- **No Source Hiding**: This is a packaging tool, not an obfuscator. The source code is extracted to the disk at runtime.
- **No Cross-Compilation**: The machine running `caxa` must have the same architecture/OS as the target if you want to bundle the _correct_ Node.js binary. You cannot bundle a Windows Node.js executable from a macOS machine (unless you provide it manually via custom scripts).
