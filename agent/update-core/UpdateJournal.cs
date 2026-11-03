using System.Text.Json;
using System.Text.Json.Serialization;

namespace ConnectLive.Updates;

public sealed record BackupFile(string Name, bool Existed, string? Sha256);

/// <summary>No access credentials, API keys, or download URLs are persisted here.</summary>
public sealed class UpdateJournal
{
    public int Schema { get; set; } = 1;
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string InstallDirectory { get; set; } = "";
    public string Version { get; set; } = "";
    public string ArchiveSha256 { get; set; } = "";
    public string RunnerSha256 { get; set; } = "";
    public int ParentPid { get; set; }
    public long ParentStartTicks { get; set; }
    public int? CandidatePid { get; set; }
    public long? CandidateStartTicks { get; set; }
    public string HealthNonce { get; set; } = Guid.NewGuid().ToString("N");
    public string Phase { get; set; } = "prepared";
    public BackupFile[] Backups { get; set; } = [];
    public string? Failure { get; set; }
    [JsonIgnore]
    public bool IsTerminal => Phase is "committed" or "rolled_back" or "aborted";

    public static UpdateJournal Read(string path)
    {
        var journal = JsonSerializer.Deserialize<UpdateJournal>(File.ReadAllBytes(path), UpdatePackage.Json)
            ?? throw new InvalidDataException("Missing update journal");
        if (journal.Schema != 1 || !Guid.TryParseExact(journal.Id, "N", out _) ||
            !Guid.TryParseExact(journal.HealthNonce, "N", out _))
            throw new InvalidDataException("Invalid update journal");
        UpdatePackage.ValidateVersion(journal.Version);
        return journal;
    }

    public void Save(string path)
    {
        var temporary = path + ".new";
        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(output, this, UpdatePackage.Json);
            output.Flush(true);
        }
        DurableFile.Replace(temporary, path);
    }
}
