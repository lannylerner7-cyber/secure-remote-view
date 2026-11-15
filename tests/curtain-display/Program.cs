using ConnectLive.Agent;
using System.ComponentModel;

int checks = 0;
void Check(bool condition, string label)
{
    if (!condition) throw new Exception(label);
    checks++;
    Console.WriteLine("PASS " + label);
}
static Task<CurtainApplyResult> Finish(Task<CurtainApplyResult> task) =>
    task.WaitAsync(TimeSpan.FromSeconds(3));

var empty = new CurtainDisplaySession(() => Array.Empty<ICurtainSurface>());
Check((await Finish(empty.ShowRenderedAsync())).Reason == "display_unavailable" && !empty.IsShown,
    "no displays fails without announcing a curtain");

foreach (string reason in new[] { "display_style_failed", "display_placement_failed",
    "capture_exclusion_failed", "capture_exclusion_unverified", "composition_unavailable" })
{
    var first = new FakeSurface();
    var second = new FakeSurface { Prepared = CurtainApplyResult.Failed(reason, 87) };
    var display = new CurtainDisplaySession(() => new[] { first, second });
    var result = await Finish(display.ShowRenderedAsync());
    Check(!result.Applied && result.Reason == reason && result.NativeError == 87,
        $"hidden-window {reason} preserves its exact rejection");
    Check(first.ShowCalls == 0 && second.ShowCalls == 0 && first.Disposed && second.Disposed &&
          display.WindowCount == 0 && !display.IsShown,
        $"hidden-window {reason} disposes every prepared monitor before any Show");
}

var events = new List<string>();
var left = new FakeSurface { PaintOnShow = false };
var right = new FakeSurface { PaintOnShow = false };
var session = new CurtainDisplaySession(() => new[] { left, right });
left.Preparing = () => events.Add("prepare-left");
right.Preparing = () => events.Add("prepare-right");
left.Showing = () =>
{
    Check(session.IsShown && !session.TryRunWhileHidden(() => throw new Exception("unsafe copy")),
        "fallback is blocked before the first window can become visible");
    events.Add("show-left");
};
right.Showing = () => events.Add("show-right");
var pending = session.ShowRenderedAsync();
Check(events.SequenceEqual(new[] { "prepare-left", "prepare-right", "show-left", "show-right" }),
    "all hidden windows are prepared before any window is shown");
Check(!pending.IsCompleted && left.VerifyCalls == 0 && right.VerifyCalls == 0,
    "activation does not acknowledge an unpainted display");
Check((await Finish(session.ShowRenderedAsync())).Reason == "activation_busy",
    "a concurrent activation cannot duplicate pending windows");
left.Paint.TrySetResult(true);
Check(!pending.IsCompleted, "painting one monitor does not acknowledge all monitors");
right.Paint.TrySetResult(true);
Check((await Finish(pending)).Applied && left.VerifyCalls == 1 && right.VerifyCalls == 1,
    "all first paints precede post-render verification and success");
Check(!session.TryRunWhileHidden(() => throw new Exception("unsafe copy")),
    "GDI fallback cannot run while the curtain is active");
left.Closing = () => Check(session.IsShown &&
    !session.TryRunWhileHidden(() => throw new Exception("teardown copy")),
    "capture remains blocked while windows are being closed");
session.Hide();
Check(left.Disposed && right.Disposed && !session.IsShown && session.WindowCount == 0,
    "off closes and disposes every monitor before announcing hidden");
int copies = 0;
Check(session.TryRunWhileHidden(() => copies++) && copies == 1,
    "fallback can resume only after cleanup completes");
session.Hide();
Check(!session.IsShown, "repeated cleanup is harmless");

foreach (string reason in new[] { "display_style_failed", "display_placement_failed",
    "capture_exclusion_unverified", "composition_unavailable", "display_unavailable" })
{
    var a = new FakeSurface();
    var b = new FakeSurface { Verified = CurtainApplyResult.Failed(reason, 5) };
    var display = new CurtainDisplaySession(() => new[] { a, b });
    var result = await Finish(display.ShowRenderedAsync());
    Check(!result.Applied && result.Reason == reason && result.NativeError == 5 &&
          a.Disposed && b.Disposed && !display.IsShown,
        $"post-render {reason} tears down the entire activation");
}

var shownA = new FakeSurface();
var shownB = new FakeSurface { Shown = CurtainApplyResult.Failed("display_placement_failed", 87) };
var failedShow = new CurtainDisplaySession(() => new[] { shownA, shownB });
Check((await Finish(failedShow.ShowRenderedAsync())).Reason == "display_placement_failed" &&
      shownA.Disposed && shownB.Disposed && !failedShow.IsShown,
    "a failure after the first Show also removes every monitor");

var unpainted = new FakeSurface { PaintOnShow = false };
var timeout = new CurtainDisplaySession(() => new[] { unpainted }, TimeSpan.FromMilliseconds(25));
Check((await Finish(timeout.ShowRenderedAsync())).Reason == "display_render_timeout" &&
      unpainted.Disposed && !timeout.IsShown,
    "render timeout disposes the notice and never acknowledges success");

var thrown = new FakeSurface();
IEnumerable<ICurtainSurface> ThrowingFactory()
{
    yield return thrown;
    throw new Win32Exception(8);
}
var factoryFailure = new CurtainDisplaySession(ThrowingFactory);
var exception = await Finish(factoryFailure.ShowRenderedAsync());
Check(exception.Reason == "display_render_failed" && exception.NativeError == 8 &&
      thrown.Disposed && thrown.ShowCalls == 0,
    "a construction exception preserves native error and cleans earlier monitors");

