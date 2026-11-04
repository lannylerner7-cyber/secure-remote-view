"""Create auditable source-only archives. Never include installed/runtime files."""
import argparse
import base64
import hashlib
import json
import posixpath
import re
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "."
EXTENSIONS = {".cs", ".csproj", ".xaml", ".manifest", ".ps1", ".bat", ".cmd",
              ".md", ".txt", ".json", ".xml", ".wxs", ".iss", ".svg", ".ico",
              ".png", ".sh", ".plist", ".config", ".props", ".targets", ".sln"}
SKIP = {"bin", "obj", "dist", "publish", "node_modules", ".git", ".vs",
        "generated-artifacts", "TestResults", "__pycache__"}


def validate_project_references(files):
    """Every explicit first-party C# link/project must exist inside the ZIP."""
    for name, data in files.items():
        if not name.endswith(".csproj"):
            continue
        for element in ET.fromstring(data).iter():
            if element.tag not in {"Compile", "ProjectReference"}:
                continue
            reference = element.get("Include", "").replace("\\", "/")
            if not reference or any(marker in reference for marker in ("$(", "*", "?", ";")):
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), reference))
            if target not in files:
                raise RuntimeError(f"Source dependency is missing: {name} -> {reference}")


def sources(side):
    candidates = list((APP / side).rglob("*")) + list((APP / "tools").rglob("*"))
    candidates += [APP / "docs/SIGNING.md"]
    if side == "admin":
        candidates += [APP / "agent/src/NativeGatewayPolicy.cs"]
    else:
        # The portable gateway regression project links this single shared
        # configuration parser. Do not ship the Admin application itself.
        candidates += [APP / "admin/src/Api/AppConfig.cs"]
    for p in sorted(set(candidates)):
        rel = p.relative_to(APP)
        if not p.is_file() or any(x in SKIP for x in rel.parts):
            continue
        if not p.resolve().is_relative_to(APP.resolve()):
            raise RuntimeError(f"Refusing an external source symlink: {rel}")
        if p.suffix.lower() not in EXTENSIONS or p.name.startswith(".env") or "_wpftmp" in p.name:
            continue
        yield rel.as_posix(), p.read_bytes()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--github-commit", help="Optional published commit; verified against remote main")
    parser.add_argument("--out", required=True)
    parser.add_argument("--side", choices=("agent", "admin"), help="Package only this client")
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
    for side in ((args.side,) if args.side else ("agent", "admin")):
        source_version = ET.parse(APP / "agent/src/ConnectLiveAgent.csproj").findtext(".//Version") if side == "agent" else None
        if source_version and not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", source_version):
            raise RuntimeError("Invalid source version for archive filename")
        version_suffix = f"-{source_version}" if source_version else ""
        destination = out / f"ConnectLive-{side.title()}{version_suffix}-Source.zip"
        if destination.exists():
            raise RuntimeError(f"Refusing to replace {destination.name}")
        files = dict(sources(side))
        files["VERIFICATION-STATUS.md"] = (ROOT / "docs/native-streaming-progress.md").read_bytes()
        files["supabase/migrations/20261022001000_allow_recorded_control_transition.sql"] = (
            APP / "supabase/migrations/20261022001000_allow_recorded_control_transition.sql").read_bytes()
        files["supabase/migrations/20261022002000_reconcile_recorded_control_guard.sql"] = (
            APP / "supabase/migrations/20261022002000_reconcile_recorded_control_guard.sql").read_bytes()
        if side == "agent":
            files["tests/agent-ui-regression.cjs"] = (ROOT / "tests/agent-ui-regression.cjs").read_bytes()
            for name in (
                "20261103000000_disclosed_device_pairing.sql",
                "20261103001000_browser_video_sessions.sql",
                "20261103002000_signed_agent_update_channel.sql",
                "20261103003000_agent_lifecycle.sql",
            ):
                files[f"supabase/migrations/{name}"] = (APP / "supabase/migrations" / name).read_bytes()
            for name in ("agent-windows-verification.md", "agent-lifecycle-implementation.md",
                         "browser-first-verification.md", "browser-first-migration.md"):
                files[f"docs/{name}"] = (ROOT / "docs" / name).read_bytes()
        validate_project_references(files)
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
            if re.search(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----", text):
                raise RuntimeError(f"Private key found in {name}")
            if re.search(r"\b(?:sb_secret_|github_pat_|ghp_|sk_live_)[A-Za-z0-9_-]{24,}", text):
                raise RuntimeError(f"Server credential pattern found in {name}")
            for token in re.findall(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{24,}\b", text):
                payload = token.split(".")[1]
                try:
                    role = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("role")
                except (ValueError, UnicodeDecodeError):
                    continue
                if role == "service_role":
                    raise RuntimeError(f"Service-role credential found in {name}")
            if name.endswith(".json"):
                def check_config(value):
                    if isinstance(value, list):
                        for item in value:
                            check_config(item)
                        return
                    if not isinstance(value, dict):
                        return
                    for key, item in value.items():
                        if re.sub(r"[^a-z]", "", key.lower()) in {
                            "password", "devicetoken", "servicerolekey", "supabaseservicerolekey",
                            "sessionsecret", "smtppassword", "privatekey", "licensekey",
                            "accesstoken", "refreshtoken", "apitoken", "apisecret", "clientsecret",
                            "githubpushtoken", "cloudflarecallsapptoken",
                        } and item:
                            raise RuntimeError(f"Runtime credential must not be packaged: {name}")
                        check_config(item)
                    if value.get("kty") in {"RSA", "EC", "OKP"} and value.get("d"):
                        raise RuntimeError(f"Private signing material must not be packaged: {name}")
                check_config(json.loads(text))
        manifest = {
            "archiveKind": "source-only",
            "sourceVersion": source_version,
            "nativeBuildPerformedForArchive": False,
            "prebuiltExecutablesIncluded": False,
            "workspaceBaselineCommit": baseline,
            "includesUncommittedChanges": True,
            "githubPushVerified": bool(args.github_commit),
            "githubCommit": args.github_commit,
            "archiveSourcesMatchCommit": bool(args.github_commit),
            "windowsRuntimeVerified": False,
            "files": {n: hashlib.sha256(b).hexdigest() for n, b in files.items()},
        }
        files["START-HERE.txt"] = (
            f"ConnectLive {side.title()} SOURCE ONLY - work in progress\n"
            "No executable or installer is included. Extract the entire archive.\n"
            + ("FIRST: Open PowerShell in admin and run .\\configure.ps1.\n"
               "Enter your Supabase public sb_publishable_ key locally, never a service-role key.\n"
               "Then cd src; dotnet run (without --no-build).\n"
               if side == "admin" else "")
            + ("FIRST: Read agent/RUN-SOURCE.md. Use a Windows x64 machine with the .NET 8 SDK.\n"
               "Extract into a fresh directory, not over an older source bundle.\n"
               "Stop the old Agent before running this source (run.ps1 -Disable, or its old tray menu).\n"
               "Open PowerShell in the extracted folder, then run:\n"
               "  cd .\\agent\n"
               "  Unblock-File .\\run.ps1\n"
               "  .\\run.ps1 -Pair\n"
               "This builds the actual Agent, Watch and updater source on YOUR machine; no MSI is created.\n"
               "The one pairing-code window replaces both old startup windows. Access details stay inline.\n"
               "Get a fresh code from your administrator. After pairing there is no status window or tray/control UI.\n"
               "Local disable still works: .\\run.ps1 -Disable or ConnectLive.exe /disable.\n"
               "Source files are in agent/src, agent/update-core and agent/tools; they are not download links.\n"
               "The single admin/src/Api/AppConfig.cs file is a shared test dependency, not another client bundle.\n"
               "Do NOT run agent/build.ps1 for the initial terminal test: -SkipInno still creates an MSI.\n"
               "Installer bundling comes later, after your manual source test.\n"
               "This ZIP does not deploy the server. SQL/verification documents are reference material only.\n"
               if side == "agent" else "")
            +
            (f"Windows .NET 8 SDK: cd {side}\\src; dotnet build -c Release\n"
             f"Packaging: cd {side}; .\\build.ps1 (see INSTALL.md and docs/SIGNING.md).\n"
             if side == "admin" else "")
            +
            "Keep the folder layout: shared dependencies and signing tools are included.\n"
            "No source edit disables SmartScreen. Signing requires your trusted identity.\n"
            "No Windows binary was compiled for this archive.\n"
            "Windows live-session, backend transition and installer verification remain incomplete.\n"
        ).encode()
        manifest["files"] = {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}
        files["SOURCE-MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
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
