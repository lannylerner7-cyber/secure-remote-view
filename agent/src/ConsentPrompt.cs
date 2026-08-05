using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>
/// The consent gate — the product's core promise made visible.
///
/// Before this existed, <c>Agent.HandleInvite</c> called
/// <c>SubmitConsentAsync(sessionId, true)</c> unconditionally: the server
/// route documents that value as "the end-user's answer to the on-screen
/// consent dialog" and there was no dialog anywhere. Every invite was
/// silently accepted. That is exactly the behaviour this platform exists to
/// not have.
///
/// Behaviour:
///   • Topmost, activated, centered window naming the technician and the
///     requested mode (view vs. control). No system tray, no notification —
///     a session cannot start unless a human clicks Allow.
///   • Auto-DECLINE on timeout (default 90s). Silence is never consent.
///   • "Always allow" is an explicit opt-in stored per-user under
///     HKCU\Software\ConnectLive (StandingConsent). Administrators who want
///     unattended support enable it once, knowingly; it can be revoked with
///     <see cref="RevokeStandingConsent"/> or by deleting the value.
///   • Closing the window with the X counts as decline.
/// </summary>
public static class ConsentPrompt
{
    private const string RegKey = @"Software\ConnectLive";
    private const string RegValue = "StandingConsent";
    private const string PromptValue = "PromptOnConnect";

