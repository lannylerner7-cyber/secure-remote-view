using System;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Raw Supabase Realtime v2 client for the admin live view. We subscribe to
/// <c>public.session_frames</c> and <c>public.session_cursors</c> filtered by
/// session_id so a new JPEG or pointer sample lands in the UI without waiting
/// on the next HTTP poll tick.
///
/// The Phoenix wire protocol used by Supabase Realtime is intentionally
/// simple:
///   1. Open ws to <c>wss://&lt;project&gt;/realtime/v1/websocket?apikey=…&amp;vsn=1.0.0</c>.
///   2. Send a <c>phx_join</c> per topic with the postgres_changes config +
///      the technician's access_token so RLS still applies.
///   3. Server pushes <c>postgres_changes</c> frames for INSERT/UPDATE with
///      the row in <c>payload.data.record</c>.
///   4. Send a <c>heartbeat</c> every 25s to keep the socket alive.
///
/// This class only decodes and forwards the payload. The HTTP poll pumps stay
/// wired as a fallback so a flaky Realtime connection never blanks the view.
/// </summary>
public sealed class RealtimeChannel : IAsyncDisposable
{
    private readonly string _sessionId;
    private readonly string _wsUrl;
    private readonly string _apiKey;
    private readonly string? _accessToken;
    private readonly Action<byte[], DateTime>? _onFrameBytes;
    private readonly Action<CursorEvent>? _onCursor;
    private readonly Action<string>? _onError;
    private readonly Action<bool>? _onHealth;

    private ClientWebSocket? _ws;
    private CancellationTokenSource? _cts;
    private int _ref;

    // Join bookkeeping. Supabase answers every phx_join with a phx_reply whose
    // payload.status is "ok" or "error". Before this existed we treated a *sent*
    // join as a *successful* join: an RLS rejection or a bad filter produced a
    // socket that was open, heart-beating and permanently silent, while the UI
    // pill said "Realtime: healthy". Now the channel is only healthy once every
    // topic has replied ok, and any error reply tears the socket down so the
    // reconnect ladder (and the HTTP poll fallback) takes over.
    private readonly System.Collections.Generic.Dictionary<string, string> _pendingJoins = new();
    private readonly object _joinGate = new();
    private TaskCompletionSource<bool>? _joinsDone;
    private string? _joinError;


    public sealed class CursorEvent
    {
        public int X { get; init; }
        public int Y { get; init; }
        public int? FrameW { get; init; }
        public int? FrameH { get; init; }
        public bool Visible { get; init; }
    }

    public RealtimeChannel(
        string supabaseUrl, string apiKey, string? accessToken, string sessionId,
        Action<byte[], DateTime>? onFrameBytes,
        Action<CursorEvent>? onCursor,
        Action<string>? onError = null,
        Action<bool>? onHealth = null)
    {
        _sessionId = sessionId;
        _apiKey = apiKey;
        _accessToken = accessToken;
        _onFrameBytes = onFrameBytes;
        _onCursor = onCursor;
        _onError = onError;
        _onHealth = onHealth;
        var scheme = supabaseUrl.StartsWith("https") ? "wss" : "ws";
        var host = new Uri(supabaseUrl).Host;
        _wsUrl = $"{scheme}://{host}/realtime/v1/websocket?apikey={Uri.EscapeDataString(apiKey)}&vsn=1.0.0";
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _ = Task.Run(() => RunAsync(_cts.Token), CancellationToken.None);
    }

    private async Task RunAsync(CancellationToken ct)
    {
        int backoffMs = 1000;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _ws = new ClientWebSocket();
                _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await _ws.ConnectAsync(new Uri(_wsUrl), ct).ConfigureAwait(false);

                lock (_joinGate)
                {
                    _pendingJoins.Clear();
                    _joinError = null;
                    _joinsDone = new TaskCompletionSource<bool>(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                }

                await JoinAsync("session_frames", ct).ConfigureAwait(false);
                await JoinAsync("session_cursors", ct).ConfigureAwait(false);

                using var hbCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                _ = Task.Run(() => HeartbeatLoop(hbCts.Token), CancellationToken.None);
                var receive = ReceiveLoop(ct);

                // Health is a *reply*, not a send. 10s covers a cold Realtime
                // node; past that the socket is dead weight and we recycle.
                var ack = _joinsDone!.Task;
                var settled = await Task.WhenAny(ack, receive, Task.Delay(10_000, ct))
                    .ConfigureAwait(false);
                if (settled != ack || !await ack.ConfigureAwait(false))
                {
                    hbCts.Cancel();
                    throw new InvalidOperationException(_joinError ?? "join timed out (no phx_reply)");
                }


                _onHealth?.Invoke(true);
                backoffMs = 1000;

                await receive.ConfigureAwait(false);
                hbCts.Cancel();
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { _onError?.Invoke("Realtime: " + ex.Message); }
            finally
            {
                _onHealth?.Invoke(false);
                try { _ws?.Dispose(); } catch { }
                _ws = null;
            }
            if (ct.IsCancellationRequested) return;
            try { await Task.Delay(backoffMs, ct).ConfigureAwait(false); } catch { return; }
            backoffMs = Math.Min(15000, backoffMs * 2);
        }
    }

