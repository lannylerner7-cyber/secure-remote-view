using ConnectLive.Agent;
using ConnectLive.Native;
var directory = Path.Combine(Path.GetTempPath(), "connectlive-config-test-" + Guid.NewGuid());
var file = Path.Combine(directory, "fresh", "config.json");
try
{
    var origin = NativeGatewayPolicy.ValidateOrigin("https://connectliveagent.com", "test");
    ConfigFile.Write(file, origin);
    if (File.ReadAllText(file) != origin) throw new Exception("Fresh profile write failed");
    ConfigFile.Write(file, "replacement");
    if (File.ReadAllText(file) != "replacement") throw new Exception("Replacement failed");
    if (Directory.GetFiles(Path.GetDirectoryName(file)!).Length != 1) throw new Exception("Temporary file leaked");
    try { NativeGatewayPolicy.ValidateOrigin("http://invalid.test", "test"); throw new Exception("HTTP accepted"); }
    catch (InvalidOperationException) { }
    try { ConfigFile.Write(Path.Combine(file, "bad.json"), "invalid"); throw new Exception("Invalid destination accepted"); }
    catch (IOException) { }
    if (File.ReadAllText(file) != "replacement") throw new Exception("Failed write corrupted existing file");
    Console.WriteLine("PASS: fresh directory, replacement, cleanup, HTTPS rejection, failed write preserves original.");
}
finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
