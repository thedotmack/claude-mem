Bun's bundler implements a `--compile` flag for generating a standalone binary from a TypeScript or JavaScript file.

{% codetabs %}

```bash
$ bun build ./cli.ts --compile --outfile mycli
```

```ts#cli.ts
console.log("Hello world!");
```

{% /codetabs %}

This bundles `cli.ts` into an executable that can be executed directly:

```
$ ./mycli
Hello world!
```

All imported files and packages are bundled into the executable, along with a copy of the Bun runtime. All built-in Bun and Node.js APIs are supported.

## Cross-compile to other platforms

The `--target` flag lets you compile your standalone executable for a different operating system, architecture, or version of Bun than the machine you're running `bun build` on.

To build for Linux x64 (most servers):

```sh
bun build --compile --target=bun-linux-x64 ./index.ts --outfile myapp

# To support CPUs from before 2013, use the baseline version (nehalem)
bun build --compile --target=bun-linux-x64-baseline ./index.ts --outfile myapp

# To explicitly only support CPUs from 2013 and later, use the modern version (haswell)
# modern is faster, but baseline is more compatible.
bun build --compile --target=bun-linux-x64-modern ./index.ts --outfile myapp
```

To build for Linux ARM64 (e.g. Graviton or Raspberry Pi):

```sh
# Note: the default architecture is x64 if no architecture is specified.
bun build --compile --target=bun-linux-arm64 ./index.ts --outfile myapp
```

To build for Windows x64:

```sh
bun build --compile --target=bun-windows-x64 ./path/to/my/app.ts --outfile myapp

# To support CPUs from before 2013, use the baseline version (nehalem)
bun build --compile --target=bun-windows-x64-baseline ./path/to/my/app.ts --outfile myapp

# To explicitly only support CPUs from 2013 and later, use the modern version (haswell)
bun build --compile --target=bun-windows-x64-modern ./path/to/my/app.ts --outfile myapp

# note: if no .exe extension is provided, Bun will automatically add it for Windows executables
```

To build for macOS arm64:

```sh
bun build --compile --target=bun-darwin-arm64 ./path/to/my/app.ts --outfile myapp
```

To build for macOS x64:

```sh
bun build --compile --target=bun-darwin-x64 ./path/to/my/app.ts --outfile myapp
```

#### Supported targets

The order of the `--target` flag does not matter, as long as they're delimited by a `-`.

| --target              | Operating System | Architecture | Modern | Baseline | Libc  |
| --------------------- | ---------------- | ------------ | ------ | -------- | ----- |
| bun-linux-x64         | Linux            | x64          | ✅     | ✅       | glibc |
| bun-linux-arm64       | Linux            | arm64        | ✅     | N/A      | glibc |
| bun-windows-x64       | Windows          | x64          | ✅     | ✅       | -     |
| ~~bun-windows-arm64~~ | Windows          | arm64        | ❌     | ❌       | -     |
| bun-darwin-x64        | macOS            | x64          | ✅     | ✅       | -     |
| bun-darwin-arm64      | macOS            | arm64        | ✅     | N/A      | -     |
| bun-linux-x64-musl    | Linux            | x64          | ✅     | ✅       | musl  |
| bun-linux-arm64-musl  | Linux            | arm64        | ✅     | N/A      | musl  |

On x64 platforms, Bun uses SIMD optimizations which require a modern CPU supporting AVX2 instructions. The `-baseline` build of Bun is for older CPUs that don't support these optimizations. Normally, when you install Bun we automatically detect which version to use but this can be harder to do when cross-compiling since you might not know the target CPU. You usually don't need to worry about it on Darwin x64, but it is relevant for Windows x64 and Linux x64. If you or your users see `"Illegal instruction"` errors, you might need to use the baseline version.

## Build-time constants

Use the `--define` flag to inject build-time constants into your executable, such as version numbers, build timestamps, or configuration values:

```bash
$ bun build --compile --define BUILD_VERSION='"1.2.3"' --define BUILD_TIME='"2024-01-15T10:30:00Z"' src/cli.ts --outfile mycli
```

These constants are embedded directly into your compiled binary at build time, providing zero runtime overhead and enabling dead code elimination optimizations.

{% callout type="info" %}
For comprehensive examples and advanced patterns, see the [Build-time constants guide](/guides/runtime/build-time-constants).
{% /callout %}

## Deploying to production

Compiled executables reduce memory usage and improve Bun's start time.

