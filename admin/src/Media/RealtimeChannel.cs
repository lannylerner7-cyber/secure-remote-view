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

    // TOKEN INVARIANT — a long-lived socket must never capture the technician
    // JWT. The Supabase access token expires roughly hourly; the old code
    // snapshotted it at construction, so once it aged out every reconnect
    // replayed the same dead token and Realtime stayed rejected for the rest of
    // the session ("InvalidJWTToken: Token has expired N seconds ago"). Both the
    // join payload and the live re-auth push read through this provider instead.
    private readonly Func<string?> _tokenProvider;
    private readonly Func<CancellationToken, Task<bool>>? _refreshTokenAsync;
    private readonly Func<bool>? _isTokenStale;

    private readonly Action<byte[], DateTime>? _onFrameBytes;
    private readonly Action<CursorEvent>? _onCursor;
    private readonly Action<string>? _onError;
    private readonly Action<bool>? _onHealth;

    private ClientWebSocket? _ws;
    private CancellationTokenSource? _cts;
    private int _ref;

    // Topics we have successfully joined, so UpdateToken can re-auth them in
    // place (Phoenix "access_token" event) without recycling the socket.
    private readonly System.Collections.Generic.List<string> _joinedTopics = new();

    // Transient reconnects are normal (Realtime node recycles, laptop sleeps,
    // token rotation). Only a *persistent* failure earns the amber banner.
    private int _consecutiveFailures;

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

    /// <param name="tokenProvider">
    /// Reads the CURRENT technician access token every time it is needed.
    /// Never pass a captured string — see the TOKEN INVARIANT above.
    /// </param>
    /// <param name="refreshTokenAsync">
    /// Forces a token renewal. Called when Realtime rejects a join because the
    /// JWT expired, so the very next attempt carries a live token instead of
    /// looping on a dead one.
    /// </param>
    /// <param name="isTokenStale">
    /// Cheap, synchronous "is the token missing or about to expire?" probe.
    /// Consulted before every join so a resume-from-sleep reconnect renews
    /// first instead of spending an attempt on a token that dies mid-handshake.
    /// </param>
    public RealtimeChannel(
        string supabaseUrl, string apiKey, Func<string?> tokenProvider, string sessionId,
        Action<byte[], DateTime>? onFrameBytes,
        Action<CursorEvent>? onCursor,
        Action<string>? onError = null,
        Action<bool>? onHealth = null,
        Func<CancellationToken, Task<bool>>? refreshTokenAsync = null,
        Func<bool>? isTokenStale = null)
    {
        _sessionId = sessionId;
        _apiKey = apiKey;
        _tokenProvider = tokenProvider;
        _refreshTokenAsync = refreshTokenAsync;
        _isTokenStale = isTokenStale;
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

    /// <summary>
    /// Push a rotated access token onto the live socket. Supabase Realtime
    /// accepts an <c>access_token</c> event per joined topic and re-runs RLS
    /// with it, so a routine refresh costs no reconnect and no dropped frames.
    /// Safe to call from any thread and before the socket is up (no-op).
    /// </summary>
    public void UpdateToken(string? token)
    {
        if (string.IsNullOrEmpty(token)) return;
        string[] topics;
        lock (_joinGate) topics = _joinedTopics.ToArray();
        if (topics.Length == 0 || _ws?.State != WebSocketState.Open) return;
        _ = Task.Run(async () =>
        {
            foreach (var topic in topics)
            {
                try
                {
                    var msg = new
                    {
                        topic,
                        @event = "access_token",
                        payload = new { access_token = token },
                        @ref = Interlocked.Increment(ref _ref).ToString(),
                    };
                    await SendJsonAsync(msg, CancellationToken.None).ConfigureAwait(false);
                }
                catch { /* the reconnect ladder re-joins with the fresh token */ }
            }
        });
    }

    private static bool IsExpiredTokenError(string? message)
        => message != null
           && (message.Contains("InvalidJWTToken", StringComparison.OrdinalIgnoreCase)
               || message.Contains("expired", StringComparison.OrdinalIgnoreCase)
               || message.Contains("JWT", StringComparison.OrdinalIgnoreCase));

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
                    _joinedTopics.Clear();
                    _joinError = null;
                    _joinsDone = new TaskCompletionSource<bool>(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                }

                // A stale token is the single most common reason a re-join is
                // rejected, so renew it up front rather than burning an attempt.
                // "Stale" includes *nearly* expired, not just missing: on a
                // resume from sleep this socket reconnects before the renewal
                // timer wakes, and a token with seconds left would otherwise
                // guarantee a rejected join.
                if (_refreshTokenAsync != null
                    && (string.IsNullOrEmpty(_tokenProvider()) || (_isTokenStale?.Invoke() ?? false)))
                    try { await _refreshTokenAsync(ct).ConfigureAwait(false); } catch { }

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
                _consecutiveFailures = 0;

                await receive.ConfigureAwait(false);
                hbCts.Cancel();
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                _consecutiveFailures++;

                // Expired JWT: renew and retry immediately at the fast rung.
                // Silently — a token rotation is housekeeping, not an incident,
                // and the amber banner used to sit over the remote desktop for
                // the rest of the session because of it.
                if (IsExpiredTokenError(ex.Message) && _refreshTokenAsync != null)
                {
                    bool refreshed = false;
                    try { refreshed = await _refreshTokenAsync(ct).ConfigureAwait(false); } catch { }
                    if (refreshed)
                    {
                        backoffMs = 1000;
                        _consecutiveFailures = 0;
                    }
                }
                else if (_consecutiveFailures >= 3)
                {
                    // Only a persistent failure earns the banner. The HTTP poll
                    // pumps keep the picture alive in the meantime.
                    _onError?.Invoke("Realtime: " + ex.Message);
                }
            }
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
        lock (_joinGate) { _pendingJoins[joinRef] = topic; }
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
            // Read through the provider, never a captured snapshot.
            access_token = _tokenProvider(),
        };
        var msg = new { topic, @event = "phx_join", payload, @ref = joinRef };
        await SendJsonAsync(msg, ct).ConfigureAwait(false);
    }

    /// <summary>Resolve/reject the join gate from a phx_reply or phx_error.</summary>
    private void CompleteJoin(string? joinRef, bool ok, string? reason)
    {
        lock (_joinGate)
        {
            string? topic = null;
            if (joinRef != null && !_pendingJoins.Remove(joinRef, out topic)) return;
            if (!ok)
            {
                _joinError = reason ?? "join rejected";
                _joinsDone?.TrySetResult(false);
                // Force the receive loop out so RunAsync recycles the socket.
                try { _ws?.Abort(); } catch { }
                return;
            }
            if (!string.IsNullOrEmpty(topic) && !_joinedTopics.Contains(topic!))
                _joinedTopics.Add(topic!);
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
