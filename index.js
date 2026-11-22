import { resolve } from "node:path";
import { createUnplugin } from "unplugin";
import { gwtar as writeArchive } from "./src/archive.js";

/**
 * @typedef {object} GwtarOptions
 * @property {string} [html] HTML entry relative to the output directory. Defaults to index.html.
 * @property {string} [base] Public base pathname such as /docs/ or ./, inferred for Vite, Bun and webpack.
 */

/**
 * @typedef {GwtarOptions & { outDir: string }} WriteGwtarOptions
 * Options for archiving a built HTML entry. The outDir contains its HTML and assets.
 */

/** Write a sibling .gwtar.html and resolve to its absolute path. */
export const gwtar = /** @type {(options: WriteGwtarOptions) => Promise<string>} */ (writeArchive);

/** @type {import("unplugin").UnpluginInstance<GwtarOptions | undefined, false>} */
const adapters = createUnplugin((options = {}, { framework }) => {
  /**
   * @param {string} outDir
   * @param {string} [base]
   */
  function pack(outDir, base) {
    return gwtar({ ...options, outDir, base: options.base ?? base });
  }

  /** @type {import("unplugin").UnpluginOptions} */
  const plugin = { name: "unplugin-gwtar" };
  if (framework === "vite") {
    /** @type {import("vite").ResolvedConfig} */
    let config;
    plugin.vite = {
      apply: "build",
      configResolved(resolved) {
        config = resolved;
      },
      writeBundle: {
        order: "post",
        sequential: true,
        async handler(output) {
          if (this.environment?.config.build.ssr || config.build.ssr) return;
          await pack(output.dir ?? resolve(config.root, config.build.outDir), config.base);
        },
      },
    };
  } else if (framework === "webpack") {
    plugin.webpack = (compiler) => {
      compiler.hooks.afterEmit.tapPromise(plugin.name, async (compilation) => {
        if (!compilation.errors.length) {
          const { path, publicPath } = compilation.outputOptions;
          if (!path) throw new Error("unplugin-gwtar requires webpack to set output.path.");
          if (typeof publicPath === "function" && options.base === undefined) {
            throw new Error("Set the gwtar base option when webpack output.publicPath is a function.");
          }
          await pack(path, typeof publicPath === "string" && publicPath !== "auto" ? publicPath : undefined);
        }
      });
    };
  } else if (framework === "bun") {
    plugin.bun = {
      setup(build) {
        const { outdir, publicPath } = build.config;
        if (!outdir) throw new Error("unplugin-gwtar requires Bun.build() to set outdir.");
        const directory = resolve(outdir);
        build.onEnd(/** @param {{ success: boolean }} result */ async (result) => {
          if (result.success) await pack(directory, publicPath);
        });
      },
    };
  }

  return plugin;
});

export const unplugin = { vite: adapters.vite, bun: adapters.bun, webpack: adapters.webpack };
export default unplugin;
