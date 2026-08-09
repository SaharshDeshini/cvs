const Parser = require("tree-sitter");
const Cpp = require("tree-sitter-cpp");

function parseCppCode(code) {
  if (!code || typeof code !== "string") {
    throw new Error("C++ code is required");
  }

  const parser = new Parser();

  parser.setLanguage(Cpp);

  const tree = parser.parse(code);

  return tree.rootNode;
}

function printTree(node, depth = 0) {
  const indentation = "  ".repeat(depth);

  console.log(
    `${indentation}${node.type} [${node.startPosition.row + 1}:${node.startPosition.column + 1}]`,
  );

  for (const child of node.namedChildren) {
    printTree(child, depth + 1);
  }
}

module.exports = {
  parseCppCode,
  printTree,
};
