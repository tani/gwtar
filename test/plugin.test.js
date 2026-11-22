import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { build as vite } from "vite";
import webpack from "webpack";
import { unplugin, gwtar } from "unplugin-gwtar";
import webpackGwtar from "unplugin-gwtar/webpack";

const marker = Buffer.from("<!-- GWTAR END\n");
const cli = fileURLToPath(new URL("../bin/gwtar.js", import.meta.url));

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "unplugin-gwtar-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("CLI shares the archive writer, defaults and error reporting", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "index.html"), "<!doctype html><p>Archive</p>");
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const output = join(root, "index.gwtar.html");
  assert.equal(result.stdout.trim(), output);
  const bytes = await readFile(output);
  assert.equal(await gwtar({ outDir: root }), output);
  assert.deepEqual(await readFile(output), bytes);

  await mkdir(join(root, "site", "guide"), { recursive: true });
  await writeFile(join(root, "site", "asset.svg"), "<svg/>");
  await writeFile(join(root, "site", "guide", "page.html"), '<!doctype html><img src="/docs/asset.svg">');
  const custom = run("site", "--html", "guide/page.html", "--base", "/docs/");
  assert.equal(custom.status, 0, custom.stderr);
  const customOutput = join(root, "site", "guide", "page.gwtar.html");
  assert.equal(custom.stdout.trim(), customOutput);
  assert.equal(inspect(await readFile(customOutput)).get("gwtar-asset-1.svg").data.toString(), "<svg/>");
  assert.match(run("--help").stdout, /^Usage: gwtar/);
  assert.match(run("--version").stdout, /^\d+\.\d+\.\d+\s*$/);
  const error = run("--html", "missing.html");
  assert.equal(error.status, 1);
  assert.match(error.stderr, /^gwtar: .*missing\.html/);
});

function inspect(bytes) {
  const overhead = bytes.indexOf(marker) + marker.length;
  const header = bytes.subarray(0, overhead).toString();
  assert.match(header, /Gwtar self-extracting HTML archive, v1/);
  assert.equal(Number(header.match(/let overhead = parseInt\("(\d+)"/)[1]), overhead);
  assert.equal(Number(header.match(/let totalArchiveSize = parseInt\("(\d+)"/)[1]), bytes.length);
  const manifest = JSON.parse(header.match(/^let assets = (.+);$/m)[1]);
  let position = overhead;
  const members = new Map();
  for (const asset of Object.values(manifest)) {
    const name = bytes.subarray(position, position + 100).toString().split("\0")[0];
    const start = position + 512;
    const end = start + asset.size - 1;
    const data = bytes.subarray(start, end + 1);
    assert.equal(createHash("sha256").update(data).digest("hex"), asset.hash);
    assert.equal(bytes.subarray(position + 257, position + 263).toString(), "ustar\0");
    members.set(name, { start, end, data });
    position += 512 + Math.ceil(asset.size / 512) * 512;
  }
  const tar = spawnSync("tar", ["-tf", "-"], { input: bytes.subarray(overhead), encoding: "utf8" });
  if (!tar.error) {
    assert.equal(tar.status, 0, tar.stderr);
    assert.deepEqual(tar.stdout.trim().split("\n"), [...members.keys()]);
  }
  return members;
}

function compilerBuild(factory, configuration) {
  const compiler = factory(configuration);
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error ?? closeError) reject(error ?? closeError);
        else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
        else resolve();
      });
    });
  });
}

test("exposes adapters for Vite, Bun and webpack", () => {
  assert.deepEqual(Object.keys(unplugin).sort(), ["bun", "vite", "webpack"]);
});

