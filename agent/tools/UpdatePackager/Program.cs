using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using ConnectLive.Updates;

// Signing material is read by the build process only; never printed or packed.
// Arguments: staged-runtime-directory version installed-public-key.pem output.zip
try
{
    if (args.Length != 4) throw new ArgumentException("Expected runtime directory, version, public key file, output ZIP");
    UpdatePackage.ValidateVersion(args[1]);
    var privatePem = Environment.GetEnvironmentVariable("CONNECTLIVE_UPDATE_SIGNING_KEY_PEM")
        ?? throw new InvalidOperationException("Configure the update signing secret before creating a runtime release");
    using var signer = RSA.Create();
    signer.ImportFromPem(privatePem);
    using var pinned = RSA.Create();
    pinned.ImportFromPem(File.ReadAllText(args[2]));
    if (signer.KeySize < 3072 || !CryptographicOperations.FixedTimeEquals(
        signer.ExportSubjectPublicKeyInfo(), pinned.ExportSubjectPublicKeyInfo()))
        throw new CryptographicException("Signing key does not match the installed publisher key");
    var files = UpdatePackage.RuntimeFiles.Select(name =>
    {
        var path = Path.Combine(args[0], name);
        var size = new FileInfo(path).Length;
        if (size <= 0 || size > UpdatePackage.MaxFileBytes) throw new InvalidDataException("Invalid runtime payload size");
        return new PackageFile(name, size, UpdatePackage.HashFile(path));
    }).ToArray();
    var manifest = JsonSerializer.SerializeToUtf8Bytes(
        new PackageManifest(1, "connectlive-agent", "win-x64", args[1], files), UpdatePackage.Json);
    var signature = signer.SignData(manifest, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
    if (File.Exists(args[3])) throw new IOException("Refusing to overwrite an existing release bundle");
    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[3]))!);
    using (var archive = ZipFile.Open(args[3], ZipArchiveMode.Create))
    {
        foreach (var file in files) archive.CreateEntryFromFile(Path.Combine(args[0], file.Path), file.Path, CompressionLevel.Optimal);
        using (var stream = archive.CreateEntry("manifest.json").Open()) stream.Write(manifest);
        using (var stream = archive.CreateEntry("manifest.sig").Open()) stream.Write(signature);
    }
    var check = Path.Combine(Path.GetTempPath(), "connectlive-package-check-" + Guid.NewGuid().ToString("N"));
    try
    {
        UpdatePackage.VerifyAndExtract(args[3], check, pinned.ExportSubjectPublicKeyInfoPem(),
            args[1], UpdatePackage.HashFile(args[3]));
    }
    finally { if (Directory.Exists(check)) Directory.Delete(check, true); }
    Console.WriteLine($"Verified signed runtime bundle SHA256: {UpdatePackage.HashFile(args[3])}");
}
catch (Exception exception)
{
    Console.Error.WriteLine($"Runtime packaging failed ({exception.GetType().Name}). Check payload, version and signing configuration.");
    return 1;
}
return 0;
