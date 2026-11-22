import { resolve } from "node:path";
import { createUnplugin } from "unplugin";
import { gwtar } from "./src/archive.js";

export { gwtar };

const adapters = createUnplugin((options = {}, { framework }) => {
  function pack(outDir, base) {
    return gwtar({ ...options, outDir, base: options.base ?? base });
  }

  const plugin = { name: "unplugin-gwtar" };
  if (framework === "vite") {
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
          await pack(compilation.outputOptions.path, compilation.outputOptions.publicPath === "auto"
            ? undefined : compilation.outputOptions.publicPath);
        }
      });
    };
  } else if (framework === "bun") {
    plugin.bun = {
      setup(build) {
        const { outdir, publicPath } = build.config;
        if (!outdir) throw new Error("unplugin-gwtar requires Bun.build() to set outdir.");
        const directory = resolve(outdir);
        build.onEnd(async (result) => {
          if (result.success) await pack(directory, publicPath);
        });
      },
    };
  }

  return plugin;
});

export const unplugin = { vite: adapters.vite, bun: adapters.bun, webpack: adapters.webpack };
export default unplugin;
