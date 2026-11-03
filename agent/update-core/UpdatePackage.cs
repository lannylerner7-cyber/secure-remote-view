using System.IO.Compression;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace ConnectLive.Updates;

public sealed record PackageFile(string Path, long Length, string Sha256);
public sealed record PackageManifest(int Schema, string Product, string Platform, string Version, PackageFile[] Files);
public sealed record VerifiedPackage(PackageManifest Manifest, string Directory);

/// <summary>Authenticates the entire runtime bundle against an installed publisher key.</summary>
public static class UpdatePackage
{
    public static readonly string[] RuntimeFiles = ["ConnectLive.exe", "ConnectLiveWatch.exe", "ConnectLiveUpdate.exe"];
    public const long MaxArchiveBytes = 512L * 1024 * 1024;
    public const long MaxFileBytes = 256L * 1024 * 1024;
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public static bool IsZipUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Fragment) &&
        uri.AbsolutePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);

    public static string? InstalledPublisherKey()
    {
        using var stream = typeof(UpdatePackage).Assembly.GetManifestResourceStream("ConnectLive.UpdatePublisher.pem");
        if (stream == null) return null;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public static void ValidateVersion(string version)
    {
        if (!Regex.IsMatch(version, @"\A\d{1,3}\.\d{1,3}\.\d{1,5}\z") ||
            !System.Version.TryParse(version, out var v) || v.Major > 255 || v.Minor > 255 || v.Build > 65535 ||
            v.ToString(3) != version)
            throw new InvalidDataException("Invalid update version");
    }

    public static VerifiedPackage VerifyAndExtract(string archivePath, string destination, string publicKey,
        string expectedVersion, string expectedArchiveHash)
    {
        ValidateVersion(expectedVersion);
        if (!Regex.IsMatch(expectedArchiveHash, @"\A[0-9a-fA-F]{64}\z") ||
            new FileInfo(archivePath).Length > MaxArchiveBytes ||
            !HashFile(archivePath).Equals(expectedArchiveHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Update archive checksum mismatch");
        if (Directory.Exists(destination)) throw new IOException("Staging directory must be new");
        CheckZipDirectory(archivePath);
        using var zip = ZipFile.OpenRead(archivePath);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in zip.Entries)
        {
            var unixKind = (entry.ExternalAttributes >> 16) & 0xf000;
            if (!names.Add(entry.FullName) || (unixKind != 0 && unixKind != 0x8000) ||
                entry.FullName.Contains('/') || entry.FullName.Contains('\\') ||
                entry.Length < 0 || entry.Length > MaxFileBytes ||
                (!RuntimeFiles.Contains(entry.FullName, StringComparer.Ordinal) &&
                 entry.FullName is not ("manifest.json" or "manifest.sig")))
                throw new InvalidDataException("Unexpected, duplicate or unsafe archive entry");
        }
        if (zip.Entries.Count != RuntimeFiles.Length + 2 ||
            zip.Entries.Sum(e => e.Length) > MaxArchiveBytes)
            throw new InvalidDataException("Incomplete or oversized runtime bundle");
        byte[] ReadSmall(string name, int limit)
        {
            var entry = zip.GetEntry(name) ?? throw new InvalidDataException("Missing signature metadata");
            if (entry.Length > limit) throw new InvalidDataException("Oversized signature metadata");
            using var source = entry.Open();
            using var bytes = new MemoryStream();
            var buffer = new byte[4096];
            int count;
            while ((count = source.Read(buffer)) != 0)
            {
                if (bytes.Length + count > limit) throw new InvalidDataException("Oversized signature metadata");
                bytes.Write(buffer, 0, count);
            }
            return bytes.ToArray();
        }
        var manifestBytes = ReadSmall("manifest.json", 16_384);
        using var publisher = RSA.Create();
        publisher.ImportFromPem(publicKey);
        if (publisher.KeySize < 3072 ||
            !publisher.VerifyData(manifestBytes, ReadSmall("manifest.sig", 8192),
                HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            throw new CryptographicException("Update publisher signature is invalid");
        var manifest = JsonSerializer.Deserialize<PackageManifest>(manifestBytes, Json)
            ?? throw new InvalidDataException("Missing manifest");
        if (manifest.Schema != 1 || manifest.Product != "connectlive-agent" ||
            manifest.Platform != "win-x64" || manifest.Version != expectedVersion ||
            manifest.Files == null || manifest.Files.Length != RuntimeFiles.Length ||
            manifest.Files.Select(f => f.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != RuntimeFiles.Length ||
            manifest.Files.Any(f => !RuntimeFiles.Contains(f.Path, StringComparer.Ordinal)))
            throw new InvalidDataException("The signed manifest does not match this release");
        Directory.CreateDirectory(destination);
        try
        {
            foreach (var file in manifest.Files)
            {
                var entry = zip.GetEntry(file.Path) ?? throw new InvalidDataException("Missing runtime file");
                if (file.Length <= 0 || file.Length != entry.Length || file.Length > MaxFileBytes ||
                    !Regex.IsMatch(file.Sha256, @"\A[0-9a-fA-F]{64}\z"))
                    throw new InvalidDataException("Invalid runtime file metadata");
                var target = System.IO.Path.Combine(destination, file.Path);
                using (var input = entry.Open())
                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    var buffer = new byte[81920];
                    long total = 0;
                    int read;
                    while ((read = input.Read(buffer)) != 0)
                    {
                        total += read;
                        if (total > file.Length) throw new InvalidDataException("Expanded file exceeded its signed size");
                        output.Write(buffer, 0, read);
                    }
                    output.Flush(true);
                    if (total != file.Length) throw new InvalidDataException("Truncated runtime file");
                }
                if (!HashFile(target).Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Runtime file checksum mismatch");
            }
            return new(manifest, destination);
        }
        catch
        {
            Directory.Delete(destination, true);
            throw;
        }
    }

    private static void CheckZipDirectory(string path)
    {
        // Bound the central directory before ZipArchive materializes entries.
        // These five-file, sub-512 MiB bundles do not need ZIP64 or multi-disk ZIP.
        using var source = File.OpenRead(path);
        var tail = new byte[(int)Math.Min(source.Length, 65557)];
        source.Position = source.Length - tail.Length;
        source.ReadExactly(tail);
        for (var offset = tail.Length - 22; offset >= 0; offset--)
        {
            var span = tail.AsSpan(offset);
            if (BinaryPrimitives.ReadUInt32LittleEndian(span) != 0x06054b50 ||
                offset + 22 + BinaryPrimitives.ReadUInt16LittleEndian(span[20..]) != tail.Length) continue;
            var size = BinaryPrimitives.ReadUInt32LittleEndian(span[12..]);
            var start = BinaryPrimitives.ReadUInt32LittleEndian(span[16..]);
            if (BinaryPrimitives.ReadUInt16LittleEndian(span[4..]) != 0 ||
                BinaryPrimitives.ReadUInt16LittleEndian(span[6..]) != 0 ||
                BinaryPrimitives.ReadUInt16LittleEndian(span[8..]) != 5 ||
                BinaryPrimitives.ReadUInt16LittleEndian(span[10..]) != 5 || size > 8192 ||
                (long)start + size != source.Length - tail.Length + offset)
                throw new InvalidDataException("Unsupported or oversized ZIP directory");
            return;
        }
        throw new InvalidDataException("Missing ZIP directory");
    }
}
