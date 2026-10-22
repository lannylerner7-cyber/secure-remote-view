"""Inventory native source coverage without implying unreviewed files were tested."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
app = root / "."
reviewed = {
    "agent/src/LatestWorkPump.cs": "reviewed; linked implementation exercised by .NET regression",
    "agent/src/ScreenCapture.cs": "reviewed upload/capture path; compiled; Windows runtime unverified",
    "agent/src/DxgiCapture.cs": "reviewed display selection/acquire/release; compiled; Windows runtime unverified",
    "agent/src/CurtainOverlay.cs": "reviewed display failure cleanup; compiled; Windows runtime unverified",
    "agent/src/InputRelay.cs": "reviewed curtain dispatch only; compiled",
    "admin/src/ViewModels/LiveSessionViewModel.cs": "reviewed lifecycle/reconnect/curtain paths; compiled",
    "admin/src/Input/InputTransport.cs": "reviewed payload/cancellation/stale callbacks; linked implementation regression tested",
    "admin/src/Api/ApiClient.cs": "reviewed active-only reconnect and mode update contract; compiled",
    "agent/packaging/gpo/install-gpo.ps1": "reviewed actual ProductCode detection and exit propagation; Windows execution unverified",
    "agent/packaging/intune/intune-app.json": "reviewed generated metadata placeholders; Windows execution unverified",
    "agent/build.ps1": "reviewed version/staging/signing target selection; static checks only",
    "agent/packaging/msi/build-msi.ps1": "reviewed wrapper; not executed on Windows",
    "agent/packaging/msi/ConnectLive.wxs": "inspected version and identity only; MSI unverified",
    "admin/build.ps1": "inspected build/dependency paths; packaging not executed",
    "agent/src/WebRtcSession.cs": "reviewed native curtain acknowledgement path; compiled; negotiation/recovery inspected only",
    "admin/src/Media/WebRtcClient.cs": "inspected negotiation/recovery; no runtime certification",
}
rows = []
for side in ("agent", "admin"):
    for file in sorted((app / side).rglob("*")):
        if not file.is_file() or any(part in {"bin", "obj", "dist", "publish", ".git"} for part in file.parts):
            continue
        name = file.relative_to(app).as_posix()
        rows.append({"path": name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                     "coverage": reviewed.get(name, "inventoried only; not semantically reviewed in this pass")})
out = root / "generated-artifacts/native-source-review"
out.mkdir(parents=True, exist_ok=True)
(out / "coverage.json").write_text(json.dumps(rows, indent=2) + "\n")
print(f"Inventoried {len(rows)} files; {len(reviewed)} have scoped review notes. Others explicitly unreviewed.")
