// Collect URL spans using the HTML srcset token boundaries. Descriptors and
// original spacing are preserved. Commas inside a URL (such as data:) remain.
export function* srcsetUrls(value) {
  const separators = /[\t\n\f\r ,]*/y;
  const url = /[^\t\n\f\r ]+/y;
  let position = 0;

  while (position < value.length) {
    separators.lastIndex = position;
    separators.exec(value);
    const start = separators.lastIndex;
    if (start === value.length) return;

    url.lastIndex = start;
    const token = url.exec(value)[0];
    const end = start + token.replace(/,+$/, "").length;
    yield { start, end };
    position = url.lastIndex;
    if (end !== position) continue;

    let inParens = false;
    while (position < value.length) {
      const character = value[position++];
      if (character === "," && !inParens) break;
      if (character === "(") inParens = true;
      if (character === ")") inParens = false;
    }
  }
}
