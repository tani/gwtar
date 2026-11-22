import { parsers } from "prettier/plugins/postcss";

const whitespace = /[\t\n\f\r ]/.source;
const escape = /\\(?:[a-fA-F0-9]{1,6}(?:\r\n|[\t\n\f\r ])?|[^\n\f\r])/.source;
const string = /"(?:\\(?:\r\n|[\s\S])|[^"\\\n\f\r])*"|'(?:\\(?:\r\n|[\s\S])|[^'\\\n\f\r])*'/.source;
const comment = /\/\*[\s\S]*?\*\//.source;
const identifier = `(?:${escape}|${/[-\w\u0080-\uFFFF]/.source})+`;
const unquoted = `(?:${escape}|${/[^\u0000-\u0020\u007F"'()\\]/.source})*`;

function decodeEscapes(value) {
  return value.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\f\r])|(.))/gi,
    (_, hex, newline, literal) => {
      if (newline) return "";
      if (!hex) return literal;
      const code = Number.parseInt(hex, 16);
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(code);
    });
}

function* valueUrls(code, offset, firstOnly) {
  const tokens = new RegExp(`${comment}|${string}|${identifier}|${whitespace}+|.`, "gs");
  const argument = new RegExp(`\\(${whitespace}*(${string}|${unquoted})${whitespace}*\\)`, "y");
  let token;
  while ((token = tokens.exec(code)) !== null) {
    if (token[0].startsWith("/*") || /^[\t\n\f\r ]/.test(token[0])) continue;
    if (firstOnly && /^["']/.test(token[0])) {
      yield {
        start: offset + token.index, end: offset + tokens.lastIndex,
        value: decodeEscapes(token[0].slice(1, -1)), form: "string",
      };
    } else if (decodeEscapes(token[0]).toLowerCase() === "url") {
      argument.lastIndex = token.index + token[0].length;
      const match = argument.exec(code);
      if (match) {
        const raw = /^["']/.test(match[1]) ? match[1].slice(1, -1) : match[1];
        yield {
          start: offset + token.index, end: offset + argument.lastIndex,
          value: decodeEscapes(raw), form: "url",
        };
        tokens.lastIndex = argument.lastIndex;
      }
    }
    if (firstOnly) return;
  }
}

// Use the stylesheet AST to locate declarations and imports. Read URL spans
// from the original spelling so CSS escapes and unquoted data URLs survive.
export async function cssUrls(code, declarationsOnly) {
  const tree = await parsers.css.parse(code, { parser: "css", originalText: code });
  const references = [];
  function walk(node) {
    const isImport = node.type === "css-atrule" && node.name.toLowerCase() === "import";
    const value = isImport ? node.params : node.type === "css-decl" ? node.value : undefined;
    if (value?.type === "value-root") {
      const { startOffset, endOffset } = value.source;
      for (const span of valueUrls(code.slice(startOffset, endOffset), startOffset, isImport)) {
        references.push({ ...span, kind: isImport ? "css" : undefined });
      }
    } else if (value?.nodes) {
      walk(value);
    }
    for (const child of node.nodes ?? []) walk(child);
  }
  for (const node of tree.nodes) {
    if (node.type !== "css-decl" || declarationsOnly) walk(node);
  }
  return references;
}
