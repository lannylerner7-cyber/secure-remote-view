using ConnectLive.Agent;

int startupCleanup = 0;
var uncertainStartup = new InputPauseGate(() => { startupCleanup++; return false; });
Check(startupCleanup == 1 && uncertainStartup.State.Paused && !uncertainStartup.State.ReleaseConfirmed,
    "a fresh gate proves cleanup instead of assuming old held input was released");
var throwingStartup = new InputPauseGate(() => throw new InvalidOperationException("synthetic cleanup failure"));
Check(throwingStartup.State.Paused && !throwingStartup.State.ReleaseConfirmed,
    "startup cleanup exceptions remain closed and unconfirmed");

int released = 0, applied = 0;
bool authority = true, releaseWorks = true;
var root = new PeerInputPermission("control", new(true, true, true, true, true), () => authority,
    releaseInputs: () => { released++; return releaseWorks; });
var peer = root.Fork();
var initial = root.InputState;
Check(initial.Paused && !peer.TryApplyInput(initial.Epoch, () => applied++),
    "new receiver is closed even when server mode is control");
root.SetMode("control");
Check(root.InputState.Paused, "heartbeat/mode refresh does not resume input");
Check(peer.ResumeInput(initial.Epoch, initial.Revision), "explicit current resume opens the shared gate");
var first = root.InputState;
Check(first.Epoch != initial.Epoch && !first.Paused, "resume rotates the input generation");
Check(peer.TryApplyInput(first.Epoch, () => applied++) && root.TryApplyInput(first.Epoch, () => applied++),
    "direct peer and fallback share the same input barrier");
Check(!peer.TryApplyInput(null, () => applied++), "untagged input cannot enter the new receiver");
Check(peer.PauseInput(first.Epoch, first.Revision), "pause is confirmed after cleanup");
Check(root.InputState.OperatorPaused && released >= 2 && root.Allows("view") && root.Allows("control"),
    "pause preserves viewing and curtain/control permission while restricting only injection");
Check(!root.TryApplyInput(first.Epoch, () => applied++), "fallback is blocked by a peer pause");
foreach (var kind in new[] { "mousemove", "mousemove_rel", "mousedown", "mouseup", "click", "wheel",
    "keydown", "keyup", "text", "unicode_text", "key_sequence" })
{
    var warnings = Log.Warnings;
    using var message = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new {
        kind, payload = new { input_epoch = first.Epoch, vk = 65, button = 0, text = "synthetic", x = .5, y = .5,
            events = new[] { new { vk = 65, down = true } } },
    }));
    InputRelay.Apply(message.RootElement, peer);
    Check(Log.Warnings == warnings, "actual input dispatcher blocks " + kind + " before any Windows call");
}
var blocked = root.InputState;
Check(peer.ResumeInput(blocked.Epoch, blocked.Revision), "deliberate resume uses the current paused generation");
Check(!peer.TryApplyInput(first.Epoch, () => applied++), "pre-pause queued input is not replayed after resume");
var active = root.InputState;
Check(peer.PauseInput(active.Epoch, active.Revision), "pause before stale resume test");
var staleResume = root.InputState;
Check(peer.PauseInput(staleResume.Epoch, staleResume.Revision), "new pause cancels an outstanding resume generation");
Check(!peer.ResumeInput(staleResume.Epoch, staleResume.Revision), "late server result cannot reopen a newer pause");
var ready = root.InputState;
Check(peer.ResumeInput(ready.Epoch, ready.Revision), "fresh explicit resume still works");

using var entered = new ManualResetEventSlim();
using var finishInput = new ManualResetEventSlim();
var beforeDrain = root.InputState;
var input = Task.Run(() => peer.TryApplyInput(beforeDrain.Epoch, () => {
    entered.Set();
    if (!finishInput.Wait(3000)) throw new Exception("Test failed to release the input callback");
    Interlocked.Increment(ref applied);
}));
Check(entered.Wait(3000), "a real input callback entered the execution barrier");
var pausing = Task.Run(() => peer.PauseInput(beforeDrain.Epoch, beforeDrain.Revision));
Check(!pausing.Wait(100), "pause cannot acknowledge while admitted native input is running");
finishInput.Set();
Check(await input && await pausing, "pause finishes only after admitted input has drained");
Check(root.InputState.Paused, "receiver remains paused after the execution barrier");

releaseWorks = false;
var failed = root.InputState;
Check(!peer.PauseInput(failed.Epoch, failed.Revision) && !root.InputState.ReleaseConfirmed,
    "failed held-key release cannot produce a successful pause acknowledgment");
failed = root.InputState;
Check(!peer.ResumeInput(failed.Epoch, failed.Revision) && root.InputState.Paused,
    "resume cannot open over an unconfirmed held-input release");
releaseWorks = true;
var recovered = root.InputState;
Check(peer.ResumeInput(recovered.Epoch, recovered.Revision), "explicit retry succeeds after cleanup is possible");
root.SetMode("view", long.MaxValue - 1);
Check(root.InputState.Paused && !root.InputState.OperatorPaused, "view-only closes input and clears only the operator-pause interlock");
Check(!root.SetMode("control", 1), "an older mode observation cannot restore control");
Check(root.InputState.Paused, "stale heartbeat leaves the barrier closed");
authority = false;
var withdrawn = root.InputState;
Check(!peer.ResumeInput(withdrawn.Epoch, withdrawn.Revision), "withdrawn authorization cannot resume");
peer.Revoke();
Check(!peer.TryApplyInput(root.InputState.Epoch, () => applied++), "revoked peer cannot inject input");
Console.WriteLine("Actual receiver guard and execution barrier passed portable checks. No Windows input was injected.");

static void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL " + name);
    Console.WriteLine("PASS " + name);
}
