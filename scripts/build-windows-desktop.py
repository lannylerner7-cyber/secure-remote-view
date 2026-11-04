"""Cross-publish from a clean native-source snapshot, never reuse bin/obj."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    out = (ROOT / args.output).resolve()
    if not out.is_relative_to(ROOT / "generated-artifacts") or out.exists():
        raise RuntimeError("A new directory under generated-artifacts is required.")
    snapshot = out / "source"
    for side, parts in (("agent", ("src", "assets", "update-core")),
                        ("admin", ("src", "assets"))):
        for part in parts:
            source = ROOT / "." / side / part
            if source.exists():
                shutil.copytree(source, snapshot / side / part,
                                ignore=shutil.ignore_patterns("bin", "obj", "*_wpftmp.csproj", ".env*"))
    hashes = {str(p.relative_to(snapshot)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(snapshot.rglob("*")) if p.is_file()}
    fingerprint = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    versions = {
        side: ET.parse(snapshot / side / "src" / (project + ".csproj")).findtext(".//Version")
        for side, project in (("agent", "ConnectLiveAgent"), ("admin", "ConnectLiveAdmin"))
    }
    if not all(versions.values()):
        raise RuntimeError("Both desktop projects must declare their release version.")
    baseline = subprocess.check_output(["git", "--no-optional-locks", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    provenance = {"baselineCommit": baseline, "nativeSourceSha256": fingerprint,
                  "baselineIsReleaseCommit": False, "githubPushVerified": False,
                   "builtAtUtc": datetime.now(timezone.utc).isoformat(),
                   "versions": versions,
                  "fileHashes": hashes}
    (out / "source-manifest.json").write_text(json.dumps(provenance, indent=2) + "\n")
    components = (
        ("agent", "agent", "ConnectLiveAgent.csproj", "ConnectLive.exe"),
        ("agent", "watch", "Watch/ConnectLiveWatch.csproj", "ConnectLiveWatch.exe"),
        ("agent", "update", "UpdateHost/ConnectLiveUpdate.csproj", "ConnectLiveUpdate.exe"),
        ("admin", "admin", "ConnectLiveAdmin.csproj", "ConnectLiveAdmin.exe"),
    )
    for side, component, project, filename in components:
        csproj = snapshot / side / "src" / project
        version = versions[side]
        publish = out / "_publish" / component
        command = ["dotnet", "publish", str(csproj), "-c", "Release", "-r", "win-x64",
                   "--self-contained", "true", "-p:EnableWindowsTargeting=true",
                   "-p:PublishSingleFile=true", "-p:IncludeSourceRevisionInInformationalVersion=false",
                   "-p:IncludeNativeLibrariesForSelfExtract=true", f"-p:Version={version}",
                   f"-p:InformationalVersion={version}+source.{fingerprint}",
                   "-o", str(publish)]
        with (out / (component + "-publish.log")).open("w") as log:
            subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        exe = publish / filename
        if not exe.is_file():
            raise RuntimeError("Publish did not create executable; inspect publish log.")
        allowed = {filename, "admin.config.json"} if side == "admin" else {filename}
        unexpected = [p.relative_to(publish).as_posix() for p in publish.rglob("*")
                      if p.is_file() and p.suffix != ".pdb"
                      and p.relative_to(publish).as_posix() not in allowed]
        if unexpected:
            raise RuntimeError(f"Unexpected {component} publish files; review dependencies: {unexpected}")
        (out / side).mkdir(exist_ok=True)
        shutil.copy2(exe, out / side / filename)
        print(f"{component} {version}: fresh publish complete ({exe.stat().st_size} bytes)", flush=True)
    print("Native source SHA256: " + fingerprint)


if __name__ == "__main__":
    main()
