import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function padded(size) {
  return Math.ceil(size / 512) * 512;
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, hash: hash.digest("hex") };
}

function header(name, size) {
  const block = Buffer.alloc(512);
  const octal = (value, offset, length) => {
    const digits = value.toString(8);
    if (digits.length >= length) throw new Error(`Value exceeds ustar field: ${value}`);
    block.write(digits.padStart(length - 1, "0"), offset, length - 1, "ascii");
  };

  if (Buffer.byteLength(name) > 100) throw new Error(`Name exceeds ustar field: ${name}`);
  block.write(name, 0, 100, "utf8");
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  block.fill(0x20, 148, 156);
  block.write("0", 156, "ascii");
  block.write("ustar\0" + "00", 257, "ascii");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return block;
}

export async function* tar(assets) {
  for (const asset of assets) {
    yield header(asset.name, asset.size);
    if (asset.data) {
      yield asset.data;
    } else {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(asset.path)) {
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
      if (size !== asset.size || hash.digest("hex") !== asset.hash) {
        throw new Error(`Build output changed while archiving: ${asset.path}`);
      }
    }
    yield Buffer.alloc(padded(asset.size) - asset.size);
  }
  yield Buffer.alloc(1024);
}