    private async Task JoinAsync(string table, CancellationToken ct)
    {
        var topic = $"realtime:public:{table}:session_id=eq.{_sessionId}";
        var joinRef = Interlocked.Increment(ref _ref).ToString();
        lock (_joinGate) { _pendingJoins[joinRef] = table; }
        var payload = new
        {
            config = new
            {
                postgres_changes = new object[]
                {
                    new
                    {
                        @event = "*",
                        schema = "public",
                        table,
                        filter = $"session_id=eq.{_sessionId}",
                    }
                },
                broadcast = new { self = false },
                presence = new { key = "" },
                @private = false,
            },
            access_token = _accessToken,
        };
        var msg = new { topic, @event = "phx_join", payload, @ref = joinRef };
        await SendJsonAsync(msg, ct).ConfigureAwait(false);
    }

    /// <summary>Resolve/reject the join gate from a phx_reply or phx_error.</summary>
    private void CompleteJoin(string? joinRef, bool ok, string? reason)
    {
        lock (_joinGate)
        {
            if (joinRef != null && !_pendingJoins.Remove(joinRef, out _)) return;
            if (!ok)
            {
                _joinError = reason ?? "join rejected";
                _joinsDone?.TrySetResult(false);
                // Force the receive loop out so RunAsync recycles the socket.
                try { _ws?.Abort(); } catch { }
                return;
            }
            if (_pendingJoins.Count == 0) _joinsDone?.TrySetResult(true);
        }
    }


    private async Task HeartbeatLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(25), ct).ConfigureAwait(false); } catch { return; }
            if (ct.IsCancellationRequested || _ws?.State != WebSocketState.Open) return;
            var hbRef = Interlocked.Increment(ref _ref).ToString();
            var msg = new { topic = "phoenix", @event = "heartbeat", payload = new { }, @ref = hbRef };
            try { await SendJsonAsync(msg, ct).ConfigureAwait(false); }
            catch { return; }
        }
    }

    private async Task SendJsonAsync(object msg, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(msg);
        var buffer = Encoding.UTF8.GetBytes(json);
        if (_ws == null) return;
        await _ws.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, ct)
            .ConfigureAwait(false);
    }

    private async Task ReceiveLoop(CancellationToken ct)
    {
        var buf = new byte[64 * 1024];
        var acc = new System.IO.MemoryStream();
        while (!ct.IsCancellationRequested && _ws != null && _ws.State == WebSocketState.Open)
        {
            acc.SetLength(0);
            WebSocketReceiveResult res;
            do
            {
                res = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), ct).ConfigureAwait(false);
                if (res.MessageType == WebSocketMessageType.Close) return;
                acc.Write(buf, 0, res.Count);
            } while (!res.EndOfMessage);

            try
            {
                using var doc = JsonDocument.Parse(acc.ToArray());
                HandleFrame(doc.RootElement);
            }
            catch (Exception ex) { _onError?.Invoke("Realtime parse: " + ex.Message); }
        }
    }

    private void HandleFrame(JsonElement root)
    {
        if (!root.TryGetProperty("event", out var evEl)) return;
        var ev = evEl.GetString();
        var msgRef = root.TryGetProperty("ref", out var refEl) ? refEl.GetString() : null;

        if (ev == "phx_reply")
        {
            var status = root.TryGetProperty("payload", out var rp)
                && rp.TryGetProperty("status", out var st) ? st.GetString() : null;
            if (status == "ok") CompleteJoin(msgRef, true, null);
            else
            {
                var reason = root.TryGetProperty("payload", out var rp2)
                    && rp2.TryGetProperty("response", out var rr) ? rr.ToString() : status;
                CompleteJoin(msgRef, false, $"join rejected: {reason}");
            }
            return;
        }
        if (ev == "phx_error" || ev == "phx_close")
        {
            CompleteJoin(msgRef, false, $"channel {ev}");
            return;
        }
        if (ev != "postgres_changes") return;
        if (!root.TryGetProperty("payload", out var payload)) return;

        if (!payload.TryGetProperty("data", out var data)) return;
        if (!data.TryGetProperty("record", out var record) || record.ValueKind != JsonValueKind.Object) return;
        if (!data.TryGetProperty("table", out var tableEl)) return;
        var table = tableEl.GetString();

        if (table == "session_frames" && _onFrameBytes != null)
        {
            if (record.TryGetProperty("frame", out var f) && f.ValueKind == JsonValueKind.String)
            {
                try
                {
                    var bytes = Convert.FromBase64String(f.GetString()!);
                    _onFrameBytes(bytes, DateTime.UtcNow);
                }
                catch (Exception ex) { _onError?.Invoke("Realtime frame decode: " + ex.Message); }
            }
        }
        else if (table == "session_cursors" && _onCursor != null)
        {
            var e = new CursorEvent
            {
                X = record.TryGetProperty("x", out var x) && x.ValueKind == JsonValueKind.Number ? x.GetInt32() : 0,
                Y = record.TryGetProperty("y", out var y) && y.ValueKind == JsonValueKind.Number ? y.GetInt32() : 0,
                FrameW = record.TryGetProperty("frame_w", out var w) && w.ValueKind == JsonValueKind.Number ? w.GetInt32() : (int?)null,
                FrameH = record.TryGetProperty("frame_h", out var h) && h.ValueKind == JsonValueKind.Number ? h.GetInt32() : (int?)null,
                Visible = record.TryGetProperty("visible", out var v) && v.ValueKind == JsonValueKind.True,
            };
            _onCursor(e);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { _cts?.Cancel(); } catch { }
        if (_ws != null)
        {
            try { await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); } catch { }
            try { _ws.Dispose(); } catch { }
        }
    }
}
