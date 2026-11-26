import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import test from "node:test";
import gwtar from "@nodefu/gwtar/bun";

test("Bun packages emitted HTML and serves the archive with byte ranges", {
  skip: typeof Bun === "undefined",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "gwtar-bun-"));
  try {
    const html = join(root, "page.html");
    await writeFile(html, '<!doctype html><h1>Bun</h1><script type="module" src="./app.js"></script>');
    await writeFile(join(root, "app.js"), 'import "./page.css"; document.body.dataset.executed = "yes";');
    await writeFile(join(root, "page.css"), 'h1 { color: blue }');
    const outdir = join(root, "dist");
    const config = {
      entrypoints: [html],
      outdir,
      publicPath: "/docs/",
      splitting: false,
      plugins: [gwtar({ html: "page.html" })],
    };
    const result = await Bun.build(config);
    assert.ok(result.success);
    assert.match(await readFile(join(outdir, "page.html"), "utf8"), /\/docs\//);
    const archive = join(outdir, "page.gwtar.html");
    const bytes = await readFile(archive);
    const marker = Buffer.from("<!-- GWTAR END\n");
    const markerOffset = bytes.indexOf(marker);
    assert.notEqual(markerOffset, -1);
    const offset = markerOffset + marker.length;
    assert.equal(bytes.toString("ascii", offset + 257, offset + 262), "ustar");

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/docs/page.gwtar.html") {
          return new Response(Bun.file(archive));
        }
        return new Response(null, { status: 404 });
      },
    });
    try {
      const url = new URL("/docs/page.gwtar.html", server.url);
      const end = offset + 511;
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), `bytes ${offset}-${end}/${bytes.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(offset, end + 1));

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url.href, { waitUntil: "commit" });
        await page.locator('body[data-executed="yes"]').waitFor({ timeout: 6000 });
        const color = await page.locator("h1").evaluate((node) => getComputedStyle(node).color);
        assert.equal(color, "rgb(0, 0, 255)");
      } finally {
        await browser.close();
      }
    } finally {
      server.stop(true);
    }

    const failed = await Bun.build({ ...config, entrypoints: [join(root, "missing.html")], throw: false });
    assert.equal(failed.success, false);
    assert.deepEqual(await readFile(archive), bytes);
    await assert.rejects(async () => Bun.build({ ...config, outdir: undefined }), /set outdir/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
