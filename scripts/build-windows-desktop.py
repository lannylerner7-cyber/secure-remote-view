"""Cross-publish from a clean native-source snapshot, never reuse bin/obj."""
import argparse
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
    for side in ("agent", "admin"):
        for part in ("src", "assets"):
            source = ROOT / "." / side / part
            if source.exists():
                shutil.copytree(source, snapshot / side / part,
                                ignore=shutil.ignore_patterns("bin", "obj", "*_wpftmp.csproj", ".env*"))
    hashes = {str(p.relative_to(snapshot)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(snapshot.rglob("*")) if p.is_file()}
    fingerprint = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    baseline = subprocess.check_output(["git", "--no-optional-locks", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    provenance = {"baselineCommit": baseline, "nativeSourceSha256": fingerprint,
                  "baselineIsReleaseCommit": False, "githubPushVerified": False,
                  "fileHashes": hashes}
    (out / "source-manifest.json").write_text(json.dumps(provenance, indent=2) + "\n")
    for side, project in (("agent", "ConnectLiveAgent"), ("admin", "ConnectLiveAdmin")):
        csproj = snapshot / side / "src" / (project + ".csproj")
        version = ET.parse(csproj).findtext(".//Version")
        command = ["dotnet", "publish", str(csproj), "-c", "Release", "-r", "win-x64",
                   "--self-contained", "true", "-p:EnableWindowsTargeting=true",
                   "-p:PublishSingleFile=true", "-p:IncludeSourceRevisionInInformationalVersion=false",
                   f"-p:InformationalVersion={version}+source.{fingerprint}",
                   "-o", str(out / side)]
        with (out / (side + "-publish.log")).open("w") as log:
            subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        exe = out / side / ("ConnectLive.exe" if side == "agent" else "ConnectLiveAdmin.exe")
        if not exe.is_file():
            raise RuntimeError("Publish did not create executable; inspect publish log.")
        print(f"{side} {version}: fresh publish complete ({exe.stat().st_size} bytes)", flush=True)
    print("Native source SHA256: " + fingerprint)


if __name__ == "__main__":
    main()
