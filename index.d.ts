import type { UnpluginInstance } from "unplugin";

export interface GwtarOptions {
  /** HTML entry relative to the build output directory. Defaults to index.html. */
  html?: string;
  /** Public base pathname such as /docs/ or ./, inferred for Vite, Bun and webpack. */
  base?: string;
}

export interface WriteGwtarOptions extends GwtarOptions {
  /** Directory containing the built HTML and its assets. */
  outDir: string;
}

/** Write a sibling .gwtar.html and resolve to its absolute path. */
export function gwtar(options: WriteGwtarOptions): Promise<string>;
export const unplugin: Pick<UnpluginInstance<GwtarOptions | undefined, false>, "vite" | "bun" | "webpack">;
export default unplugin;
