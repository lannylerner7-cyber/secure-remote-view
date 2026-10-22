"""Package published, unsigned Windows desktop clients; never package server secrets."""
import base64
import hashlib
import json
import os
from pathlib import Path
import struct
import urllib.request
import zipfile
import argparse

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "generated-artifacts/windows-desktop"
ORIGIN = "https://connectliveagent.com"
SUPABASE = "https://esjlqcfcwewymmeghbvj.supabase.co"


def main():
    global OUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="New, isolated publish directory under generated-artifacts")
    args = parser.parse_args()
    OUT = (ROOT / args.output).resolve()
    if not OUT.is_relative_to(ROOT / "generated-artifacts") or OUT == ROOT / "generated-artifacts/windows-desktop":
        raise RuntimeError("Use a new generated-artifacts directory; preserve prior archives.")
    provenance = json.loads((OUT / "source-manifest.json").read_text())
    if list(OUT.glob("*.zip")):
        raise RuntimeError("Refusing to replace existing archives.")
    key = os.environ.get("VITE_SUPABASE_PUBLISHABLE_KEY", "")
    if not key.startswith("sb_publishable_"):
        try:
            payload = key.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            assert claims.get("role") == "anon"
            assert claims.get("ref") == SUPABASE.split("//")[1].split(".")[0]
        except Exception:
            raise RuntimeError("A valid public publishable/anon key is required; privileged keys are forbidden.") from None
    # Validate the public key against the intended project's real REST endpoint,
    # with zero returned rows. No user credentials or server secrets are used.
    request = urllib.request.Request(SUPABASE + "/rest/v1/plans?select=*&limit=0",
                                     headers={"apikey": key, "Authorization": "Bearer " + key})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200 and isinstance(json.load(response), list)
    config = {"baseUrl": ORIGIN, "supabaseUrl": SUPABASE, "supabaseAnonKey": key}
    (OUT / "admin/admin.config.json").write_text(json.dumps(config, indent=2) + "\n")
    common = """ConnectLive - Windows desktop verification build

Windows x64, Windows 10 version 2004 or newer / Windows 11.
Self-contained: no separate .NET installation is required.
Extract the ENTIRE ZIP to its own folder before launching.
Do not run directly inside the ZIP. Keep all supplied files together.

These executables are unsigned. Windows may show an unknown-publisher warning.
Verify the SHA256 against SHA256SUMS.txt. Follow your organization's approval
policy; do not disable Defender or other security controls.
These are portable builds, NOT MSI/setup installers. They do not install a
watchdog service or startup task. Do not distribute as a signed production release.

Backend: https://connectliveagent.com
HTTP health checks do not prove the deployed backend revision,
signed-in workflows, TURN relay, or DXGI media performance.
Built on Linux for Windows. No Windows application was launched here.

KNOWN RELEASE BLOCKERS remain: consent-to-RTC timing, control/reconnect state
contracts, native input envelope mismatch, concurrent-window/logout/takeover
isolation, multi-monitor input, installer/update behavior. This build fixes
fresh-profile config persistence only; it does not certify those workflows.
Do not publish these packages as an automatic production update.

First-session checks on two authorized Windows devices:
1. Enroll the Agent and accept the displayed access permissions.
2. Sign into Admin with an existing authorized technician account.
3. Verify the device appears, then start an authorized viewing session.
4. Verify separate viewing/control permissions, first frame and input response.
5. End the session and confirm sharing/control stop; verify local stop/revocation.
6. Check reconnect, takeover and a network requiring TURN relay.
Report the exact error and time if a check fails; never share keys or passwords.

If an older installed Agent is already running, close it normally first or use
a separate verification device. Do not remove its data or bypass a local stop.
"""
    instructions = {
        "agent": """
AGENT
Launch Start-Agent.cmd. It explicitly selects the production address, including
on a PC with older saved configuration. This updates the Agent's saved API URL.
The Agent displays its authorization UI; no permissions are bypassed.
Use the visible Agent window to stop access. No license or account is bundled.
""",
        "admin": """
ADMIN
Double-click ConnectLiveAdmin.exe. Keep admin.config.json beside it.
The configuration contains only a PUBLIC Supabase key, not a service-role key.
Sign in with your technician credentials; no password is bundled.
Do not copy any server, SMTP, session or Cloudflare credential into this file.
""",
    }
    (OUT / "agent/Start-Agent.cmd").write_bytes(
        b'@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0ConnectLive.exe" --api-url https://connectliveagent.com\r\n')
    manifest = []
    for side, exe, name in [
        ("agent", "ConnectLive.exe", "ConnectLive-Agent-Windows-x64"),
        ("admin", "ConnectLiveAdmin.exe", "ConnectLive-Admin-Windows-x64"),
    ]:
        directory = OUT / side
        binary = (directory / exe).read_bytes()
        assert binary[:2] == b"MZ", "Missing Windows executable"
        pe = struct.unpack_from("<I", binary, 0x3C)[0]
        assert binary[pe:pe+4] == b"PE\0\0"
        assert struct.unpack_from("<H", binary, pe+4)[0] == 0x8664, "Not x64"
        assert len(binary) > 50_000_000, "Expected self-contained publish"
        (directory / "README.txt").write_text(common + instructions[side])
        (directory / "SOURCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
        files = sorted(p for p in directory.iterdir()
                       if p.is_file() and p.suffix != ".pdb" and p.name != "SHA256SUMS.txt")
        assert {p.name for p in files} == (
            {exe, "Start-Agent.cmd", "README.txt", "SOURCE.json"} if side == "agent"
            else {exe, "admin.config.json", "README.txt", "SOURCE.json"}
        ), "Unexpected publish contents; review before packaging"
        sums = "".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files)
        (directory / "SHA256SUMS.txt").write_text(sums)
        files.append(directory / "SHA256SUMS.txt")
        archive = OUT / (name + ".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for p in files:
                z.write(p, name + "/" + p.name)
        with zipfile.ZipFile(archive) as z:
            assert z.testzip() is None
            assert len(z.namelist()) == len(files)
            for p in files:
                assert hashlib.sha256(z.read(name + "/" + p.name)).hexdigest() == hashlib.sha256(p.read_bytes()).hexdigest()
        manifest.append({"file": archive.name, "bytes": archive.stat().st_size,
                         "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                         "platform": "win-x64", "version": "1.9.2" if side == "agent" else "1.7.3",
                         "source": provenance, "signed": False, "windowsRuntimeVerified": False})
    (OUT / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps([{k: v for k, v in item.items() if k != "source"} for item in manifest], indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Transport and config exceptions can include key-bearing request details.
        print("Packaging failed (" + type(exc).__name__ + "); no credentials logged.")
        raise SystemExit(1)
