const fs = require("node:fs");
const assert = require("node:assert/strict");
const root = "";
const read = file => fs.readFileSync(root + file, "utf8");
const capture = read("agent/src/ScreenCapture.cs");
assert.ok(capture.includes("LatestWorkPump<"));
assert.ok(capture.includes("permission.Token"));
assert.ok(capture.includes("uploads!.Offer("));
assert.ok(capture.includes("videoOnly ? null : new LatestWorkPump<"),
  "Video-only sessions must not create an HTTP/JPEG upload worker");
assert.ok(capture.includes("if (!videoOnly)"), "JPEG encoding remains gated to legacy sessions");
assert.ok(!capture.slice(capture.indexOf('while (!ct.IsCancellationRequested')).includes("await api.PostFrameAsync"),
  "Capture loop must not await HTTP fallback");
const dxgi = read("agent/src/DxgiCapture.cs");
assert.ok(dxgi.includes("if (frameAcquired)"));
assert.ok(!dxgi.includes("return TryBuildDefault();"));
const build = read("agent/build.ps1");
assert.ok(build.includes("-p:Version=$Version"));
assert.ok(build.includes("$parts[2] -gt 65535"));
assert.ok(build.includes("$zipItems = @($builtInstallers)"));
assert.ok(!build.includes('$now.ToString("yyMMdd")'));
const admin = read("admin/src/ViewModels/LiveSessionViewModel.cs");
assert.ok(admin.includes("Interlocked.Exchange(ref _started, 1)"));
assert.ok(admin.includes("Interlocked.Exchange(ref _stopped, 1)"));
assert.ok(admin.includes("_reconnectGate.WaitAsync(0)"));
assert.ok(admin.includes("finally { _reconnectGate.Release(); }"));
const input = read("admin/src/Input/InputTransport.cs");
assert.ok(input.includes("JsonSerializer.Serialize(new { kind, payload })"));
assert.ok(input.includes("ct.ThrowIfCancellationRequested()"));
assert.ok(input.includes("ReferenceEquals(_dc, dc)"));
const api = read("admin/src/Api/ApiClient.cs");
const resume = api.split("public async Task ResumeSessionAsync")[1].split("// Push an input event")[0];
assert.ok(resume.includes("&state=eq.active"));
assert.ok(!resume.includes('state = "active"'));
assert.ok(resume.includes("GetArrayLength() != 1"));
assert.ok(read("agent/packaging/gpo/install-gpo.ps1").includes("$process.ExitCode"));
const vp8 = read("agent/src/Vp8FrameEncoder.cs");
const release = vp8.split("private void ReleaseEncoder()")[1].split("public void Dispose()")[0];
assert.ok(release.indexOf("_encoder = null") < release.indexOf("encoder.Dispose()"),
  "Detach partially initialized encoders before native cleanup");
assert.ok(/try\s*\{\s*encoder\.Dispose\(\);\s*\}\s*catch\s*\(Exception ex\)/.test(release),
  "Failed VP8 cleanup must not escape the probe and block H.264");
assert.ok(!vp8.includes("_encoder?.Dispose()"), "All VP8 cleanup must use the guarded path");
assert.ok(vp8.split("public void Dispose()")[1].includes("ReleaseEncoder();"));
const rtc = read("agent/src/WebRtcSession.cs");
assert.ok(rtc.includes("bool offerH264 = !_h264UnavailableForSession && CodecPolicy.AllowH264;"));
assert.ok(rtc.includes('(_vp8 != null ? "VP8 fallback available" : "VP8 unavailable")'));
assert.ok(!read("agent/src/HwEncoderProbe.cs").includes("wire codec remains VP8"));
console.log("PASS: static capture, DXGI ownership, MSI version/staging, codec cleanup and lifecycle invariants");
