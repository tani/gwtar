import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decodeHTMLAttribute } from "entities/decode";
import mime from "mime";
import { parsers as htmlParsers } from "prettier/plugins/html";
import { openArchive } from "./browser.js";
import { cssUrls } from "./css.js";
import { checkScript } from "./javascript.js";
import { srcsetUrls } from "./srcset.js";
import { hashFile, padded, tar } from "./tar.js";

const origin = "https://gwtar.invalid";
const dataScheme = /^data:/i;
const external = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;
const scriptTypes = /^(?:module|(?:application|text)\/(?:x-)?(?:java|ecma)script)$/i;
const lazyAttributes = new Set(["src", "srcset"]);
const sourceTags = new Set(["audio", "video", "img", "source", "track", "embed", "input"]);
const assetLinks = new Set(["stylesheet", "icon", "apple-touch-icon"]);
const discardedLink = new Set(["preload", "modulepreload", "prefetch"]);

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function readAttribute(value) {
  return decodeHTMLAttribute((value ?? "").replace(/\r\n?/g, "\n").replaceAll("\0", "\ufffd"));
}

function inside(root, path) {
  const remainder = relative(root, path);
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

function outputFile(root, name) {
  if (typeof name !== "string" || !name || isAbsolute(name)) {
    throw new Error(`Expected a path relative to the output directory: ${name}`);
  }
  const path = resolve(root, name);
  if (!inside(root, path) || path === root) throw new Error(`Path escapes output directory: ${name}`);
  return path;
}

function parseBase(base) {
  if (base === "" || base === "./") return "/";
  if (typeof base !== "string" || !base.startsWith("/") || base.startsWith("//") ||
      /[?#\\]/.test(base)) {
    throw new Error("base must be a pathname such as /docs/ or ./");
  }
  return new URL(`${base.replace(/\/$/, "")}/`, origin).pathname;
}

function materialize(edits, input) {
  let text = "";
  let cursor = 0;
  const patches = [];
  for (const edit of edits.sort((left, right) => left.start - right.start)) {
    text += input.slice(cursor, edit.start);
    const start = text.length;
    text += edit.text;
    cursor = edit.end;
    if (edit.names?.size) {
      const patch = [start, text.length, [...edit.names]];
      if (edit.lazy) patch.push(edit.attribute, edit.value);
      patches.push(patch);
    }
  }
  return { text: text + input.slice(cursor), patches };
}

function memoryAsset(asset, data) {
  return Object.assign(asset, {
    data,
    size: data.length,
    hash: createHash("sha256").update(data).digest("hex"),
  });
}

async function createPage(root, htmlName, base, pageName) {
  const entries = new Map();
  const assets = [];
  const css = Object.create(null);

  async function locate(reference, from) {
    reference = reference.trim();
    if (dataScheme.test(reference)) return { key: reference };
    if (!reference || external.test(reference) || reference.includes("\\")) return;
    const url = new URL(reference, origin + from);
    if (url.origin !== origin) return;
    const pathname = decodeURIComponent(
      url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname.slice(1),
    );
    const path = outputFile(root, pathname);
    const actual = await realpath(path).catch((error) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      throw new Error(`Missing local asset ${reference} (from ${from})`, { cause: error });
    });
    if (!inside(root, actual) || !(await stat(actual)).isFile()) {
      throw new Error(`Expected an asset file inside the output directory: ${reference}`);
    }
    return { key: url.pathname, url, path: actual };
  }

  async function rewriteReference(raw, from, names, kind, ancestors = []) {
    const found = await locate(raw, from);
    if (!found) return raw;
    const { key, path, url } = found;
    if (ancestors.includes(key)) throw new Error(`Circular CSS import in ${from}: ${raw}`);
    let asset = entries.get(key);
    if (!asset) {
      let data;
      let type;
      if (path) {
        type = mime.getType(path) || "application/octet-stream";
      } else {
        const response = await fetch(key);
        type = response.headers.get("content-type") || "application/octet-stream";
        data = Buffer.from(await response.arrayBuffer());
      }
      if (kind === "css") type = "text/css";
      if (kind === "script") type = "text/javascript";
      const suffix = (mime.getExtension(type) || "bin").replace(/[^a-z\d]/gi, "").toLowerCase() || "bin";
      const name = `gwtar-asset-${assets.length + 1}.${suffix}`;
      asset = { name, path, type };
      entries.set(key, asset);
      assets.push(asset);
      if (type.split(";")[0] === "text/css") {
        const code = data ?? await readFile(path);
        const dependencies = new Set();
        const output = await rewriteCss(code.toString("utf8"), url?.pathname ?? from, dependencies,
          [...ancestors, key]);
        css[name] = [...dependencies];
        memoryAsset(asset, Buffer.from(output));
      } else {
        if (kind === "script") {
          data ??= await readFile(path);
          await checkScript(data.toString("utf8"), raw);
        }
        if (data) memoryAsset(asset, data);
        else Object.assign(asset, await hashFile(path));
      }
    } else if (kind === "script" && asset.type !== "text/javascript") {
      const code = asset.data ?? await readFile(asset.path);
      await checkScript(code.toString("utf8"), raw);
      asset.type = "text/javascript";
    }
    names.add(asset.name);
    const fragment = url?.hash ?? "";
    return `./${asset.name}${fragment}`;
  }

  async function rewriteCss(code, from, names, ancestors = [], declarationsOnly = false) {
    const edits = [];
    for (const { start, end, value, form, kind } of await cssUrls(code, declarationsOnly)) {
      const next = await rewriteReference(value, from, names, kind, ancestors);
      if (next === value) continue;
      const quoted = `"${next.replace(/["\\]/g, "\\$&")}"`;
      edits.push({ start, end, text: form === "url" ? `url(${quoted})` : quoted });
    }
    return materialize(edits, code).text;
  }

  const entryPath = await realpath(outputFile(root, htmlName));
  if (!inside(root, entryPath)) throw new Error(`HTML entry escapes output directory: ${htmlName}`);
  const input = (await readFile(entryPath, "utf8")).replace(/^\uFEFF/, "");
  if (/^(?:<!doctype html>\s*)?<html>\s*<!-- Gwtar self-extracting HTML archive/i.test(input)) {
    throw new Error(`Expected a plain HTML entry: ${htmlName}`);
  }
  const parser = htmlParsers.html;
  const document = await parser.parse(input, { parser: "html", filepath: htmlName });
  const entryURL = base + relative(root, outputFile(root, htmlName)).split(sep).map(encodeURIComponent).join("/");
  const edits = [];

  async function walk(node, inLazyPicture = false) {
    const tag = node.kind === "element" ? node.name : undefined;
    const attrs = new Map();
    for (const attr of node.attrs ?? []) {
      if (attrs.has(attr.name)) continue;
      attrs.set(attr.name, {
        span: attr.sourceSpan,
        value: readAttribute(attr.value),
      });
    }
    const attrValue = (name) => attrs.get(name)?.value;
    const rel = (attrValue("rel") ?? "").toLowerCase().split(/\s+/);
    const lazyImage = tag === "img" && attrValue("loading")?.toLowerCase() === "lazy";
    if (tag === "base" && attrs.has("href")) throw new Error("Use the base option instead of <base href>.");
    if (tag === "link" && rel.some((value) => discardedLink.has(value)) &&
        attrValue("href") && !external.test(attrValue("href"))) {
      edits.push({ start: parser.locStart(node), end: parser.locEnd(node), text: "" });
      return;
    }

    if (tag) {
      if (tag === "script" && attrValue("type")?.toLowerCase() === "module" && !attrs.has("src")) {
        const start = node.startSourceSpan.end.offset;
        const end = node.endSourceSpan?.start.offset ?? input.length;
        await checkScript(input.slice(start, end), htmlName);
      }
      const references = new Map([["style", "style"]]);
      if (tag === "link" && rel.some((value) => assetLinks.has(value))) {
        references.set("href", rel.includes("stylesheet") ? "css" : "file");
      }
      if (tag === "script" && (!attrValue("type") || scriptTypes.test(attrValue("type")))) {
        references.set("src", "script");
      }
      if (sourceTags.has(tag)) references.set("src", "file");
      if (tag === "img" || tag === "source") references.set("srcset", "srcset");
      if (tag === "video") references.set("poster", "file");
      if (tag === "object") references.set("data", "file");
      for (const [attribute, kind] of references) {
        const attr = attrs.get(attribute);
        if (!attr) continue;
        const { span, value: original } = attr;
        const names = new Set();
        let value;
        if (kind === "style") {
          value = await rewriteCss(original, entryURL, names, [], true);
        } else if (kind === "srcset") {
          const replacements = [];
          for (const { start, end } of srcsetUrls(original)) {
            const text = await rewriteReference(original.slice(start, end), entryURL, names);
            replacements.push({ start, end, text });
          }
          value = materialize(replacements, original).text;
        } else {
          value = await rewriteReference(original, entryURL, names, kind);
        }
        if (!names.size) continue;
        if (attrs.has("integrity")) throw new Error(`Subresource integrity is unsupported on archived <${tag}>.`);
        edits.push({
          start: span.start.offset, end: span.end.offset,
          text: `${attribute}="${escapeAttribute(value)}"`, names,
          lazy: (lazyImage || inLazyPicture) && lazyAttributes.has(attribute),
          attribute, value,
        });
      }
      if (tag === "style") {
        const start = node.startSourceSpan.end.offset;
        const end = node.endSourceSpan?.start.offset ?? input.length;
        const names = new Set();
        const value = await rewriteCss(input.slice(start, end), entryURL, names);
        if (names.size) edits.push({ start, end, text: value, names });
      }
    }
    if (tag === "noscript" || tag === "template") return;
    const lazyPicture = tag === "picture" && node.children.some((child) =>
      child.name === "img" && readAttribute(
        child.attrs.find(({ name }) => name === "loading")?.value ?? "",
      ).toLowerCase() === "lazy");
    for (const child of node.children ?? []) await walk(child, lazyPicture);
  }

  await walk(document);
  const { text, patches } = materialize(edits, input);
  const page = memoryAsset({ name: pageName, type: "text/html" }, Buffer.from(text));
  return { page, assets, plans: { html: patches, css } };
}

function bootstrap({ page, assets, plans }) {
  const entries = [["0", page], ...assets.map((asset) => [asset.name, asset])];
  const manifest = Object.fromEntries(entries.map(([key, asset]) => [key, {
    size: asset.size,
    "content-type": asset.type,
    ...(key === "0" ? { basename: page.name.slice(0, -5) } : {}),
    hash: asset.hash,
  }]));
  const json = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const render = (overhead, total) => `<!doctype html>
<html>
<!-- Gwtar self-extracting HTML archive, v1 -->
<head><meta charset="utf-8"><title>Gwtar archive</title></head>
<body>
<noscript>This Gwtar archive requires JavaScript to open in a browser.</noscript>
<script>
let assets = ${json(manifest)};
let overhead = parseInt("${String(overhead).padStart(12, "0")}", 10);
let totalArchiveSize = parseInt("${String(total).padStart(24, "0")}", 10);
window.stop();
(${openArchive.toString()})(assets, overhead, ${json(plans)});
</script>
</body>
</html>
<!-- GWTAR END
`;
  const overhead = Buffer.byteLength(render(0, 0));
  const tarLength = entries.reduce((sum, [, entry]) => sum + 512 + padded(entry.size), 1024);
  return Buffer.from(render(overhead, overhead + tarLength));
}

/**
 * Package one built HTML page and return the absolute archive path.
 * @param {import("../index.js").WriteGwtarOptions} options
 * @returns {Promise<string>}
 */
export async function gwtar(options) {
  const { outDir, html = "index.html", base = "/" } = options;
  const root = await realpath(resolve(outDir));
  if (!/\.html$/i.test(html) || /\.gwtar\.html$/i.test(html)) {
    throw new Error("html must be a plain .html entry in the output directory.");
  }
  const entry = outputFile(root, html);
  const output = entry.slice(0, -5) + ".gwtar.html";
  const outputDir = await realpath(dirname(output));
  if (!inside(root, outputDir)) throw new Error(`Archive path escapes output directory: ${output}`);
  const page = await createPage(root, html, parseBase(base), "index.html");
  const temporaryDir = await mkdtemp(resolve(outputDir, ".gwtar-"));
  const temporary = resolve(temporaryDir, "archive");
  try {
    async function* stream() {
      yield bootstrap(page);
      yield* tar([page.page, ...page.assets]);
    }
    await pipeline(Readable.from(stream()), createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, output);
    return output;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}