test("webpack packages JS and CSS emitted from a native HTML entry", async (t) => {
  const root = await project(t);
  const dir = join(root, "dist");
  await writeFile(join(root, "index.html"), `<!doctype html>
<link rel="stylesheet" href="./site.css">
<h1>webpack</h1>
<script type="module" src="./app.js"></script>`);
  await writeFile(join(root, "app.js"), "document.body.dataset.executed = 'webpack';");
  await writeFile(join(root, "site.css"), "h1 { color: blue; }");

  await compilerBuild(webpack, {
    context: root,
    mode: "production",
    entry: { index: "./index.html" },
    experiments: { html: true, css: true },
    output: {
      path: dir,
      publicPath: "/docs/",
      filename: "[name].[contenthash:8].js",
      cssFilename: "[name].[contenthash:8].css",
      htmlFilename: "[name].html",
    },
    plugins: [webpackGwtar()],
  });

  const html = await readFile(join(dir, "index.html"), "utf8");
  assert.match(html, /site\.[a-f0-9]{8}\.css/);
  assert.match(html, /app\.[a-f0-9]{8}\.js/);
  const members = inspect(await readFile(join(dir, "index.gwtar.html")));
  const archivedPage = members.get("index.html").data.toString();
  assert.doesNotMatch(archivedPage, /\/docs\//);
  assert.match(archivedPage, /href="\.\/gwtar-asset-\d+\.css"/);
  assert.match(archivedPage, /src="\.\/gwtar-asset-\d+\.js"/);
  assert.ok([...members].some(([name, { data }]) => name.endsWith(".js") && /executed/.test(data)));
  assert.ok([...members].some(([name, { data }]) => name.endsWith(".css") && /color:blue/.test(data)));
});

test("Vite packages emitted HTML, JS, linked CSS and nested assets", async (t) => {
  const root = await project(t);
  await mkdir(join(root, "public"));
  await writeFile(join(root, "index.html"), `<!doctype html><meta charset="utf-8">
<h1>日本語</h1>
<div id="styled">CSS</div>
<script type="module" src="/app.js"></script>
<div style="height:3000px"></div>
<picture><source srcset="/lazy.svg"><img loading="lazy" width="32" height="32" src="/lazy.svg" srcset="/lazy.svg 1x"></picture>`);
  await writeFile(join(root, "app.js"), `import "./site.css"; document.body.dataset.executed = "yes";`);
  await writeFile(join(root, "site.css"), `#styled{height:10px;background-image:url("/background.svg")}`);
  for (const name of ["lazy.svg", "background.svg"]) {
    await writeFile(join(root, "public", name), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>');
  }
  await vite({
    root, configFile: false, logLevel: "silent", base: "/docs/",
    plugins: [(await import("unplugin-gwtar/vite")).default()],
    build: { rolldownOptions: { output: { codeSplitting: false } } },
  });
  const bytes = await readFile(join(root, "dist/index.gwtar.html"));
  const members = inspect(bytes);
  assert.match(members.get("index.html").data.toString(), /日本語/);
  assert.doesNotMatch(members.get("index.html").data.toString(), /\/docs\//);
  assert.equal(members.size, 5);
  const lazySource = members.get("index.html").data.toString().match(/<img[^>]+src="\.\/([^"]+)"/)[1];
  const { start: lazyStart, end: lazyEnd } = members.get(lazySource);
  const chromiumPath = process.env.CHROMIUM_PATH;
  if (!chromiumPath) {
    t.diagnostic("Set CHROMIUM_PATH to also verify browser rendering and byte-range behavior.");
    return;
  }

  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/docs/index.gwtar.html") {
      response.writeHead(404).end();
      return;
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!range || url.searchParams.has("full")) {
      response.writeHead(200, { "content-type": "text/html", "content-length": bytes.length }).end(bytes);
      return;
    }
    const start = Number(range[1]);
    const end = Number(range[2]);
    requests.push([start, end]);
    response.writeHead(206, {
      "content-type": "text/html",
      "content-range": `bytes ${start}-${end}/${bytes.length}`,
      "content-length": end - start + 1,
    }).end(bytes.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const archive = `http://127.0.0.1:${server.address().port}/docs/index.gwtar.html`;
  await page.goto(archive, { waitUntil: "commit" });
  await page.waitForSelector('body[data-executed="yes"]');
  assert.equal(await page.locator("h1").textContent(), "日本語");
  assert.equal(await page.evaluate(() => document.compatMode), "CSS1Compat");
  assert.match(await page.locator("#styled").evaluate((node) => getComputedStyle(node).backgroundImage), /blob:/);
  assert.ok(requests.length >= 4);
  assert.ok(!requests.some(([start]) => start === lazyStart));
  await page.locator("img").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("img").naturalWidth === 32);
  assert.ok(requests.some(([start, end]) => start === lazyStart && end === lazyEnd));
  await page.goto(archive + "?full", { waitUntil: "commit" });
  await page.waitForSelector('body[data-executed="yes"]');
});

test("standalone writer reports unbundled imports and preserves a previous archive on failure", async (t) => {
  const root = await project(t);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/page.html"), '<!doctype html><img src="data:image/svg+xml,%3Csvg%2F%3E">');
  const options = { outDir: root, html: "nested/page.html" };
  const destination = await gwtar(options);
  assert.equal(destination, join(root, "nested/page.gwtar.html"));
  const previous = await readFile(destination);
  assert.equal(inspect(previous).get("gwtar-asset-1.svg").data.toString(), "<svg/>");
  await writeFile(join(root, "nested/page.html"), '<script type="module">import "./chunk.js";</script>');
  await assert.rejects(gwtar(options), /Bundle module imports/);
  assert.deepEqual(await readFile(destination), previous);
});

test("rewrites CSS URL tokens and srcset URLs without changing surrounding syntax", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "index.html"), `<!doctype html>
<link rel="stylesheet" href="main.css">
<div style="--hero:url('hero.svg');color:blue"></div>
<img srcset="data:image/svg+xml,%3Csvg%2F%3E 1x,
  a,b.svg 2x">
<img srcset="x, hero.svg 2x">`);
  const css = String.raw`/* url(missing.svg) */
@import /* keep */ './theme.css' layer(theme);
@supports (background: url(missing.svg)) {
  h1:hover { background: image-set(url("hero\20 wide.svg") 1x); }
}
aside { --group: { background: URL(hero.svg); }; }`;
  await writeFile(join(root, "main.css"), css);
  await writeFile(join(root, "theme.css"), '@font-face { src: url(theme.woff2) format("woff2"); }');
  for (const name of ["hero.svg", "hero wide.svg", "a,b.svg", "x", "theme.woff2"]) {
    await writeFile(join(root, name), name);
  }

  const file = await gwtar({ outDir: root });
  const members = inspect(await readFile(file));
  const archivedName = (data) => [...members].find(([, member]) => member.data.toString() === data)[0];
  const html = members.get("index.html").data.toString();
  assert.ok(html.includes("./" + archivedName("<svg/>") + " 1x,\n  ./" + archivedName("a,b.svg") + " 2x"));
  assert.ok(html.includes("./" + archivedName("x") + ", ./" + archivedName("hero.svg") + " 2x"));
  assert.ok(html.includes("style=\"--hero:url(&quot;./" + archivedName("hero.svg") + "&quot;);color:blue\""));

  const main = [...members.values()].find(({ data }) => data.toString().startsWith("/* url(missing.svg) */"));
  const theme = [...members].find(([, { data }]) => data.toString().startsWith("@font-face"));
  assert.ok(main.data.toString().includes('@import /* keep */ "./' + theme[0] + '" layer(theme)'));
  assert.ok(main.data.toString().includes("@supports (background: url(missing.svg))"));
  assert.ok(main.data.toString().includes('image-set(url("./' + archivedName("hero wide.svg") + '") 1x)'));
  assert.ok(main.data.toString().includes('--group: { background: url("./' + archivedName("hero.svg") + '"); };'));
  assert.ok(theme[1].data.toString().includes('url("./' + archivedName("theme.woff2") + '") format("woff2")'));
});

