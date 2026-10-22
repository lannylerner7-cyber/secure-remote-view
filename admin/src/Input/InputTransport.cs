using System;
using System.Collections.Generic;
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
public static class InputTransport
{
    private static readonly HashSet<string> AlwaysRest = new(StringComparer.Ordinal)
    {
        "curtain_off",
        "release_inputs",
    };

    private static readonly object _gate = new();
    private static RTCDataChannel? _dc;
    private static string _sessionId = "";
    private static bool _open;
    private static bool _demoted;
    private static long _sent, _restFallback;
    public static event Action<string, string, bool>? CurtainAcknowledged;

    /// <summary>Called by <see cref="Media.WebRtcClient"/> after it creates the peer.</summary>
    public static void Attach(string sessionId, RTCDataChannel dc)
    {
        lock (_gate)
        {
            Detach();
            _sessionId = sessionId;
            _dc = dc;
            _open = false;
            _demoted = false;
        }
        dc.onopen += () =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; _open = true; }
            Log.Write($"[input] datachannel OPEN — native input now rides SCTP (session={sessionId})");
        };
        dc.onclose += () =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; _open = false; _demoted = true; }
            Log.Write("[input] datachannel CLOSED — REST fallback carries input");
        };
        dc.onerror += (err) =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; _open = false; _demoted = true; }
            Log.Write("[input] datachannel error: " + err);
        };
        dc.onmessage += (_, __, data) =>
        {
            lock (_gate) { if (!ReferenceEquals(_dc, dc)) return; }
            try
            {
                using var doc = JsonDocument.Parse(data);
                var root = doc.RootElement;
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
        if (AlwaysRest.Contains(kind))
            return SendRestAsync(sessionId, kind, payload, ct);

        RTCDataChannel? dc;
        bool open;
        lock (_gate)
        {
            dc = _dc;
            open = _open && !_demoted && _sessionId == sessionId;
        }
        if (dc == null || !open)
            return SendRestAsync(sessionId, kind, payload, ct);

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
        Interlocked.Increment(ref _restFallback);
        return App.Api.PushInputAsync(sessionId, kind, payload, ct);
    }

    /// <summary>Match the REST row envelope consumed by Agent InputRelay.Apply.</summary>
    private static string MergeEnvelope(string kind, object payload)
    {
        return JsonSerializer.Serialize(new { kind, payload });
    }
}
