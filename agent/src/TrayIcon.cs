using System;
using System.Drawing;
using System.Windows.Forms;

namespace ConnectLive.Agent;

/// <summary>
/// Persistent tray icon. Provides the visible "agent is running" signal and a
/// menu with About / Quit. The tray icon is always present while the agent
/// runs — it is not a covert background service.
/// </summary>
public sealed class TrayIcon : IDisposable
{
    private readonly NotifyIcon _icon;

    public TrayIcon(Action<int> onQuit)
    {
        _icon = new NotifyIcon
        {
            Icon = LoadIcon(),
            Visible = true,
            Text = "ConnectLive Agent — no active session"
        };

        var menu = new ContextMenuStrip();
        menu.Items.Add("ConnectLive Agent").Enabled = false;
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("About…", null, (_, _) =>
            MessageBox.Show(
                "ConnectLive Agent\nTransparent, consent-based remote support.\n\nYou will always be prompted before your screen is shared.",
                "ConnectLive", MessageBoxButtons.OK, MessageBoxIcon.Information));
        menu.Items.Add("Quit", null, (_, _) => { _icon.Visible = false; onQuit(0); });
        _icon.ContextMenuStrip = menu;
    }

    private static Icon LoadIcon()
    {
        try { return new Icon("assets/icon.ico"); }
        catch { return SystemIcons.Application; }
    }

    public void Dispose() => _icon.Dispose();
}
