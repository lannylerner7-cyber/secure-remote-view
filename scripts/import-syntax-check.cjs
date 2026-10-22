// Parse all imported TS/TSX source without executing it or loading its dependencies.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const excluded = new Set(["node_modules", "bin", "obj", ".git", "dist", ".output", "publish"]);
let checked = 0;
const failures = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) walk(name);
    } else if (/\.tsx?$/.test(entry.name)) {
      const source = ts.createSourceFile(name, fs.readFileSync(name, "utf8"),
        ts.ScriptTarget.Latest, true,
        entry.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      checked++;
      for (const d of source.parseDiagnostics) {
        const position = source.getLineAndCharacterOfPosition(d.start || 0);
        failures.push(`${name}:${position.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
      }
    }
  }
}
walk(".");
const report = [
  "# Imported TypeScript syntax check", "",
  `Files parsed: ${checked}`,
  `Syntax diagnostics: ${failures.length}`, "",
  ...failures,
  "",
  "Parser-only check. Not a semantic typecheck, dependency build, route test or runtime verification.",
];
fs.writeFileSync("docs/import-syntax-check.md", report.join("\n") + "\n");
console.log(`Parsed ${checked} TypeScript files; ${failures.length} syntax diagnostics.`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exitCode = 1;
}
