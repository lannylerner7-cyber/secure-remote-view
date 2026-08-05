using System;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Windows;
using SIPSorcery.Net;

namespace ConnectLive.Agent;

/// <summary>
/// S22 — clipboard sync over the dedicated WebRTC "clip" data channel.
///
/// Wire format (mirrors src/lib/webrtc-live.ts and admin/src/Media/ClipboardTransport.cs):
///   { "type": "clip", "text": "..." }
///
/// Text only, hard-capped at <see cref="MaxChars"/>. Images and file drops are
/// deliberately out of scope: the encrypted "files" channel already covers
/// binary payloads and an unbounded clipboard would be a trivial exfiltration
/// channel through an ordered/reliable SCTP stream.
///
/// Outbound: a 1 Hz poll on the STA UI dispatcher notices local clipboard
/// changes and pushes them once. We never echo back text we just applied
/// (<see cref="_lastSeen"/> guards the loop), otherwise the two peers would
/// ping-pong the same string forever.
/// </summary>
internal static class ClipboardRelay
{
    private const int MaxChars = 256 * 1024;
    private const int PollMs = 1000;

    private static readonly object _gate = new();
    private static RTCDataChannel? _dc;
    private static Timer? _poll;
    private static string _lastSeen = "";

    internal static bool IsOpen
    {
        get { lock (_gate) return _dc?.readyState == RTCDataChannelState.open; }
    }

    internal static void Attach(RTCDataChannel dc)
    {
        Detach();
        lock (_gate) _dc = dc;

        dc.onmessage += (_, __, data) =>
        {
            try
            {
                var json = Encoding.UTF8.GetString(data);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("type", out var t) || t.GetString() != "clip") return;
                var text = root.TryGetProperty("text", out var tv) ? tv.GetString() : null;
                if (text == null) return;
                if (text.Length > MaxChars) text = text.Substring(0, MaxChars);
                ApplyLocal(text);
            }
            catch (Exception ex) { Log.Warn($"[clip] apply: {ex.Message}"); }
        };

        dc.onopen += () =>
        {
            Log.Info("[clip] datachannel OPEN");
            StartPoll();
        };
        dc.onclose += Detach;
        dc.onerror += (e) => Log.Warn($"[clip] datachannel error: {e}");

        if (dc.readyState == RTCDataChannelState.open) StartPoll();
    }

    internal static void Detach()
    {
        lock (_gate)
        {
            try { _poll?.Dispose(); } catch { }
            _poll = null;
            _dc = null;
            _lastSeen = "";
        }
    }

    private static void StartPoll()
    {
        lock (_gate)
        {
            if (_poll != null) return;
            _poll = new Timer(_ => PollOnce(), null, PollMs, PollMs);
        }
    }

    private static void PollOnce()
    {
        try
        {
            var app = Application.Current;
            if (app == null) return;
            app.Dispatcher.Invoke(() =>
            {
                string text;
                try
                {
                    if (!Clipboard.ContainsText()) return;
                    text = Clipboard.GetText() ?? "";
                }
                catch { return; } // clipboard is briefly locked by another process
                if (text.Length == 0 || text.Length > MaxChars) return;
                lock (_gate)
                {
                    if (text == _lastSeen) return;
                    _lastSeen = text;
                }
                Send(text);
            });
        }
        catch (Exception ex) { Log.Warn($"[clip] poll: {ex.Message}"); }
    }

    private static void ApplyLocal(string text)
    {
        var app = Application.Current;
        if (app == null) return;
        app.Dispatcher.Invoke(() =>
        {
            try
            {
                lock (_gate) _lastSeen = text; // suppress the echo on the next poll
                Clipboard.SetText(text);
                Log.Info($"[clip] applied {text.Length} char(s) from console");
            }
            catch (Exception ex) { Log.Warn($"[clip] set: {ex.Message}"); }
        });
    }

    private static void Send(string text)
    {
        RTCDataChannel? dc;
        lock (_gate) dc = _dc;
        if (dc == null || dc.readyState != RTCDataChannelState.open) return;
        try
        {
            dc.send(JsonSerializer.Serialize(new { type = "clip", text }));
            Log.Info($"[clip] pushed {text.Length} char(s) to console");
        }
        catch (Exception ex) { Log.Warn($"[clip] send: {ex.Message}"); }
    }
}