Normally, Bun reads and transpiles JavaScript and TypeScript files on `import` and `require`. This is part of what makes so much of Bun "just work", but it's not free. It costs time and memory to read files from disk, resolve file paths, parse, transpile, and print source code.

With compiled executables, you can move that cost from runtime to build-time.

When deploying to production, we recommend the following:

```sh
bun build --compile --minify --sourcemap ./path/to/my/app.ts --outfile myapp
```

### Bytecode compilation

To improve startup time, enable bytecode compilation:

```sh
bun build --compile --minify --sourcemap --bytecode ./path/to/my/app.ts --outfile myapp
```

Using bytecode compilation, `tsc` starts 2x faster:

{% image src="https://github.com/user-attachments/assets/dc8913db-01d2-48f8-a8ef-ac4e984f9763" width="689" /%}

Bytecode compilation moves parsing overhead for large input files from runtime to bundle time. Your app starts faster, in exchange for making the `bun build` command a little slower. It doesn't obscure source code.

**Experimental:** Bytecode compilation is an experimental feature introduced in Bun v1.1.30. Only `cjs` format is supported (which means no top-level-await). Let us know if you run into any issues!

### What do these flags do?

The `--minify` argument optimizes the size of the transpiled output code. If you have a large application, this can save megabytes of space. For smaller applications, it might still improve start time a little.

The `--sourcemap` argument embeds a sourcemap compressed with zstd, so that errors & stacktraces point to their original locations instead of the transpiled location. Bun will automatically decompress & resolve the sourcemap when an error occurs.

The `--bytecode` argument enables bytecode compilation. Every time you run JavaScript code in Bun, JavaScriptCore (the engine) will compile your source code into bytecode. We can move this parsing work from runtime to bundle time, saving you startup time.

## Act as the Bun CLI

{% note %}

New in Bun v1.2.16

{% /note %}

You can run a standalone executable as if it were the `bun` CLI itself by setting the `BUN_BE_BUN=1` environment variable. When this variable is set, the executable will ignore its bundled entrypoint and instead expose all the features of Bun's CLI.

For example, consider an executable compiled from a simple script:

```sh
$ cat such-bun.js
console.log("you shouldn't see this");

$ bun build --compile ./such-bun.js
 [3ms] bundle 1 modules
[89ms] compile such-bun
```

Normally, running `./such-bun` with arguments would execute the script. However, with the `BUN_BE_BUN=1` environment variable, it acts just like the `bun` binary:

```sh
# Executable runs its own entrypoint by default
$ ./such-bun install
you shouldn't see this

# With the env var, the executable acts like the `bun` CLI
$ BUN_BE_BUN=1 ./such-bun install
bun install v1.2.16-canary.1 (1d1db811)
Checked 63 installs across 64 packages (no changes) [5.00ms]
```

This is useful for building CLI tools on top of Bun that may need to install packages, bundle dependencies, run different or local files and more without needing to download a separate binary or install bun.

## Full-stack executables

{% note %}

New in Bun v1.2.17

{% /note %}

Bun's `--compile` flag can create standalone executables that contain both server and client code, making it ideal for full-stack applications. When you import an HTML file in your server code, Bun automatically bundles all frontend assets (JavaScript, CSS, etc.) and embeds them into the executable. When Bun sees the HTML import on the server, it kicks off a frontend build process to bundle JavaScript, CSS, and other assets.

{% codetabs %}

```ts#server.ts
import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    "/": index,
    "/api/hello": { GET: () => Response.json({ message: "Hello from API" }) },
  },
});

console.log(`Server running at http://localhost:${server.port}`);
```

```html#index.html
<!DOCTYPE html>
<html>
  <head>
    <title>My App</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <h1>Hello World</h1>
    <script src="./app.js"></script>
  </body>
</html>
```

```js#app.js
console.log("Hello from the client!");
```

```css#styles.css
body {
  background-color: #f0f0f0;
}
```

{% /codetabs %}

To build this into a single executable:

```sh
bun build --compile ./server.ts --outfile myapp
```

This creates a self-contained binary that includes:

- Your server code
- The Bun runtime
- All frontend assets (HTML, CSS, JavaScript)
- Any npm packages used by your server

The result is a single file that can be deployed anywhere without needing Node.js, Bun, or any dependencies installed. Just run:

```sh
./myapp
```

Bun automatically handles serving the frontend assets with proper MIME types and cache headers. The HTML import is replaced with a manifest object that `Bun.serve` uses to efficiently serve pre-bundled assets.

For more details on building full-stack applications with Bun, see the [full-stack guide](/docs/bundler/fullstack).

## Worker

To use workers in a standalone executable, add the worker's entrypoint to the CLI arguments:

```sh
$ bun build --compile ./index.ts ./my-worker.ts --outfile myapp
```

Then, reference the worker in your code:

```ts
console.log("Hello from Bun!");