var old = new FakeSurface { PaintOnShow = false, CancelPaintOnDispose = false };
var replacement = new FakeSurface();
var next = old;
var generation = new CurtainDisplaySession(() => new[] { next });
var oldActivation = generation.ShowRenderedAsync();
generation.Hide();
next = replacement;
Check((await Finish(generation.ShowRenderedAsync())).Applied, "a fresh explicit activation can replace a cancelled one");
old.Paint.TrySetResult(true);
Check((await Finish(oldActivation)).Reason == "activation_cancelled" &&
      generation.IsShown && !replacement.Disposed && old.VerifyCalls == 0,
    "late old painting cannot verify, hide, or clear a replacement activation");
generation.Hide();

var closeFailure = new FakeSurface { ThrowClose = true };
var closeSession = new CurtainDisplaySession(() => new[] { closeFailure });
await Finish(closeSession.ShowRenderedAsync());
closeSession.Hide();
Check(closeFailure.Disposed && !closeSession.IsShown,
    "Dispose still runs when Close throws");

var survivor = new FakeSurface { ThrowClose = true, ThrowDispose = true };
var survivorSession = new CurtainDisplaySession(() => new[] { survivor });
await Finish(survivorSession.ShowRenderedAsync());
survivorSession.Hide();
Check(survivorSession.IsShown && survivorSession.WindowCount == 1 &&
      !survivorSession.TryRunWhileHidden(() => throw new Exception("orphan copy")),
    "unconfirmed cleanup retains the surface and continues blocking capture");
Check((await Finish(survivorSession.ShowRenderedAsync())).Reason == "activation_busy",
    "a surviving window is not silently forgotten during reactivation");
survivor.ThrowClose = survivor.ThrowDispose = false;
survivorSession.Hide();
Check(!survivorSession.IsShown && survivor.Disposed,
    "failed cleanup remains retryable");

// Exercise the real gate: preparation may run during a prior GDI copy, but
// showing the first notice must wait until that copy exits.
using var copying = new ManualResetEventSlim();
using var prepared = new ManualResetEventSlim();
using var releaseCopy = new ManualResetEventSlim();
int inCopy = 0, overlapped = 0;
var gatedSurface = new FakeSurface
{
    Preparing = () => prepared.Set(),
    Showing = () => { if (Volatile.Read(ref inCopy) != 0) Interlocked.Exchange(ref overlapped, 1); },
};
var gated = new CurtainDisplaySession(() => new[] { gatedSurface });
var copyTask = Task.Run(() => gated.TryRunWhileHidden(() =>
{
    Volatile.Write(ref inCopy, 1);
    copying.Set();
    if (!releaseCopy.Wait(TimeSpan.FromSeconds(3))) throw new Exception("copy gate timeout");
    Volatile.Write(ref inCopy, 0);
}));
Check(copying.Wait(TimeSpan.FromSeconds(3)), "a fallback copy entered its protected interval");
var activationTask = Task.Run(gated.ShowRenderedAsync);
Check(prepared.Wait(TimeSpan.FromSeconds(3)), "hidden preparation can proceed without showing over an in-flight copy");
releaseCopy.Set();
Check(await copyTask && (await Finish(activationTask)).Applied && overlapped == 0,
    "first Show and an already-started fallback copy cannot overlap");
gated.Hide();

Check((CurtainNative.RequiredExStyles & CurtainNative.WS_EX_LAYERED) != 0 &&
      (CurtainNative.RequiredExStyles & CurtainNative.WS_EX_TRANSPARENT) != 0 &&
      (CurtainNative.RequiredExStyles & CurtainNative.WS_EX_NOACTIVATE) != 0,
    "production creation styles retain layered, click-through and no-activation bits");
Check(CurtainApplyResult.Failed("display_style_failed", -1).NativeError == null &&
      CurtainApplyResult.Failed("display_style_failed", 87).NativeError == 87,
    "native diagnostic metadata remains bounded");
Console.WriteLine($"{checks} checks passed against the production display lifecycle/native declarations.");
Console.WriteLine("NO Windows Forms, DWM, display affinity, screen capture, or input hooks were executed.");

internal sealed class FakeSurface : ICurtainSurface
{
    internal CurtainApplyResult Prepared = CurtainApplyResult.Success;
    internal CurtainApplyResult Shown = CurtainApplyResult.Success;
    internal CurtainApplyResult Verified = CurtainApplyResult.Success;
    internal bool PaintOnShow = true, CancelPaintOnDispose = true, ThrowClose, ThrowDispose;
    internal bool Disposed;
    internal int ShowCalls, VerifyCalls;
    internal Action? Preparing, Showing, Closing;
    internal readonly TaskCompletionSource<bool> Paint = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public bool IsVisible { get; private set; }
    public Task Rendered => Paint.Task;
    public CurtainApplyResult Prepare() { Preparing?.Invoke(); return Prepared; }
    public CurtainApplyResult ShowAndRender()
    {
        Showing?.Invoke();
        ShowCalls++;
        IsVisible = true;
        if (PaintOnShow) Paint.TrySetResult(true);
        return Shown;
    }
    public CurtainApplyResult VerifyAfterRender() { VerifyCalls++; return Verified; }
    public void Close()
    {
        Closing?.Invoke();
        if (ThrowClose) throw new InvalidOperationException("simulated close failure");
        IsVisible = false;
    }
    public void Dispose()
    {
        if (ThrowDispose) throw new InvalidOperationException("simulated dispose failure");
        IsVisible = false;
        Disposed = true;
        if (CancelPaintOnDispose) Paint.TrySetCanceled();
    }
}

namespace ConnectLive.Agent
{
    internal static class Log { internal static void Warn(string message) { } }
}
