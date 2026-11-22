# unplugin-gwtar

Turn a built HTML entry and its local assets into a [Gwtar v1](https://gwern.net/gwtar) archive. Use an adapter with Vite, Bun or webpack when building from a native HTML entry. For other build pipelines, call `gwtar()` on the emitted files. The package uses unplugin 3.7.0 and runs on Node.js 20.19+ within the 20.x series, Node.js 22.12+, and subsequent Node.js releases.

## Install

Install the supplied npm tarball in your project.

```sh
npm install -D ./unplugin-gwtar-0.6.0.tgz
```

## Vite 8

```js
import { defineConfig } from "vite";
import gwtar from "unplugin-gwtar/vite";

export default defineConfig({
  plugins: [gwtar()],
  build: {
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
```

Run your production build and open `/index.gwtar.html` on your static server. For a local preview, run `npx vite preview`. For an application with multiple entries, archive a selected HTML entry with `gwtar({ html: "docs/index.html" })` and configure your build to produce self-contained scripts for that page.

## Bun

```js
import gwtar from "unplugin-gwtar/bun";

await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  target: "browser",
  splitting: false,
  plugins: [gwtar()],
});
```

Run the script with `bun run build.js`. After a successful build, the plugin writes `dist/index.gwtar.html` before the build promise resolves. Use an explicit `outdir` for disk output. The adapter defaults to Bun's `publicPath` when set. Pass `gwtar({ html: "docs/index.html" })` if your build emits the HTML entry at a different path inside `outdir`.

The Bun adapter is tested with Bun 1.4.5. Run `bun test test/bun.test.js` to check it from the source tree.

## webpack

```js
import gwtar from "unplugin-gwtar/webpack";

export default {
  entry: { index: "./src/index.html" },
  experiments: { html: true, css: true },
  plugins: [gwtar()],
};
```

The adapter is tested with webpack 5.113.0 and its native HTML entry support. The `index` entry name produces `dist/index.html` and `dist/index.gwtar.html` with webpack's default output directory.

## CLI and JavaScript API

For Rollup, Rolldown, esbuild, Rspack or any other build pipeline, write the HTML and its assets to disk and then run `gwtar`. This also works for prebuilt static sites.

```sh
npx gwtar dist
npx gwtar dist --html guide/index.html --base /docs/
```

The CLI defaults to the current directory and `index.html`. It prints the absolute archive path on success. The JavaScript API takes the same inputs. In v0.6.0, the named export `writeGwtar` was renamed to `gwtar`.

```js
import { gwtar } from "unplugin-gwtar";

const path = await gwtar({
  outDir: "dist",
  html: "guide/index.html",
  base: "/docs/",
});
```

The JavaScript entry points declare their types with JSDoc. TypeScript projects consuming the installed package can enable inference with `allowJs: true` and `maxNodeModuleJsDepth: 1` in `compilerOptions`.

| Option | Default | Meaning |
| --- | --- | --- |
| `html` | `index.html` | HTML entry relative to the output directory. The archive is written beside it. |
| `base` | Inferred for Vite, Bun and webpack when available. Otherwise `/`. | Public pathname such as `/docs/`. Use `./` for relative build URLs. |
| `outDir` | Required by `gwtar` | Directory containing the built HTML and assets. Adapters infer it. |

## Archive behavior

- The build reads HTML, CSS and JavaScript with Prettier's parser plugins. The archive preserves source text around rewritten references. Prettier can reject malformed markup or scripts that a browser would partially recover.
- The HTML loader stops the initial navigation and then reads the page and its assets from the same URL with byte ranges. Serve the archive as `text/html` over HTTP(S). For selective loading, serve byte ranges with `206 Partial Content` and avoid on-the-fly compression of the archive. The loader falls back to downloading the full archive on `200 OK`.
- The archive contains uncompressed ustar records with SHA-256 digests. The loader begins with an HTML doctype before the Gwtar magic comment to enable standards mode. It includes supported HTML media attributes, image source sets, stylesheets and their CSS `url()` and `@import` references, executable script references, and supported data URLs. Images marked `loading="lazy"` are fetched as they approach the viewport. Each referenced asset is fetched as a whole when needed. Linked stylesheets load with their dependencies.
- JavaScript should be bundled into self-contained scripts. Unbundled local imports are build errors. URLs assembled by JavaScript, workers, iframe documents, hyperlinks to other pages, and remote resources are outside the archive's asset discovery. When browser code uses relative URLs against `import.meta.url`, account for scripts loading from blob URLs. The emitted page requires a policy that allows the inline loader and applicable blob URLs. The loader reconstructs the DOM before activating scripts, so scripts that depend on parser-time execution, such as scripts using `document.write()`, can behave differently.
- Extract the tar for offline use. The extracted `index.html` refers to the extracted assets by relative path. ES modules may still require serving the extracted directory over HTTP, depending on the browser.

```sh
mkdir extracted
perl -ne 'print if $tar; $tar=1 if /^<!-- GWTAR END$/' index.gwtar.html | tar -xf - -C extracted
```

Run `npm ci && npm test` from the source tree. Set `CHROMIUM_PATH` to a Chromium executable to include browser checks for JavaScript, CSS, lazy assets, byte ranges, and the full-response fallback.
