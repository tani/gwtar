// Serialized into the archive header. Keep all browser dependencies inside.
export async function openArchive(assets, overhead, plans) {
  const address = new URL(location.href);
  address.hash = "";
  const offsets = new Map();
  let offset = overhead;
  for (const [name, asset] of Object.entries(assets)) {
    offsets.set(name, offset + 512);
    offset += 512 + Math.ceil(asset.size / 512) * 512;
  }

  let fullResponse;
  async function read(name) {
    const { size } = assets[name];
    if (size === 0) return new ArrayBuffer(0);
    const start = offsets.get(name);
    const end = start + size - 1;
    if (!fullResponse) {
      const response = await fetch(address, {
        headers: { Range: `bytes=${start}-${end}` },
        cache: "no-store",
      });
      if (response.status === 206) {
        const range = response.headers.get("content-range");
        if (!range?.startsWith(`bytes ${start}-${end}/`)) {
          throw new Error(`Incorrect Range response for ${name}`);
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== size) throw new Error(`Incomplete asset: ${name}`);
        return bytes;
      }
      if (response.status !== 200) throw new Error(`HTTP ${response.status} reading ${name}`);
      fullResponse = response.arrayBuffer();
    }
    const bytes = await fullResponse;
    if (bytes.byteLength <= end) throw new Error(`Incomplete asset: ${name}`);
    return bytes.slice(start, end + 1);
  }

  const urls = new Map();
  const decoder = new TextDecoder();
  async function substitute(text, names) {
    if (!names.length) return text;
    const pairs = await Promise.all(names.map(async (name) => [name, await objectURL(name)]));
    const replacements = new Map(pairs);
    return text.replace(/\.\/(gwtar-asset-\d+\.[a-z\d]+)/g, (match, name) =>
      replacements.get(name) ?? match);
  }

  function objectURL(name) {
    if (!urls.has(name)) {
      urls.set(name, (async () => {
        let data = await read(name);
        if (plans.css[name]) data = await substitute(decoder.decode(data), plans.css[name]);
        return URL.createObjectURL(new Blob([data], { type: assets[name]["content-type"] }));
      })());
    }
    return urls.get(name);
  }

  try {
    if (location.protocol === "file:") throw new Error("Serve this archive over HTTP or HTTPS.");
    const html = decoder.decode(await read("0"));
    const patches = await Promise.all(plans.html.map(async ([start, end, names, attribute], index) => {
      const original = html.slice(start, end);
      if (attribute) return `data-gwtar-load-${attribute}="${index}"`;
      return substitute(original, names);
    }));

    let page = "";
    let cursor = 0;
    for (const [index, [start, end]] of plans.html.entries()) {
      page += html.slice(cursor, start) + patches[index];
      cursor = end;
    }
    page += html.slice(cursor);
    // A stopped HTML parser ignores document.open() and document.write().
    const parsed = new DOMParser().parseFromString(page, "text/html");
    document.documentElement.replaceWith(document.importNode(parsed.documentElement, true));

    function activateScript(original) {
      const script = document.createElement("script");
      for (const attribute of original.attributes) {
        script.setAttribute(attribute.name, attribute.value);
      }
      script.async = original.hasAttribute("async");
      script.textContent = original.textContent;
      const module = script.type.toLowerCase() === "module";
      const loaded = script.src || module
        ? new Promise((resolve) => {
          script.addEventListener("load", resolve, { once: true });
          script.addEventListener("error", resolve, { once: true });
        })
        : undefined;
      original.replaceWith(script);
      return loaded;
    }

    const deferred = [];
    for (const script of document.querySelectorAll("script")) {
      const type = script.type.toLowerCase();
      const module = type === "module";
      if (type && !module && type !== "importmap" &&
          !/^(?:application|text)\/(?:x-)?(?:java|ecma)script$/.test(type)) continue;
      if (script.noModule && !module) continue;
      if (script.hasAttribute("async")) activateScript(script);
      else if (module || (script.src && script.defer)) deferred.push(script);
      else await activateScript(script);
    }
    for (const script of deferred) await activateScript(script);
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));

    const placeholders = ["data-gwtar-load-srcset", "data-gwtar-load-src"];
    const selector = placeholders.map((attribute) => `[${attribute}]`).join(",");
    async function activate(element) {
      const nodes = Array.from(element.querySelectorAll(selector));
      if (element.matches(selector)) nodes.push(element);
      const pending = [];
      for (const node of nodes) {
        for (const placeholder of placeholders) {
          const index = node.getAttribute(placeholder);
          if (index === null) continue;
          const [, , names, attribute, value] = plans.html[Number(index)];
          pending.push({ node, placeholder, attribute, value: substitute(value, names) });
        }
      }
      const values = await Promise.all(pending.map(({ value }) => value));
      for (const [index, { node, placeholder, attribute }] of pending.entries()) {
        node.setAttribute(attribute, values[index]);
        node.removeAttribute(placeholder);
      }
    }

    const lazyImages = new Set();
    for (const element of document.querySelectorAll(selector)) {
      const picture = element.closest("picture");
      lazyImages.add(picture?.querySelector("img") ?? element);
    }
    if (!lazyImages.size) return;
    const load = (image) => activate(image.closest("picture") ?? image).catch(console.error);
    if (!("IntersectionObserver" in window)) {
      for (const image of lazyImages) load(image);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        load(entry.target);
      }
    }, { rootMargin: "256px" });
    for (const image of lazyImages) observer.observe(image);
  } catch (error) {
    const message = document.createElement("p");
    message.textContent = `Could not open Gwtar: ${error.message}`;
    document.body.append(message);
    console.error(error);
  }
}
