using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ConnectLive.Admin.Api;

public sealed class AppConfig
{
    [JsonPropertyName("baseUrl")] public string BaseUrl { get; set; } = "https://secure-remote-view.lovable.app";
    [JsonPropertyName("supabaseUrl")] public string SupabaseUrl { get; set; } = "";
    [JsonPropertyName("supabaseAnonKey")] public string SupabaseAnonKey { get; set; } = "";

    public static AppConfig Load()
    {
        // Search order: exe dir, then %AppData%\ConnectLiveAdmin\admin.config.json
        var exeDir = AppContext.BaseDirectory;
        var candidate = Path.Combine(exeDir, "admin.config.json");
        if (!File.Exists(candidate))
        {
            var userDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "ConnectLiveAdmin");
            candidate = Path.Combine(userDir, "admin.config.json");
        }
        if (!File.Exists(candidate))
        {
            // Fall back to embedded defaults
            return new AppConfig
            {
                BaseUrl = "https://secure-remote-view.lovable.app",
                SupabaseUrl = "https://usjygjxpzunpzngmmrqy.supabase.co",
                SupabaseAnonKey = "sb_publishable_-6LC9u-eg5GW9n2yHRrZog_2lbuB7j_",
            };
        }

        var json = File.ReadAllText(candidate);
        return JsonSerializer.Deserialize<AppConfig>(json)
               ?? throw new InvalidOperationException("admin.config.json is invalid");
    }
}
