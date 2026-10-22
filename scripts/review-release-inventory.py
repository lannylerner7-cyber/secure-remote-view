"""Read-only product/package inventory; writes only review evidence."""
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "docs/review"
REPORT.mkdir(parents=True, exist_ok=True)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def baseline():
    paths = subprocess.check_output(["git", "--no-optional-locks", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    entries = []
    for name in sorted(filter(None, paths)):
        p = ROOT / name
        if p.name.startswith(".env") and p.name not in {".env.sample", ".env.example"}:
            entries.append({"path": name, "status": "excluded", "reason": "environment values not inspected"})
            continue
        if not p.is_file():
            entries.append({"path": name, "status": "blocked", "reason": "tracked file unavailable"})
            continue
        entries.append({"path": name, "bytes": p.stat().st_size, "sha256": sha(p.read_bytes()),
                        "status": "automatically_checked",
                        "reason": "baseline presence/hash only; semantic review not implied"})
    result = {"revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
              "workingTree": subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain"], cwd=ROOT).decode().splitlines(),
              "files": entries}
    (REPORT / "baseline.json").write_text(json.dumps(result, indent=2) + "\n")
    print("Baseline recorded:", len(entries), "tracked files")

def packages():
    out = ROOT / "generated-artifacts/windows-desktop"
    manifest = {e["file"]: e for e in json.loads((out / "release-manifest.json").read_text())}
    results = []
    for side in ["Agent", "Admin"]:
        p = out / f"ConnectLive-{side}-Windows-x64.zip"
        record = {"archive": p.name, "sha256": sha(p.read_bytes()), "bytes": p.stat().st_size}
        record["manifestHashMatches"] = record["sha256"] == manifest[p.name]["sha256"]
        with zipfile.ZipFile(p) as z:
            members = z.infolist()
            record["crcValid"] = z.testzip() is None
            record["duplicatePaths"] = len(z.namelist()) != len(set(z.namelist()))
            record["unsafePaths"] = [i.filename for i in members if i.filename.startswith(("/", "\\")) or ".." in Path(i.filename).parts]
            record["members"] = []
            sums_name = next(i.filename for i in members if i.filename.endswith("/SHA256SUMS.txt"))
            sums = dict(line.split("  ", 1)[::-1] for line in z.read(sums_name).decode().splitlines())
            for i in members:
                data = z.read(i.filename)
                row = {"path": i.filename, "bytes": len(data), "sha256": sha(data)}
                name = Path(i.filename).name
                row["checksumMatches"] = sums.get(name) == row["sha256"] if name in sums else None
                if name.endswith(".exe"):
                    pe = struct.unpack_from("<I", data, 0x3C)[0]
                    optional = pe + 24
                    row["peValid"] = data[:2] == b"MZ" and data[pe:pe+4] == b"PE\0\0"
                    row["machine"] = hex(struct.unpack_from("<H", data, pe+4)[0])
                    row["pe32Plus"] = struct.unpack_from("<H", data, optional)[0] == 0x20b
                    row["certificateTableBytes"] = struct.unpack_from("<II", data, optional + 112 + 4*8)[1]
                    row["embeddedVersionHints"] = sorted(set(x.decode() for x in re.findall(rb"1\.(?:9\.1|7\.2)\+[0-9a-f]{40}", data)))
                    staged = out / side.lower() / name
                    row["matchesPublishedStagingExe"] = staged.exists() and sha(staged.read_bytes()) == row["sha256"]
                    row["windowsRuntimeVerified"] = False
                elif name == "admin.config.json":
                    config = json.loads(data)
                    key = config.get("supabaseAnonKey", "")
                    row["configFields"] = sorted(config)
                    row["productionOriginMatches"] = config.get("baseUrl") == "https://connectliveagent.com"
                    row["supabaseOriginMatches"] = config.get("supabaseUrl") == "https://esjlqcfcwewymmeghbvj.supabase.co"
                    row["keyType"] = "publishable" if key.startswith("sb_publishable_") else "not-publishable-format"
                    row["privilegedConfigFields"] = any("service" in k.lower() or "password" in k.lower() for k in config)
                elif name == "Start-Agent.cmd":
                    row["launcherProductionOriginMatches"] = b"--api-url https://connectliveagent.com" in data
                record["members"].append(row)
            record["everyPayloadChecksummed"] = all(Path(i.filename).name in sums or i.filename == sums_name for i in members)
        results.append(record)
    (REPORT / "package-verification.json").write_text(json.dumps(results, indent=2) + "\n")
    print("ZIP integrity and metadata recorded for", len(results), "unchanged archives")

def routes():
    app = ROOT / "."
    definitions, callers = [], []
    for p in sorted((app / "src/routes").rglob("*")):
        if p.suffix not in {".ts", ".tsx"}:
            continue
        text = p.read_text()
        for match in re.finditer(r'createFileRoute\(["\']([^"\']+)', text):
            definitions.append({"file": str(p.relative_to(ROOT)), "route": match[1],
                                "methods": sorted(set(re.findall(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):", text))),
                                "staticAuthMarkers": [x for x in ["verifyDevice", "requireSupabaseAuth", "sessionAuthorized", "getUser"] if x in text],
                                "reviewLimit": "Declaration index only; markers do not prove enforcement"})
    for side in ["agent/src", "admin/src", "src"]:
        for p in sorted((app / side).rglob("*")):
            if p.suffix not in {".cs", ".ts", ".tsx"} or set(p.parts) & {"bin", "obj", "node_modules"}:
                continue
            if p.name == "routeTree.gen.ts":
                continue
            for number, line in enumerate(p.read_text().splitlines(), 1):
                for m in re.finditer(r'["\'](/(?:api/public/|rest/v1/|auth/v1/)[^"\']*)', line):
                    callers.append({"file": str(p.relative_to(ROOT)), "line": number,
                                    "pathFragment": m[1].split("?")[0],
                                    "reviewLimit": "May be declaration/comment or interpolated fragment, not executed request"})
    (REPORT / "route-index.json").write_text(json.dumps({"declarations": definitions, "literalReferences": callers}, indent=2) + "\n")
    print("Indexed", len(definitions), "route declarations and", len(callers), "literal references")

def coverage():
    baseline = json.loads((REPORT / "baseline.json").read_text())
    rows = {r["path"]: {**r, "reviewers": []} for r in baseline["files"]}
    priority = {"excluded": 0, "blocked": 1, "automatically_checked": 2, "reviewed": 3}
    for reviewer in ["agent", "admin", "backend"]:
        for item in json.loads((REPORT / f"{reviewer}-coverage.json").read_text()):
            name = item["path"]
            row = rows.setdefault(name, {"path": name, "status": "excluded", "reason": "", "reviewers": []})
            row["reviewers"].append({"reviewer": reviewer, "status": item["status"], "reason": item["reason"]})
            if priority.get(item["status"], 1) >= priority.get(row["status"], 1):
                row["status"], row["reason"] = item["status"], item["reason"]
    counts = {}
    for row in rows.values():
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    result = {"baselineTrackedFiles": len(baseline["files"]), "coverageEntries": len(rows),
              "counts": counts, "limits": "Reviewed means scoped static examination, not approval. Hash-only rows remain automatic checks, not semantic reviews.",
              "files": sorted(rows.values(), key=lambda r: r["path"])}
    (REPORT / "coverage-ledger.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "files"}))

if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["baseline"]:
        baseline()
    elif sys.argv[1:] == ["packages"]:
        packages()
    elif sys.argv[1:] == ["routes"]:
        routes()
    elif sys.argv[1:] == ["coverage"]:
        coverage()
    else:
        raise SystemExit("Use baseline, packages, routes or coverage")
