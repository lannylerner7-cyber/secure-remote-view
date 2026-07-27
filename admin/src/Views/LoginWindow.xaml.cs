using System.Windows;
using ConnectLive.Admin.ViewModels;

namespace ConnectLive.Admin.Views;

public partial class LoginWindow : Window
{
    public LoginWindow() => InitializeComponent();

    private void PwdBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (DataContext is LoginViewModel vm) vm.Password = PwdBox.Password;
    }
}
