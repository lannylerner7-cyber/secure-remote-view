using ConnectLive.Agent;
using System.Collections.Concurrent;

static void Check(bool value, string label)
{
    if (!value) throw new Exception(label);
    Console.WriteLine("PASS " + label);
}
static TaskCompletionSource<CurtainApplyResult> Receipt() =>
    new(TaskCreationOptions.RunContinuationsAsynchronously);

var dispatcher = System.Windows.Application.Current!.Dispatcher;
var owner = new PeerInputPermission();
var first = Receipt();
CurtainOverlay.Next = Task.FromResult(CurtainApplyResult.Failed("capture_exclusion_failed", 87));
CurtainController.EnableDetailed(owner, value => first.TrySetResult(value));
dispatcher.Drain();
var failure = await first.Task.WaitAsync(TimeSpan.FromSeconds(2));
dispatcher.Drain();
Check(!failure.Applied && failure.Reason == "capture_exclusion_failed" && failure.NativeError == 87,
    "real controller propagates capture-exclusion failure with its Windows error");
Check(InputBlocker.EngageCalls == 0 && !CurtainController.ActiveFor(owner),
    "render/exclusion failure never pauses local input or confirms a curtain");

var render = Receipt();
CurtainOverlay.Next = render.Task;
var pending = Receipt();
CurtainController.EnableDetailed(owner, value => pending.TrySetResult(value));
dispatcher.Drain();
Check(!pending.Task.IsCompleted && InputBlocker.EngageCalls == 0,
    "controller waits for actual rendering before engaging input");
CurtainController.Release(owner, "cancelled");
dispatcher.Drain();
var replacement = Receipt();
CurtainOverlay.Next = Task.FromResult(CurtainApplyResult.Success);
CurtainController.EnableDetailed(owner, value => replacement.TrySetResult(value));
dispatcher.Drain();
Check((await replacement.Task.WaitAsync(TimeSpan.FromSeconds(2))).Applied &&
      CurtainController.ActiveFor(owner), "a fresh explicit activation can succeed");
render.SetResult(CurtainApplyResult.Failed("activation_cancelled"));
Check(!(await pending.Task.WaitAsync(TimeSpan.FromSeconds(2))).Applied,
    "late cancelled render never acknowledges success");
dispatcher.Drain();
Check(CurtainController.ActiveFor(owner), "late completion cannot release a newer activation");

var oldChanges = 0;
CurtainController.Release(owner, "cleanup");
dispatcher.Drain();
var active = Receipt();
CurtainOverlay.Next = Task.FromResult(CurtainApplyResult.Success);
CurtainController.EnableDetailed(owner, value => active.TrySetResult(value),
    (_, _) => oldChanges++);
dispatcher.Drain();
await active.Task.WaitAsync(TimeSpan.FromSeconds(2));
CurtainController.Release(owner, "old_off"); // Leave its hide/notification queued.
var newer = Receipt();
CurtainController.EnableDetailed(owner, value => newer.TrySetResult(value));
dispatcher.Drain();
Check((await newer.Task.WaitAsync(TimeSpan.FromSeconds(2))).Applied &&
      CurtainController.ActiveFor(owner) && oldChanges == 0,
    "an old queued release cannot hide or falsely announce a new curtain");

ConnectLive.Agent.Environment.TickCount64 += CurtainLease.LifetimeMs + 1;
ConnectLive.Agent.Timer.Fire();
dispatcher.Drain();
Check(!CurtainController.ActiveFor(owner) && !InputBlocker.IsEngaged && !CurtainOverlay.IsShown,
    "five-second lease expiry still restores input and removes the curtain");
Check(!CurtainController.Renew(owner), "renewal cannot reactivate an expired curtain");

InputBlocker.LocalStopPending = true;
var stopped = Receipt();
CurtainController.EnableDetailed(owner, value => stopped.TrySetResult(value));
Check((await stopped.Task).Reason == "local_stop" && !InputBlocker.IsEngaged,
    "local stop rejects activation");
InputBlocker.LocalStopPending = false;
owner.Allowed = false;
var denied = Receipt();
CurtainController.EnableDetailed(owner, value => denied.TrySetResult(value));
Check((await denied.Task).Reason == "authorization_changed",
    "withdrawn control authorization is never bypassed");
owner.Allowed = true;
dispatcher.HasShutdownStarted = true;
var unavailable = Receipt();
CurtainController.EnableDetailed(owner, value => unavailable.TrySetResult(value));
Check((await unavailable.Task).Reason == "ui_unavailable",
    "a stopped Windows UI dispatcher fails explicitly");
Console.WriteLine("Real controller/lease compiled and exercised with inert adapters. NOT a Windows rendering or hook test.");

namespace ConnectLive.Agent
{
    internal static class OperatingSystem
    { public static bool IsWindowsVersionAtLeast(int major, int minor, int build) => true; }
    internal static class Environment { internal static long TickCount64 = 100; }
    internal sealed class Timer
    {
        private static Action<object?>? _tick;
        public Timer(Action<object?> tick, object? state, int due, int period) => _tick = tick;
        internal static void Fire() => _tick?.Invoke(null);
    }
    internal sealed class PeerInputPermission
    {
        internal bool Allowed = true;
        internal bool Allows(string capability) => Allowed && capability == "control";
    }
    internal static class CurtainOverlay
    {
        internal static Task<CurtainApplyResult> Next = Task.FromResult(CurtainApplyResult.Success);
        internal static bool IsShown;
        internal static async Task<CurtainApplyResult> ShowRenderedAsync()
        {
            var result = await Next;
            if (result.Applied) IsShown = true;
            return result;
        }
        internal static void Hide() => IsShown = false;
    }
    internal static class InputBlocker
    {
        internal static bool LocalStopPending, IsEngaged;
        internal static int EngageCalls;
        private static Action<string>? _released;
        internal static bool Engage(Action<string> released)
        { EngageCalls++; IsEngaged = true; _released = released; return true; }
        internal static void Heartbeat() { }
        internal static void Release(string reason)
        { IsEngaged = false; var released = _released; _released = null; released?.Invoke(reason); }
    }
    internal static class InputRelay { internal static void ReleaseHeldInputs() { } }
    internal static class Log { internal static void Info(string text) { } internal static void Warn(string text) { } }
    public sealed class TestDispatcher
    {
        public bool HasShutdownStarted, HasShutdownFinished;
        private readonly ConcurrentQueue<Action> _queued = new();
        public void BeginInvoke(Action work) => _queued.Enqueue(work);
        public void Drain() { while (_queued.TryDequeue(out var work)) work(); }
    }
}
namespace System.Windows
{
    public sealed class Application
    {
        public static Application? Current { get; set; } = new();
        public ConnectLive.Agent.TestDispatcher Dispatcher { get; } = new();
    }
}
namespace Microsoft.Win32
{
    internal static class SystemEvents
    {
        public static event EventHandler? DisplaySettingsChanging { add { } remove { } }
    }
}
