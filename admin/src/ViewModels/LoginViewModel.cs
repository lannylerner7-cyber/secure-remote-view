using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ConnectLive.Admin.Views;

namespace ConnectLive.Admin.ViewModels;

public partial class LoginViewModel : ObservableObject
{
    [ObservableProperty] private string identifier = "";
    [ObservableProperty] private string password = "";
    [ObservableProperty] private string? error;
    [ObservableProperty] private bool busy;

    [RelayCommand]
    private async Task SignIn()
    {
        if (Busy) return;
        Busy = true;
        Error = null;
        try
        {
            var res = await App.Api.LoginAsync(Identifier, Password, CancellationToken.None);
            if (res.Session != null)
            {
                var win = new MainWindow();
                Application.Current.MainWindow = win;
                win.Show();
                foreach (Window w in Application.Current.Windows)
                {
                    if (w is LoginWindow lw) { lw.Close(); break; }
                }
                return;
            }
            if (res.LockedForSeconds is int locked)
                Error = $"Locked for {(locked >= 60 ? $"{(locked + 59) / 60} min" : $"{locked}s")}.";
            else if (res.AttemptsLeft is int left)
                Error = $"Invalid credentials. {left} attempt{(left == 1 ? "" : "s")} left before lockout.";
            else
                Error = res.Error ?? "Sign-in failed.";
        }
        catch (System.Exception ex)
        {
            Error = ex.Message;
        }
        finally { Busy = false; }
    }
}