// Any of these will work:
new Worker("./my-worker.ts");
new Worker(new URL("./my-worker.ts", import.meta.url));
new Worker(new URL("./my-worker.ts", import.meta.url).href);
```

As of Bun v1.1.25, when you add multiple entrypoints to a standalone executable, they will be bundled separately into the executable.

In the future, we may automatically detect usages of statically-known paths in `new Worker(path)` and then bundle those into the executable, but for now, you'll need to add it to the shell command manually like the above example.

If you use a relative path to a file not included in the standalone executable, it will attempt to load that path from disk relative to the current working directory of the process (and then error if it doesn't exist).

## SQLite

You can use `bun:sqlite` imports with `bun build --compile`.

By default, the database is resolved relative to the current working directory of the process.

```js
import db from "./my.db" with { type: "sqlite" };

console.log(db.query("select * from users LIMIT 1").get());
```

That means if the executable is located at `/usr/bin/hello`, the user's terminal is located at `/home/me/Desktop`, it will look for `/home/me/Desktop/my.db`.

```
$ cd /home/me/Desktop
$ ./hello
```

## Embed assets & files

Standalone executables support embedding files.

To embed files into an executable with `bun build --compile`, import the file in your code.

```ts
// this becomes an internal file path
import icon from "./icon.png" with { type: "file" };
import { file } from "bun";

export default {
  fetch(req) {
    // Embedded files can be streamed from Response objects
    return new Response(file(icon));
  },
};
```

Embedded files can be read using `Bun.file`'s functions or the Node.js `fs.readFile` function (in `"node:fs"`).

For example, to read the contents of the embedded file:

```js
import icon from "./icon.png" with { type: "file" };
import { file } from "bun";

const bytes = await file(icon).arrayBuffer();
// await fs.promises.readFile(icon)
// fs.readFileSync(icon)
```

### Embed SQLite databases

If your application wants to embed a SQLite database, set `type: "sqlite"` in the import attribute and the `embed` attribute to `"true"`.

```js
import myEmbeddedDb from "./my.db" with { type: "sqlite", embed: "true" };

console.log(myEmbeddedDb.query("select * from users LIMIT 1").get());
```

This database is read-write, but all changes are lost when the executable exits (since it's stored in memory).

### Embed N-API Addons

As of Bun v1.0.23, you can embed `.node` files into executables.

```js
const addon = require("./addon.node");

console.log(addon.hello());
```

Unfortunately, if you're using `@mapbox/node-pre-gyp` or other similar tools, you'll need to make sure the `.node` file is directly required or it won't bundle correctly.

### Embed directories

To embed a directory with `bun build --compile`, use a shell glob in your `bun build` command:

```sh
$ bun build --compile ./index.ts ./public/**/*.png
```

Then, you can reference the files in your code:

```ts
import icon from "./public/assets/icon.png" with { type: "file" };
import { file } from "bun";

export default {
  fetch(req) {
    // Embedded files can be streamed from Response objects
    return new Response(file(icon));
  },
};
```

This is honestly a workaround, and we expect to improve this in the future with a more direct API.

### Listing embedded files

To get a list of all embedded files, use `Bun.embeddedFiles`:

```js
import "./icon.png" with { type: "file" };
import { embeddedFiles } from "bun";

