using System;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Polls <c>session_cursors</c> at 5 Hz and hands the latest sample to a UI
/// callback — mirror of the web console's cursor overlay so the native
/// admin also sees the target machine's real pointer position on top of
/// the frame stream.
/// </summary>
public sealed class CursorPollPump
{
    private readonly string _sessionId;
    private readonly Action<Api.ApiClient.CursorSample?> _onSample;
    private readonly Action<string>? _onError;

    public CursorPollPump(string sessionId,
        Action<Api.ApiClient.CursorSample?> onSample,
        Action<string>? onError = null)
    {
        _sessionId = sessionId;
        _onSample = onSample;
        _onError = onError;
    }

    public void Start(CancellationToken ct) => _ = Task.Run(() => Loop(ct), CancellationToken.None);

    private async Task Loop(CancellationToken ct)
    {
        int failures = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var s = await App.Api.PollSessionCursorAsync(_sessionId, ct);
                _onSample(s);
                failures = 0;
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                failures++;
                if (failures == 3) _onError?.Invoke("Cursor poll: " + ex.Message);
            }
            try { await Task.Delay(failures > 0 ? 2000 : 200, ct); } catch { }
        }
    }
}
