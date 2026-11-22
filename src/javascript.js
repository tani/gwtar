import { parsers } from "prettier/plugins/babel";

function* imports(node) {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
      if (node.source) yield node.source.value;
      break;
    case "ImportExpression": {
      const source = node.source;
      if (source.type === "StringLiteral") yield source.value;
      else if (source.type === "TemplateLiteral" && !source.expressions.length) {
        yield source.quasis[0].value.cooked;
      } else {
        yield undefined;
      }
      break;
    }
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item?.type) yield* imports(item);
      }
    } else if (child?.type) {
      yield* imports(child);
    }
  }
}

export async function checkScript(code, name) {
  const ast = await parsers.babel.parse(code, { parser: "babel", filepath: name });
  for (const specifier of imports(ast.program)) {
    if (!specifier || !/^(https?:|data:)/i.test(specifier)) {
      throw new Error(`Bundle module imports into one file before archiving: ${name}`);
    }
  }
}
