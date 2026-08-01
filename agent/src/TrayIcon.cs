using System;
using System.Drawing;
using System.Windows.Forms;

namespace ConnectLive.Agent;

/// <summary>
/// Persistent tray icon. Provides the visible "agent is running" signal and a
/// menu with About / Exit. The tray icon is always present while the agent
/// runs — it is not a covert background service.
///
/// Double-click shows the status window. Exit is the ONLY quit path: it drops
/// stop.flag so nothing (Run key, Updater in Phase 2) brings the Agent back
/// until the user launches it manually again.
/// </summary>
public sealed class TrayIcon : IDisposable
{
    private readonly NotifyIcon _icon;

    public TrayIcon(Action onShowWindow, Action onExit)
    {
        _icon = new NotifyIcon
        {
            Icon = LoadIcon(),
            Visible = true,
            Text = "ConnectLive Agent — no active session"
        };

        _icon.DoubleClick += (_, _) => onShowWindow();

        var menu = new ContextMenuStrip();
        menu.Items.Add("ConnectLive Agent").Enabled = false;
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open ConnectLive", null, (_, _) => onShowWindow());
        menu.Items.Add("About…", null, (_, _) =>
            MessageBox.Show(
                "ConnectLive Agent\nTransparent remote support for managed devices.\n\nA live banner stays visible for every support session, and Curtain Mode can be released automatically if the connection drops.",
                "ConnectLive", MessageBoxButtons.OK, MessageBoxIcon.Information));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) =>
        {
            _icon.Visible = false;
            onExit();
        });
        _icon.ContextMenuStrip = menu;
    }

    /// <summary>Updates the tray tooltip (max 63 chars on Windows).</summary>
    public void SetStatus(string text)
    {
        try
        {
            var t = $"ConnectLive Agent — {text}";
            _icon.Text = t.Length > 62 ? t.Substring(0, 62) : t;
        }
        catch { /* tooltip is cosmetic */ }
    }

    private static Icon LoadIcon()
    {
        try { return new Icon("assets/icon.ico"); }
        catch { return SystemIcons.Application; }
    }

    public void Dispose() => _icon.Dispose();
}