test("decodes HTML references and checks JavaScript imports with Prettier", async (t) => {
  const root = await project(t);
  const index = join(root, "index.html");
  await writeFile(index, [
    '<!doctype html><p>日本😀</p>',
    '<img SRC="a&amp;b.svg" src="wrong.svg"><img src=a&#38;b.svg>',
    '<div style="background:url(&quot;a&amp;b.svg&quot;)"></div>',
    '<template><img src="wrong.svg"></template>',
    '<script type="module">export {x} from "https://example.com/app.js";',
    'const status = import.meta.url;',
    'if (status) import(`https://example.com/extra.js`);</script>',
  ].join("\r\n"));
  await writeFile(join(root, "a&b.svg"), "<svg/>");
  const file = await gwtar({ outDir: root });
  const members = inspect(await readFile(file));
  assert.equal(members.size, 2);
  const html = members.get("index.html").data.toString();
  assert.ok(html.includes("<p>日本😀</p>\r\n"));
  assert.ok(html.includes('<img src="./gwtar-asset-1.svg" src="wrong.svg">'));
  assert.ok(html.includes('<img src="./gwtar-asset-1.svg">'));
  assert.ok(html.includes('url(&quot;./gwtar-asset-1.svg&quot;)'));
  assert.ok(html.includes('import(`https://example.com/extra.js`)'));

  for (const code of ['export * from "./local.js";', 'import("./local.js");', 'if (ok) import(path);']) {
    await writeFile(index, '<script type="module">' + code + '</script>');
    await assert.rejects(gwtar({ outDir: root }), /Bundle module imports/);
  }
});
