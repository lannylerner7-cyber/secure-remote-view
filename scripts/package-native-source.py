"""Create auditable source-only archives. Never include installed/runtime files."""
import argparse
import hashlib
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "."
EXTENSIONS = {".cs", ".csproj", ".xaml", ".manifest", ".ps1", ".bat", ".cmd",
              ".md", ".txt", ".json", ".xml", ".wxs", ".iss", ".svg", ".ico",
              ".png", ".sh", ".plist", ".config", ".props", ".targets", ".sln"}
SKIP = {"bin", "obj", "dist", "publish", "node_modules", ".git"}


def sources(side):
    candidates = list((APP / side).rglob("*")) + list((APP / "tools").rglob("*"))
    candidates += [APP / "docs/SIGNING.md"]
    if side == "admin":
        candidates += [APP / "agent/src/NativeGatewayPolicy.cs"]
    for p in sorted(set(candidates)):
        rel = p.relative_to(APP)
        if not p.is_file() or any(x in SKIP for x in rel.parts):
            continue
        if p.suffix.lower() not in EXTENSIONS or p.name.startswith(".env") or "_wpftmp" in p.name:
            continue
        yield rel.as_posix(), p.read_bytes()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--github-commit", help="Optional published commit; verified against remote main")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.github_commit:
        remote = subprocess.check_output(
            ["git", "ls-remote", "https://github.com/lannylerner7-cyber/secure-remote-view.git", "refs/heads/main"],
            text=True).split()[0]
        if remote != args.github_commit:
            raise SystemExit("Requested GitHub commit is not current remote main")
        # Compare the bytes we will archive, not just a branch name. Never label
        # uncommitted local edits as belonging to an unrelated published commit.
        checkout = tempfile.TemporaryDirectory(prefix="connectlive-archive-commit-")
        subprocess.run(["git", "clone", "--quiet", "--no-checkout",
                        "https://github.com/lannylerner7-cyber/secure-remote-view.git",
                        checkout.name], check=True)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    baseline = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    for side in ("agent", "admin"):
        destination = out / f"ConnectLive-{side.title()}-Source.zip"
        if destination.exists():
            raise RuntimeError(f"Refusing to replace {destination.name}")
        files = dict(sources(side))
        files["VERIFICATION-STATUS.md"] = (ROOT / "docs/native-streaming-progress.md").read_bytes()
        files["supabase/migrations/20261022001000_allow_recorded_control_transition.sql"] = (
            APP / "supabase/migrations/20261022001000_allow_recorded_control_transition.sql").read_bytes()
        files["supabase/migrations/20261022002000_reconcile_recorded_control_guard.sql"] = (
            APP / "supabase/migrations/20261022002000_reconcile_recorded_control_guard.sql").read_bytes()
        if args.github_commit:
            for name, data in files.items():
                tracked = "docs/native-streaming-progress.md" if name == "VERIFICATION-STATUS.md" else name
                published = subprocess.check_output(
                    ["git", "-C", checkout.name, "show", f"{args.github_commit}:{tracked}"])
                if data != published:
                    raise SystemExit(f"Source differs from published commit: {name}")
        for name, data in files.items():
            if Path(name).suffix.lower() in {".png", ".ico"}:
                continue
            text = data.decode("utf-8", errors="replace")
            if "-----BEGIN PRIVATE KEY-----" in text or "-----BEGIN OPENSSH PRIVATE KEY-----" in text:
                raise RuntimeError(f"Private key found in {name}")
        manifest = {
            "workspaceBaselineCommit": baseline,
            "includesUncommittedChanges": True,
            "githubPushVerified": bool(args.github_commit),
            "githubCommit": args.github_commit,
            "archiveSourcesMatchCommit": bool(args.github_commit),
            "windowsRuntimeVerified": False,
            "files": {n: hashlib.sha256(b).hexdigest() for n, b in files.items()},
        }
        files["SOURCE-MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
        files["START-HERE.txt"] = (
            f"ConnectLive {side.title()} SOURCE ONLY - work in progress\n"
            "No executable or installer is included. Extract the entire archive.\n"
            f"Windows .NET 8 SDK: cd {side}\\src; dotnet build -c Release\n"
            f"Packaging: cd {side}; .\\build.ps1 (see INSTALL.md and docs/SIGNING.md).\n"
            "Keep the folder layout: shared dependencies and signing tools are included.\n"
            "Agent installer additionally requires Inno Setup / WiX as documented.\n"
            "No source edit disables SmartScreen. Signing requires your trusted identity.\n"
            "Windows live-session, backend transition and installer verification remain incomplete.\n"
        ).encode()
        with zipfile.ZipFile(destination, "x", zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                archive.writestr(name, data)
        with zipfile.ZipFile(destination) as archive:
            assert archive.testzip() is None
            for name, digest in manifest["files"].items():
                assert hashlib.sha256(archive.read(name)).hexdigest() == digest
            assert not any(Path(n).suffix.lower() in {".exe", ".dll", ".msi", ".pfx", ".key"} for n in archive.namelist())
        checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
        destination.with_suffix(".zip.sha256").write_text(f"{checksum}  {destination.name}\n")
        print(f"{destination.name}: {len(manifest['files'])} source files, sha256={checksum}")


if __name__ == "__main__":
    main()
