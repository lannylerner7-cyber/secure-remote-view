using System;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Polls <c>session_cursors</c> and hands the latest sample to a UI callback
/// — mirror of the web console's cursor overlay so the native admin also
/// sees the target machine's real pointer position on top of the frame
/// stream.
///
/// Uses the same `updated_at` short-circuit as the frame pump: the server
/// returns nothing when the pointer hasn't moved, so an idle session costs a
/// near-empty response instead of a full row every 200 ms.
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

    private const int FastDelayMs = 100;
    private const int IdleDelayMs = 500;
    private const int ErrorDelayMs = 2000;


    private async Task Loop(CancellationToken ct)
    {
        int failures = 0;
        int idle = 0;
        string? since = null;

        while (!ct.IsCancellationRequested)
        {
            int delay = FastDelayMs;
            try
            {
                var s = await App.Api.PollSessionCursorAsync(_sessionId, since, ct).ConfigureAwait(false);
                if (s != null)
                {
                    if (!string.IsNullOrEmpty(s.UpdatedAt)) since = s.UpdatedAt;
                    _onSample(s);
                    idle = 0;
                }
                else
                {
                    idle++;
                    delay = idle > 10 ? IdleDelayMs : FastDelayMs;
                }
                failures = 0;
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                failures++;
                if (failures == 3) _onError?.Invoke("Cursor poll: " + ex.Message);
                delay = ErrorDelayMs;
            }

            try { await Task.Delay(delay, ct).ConfigureAwait(false); } catch { return; }
        }
    }
}
