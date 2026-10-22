using System;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>One in-flight operation plus one replaceable pending item. Never queues old frames.</summary>
internal sealed class LatestWorkPump<T> : IAsyncDisposable
{
    private readonly Channel<T> _pending = Channel.CreateBounded<T>(new BoundedChannelOptions(1)
    {
        SingleReader = true,
        SingleWriter = true,
        FullMode = BoundedChannelFullMode.DropOldest,
    });
    private readonly CancellationTokenSource _stop;
    private readonly Task _worker;

    public LatestWorkPump(Func<T, CancellationToken, Task> consume, CancellationToken lifetime)
    {
        _stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        _worker = Task.Run(async () =>
        {
            try
            {
                await foreach (var item in _pending.Reader.ReadAllAsync(_stop.Token))
                {
                    _stop.Token.ThrowIfCancellationRequested();
                    await consume(item, _stop.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        });
    }

    public bool Offer(T item) => !_stop.IsCancellationRequested && !_worker.IsCompleted &&
                                 _pending.Writer.TryWrite(item);

    public async ValueTask DisposeAsync()
    {
        _pending.Writer.TryComplete();
        _stop.Cancel();
        try { await _worker.ConfigureAwait(false); }
        finally
        {
            while (_pending.Reader.TryRead(out _)) { }
            _stop.Dispose();
        }
    }
}
