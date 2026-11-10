using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ConnectLive.Admin.Diag;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Input;

/// <summary>
/// S10 — input over the WebRTC datachannel, with the REST queue as the
/// guaranteed fallback.
///
/// The agent already accepts input on an <c>input</c> datachannel
/// (agent/src/WebRtcSession.cs → <c>ondatachannel</c> → <c>InputRelay.Apply</c>);
/// until now the native console never opened one, so every click and every
/// mouse delta paid an HTTPS round trip to a peer we already hold an SRTP
/// tunnel with.
///
/// Rules:
///   * the channel is used only while genuinely open; one send failure
///     demotes the session to REST for good so the stream can never
///     interleave two transports with different latencies and reorder itself;
///   * safety kinds (<c>curtain_off</c>, <c>release_inputs</c>) always take
///     REST — they must land precisely when media is broken, which is when
///     the channel is least trustworthy;
///   * wire shape is identical on both paths (<c>{ kind, payload }</c>)
    ///     so the agent's switch does not need to know which pipe delivered it.
/// </summary>
public static partial class InputTransport
{
    private static readonly HashSet<string> AlwaysRest = new(StringComparer.Ordinal)
    {
        "curtain_off",
        "release_inputs",
    };

    private static readonly object _gate = new();
    private static readonly ConcurrentDictionary<string, byte> SensitiveSessions = new(StringComparer.Ordinal);
    public static bool IsSensitive(string sessionId) => SensitiveSessions.ContainsKey(sessionId);
    public static void BlockOrdinaryInput(string sessionId) => SensitiveSessions.TryAdd(sessionId, 0);
    public static void ResumeOrdinaryInput(string sessionId)
    {
        lock (_gate)
        {
            if (Unlock?.SessionId == sessionId && Unlock.Active) return;
            SensitiveSessions.TryRemove(sessionId, out _);
            Unlock?.AllowOrdinaryInput();
        }
    }
    private static RTCDataChannel? _dc;
    private static string _sessionId = "";
    private static bool _open;
    private static bool _demoted;
    private static long _sent, _restFallback;
    public static event Action<string, string, bool>? CurtainAcknowledged;
    public static WindowsUnlockChannel? Unlock { get; private set; }
    public static event Action<string, WindowsUnlockState>? UnlockChanged;

    /// <summary>Called by <see cref="Media.WebRtcClient"/> after it creates the peer.</summary>
    public static void Attach(string sessionId, RTCDataChannel dc, string peerId)
    {
        lock (_gate)
        {
            Detach();
            _sessionId = sessionId;
            _dc = dc;
            _open = false;
            _demoted = false;
            Unlock = new WindowsUnlockChannel(sessionId, peerId, dc);
            Unlock.Changed += state =>
            {
                if (state.Phase is "starting" or "ready" or "submitted")
                    SensitiveSessions.TryAdd(sessionId, 0);
                UnlockChanged?.Invoke(sessionId, state);
            };
        }
        dc.onopen += () =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; _open = true; }
            Log.Write($"[input] datachannel OPEN — native input now rides SCTP (session={sessionId})");
        };
        dc.onclose += () =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; _open = false; _demoted = true; ResetPermission(); }
            Log.Write("[input] datachannel CLOSED — REST fallback carries input");
        };
        dc.onerror += (err) =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; _open = false; _demoted = true; ResetPermission(); }
            Log.Write("[input] datachannel error: " + err);
        };
        dc.onmessage += (_, __, data) =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; }
            try
            {
                using var doc = JsonDocument.Parse(data);
                var root = doc.RootElement;
                if (ObservePermission(sessionId, dc, root)) return;
                if (ObserveCurtainApplication(sessionId, dc, root)) return;
                if (root.GetProperty("kind").GetString() != "curtain_status") return;
                var age = Environment.TickCount64 - root.GetProperty("sent_at").GetInt64();
                if (age < 0 || age > 3000) return;
                var id = root.GetProperty("request_id").GetString();
                if (id == null || id.Length > 64) return;
                CurtainAcknowledged?.Invoke(sessionId, id, root.GetProperty("applied").GetBoolean());
            }
            catch { /* Unknown/invalid peer messages do not change UI state. */ }
        };
    }

    public static void Detach()
    {
        lock (_gate)
        {
            Unlock?.Dispose();
            ResetPermission();
            Unlock = null;
            _dc = null;
            _open = false;
            _demoted = false;
            _sent = 0;
            _restFallback = 0;
        }
    }

    /// <summary>"dc" while the datachannel carries input, "rest" otherwise (S11 telemetry).</summary>
    public static string CurrentPath
    {
        get { lock (_gate) return _open && !_demoted ? "dc" : "rest"; }
    }

    /// <summary>Human line for the stats loop.</summary>
    public static string StatsLine()
    {
        lock (_gate)
        {
            var path = _open && !_demoted ? "dc" : "rest";
            return $"input.path={path} dc.sent={_sent} rest.fallback={_restFallback} demoted={_demoted}";
        }
    }

    /// <summary>
    /// Send one input event. Sessionless callers still get the REST path so
    /// this method is safe before <see cref="Attach"/> ever runs.
    /// </summary>
    public static Task SendAsync(string sessionId, string kind, object payload, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var unlock = Unlock;
        if (IsSensitive(sessionId) && !AlwaysRest.Contains(kind))
        {
            if (unlock?.SessionId == sessionId) unlock.Input(kind, payload);
            return Task.CompletedTask; // Never enqueue or replay sensitive input.
        }
        if (AlwaysRest.Contains(kind))
        {
            // Release immediately through the CURRENT peer too. A REST-only
            // curtain_off could miss the peer-owned curtain or wait behind a
            // slow heartbeat. REST remains an independent safety fallback.
            lock (_gate)
            {
                if (_sessionId == sessionId && _open && !_demoted && _dc != null)
                    try { _dc.send(Encoding.UTF8.GetBytes(MergeEnvelope(kind, payload))); } catch { }
            }
            return SendRestAsync(sessionId, kind, payload, ct);
        }

        RTCDataChannel? dc;
        bool open;
        lock (_gate)
        {
            dc = _dc;
            open = _open && !_demoted && _sessionId == sessionId;
        }
        if (dc == null || !open)
        {
            if (kind == "curtain_renew")
                throw new InvalidOperationException("The curtain command channel is disconnected.");
            return SendRestAsync(sessionId, kind, payload, ct);
        }

        try
        {
            var envelope = MergeEnvelope(kind, payload);
            var bytes = Encoding.UTF8.GetBytes(envelope);
            dc.send(bytes);
            Interlocked.Increment(ref _sent);
            return Task.CompletedTask;
        }
        catch (Exception ex)
        {
            lock (_gate)
            {
                if (ReferenceEquals(_dc, dc)) { _open = false; _demoted = true; }
            }
            Log.Write("[input] dc send failed, demoting to REST: " + ex.Message);
            return SendRestAsync(sessionId, kind, payload, ct);
        }
    }

    private static Task SendRestAsync(string sessionId, string kind, object payload, CancellationToken ct)
    {
        if (IsSensitive(sessionId) && !AlwaysRest.Contains(kind)) return Task.CompletedTask;
        Interlocked.Increment(ref _restFallback);
        return App.Api.PushInputAsync(sessionId, kind, payload, ct);
    }

    /// <summary>Match the REST row envelope consumed by Agent InputRelay.Apply.</summary>
    private static string MergeEnvelope(string kind, object payload)
    {
        return JsonSerializer.Serialize(new { kind, payload });
    }
}