    /// <summary>
    /// The connect-time dialog is OFF by default (2026-08-05). Allow/Deny is
    /// still available for deployments that want it — set
    /// HKCU\Software\ConnectLive\PromptOnConnect = 1 — and the curtain,
    /// session banner and audit trail keep the session visible either way.
    /// </summary>
    public static bool PromptOnConnect()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(RegKey);
            return k?.GetValue(PromptValue) is int v && v == 1;
        }
        catch { return false; }
    }

    public static bool HasStandingConsent()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(RegKey);
            return k?.GetValue(RegValue) is int v && v == 1;
        }
        catch { return false; }
    }


    public static void RevokeStandingConsent()
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(RegKey);
            k?.SetValue(RegValue, 0, RegistryValueKind.DWord);
        }
        catch { }
    }

    private static void GrantStandingConsent()
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(RegKey);
            k?.SetValue(RegValue, 1, RegistryValueKind.DWord);
        }
        catch { }
    }

    /// <summary>
    /// Ask the person at the keyboard. Returns true only on an explicit
    /// Allow click (or a previously granted standing consent). Never blocks
    /// the caller's thread: the dialog is built and shown on the WPF UI
    /// dispatcher and the result comes back through a TaskCompletionSource.
    /// </summary>
    public static Task<bool> AskAsync(string technician, string mode, CancellationToken ct,
                                      TimeSpan? timeout = null)
    {
        if (HasStandingConsent())
        {
            Log.Info("consent: standing consent on file — auto-accepted");
            return Task.FromResult(true);
        }

        var app = Application.Current;
        if (app is null)
        {
            // Headless / no UI thread: we cannot ask, so we must not assume.
            Log.Warn("consent: no WPF application — declining by default");
            return Task.FromResult(false);
        }

        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var limit = timeout ?? TimeSpan.FromSeconds(90);

        app.Dispatcher.BeginInvoke(new Action(() =>
        {
            try { ShowDialog(technician, mode, limit, ct, tcs); }
            catch (Exception ex)
            {
                Log.Warn($"consent dialog failed: {ex.Message}");
                tcs.TrySetResult(false);
            }
        }));

        return tcs.Task;
    }

    private static void ShowDialog(string technician, string mode, TimeSpan limit,
                                   CancellationToken ct, TaskCompletionSource<bool> tcs)
    {
        var controlMode = string.Equals(mode, "control", StringComparison.OrdinalIgnoreCase);

        var win = new Window
        {
            Title = "ConnectLive — support request",
            Width = 520,
            SizeToContent = SizeToContent.Height,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true,
            ShowInTaskbar = true,
        };

        Brush Res(string key, Brush fallback)
        {
            try { return (Brush)Application.Current.Resources[key] ?? fallback; }
            catch { return fallback; }
        }

        var surface = Res("BrandSurface", Brushes.White);
        var border = Res("BrandBorder", new SolidColorBrush(Color.FromRgb(0xD8, 0xDD, 0xE6)));
        var text = Res("BrandText", new SolidColorBrush(Color.FromRgb(0x14, 0x18, 0x22)));
        var muted = Res("BrandMuted", new SolidColorBrush(Color.FromRgb(0x5B, 0x64, 0x77)));
        var accent = Res("BrandAccent", new SolidColorBrush(Color.FromRgb(0x4F, 0x5B, 0xD5)));

        var stack = new StackPanel { Margin = new Thickness(30, 26, 30, 24) };

        stack.Children.Add(new TextBlock
        {
            Text = "Remote support request",
            FontSize = 20,
            FontWeight = FontWeights.SemiBold,
            Foreground = text,
        });

        stack.Children.Add(new TextBlock
        {
            Text = $"{technician} is asking to {(controlMode ? "control" : "view")} this computer.",
            FontSize = 14,
            Foreground = text,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 12, 0, 0),
        });

        stack.Children.Add(new TextBlock
        {
            Text = controlMode
                ? "They will see your screen and can move your mouse and type. You can end the session at any time, and nothing starts until you allow it."
                : "They will see your screen only — no mouse or keyboard control. You can end the session at any time.",
            FontSize = 12.5,
            Foreground = muted,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 0),
        });

        var always = new CheckBox
        {
            Content = "Always allow support sessions on this computer",
            Foreground = muted,
            FontSize = 12.5,
            Margin = new Thickness(0, 16, 0, 0),
        };
        stack.Children.Add(always);

        var countdown = new TextBlock
        {
            FontSize = 12,
            Foreground = muted,
            Margin = new Thickness(0, 14, 0, 0),
        };
        stack.Children.Add(countdown);

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 18, 0, 0),
        };

        var decline = new Button
        {
            Content = "Decline",
            Padding = new Thickness(18, 8, 18, 8),
            Margin = new Thickness(0, 0, 10, 0),
            Foreground = text,
            Background = Brushes.Transparent,
            BorderBrush = border,
            BorderThickness = new Thickness(1),
            Cursor = System.Windows.Input.Cursors.Hand,
            IsCancel = true,
        };
        var allow = new Button
        {
            Content = "Allow",
            Padding = new Thickness(22, 8, 22, 8),
            Foreground = Brushes.White,
            Background = accent,
            BorderThickness = new Thickness(0),
            Cursor = System.Windows.Input.Cursors.Hand,
            IsDefault = true,
        };
        buttons.Children.Add(decline);
        buttons.Children.Add(allow);
        stack.Children.Add(buttons);

        win.Content = new Border
        {
            CornerRadius = new CornerRadius(14),
            Background = surface,
            BorderBrush = border,
            BorderThickness = new Thickness(1),
            Child = stack,
            Effect = new System.Windows.Media.Effects.DropShadowEffect
            {
                Color = Colors.Black, Opacity = 0.2, BlurRadius = 30, ShadowDepth = 6,
            },
        };

        var deadline = DateTime.UtcNow + limit;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        CancellationTokenRegistration reg = default;
        var settled = false;

        void Finish(bool granted, string why)
        {
            if (settled) return;
            settled = true;
            timer.Stop();
            try { reg.Dispose(); } catch { }
            if (granted && always.IsChecked == true) GrantStandingConsent();
            Log.Info($"consent: {(granted ? "GRANTED" : "DECLINED")} ({why})");
            tcs.TrySetResult(granted);
            try { win.Close(); } catch { }
        }

        timer.Tick += (_, _) =>
        {
            var left = (int)Math.Ceiling((deadline - DateTime.UtcNow).TotalSeconds);
            if (left <= 0) { Finish(false, "timed out"); return; }
            countdown.Text = $"This request declines automatically in {left}s.";
        };
        countdown.Text = $"This request declines automatically in {(int)limit.TotalSeconds}s.";
        timer.Start();

        allow.Click += (_, _) => Finish(true, "user clicked Allow");
        decline.Click += (_, _) => Finish(false, "user clicked Decline");
        // Closing the window is a decline, never a silent accept.
        win.Closed += (_, _) => Finish(false, "window closed");

        // The admin cancelling the invite (session ended server-side) should
        // take the dialog off the user's screen instead of leaving it hanging.
        if (ct.CanBeCanceled)
        {
            reg = ct.Register(() =>
            {
                try { win.Dispatcher.BeginInvoke(new Action(() => Finish(false, "invite cancelled"))); }
                catch { }
            });
        }

        win.Show();
        win.Activate();
        try { win.Focus(); } catch { }
    }
}
