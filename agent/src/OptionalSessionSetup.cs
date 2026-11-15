using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace ConnectLive.Agent;

internal static class OptionalSessionSetup
{
    internal static async Task<bool> HandleAsync(string[] args)
    {
        bool setup = Array.Exists(args, a => a == "--session-tools-setup");
        bool disable = Array.Exists(args, a => a == "--session-tools-disable");
        if (!setup && !disable) return false;
        if (disable) { SessionToolsPolicy.Forget(); return true; }
        var api = new ApiClient { LocalAuthorization = GrantStore.Load() };
        if (api.DeviceId == null || api.LocalAuthorization == null || LocalAccessState.IsDisabled())
            throw new InvalidOperationException("Pair the Windows Agent normally first.");
        await ShowAsync(api); return true;
    }
    internal static Task ShowAsync(ApiClient api)
    {
        var existing = SessionToolsPolicy.Read(api);
        var folders = new List<ApprovedFolder>(existing?.Folders ?? []);
        var panel = new StackPanel { Margin = new Thickness(20) };
        var window = new Window { Title = "Optional session tools", Width = 530, SizeToContent = SizeToContent.Height,
            WindowStartupLocation = WindowStartupLocation.CenterScreen, Content = panel };
        panel.Children.Add(new TextBlock { Text =
            "Pairing is complete. These options are separate permissions and are not required for ordinary support. " +
            "Skip now; reopen later with ConnectLive.exe --session-tools-setup.",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0,0,0,12) });
        var mic = new CheckBox { IsChecked = existing?.Microphone == true,
            Content = new TextBlock { Text = "Allow technicians to request live listening to this Windows microphone. " +
                "Off each session; never recorded. A visible notice and Ctrl+Alt+Shift+M stop sharing, even with the curtain.",
                TextWrapping = TextWrapping.Wrap }, Margin = new Thickness(0,0,0,12) };
        panel.Children.Add(mic);
        panel.Children.Add(new TextBlock { Text = "Folder browsing expands transfer-only access. Only folders you select below can be listed and downloaded, using your ordinary Windows permissions.",
            TextWrapping = TextWrapping.Wrap });
        var list = new ListBox { Height = 110, Margin = new Thickness(0,8,0,8), DisplayMemberPath = "Name" };
        void Refresh() { list.ItemsSource = null; list.ItemsSource = folders.ToArray(); }
        Refresh(); panel.Children.Add(list);
        var add = new Button { Content = "Choose an approved folder" };
        var remove = new Button { Content = "Remove selected folder", Margin = new Thickness(0,5,0,5) };
        add.Click += (_, _) => {
            if (folders.Count >= 8) return;
            using var picker = new System.Windows.Forms.FolderBrowserDialog { Description = "Approve remote browsing of this folder only", UseDescriptionForTitle = true };
            if (picker.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
            try
            {
                RemoteFileAccess.ValidateRoot(picker.SelectedPath);
                folders.Add(new ApprovedFolder(Guid.NewGuid().ToString(), new DirectoryInfo(picker.SelectedPath).Name, picker.SelectedPath)); Refresh();
            }
            catch { MessageBox.Show("Choose a local folder without junctions, symbolic links or network paths."); }
        };
        remove.Click += (_, _) => { if (list.SelectedItem is ApprovedFolder folder) { folders.Remove(folder); Refresh(); } };
        panel.Children.Add(add); panel.Children.Add(remove);
        var pin = new Button { Content = "Optional Windows Hello PIN setup…", Margin = new Thickness(0,8,0,8) };
        pin.Click += async (_, _) => { pin.IsEnabled = false; try { await OwnerPinSetup.ShowAsync(api); }
            catch { MessageBox.Show("Protected PIN setup is unavailable. Ordinary support is unchanged."); }
            finally { pin.IsEnabled = true; } };
        panel.Children.Add(pin);
        var save = new Button { Content = "Save these optional permissions", Margin = new Thickness(0,5,0,5) };
        save.Click += (_, _) => {
            try { SessionToolsPolicy.Save(api, mic.IsChecked == true, folders); window.Close(); }
            catch { MessageBox.Show("Optional permissions were not saved. Ordinary support remains available."); }
        };
        var skip = new Button { Content = "Skip / close" }; skip.Click += (_, _) => window.Close();
        panel.Children.Add(save); panel.Children.Add(skip);
        var done = new TaskCompletionSource();
        window.Closed += (_, _) => done.TrySetResult();
        window.Show(); return done.Task;
    }
}
