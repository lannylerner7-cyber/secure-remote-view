using ConnectLive.Agent;
using System.Collections.Concurrent;

var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var latest = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var seen = new ConcurrentQueue<int>();
await using (var pump = new LatestWorkPump<int>(async (value, ct) =>
{
    seen.Enqueue(value);
    if (value == 1) { started.SetResult(); await release.Task.WaitAsync(ct); }
    if (value == 100) latest.SetResult();
}, CancellationToken.None))
{
    if (!pump.Offer(1)) throw new Exception("First frame rejected");
    await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
    for (int i = 2; i <= 100; i++)
        if (!pump.Offer(i)) throw new Exception("Producer blocked/rejected while upload pending");
    release.SetResult();
    await latest.Task.WaitAsync(TimeSpan.FromSeconds(5));
    if (!seen.ToArray().SequenceEqual(new[] { 1, 100 }))
        throw new Exception("Stale queued frames were replayed");
}
var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using var revoked = new CancellationTokenSource();
var cancelled = new LatestWorkPump<int>(async (_, ct) =>
{
    entered.SetResult();
    await Task.Delay(Timeout.Infinite, ct);
}, revoked.Token);
cancelled.Offer(1);
await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
cancelled.Offer(2);
revoked.Cancel();
await cancelled.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
if (cancelled.Offer(3)) throw new Exception("Accepted work after revocation");
Console.WriteLine("PASS: nonblocking producer, latest-only pending frame, cancellation and post-stop rejection");
