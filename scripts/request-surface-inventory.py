"""Inventory declared routes/callers without importing or executing product code."""
from pathlib import Path
import re

root = Path(".")
sections = {"File route declarations": [], "Server functions": [],
            "HTTP path references": [], "Database/storage collection references": [],
            "Database RPC references": []}
for base in ("src", "agent/src", "admin/src"):
    for p in sorted((root / base).rglob("*")):
        if not p.is_file() or p.suffix not in (".ts", ".tsx", ".cs"):
            continue
        if any(part in {"bin", "obj", "node_modules"} for part in p.parts):
            continue
        if p.name in {"routeTree.gen.ts", "types.ts"}:
            continue
        content = p.read_text()
        rules = {
            "File route declarations": r'createFileRoute\(["\']([^"\']+)',
            "Server functions": r'export const (\w+)\s*=\s*createServerFn',
            "HTTP path references": r'((?:/api/|/rest/v1/)[^"\'`\s<]*)',
            "Database/storage collection references": r'\.from\(["\']([^"\']+)',
            "Database RPC references": r'\.rpc\(\s*["\']([^"\']+)',
        }
        for name, pattern in rules.items():
            for match in re.finditer(pattern, content):
                # Report paths, never query values or source request payloads.
                value = match[1].split("?")[0].replace("|", "\\|")
                line = content[:match.start()].count("\n") + 1
                sections[name].append((str(p.relative_to(root)), line, value))

out = [
    "# Request-surface inventory", "",
    "Static references across web/server source and both Windows clients.",
    "This is a navigation aid, not proof that every constructed URL is covered.",
    "Dynamic path builders, aliases, external APIs, storage policies and runtime",
    "state need separate review. No application modules or credentials were loaded.", "",
    "Path fragments can include source interpolation or comments; they are not",
    "assertions of routability. `.from()` references include storage buckets.", "",
]
for name, rows in sections.items():
    out += [f"## {name} ({len(rows)})", "",
            "| Source | Line | Declaration/reference |", "| --- | ---: | --- |"]
    out += [f"| `{file}` | {line} | `{value}` |" for file, line, value in rows]
    out.append("")
Path("docs/request-surface-inventory.md").write_text("\n".join(out))
print({name: len(rows) for name, rows in sections.items()})
