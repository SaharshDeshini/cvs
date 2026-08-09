const { parseCppCode } = require("./cppParserService");

const TRACEABLE_TYPES = new Set([
  "int",
  "long",
  "long long",
  "float",
  "double",
  "char",
  "bool",
]);

function getDeclaredVariables(node) {
  const variables = [];

  if (node.type !== "declaration") {
    return variables;
  }

  let typeName = "";

  for (const child of node.namedChildren) {
    if (child.type === "primitive_type") {
      typeName = child.text;
    }
  }

  if (!TRACEABLE_TYPES.has(typeName)) {
    return variables;
  }

  for (const child of node.namedChildren) {
    if (child.type !== "init_declarator") {
      continue;
    }

    const identifier = child.namedChildren.find(
      (item) => item.type === "identifier",
    );

    if (identifier) {
      variables.push({
        name: identifier.text,
        type: typeName,
      });
    }
  }

  return variables;
}

function instrumentCppCode(code) {
  const rootNode = parseCppCode(code);

  const insertions = [];
  const variables = [];

  function visit(node) {
    if (node.type === "declaration") {
      const declaredVariables = getDeclaredVariables(node);

      for (const variable of declaredVariables) {
        variables.push(variable);
      }

      if (declaredVariables.length > 0) {
        const line = node.startPosition.row + 1;

        const traceParts = declaredVariables.map(
          (variable) => `|${variable.name}=` + variable.name,
        );

        insertions.push({
          position: node.endIndex,
          text:
            `\nstd::cout << "TRACE|line=${line}"` +
            traceParts
              .map(
                (part) =>
                  ` << "${part.split("=")[0]}=" << ${part.split("=")[1]}`,
              )
              .join("") +
            ` << std::endl;`,
        });
      }
    }

    if (node.type === "expression_statement") {
      const line = node.startPosition.row + 1;

      const usedVariables = variables.filter((variable) => {
        return node.text.includes(variable.name);
      });

      if (usedVariables.length > 0) {
        const traceOutput = usedVariables
          .map((variable) => ` << "|${variable.name}=" << ${variable.name}`)
          .join("");

        insertions.push({
          position: node.endIndex,
          text:
            `\nstd::cout << "TRACE|line=${line}"` +
            traceOutput +
            ` << std::endl;`,
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);

  // Never insert a trace after return statements.
  // A return exits the function immediately.
  insertions.sort((a, b) => b.position - a.position);

  let instrumentedCode = code;

  for (const insertion of insertions) {
    instrumentedCode =
      instrumentedCode.slice(0, insertion.position) +
      insertion.text +
      instrumentedCode.slice(insertion.position);
  }

  if (!code.includes("#include <iostream>")) {
    instrumentedCode = "#include <iostream>\n" + instrumentedCode;
  }

  return instrumentedCode;
}

module.exports = {
  instrumentCppCode,
};
