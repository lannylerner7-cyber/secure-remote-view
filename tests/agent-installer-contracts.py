"""Static source contracts only: this does not execute Windows Installer."""
import ast
from pathlib import Path
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
agent = root / "agent"
xml = ET.parse(agent / "packaging/msi/ConnectLive.wxs")
ns = {"w": "http://wixtoolset.org/schemas/v4/wxs"}
package = xml.find("w:Package", ns)
assert package is not None and package.attrib["Scope"] == "perMachine"
assert package.attrib["Version"] == "$(var.Version)"
files = {item.attrib["Source"].replace("\\", "/").split("/")[-1] for item in xml.findall(".//w:File", ns)}
assert files == {"ConnectLive.exe", "ConnectLiveWatch.exe", "ConnectLiveUpdate.exe"}
assert not xml.findall(".//w:ServiceInstall", ns), "No installer-added capture service"
marker = next(item for item in xml.findall(".//w:RegistryValue", ns) if item.attrib.get("Name") == "UninstallRequested")
assert marker.attrib["Type"] == "string" and marker.attrib["Value"] == "none"
actions = {item.attrib["Id"]: item for item in xml.findall(".//w:CustomAction", ns)}
assert "[INSTALLDIR]." in actions["MarkRemoval"].attrib["ExeCommand"]
assert actions["WithdrawCurrentUser"].attrib["ExeCommand"] == "/uninstall"
assert actions["WithdrawCurrentUser"].attrib["Impersonate"] == "yes"
conditions = {item.attrib["Action"]: item.attrib["Condition"] for item in xml.findall(".//w:Custom", ns)}
for name in ("MarkRemoval", "RollbackRemovalMarker", "WithdrawCurrentUser"):
    assert 'REMOVE="ALL"' in conditions[name] and "NOT UPGRADINGPRODUCTCODE" in conditions[name]
for item in xml.findall(".//w:RemoveRegistryValue", ns):
    assert "Action" not in item.attrib, "WiX v4 RemoveRegistryValue has no Action attribute"
inno = (agent / "packaging/inno/ConnectLiveSetup.iss").read_text()
assert all(name in inno for name in files)
assert 'Parameters: "/uninstall"' in inno
build = (agent / "build.ps1").read_text()
assert "dotnet tool restore" in build and "Invoke-PinnedWix" in build
assert "WixToolset.Firewall.wixext/4.0.6" in build
assert "OpenDatabase" in build and "ProductCode" in build
assert "Compress-Archive -Path $zipItems" in build, "No wildcard distribution of stale outputs"
startup = (agent / "src/StartupSelfHeal.cs").read_text()
assert 'E("ExecutionTimeLimit", "PT0S")' in startup
assert 'E("Hidden", "true")' not in startup  # Task Scheduler's default is visible.
assert 'E("WakeToRun", "false")' in startup
assert 'E("RunLevel", "LeastPrivilege")' in startup
ast.parse((root / "scripts/package-native-source.py").read_text())
print("Agent installer XML, companion inventory, withdrawal guards, startup and packaging contracts passed.")
print("NOT a PowerShell execution, MSI compilation, installation or Windows recovery test.")
