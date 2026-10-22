using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ConnectLive.Admin.Api;

public sealed class AppConfig
{
    [JsonPropertyName("baseUrl")] public string BaseUrl { get; set; } = "";
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
            throw new InvalidOperationException(
                "Missing admin.config.json. Ask your deployment administrator for baseUrl, supabaseUrl and supabaseAnonKey. Place the file beside the executable or in %AppData%\\ConnectLiveAdmin, then restart.");
        }

        var json = File.ReadAllText(candidate);
        var config = JsonSerializer.Deserialize<AppConfig>(json)
               ?? throw new InvalidOperationException("admin.config.json is invalid");
        config.Validate();
        return config;
    }

    public void Validate()
    {
        BaseUrl = ConnectLive.Native.NativeGatewayPolicy.ValidateOrigin(BaseUrl, "admin.config.json baseUrl");
        SupabaseUrl = ConnectLive.Native.NativeGatewayPolicy.ValidateOrigin(SupabaseUrl, "admin.config.json supabaseUrl");
        if (string.IsNullOrWhiteSpace(SupabaseAnonKey))
            throw new InvalidOperationException("Set supabaseAnonKey in admin.config.json to your deployment's publishable key, then restart. Never use a service-role key.");
    }
}
