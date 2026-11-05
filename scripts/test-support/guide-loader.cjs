// Loads the actual server modules in isolation. Network/credentials are denied
// unless a caller explicitly supplies them (the opt-in live smoke check).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const app = path.resolve(__dirname, "../..");
const appRequire = createRequire(path.join(app, "package.json"));
const ts = appRequire("typescript");

function createGuideLoader({ overrides = {}, globals = {} } = {}) {
  const modules = new Map();
  const load = (name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (modules.has(name)) return modules.get(name).exports;
    const filename = path.join(app, name);
    if (name.endsWith(".json")) return JSON.parse(fs.readFileSync(filename, "utf8"));
    const output = { exports: {} };
    modules.set(name, output);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(code, {
      module: output, exports: output.exports,
      Buffer, URL, Headers, Request, Response, AbortSignal, setTimeout, clearTimeout,
      console, process: { env: {} },
      fetch: () => { throw new Error("Unexpected network access in isolated guide test"); },
      ...globals,
      require: (id) => {
        if (Object.hasOwn(overrides, id)) return overrides[id];
        if (id.startsWith("node:")) return require(id);
        if (id === "zod") return appRequire(id);
        if (!id.startsWith(".") && !id.startsWith("@/")) throw new Error(`Unexpected dependency: ${id}`);
        let target = id.startsWith("@/") ? path.join(app, "src", id.slice(2))
          : path.resolve(path.dirname(filename), id);
        if (!/\.(?:ts|tsx|json)$/.test(target)) target += ".ts";
        return load(path.relative(app, target));
      },
    }, { filename });
    return output.exports;
  };
  return load;
}

function approvedKnowledge() {
  const topics = path.join(app, "knowledge/topics");
  const entries = fs.readdirSync(topics).filter((name) => name.endsWith(".json"))
    .flatMap((name) => JSON.parse(fs.readFileSync(path.join(topics, name), "utf8")).entries);
  return {
    guideManifest: JSON.parse(fs.readFileSync(path.join(app, "knowledge/manifest.json"), "utf8")),
    knowledgeEntries: entries,
    findAnswer: (question) => entries.find((entry) => entry.question === question) ?? null,
  };
}

module.exports = { createGuideLoader, approvedKnowledge, appRequire };
