using System;
using System.Windows;
using System.Windows.Media.Imaging;

namespace ConnectLive.Admin.Ui;

/// <summary>
/// Applies the embedded admin icon (assets/icon.ico) to a window.
///
/// The icon is an OPTIONAL asset: the .ico is added manually to
/// admin/assets/ and the csproj only embeds it when the file exists.
/// A hard XAML reference (Icon="pack://...") throws at runtime when the
/// resource is absent, so the icon is applied here defensively instead.
/// </summary>
public static class AppIcon
{
    private static BitmapImage? _cached;
    private static bool _resolved;

    public static void Apply(Window window)
    {
        var icon = Resolve();
        if (icon is not null) window.Icon = icon;
    }

    private static BitmapImage? Resolve()
    {
        if (_resolved) return _cached;
        _resolved = true;
        try
        {
            var uri = new Uri("pack://application:,,,/assets/icon.ico", UriKind.Absolute);
            var img = new BitmapImage();
            img.BeginInit();
            img.UriSource = uri;
            img.CacheOption = BitmapCacheOption.OnLoad;
            img.EndInit();
            img.Freeze();
            _cached = img;
        }
        catch
        {
            // No icon embedded in this build — keep the WPF default.
            _cached = null;
        }
        return _cached;
    }
}