console.log(embeddedFiles[0].name); // `icon-${hash}.png`
```

`Bun.embeddedFiles` returns an array of `Blob` objects which you can use to get the size, contents, and other properties of the files.

```ts
embeddedFiles: Blob[]
```

The list of embedded files excludes bundled source code like `.ts` and `.js` files.

#### Content hash

By default, embedded files have a content hash appended to their name. This is useful for situations where you want to serve the file from a URL or CDN and have fewer cache invalidation issues. But sometimes, this is unexpected and you might want the original name instead:

To disable the content hash, pass `--asset-naming` to `bun build --compile` like this:

```sh
$ bun build --compile --asset-naming="[name].[ext]" ./index.ts
```

## Minification

To trim down the size of the executable a little, pass `--minify` to `bun build --compile`. This uses Bun's minifier to reduce the code size. Overall though, Bun's binary is still way too big and we need to make it smaller.

## Using Bun.build() API

You can also generate standalone executables using the `Bun.build()` JavaScript API. This is useful when you need programmatic control over the build process.

### Basic usage

```js
await Bun.build({
  entrypoints: ["./app.ts"],
  outdir: "./dist",
  compile: {
    target: "bun-windows-x64",
    outfile: "myapp.exe",
  },
});
```

### Windows metadata with Bun.build()

When targeting Windows, you can specify metadata through the `windows` object:

```js
await Bun.build({
  entrypoints: ["./app.ts"],
  outdir: "./dist",
  compile: {
    target: "bun-windows-x64",
    outfile: "myapp.exe",
    windows: {
      title: "My Application",
      publisher: "My Company Inc",
      version: "1.2.3.4",
      description: "A powerful application built with Bun",
      copyright: "© 2024 My Company Inc",
      hideConsole: false, // Set to true for GUI applications
      icon: "./icon.ico", // Path to icon file
    },
  },
});
```

### Cross-compilation with Bun.build()

You can cross-compile for different platforms:

```js
// Build for multiple platforms
const platforms = [
  { target: "bun-windows-x64", outfile: "app-windows.exe" },
  { target: "bun-linux-x64", outfile: "app-linux" },
  { target: "bun-darwin-arm64", outfile: "app-macos" },
];

for (const platform of platforms) {
  await Bun.build({
    entrypoints: ["./app.ts"],
    outdir: "./dist",
    compile: platform,
  });
}
```

## Windows-specific flags

When compiling a standalone executable for Windows, there are several platform-specific options that can be used to customize the generated `.exe` file:

### Visual customization

- `--windows-icon=path/to/icon.ico` - Set the executable file icon
- `--windows-hide-console` - Disable the background terminal window (useful for GUI applications)

### Metadata customization

You can embed version information and other metadata into your Windows executable:

- `--windows-title <STR>` - Set the product name (appears in file properties)
- `--windows-publisher <STR>` - Set the company name
- `--windows-version <STR>` - Set the version number (e.g. "1.2.3.4")
- `--windows-description <STR>` - Set the file description
- `--windows-copyright <STR>` - Set the copyright information

#### Example with all metadata flags:

```sh
bun build --compile ./app.ts \
  --outfile myapp.exe \
  --windows-title "My Application" \
  --windows-publisher "My Company Inc" \
  --windows-version "1.2.3.4" \
  --windows-description "A powerful application built with Bun" \
  --windows-copyright "© 2024 My Company Inc"
```

This metadata will be visible in Windows Explorer when viewing the file properties:

1. Right-click the executable in Windows Explorer
2. Select "Properties"
3. Go to the "Details" tab

#### Version string format

The `--windows-version` flag accepts version strings in the following formats:

- `"1"` - Will be normalized to "1.0.0.0"
- `"1.2"` - Will be normalized to "1.2.0.0"
- `"1.2.3"` - Will be normalized to "1.2.3.0"
- `"1.2.3.4"` - Full version format

Each version component must be a number between 0 and 65535.

{% callout %}

These flags currently cannot be used when cross-compiling because they depend on Windows APIs. They are only available when building on Windows itself.

{% /callout %}

## Code signing on macOS

To codesign a standalone executable on macOS (which fixes Gatekeeper warnings), use the `codesign` command.

```sh
$ codesign --deep --force -vvvv --sign "XXXXXXXXXX" ./myapp
```

We recommend including an `entitlements.plist` file with JIT permissions.

```xml#entitlements.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
```

To codesign with JIT support, pass the `--entitlements` flag to `codesign`.

```sh
$ codesign --deep --force -vvvv --sign "XXXXXXXXXX" --entitlements entitlements.plist ./myapp
```

After codesigning, verify the executable:

```sh
$ codesign -vvv --verify ./myapp
./myapp: valid on disk
./myapp: satisfies its Designated Requirement
```

{% callout %}

Codesign support requires Bun v1.2.4 or newer.

{% /callout %}

## Unsupported CLI arguments

Currently, the `--compile` flag can only accept a single entrypoint at a time and does not support the following flags:

- `--outdir` — use `outfile` instead.
- `--splitting`
- `--public-path`
- `--target=node` or `--target=browser`
- `--no-bundle` - we always bundle everything into the executable.
