#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { gwtar } from "../src/archive.js";

const usage = `Usage: gwtar [out-dir] [--html path] [--base pathname]

Write a Gwtar archive beside the built HTML entry and print its absolute path.

  out-dir       Directory containing the built files (default: current directory)
  --html PATH   HTML entry relative to out-dir (default: index.html)
  --base PATH   Public base pathname (default: /)
  -h, --help    Show usage
  -v, --version Show the package version`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      html: { type: "string" },
      base: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (positionals.length > 1) throw new Error("Expected at most one out-dir argument.");
  if (values.help) {
    console.log(usage);
  } else if (values.version) {
    const manifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    console.log(JSON.parse(manifest).version);
  } else {
    console.log(await gwtar({
      outDir: positionals[0] ?? ".",
      html: values.html,
      base: values.base,
    }));
  }
} catch (error) {
  console.error(`gwtar: ${error.message}`);
  process.exitCode = 1;
}
