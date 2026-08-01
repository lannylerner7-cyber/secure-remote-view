using System.Windows;
using ConnectLive.Admin.Ui;
using ConnectLive.Admin.ViewModels;

namespace ConnectLive.Admin.Views;

public partial class LoginWindow : Window
{
    public LoginWindow()
    {
        InitializeComponent();
        AppIcon.Apply(this);
    }

    private void PwdBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (DataContext is LoginViewModel vm) vm.Password = PwdBox.Password;
    }
}
