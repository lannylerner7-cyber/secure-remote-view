using System.Diagnostics;
using System.Windows;
using ConnectLive.Admin.ViewModels;

namespace ConnectLive.Admin.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += (_, _) => (DataContext as DevicesViewModel)?.StartPolling();
        Closed += (_, _) => (DataContext as DevicesViewModel)?.StopPolling();
    }

    private void OpenPayments_Click(object sender, RoutedEventArgs e)
        => OpenBrowser($"{App.Config.BaseUrl}/console?tab=payments");

    private void OpenOrders_Click(object sender, RoutedEventArgs e)
        => OpenBrowser($"{App.Config.BaseUrl}/order");

    private void SignOut_Click(object sender, RoutedEventArgs e)
    {
        App.Api.Logout();
        new LoginWindow().Show();
        Close();
    }

    private static void OpenBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
        catch { }
    }
}
