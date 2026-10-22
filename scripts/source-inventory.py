"""Read-only source inventory; writes a report, never executes imported code."""
from pathlib import Path
import argparse
import hashlib
import re
import subprocess
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("--baseline", required=True)
args = parser.parse_args()
root = Path(".")
baseline = Path(args.baseline)
skip = {"node_modules", "bin", "obj", ".git", "dist", "publish", ".output"}

def files(base):
    return sorted(p for p in base.rglob("*") if p.is_file()
                  and not any(part in skip for part in p.relative_to(base).parts)
                  and not p.name.startswith(".env"))

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

tracked = subprocess.check_output(
    ["git", "-C", str(baseline), "ls-files", "-z"], text=True).split("\0")
tracked = [n for n in tracked if n and not Path(n).name.startswith(".env")]
same, changed, missing = [], [], []
for n in tracked:
    target = root / n
    if not target.exists():
        missing.append(n)
    elif digest(target) == digest(baseline / n):
        same.append(n)
    else:
        changed.append(n)
added = [str(p.relative_to(root)) for p in files(root)
         if str(p.relative_to(root)) not in tracked]
revision = subprocess.check_output(
    ["git", "-C", str(baseline), "rev-parse", "HEAD"], text=True).strip()

lines = [
    "# ConnectLive codebase map and source verification",
    "",
    f"Compared with GitHub revision `{revision}`.",
    "This report inventories source; it does not certify behavior, authorization,",
    "successful Windows builds, deployment health, or exhaustive security coverage.",
    "",
    "## Locations in this project",
    "",
    "| Location | Purpose |",
    "| --- | --- |",
    "| `` | Main GitHub source plus local defensive edits |",
    "| `src/routes/_authenticated/console.tsx` | Technician web console at `/console` |",
    "| `src/routes/_authenticated/payments.tsx` | Separate payments console at `/payments` |",
    "| `admin/` | Windows technician Admin source |",
    "| `agent/` | Windows Agent and repository Watch source |",
    "| `supabase/migrations/` | Existing database migration source; not applied here |",
    "| `imports/client-archives/agent/` | Extracted Agent builder ZIP, unchanged reference |",
    "| `imports/client-archives/admin/` | Extracted Admin builder ZIP, unchanged reference |",
    "| `docs/` | Review evidence, configuration and access-policy documentation |",
    "| `artifacts/` | Original workspace services, not the imported product |",
    "",
    "## Import comparison",
    "",
    f"- Unchanged tracked files: **{len(same)}**",
    f"- Locally changed tracked files: **{len(changed)}**",
    f"- Missing tracked files (excluding environment files): **{len(missing)}**",
    f"- Added source files: **{len(added)}**",
    "- Environment files were deliberately excluded; values were not read.",
    "",
]
for title, entries in [("Changed", changed), ("Missing", missing), ("Added", added)]:
    lines += [f"### {title}", ""] + ([f"- `{n}`" for n in entries] or ["None."]) + [""]

lines += ["## Subsystem inventory", "", "| Subsystem | Files |", "| --- | ---: |"]
for name in ["src/routes", "src/components", "src/lib", "src/shared",
             "src/integrations", "agent/src", "admin/src", "supabase/migrations"]:
    lines.append(f"| `{name}` | {len(files(root/name))} |")

lines += [
    "", "## Declared file routes", "",
    "Paths below are route declarations, not proof of reachable/authenticated routes.",
    "`_authenticated` is a pathless layout; it is not a URL segment.",
    "HTTP methods are syntactic declarations only. Server functions and direct",
    "Supabase calls are separate surfaces and are not covered by this table.",
    "", "| Declaration | Declared methods | Source |", "| --- | --- | --- |",
]
for p in files(root / "src/routes"):
    if p.suffix not in {".ts", ".tsx"}:
        continue
    text = p.read_text()
    route = re.search(r'createFileRoute\(\s*[\'"]([^\'"]+)', text)
    if route:
        methods = sorted(set(re.findall(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*:", text)))
        lines.append(f"| `{route[1]}` | {', '.join(methods) or 'Page/layout'} | `{p.relative_to(root)}` |")

lines += ["", "## Client project declarations", "", "| Project | XML parses | Target |", "| --- | --- | --- |"]
for base in [root/"agent", root/"admin"]:
    for p in files(base):
        if p.suffix != ".csproj":
            continue
        try:
            tree = ET.fromstring(p.read_text())
            target = tree.findtext(".//TargetFramework", "unspecified")
            result = "Yes; not compilation"
        except ET.ParseError:
            target, result = "Unknown", "No"
        lines.append(f"| `{p.relative_to(root)}` | {result} | `{target}` |")

lines += ["", "## Archive reference comparison", ""]
for side in ["agent", "admin"]:
    archive_root = Path("imports/client-archives") / side
    equal, different, extra = [], [], []
    for p in files(archive_root):
        rel = p.relative_to(archive_root)
        other = baseline / side / rel
        if not other.exists() and rel.parts[0] in {"tools", "docs"}:
            other = baseline / rel
        if not other.exists():
            extra.append(str(rel))
        elif digest(p) == digest(other):
            equal.append(str(rel))
        else:
            different.append(str(rel))
    lines += [
        f"### {side.title()}",
        f"- Files: {len(equal)+len(different)+len(extra)}",
        f"- Byte-identical to upstream: {len(equal)}",
        f"- Different: {', '.join('`'+n+'`' for n in different) or 'None'}",
        f"- Archive-only: {', '.join('`'+n+'`' for n in extra) or 'None'}", "",
    ]

lines += [
    "## Verification still required", "",
    "- Full TypeScript semantic checking and dependency-resolved builds.",
    "- Server/Agent grant enforcement, local withdrawal, peer-channel permissions and race handling.",
    "- Windows UI/build/runtime tests; earlier compilation blockers remain documented.",
    "- Isolated authentication, tenant isolation, database policies and all state transitions.",
    "- Actual compiled ZIP signatures, contents and install/uninstall behavior.",
    "- Android native implementation: no APK/client project is established by these sources.",
    "",
    "No secrets, live devices, migrations or production configuration were used.",
]
Path("docs/codebase-map.md").write_text("\n".join(lines) + "\n")
print(f"Inventory saved: {len(same)} unchanged, {len(changed)} changed, "
      f"{len(missing)} missing, {len(added)} added.")
