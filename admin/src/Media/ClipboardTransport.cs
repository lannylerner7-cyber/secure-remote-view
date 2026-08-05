using System;
using System.Text;
using System.Text.Json;
using System.Windows;
using ConnectLive.Admin.Diag;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Media;

/// <summary>
/// S22 — clipboard sync over the dedicated WebRTC "clip" data channel.
///
/// Wire format is identical on all three peers (agent/src/ClipboardRelay.cs and
/// src/lib/webrtc-live.ts):
///   { "type":"clip", "text":"..." }   — text only, capped at 256 KiB.
///
/// The channel is deliberately separate from "input" and "files": a large paste
/// must never head-of-line block a mouseup, and a multi-megabyte transfer must
/// never delay a paste.
///
/// Inbound text is applied to the technician's own clipboard on the STA UI
/// thread (WPF's Clipboard API is STA-only). The last applied string is
/// remembered so the mirror-back from the remote peer does not loop.
/// </summary>
public static class ClipboardTransport
{
    private const int MaxChars = 256 * 1024;

    private static readonly object _gate = new();
    private static RTCDataChannel? _dc;
    private static bool _open;
    private static string _last = "";

    /// <summary>Raised with the text that arrived from the remote machine.</summary>
    public static event Action<string>? ClipboardReceived;

    public static bool IsOpen
    {
        get { lock (_gate) return _open; }
    }

    public static void Attach(RTCDataChannel dc)
    {
        Detach();
        lock (_gate)
        {
            _dc = dc;
            _open = dc.readyState == RTCDataChannelState.open;
        }

        dc.onopen += () =>
        {
            lock (_gate) _open = true;
            Log.Info("[clip] channel open");
        };

        dc.onclose += () =>
        {
            lock (_gate) _open = false;
            Log.Info("[clip] channel closed");
        };

        dc.onerror += (err) =>
        {
            lock (_gate) _open = false;
            Log.Warn("[clip] channel error: " + err);
        };

        dc.onmessage += (_, __, data) =>
        {
            try
            {
                var json = Encoding.UTF8.GetString(data);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("type", out var t) || t.GetString() != "clip") return;
                if (!root.TryGetProperty("text", out var tv)) return;
                var text = tv.GetString();
                if (string.IsNullOrEmpty(text)) return;
                if (text!.Length > MaxChars) text = text.Substring(0, MaxChars);

                lock (_gate)
                {
                    if (text == _last) return; // echo of what we just sent
                    _last = text;
                }

                ApplyLocal(text);
                ClipboardReceived?.Invoke(text);
            }
            catch (Exception ex)
            {
                Log.Warn("[clip] inbound parse failed: " + ex.Message);
            }
        };
    }

    public static void Detach()
    {
        lock (_gate)
        {
            _dc = null;
            _open = false;
            _last = "";
        }
    }

    /// <summary>Push the technician's local clipboard text to the remote machine.</summary>
    public static bool Send(string text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        if (text.Length > MaxChars) text = text.Substring(0, MaxChars);

        RTCDataChannel? dc;
        lock (_gate)
        {
            if (!_open || _dc == null) return false;
            dc = _dc;
            _last = text; // suppress the echo when the agent mirrors it back
        }

        try
        {
            var json = JsonSerializer.Serialize(new { type = "clip", text });
            dc!.send(json);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("[clip] send failed: " + ex.Message);
            return false;
        }
    }

    /// <summary>Read the local clipboard on the STA thread; empty string on failure.</summary>
    public static string ReadLocal()
    {
        var app = Application.Current;
        if (app == null) return "";
        var result = "";
        app.Dispatcher.Invoke(() =>
        {
            try { if (Clipboard.ContainsText()) result = Clipboard.GetText(); }
            catch (Exception ex) { Log.Warn("[clip] local read failed: " + ex.Message); }
        });
        return result;
    }

    private static void ApplyLocal(string text)
    {
        var app = Application.Current;
        if (app == null) return;
        app.Dispatcher.BeginInvoke(new Action(() =>
        {
            // Clipboard.SetText can throw CLIPBRD_E_CANT_OPEN when another
            // process holds the clipboard; retry once, then give up quietly.
            try { Clipboard.SetText(text); }
            catch
            {
                try { Clipboard.SetDataObject(text, true); }
                catch (Exception ex) { Log.Warn("[clip] local apply failed: " + ex.Message); }
            }
        }));
    }
}
