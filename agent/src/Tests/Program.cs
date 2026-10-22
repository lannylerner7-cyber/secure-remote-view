using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using ConnectLive.Native;
using ConnectLive.Admin.Api;

var passed = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    Console.WriteLine("PASS: " + name);
    passed++;
}

foreach (var bad in new[] {
    "", "http://example.test", "https://user:pass@example.test",
    "https://example.test?q=token", "https://example.test#token",
    "https://example.test?", "https://example.test#", "https://example.test/api",
    "https://example.test/../api", "//example.test", "file:///example.test" })
{
    var rejected = false;
    try { NativeGatewayPolicy.ValidateOrigin(bad, "test"); }
    catch (InvalidOperationException) { rejected = true; }
    Check(rejected, "reject unsafe origin #" + passed);
}
Check(NativeGatewayPolicy.ValidateOrigin("https://EXAMPLE.test:8443/", "test") ==
    "https://example.test:8443", "canonical HTTPS origin with explicit port");
Check(NativeGatewayPolicy.IcePath("session /?&") ==
    "/api/public/agent/ice?sessionId=session%20%2F%3F%26", "session ID query escaping");
var emptyRejected = false;
try { NativeGatewayPolicy.IcePath(""); }
catch (ArgumentException) { emptyRejected = true; }
Check(emptyRejected, "session ID required");
var configRejected = false;
try { new AppConfig().Validate(); }
catch (InvalidOperationException) { configRejected = true; }
Check(configRejected, "Admin has no implicit account configuration");
var config = new AppConfig { BaseUrl = "https://gateway.test/", SupabaseUrl = "https://auth.test/", SupabaseAnonKey = "test-publishable-key" };
config.Validate();
Check(config.BaseUrl == "https://gateway.test" && config.SupabaseUrl == "https://auth.test",
    "explicit Admin settings canonicalized");
config.SupabaseAnonKey = "";
configRejected = false;
try { config.Validate(); }
catch (InvalidOperationException ex) { configRejected = ex.Message.Contains("supabaseAnonKey"); }
Check(configRejected, "missing publishable key gives actionable error");

// Real socket redirect test of the exact handler used by both clients.
// HTTP loopback exists only in this test; production origins require HTTPS.
using var origin = new TcpListener(IPAddress.Loopback, 0);
using var destination = new TcpListener(IPAddress.Loopback, 0);
origin.Start();
destination.Start();
var originPort = ((IPEndPoint)origin.LocalEndpoint).Port;
var destinationPort = ((IPEndPoint)destination.LocalEndpoint).Port;
var receivedAuth = false;
var server = Task.Run(async () =>
{
    using var socket = await origin.AcceptTcpClientAsync();
    using var stream = socket.GetStream();
    using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
    string? line;
    while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
        if (line.StartsWith("X-Device-Token:") || line.StartsWith("Authorization:"))
            receivedAuth = true;
    var response = Encoding.ASCII.GetBytes($"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{destinationPort}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    await stream.WriteAsync(response);
});
using (var http = new HttpClient(NativeGatewayPolicy.CreateHandler()))
using (var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{originPort}/ice"))
{
    request.Headers.Add("X-Device-Token", "test-device-token");
    request.Headers.Authorization = new("Bearer", "test-bearer");
    using var response = await http.SendAsync(request);
    await server;
    Check(receivedAuth && response.StatusCode == HttpStatusCode.TemporaryRedirect &&
        !destination.Pending(), "redirect returned, no credential request to other origin");
}
Check(NativeGatewayPolicy.IceBudget == TimeSpan.FromSeconds(12), "12-second total ICE budget");
using (var http = new HttpClient(new DelayedHandler(TimeSpan.FromMilliseconds(5200))))
using (var timeout = new CancellationTokenSource(NativeGatewayPolicy.IceBudget))
{
    using var response = await http.GetAsync("https://gateway.test/ice", timeout.Token);
    Check(response.IsSuccessStatusCode, "provider 5-second failure plus fallback fits native total budget");
}
using (var http = new HttpClient(new DelayedHandler(TimeSpan.FromSeconds(30))))
using (var caller = new CancellationTokenSource(TimeSpan.FromMilliseconds(80)))
using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(caller.Token))
{
    timeout.CancelAfter(NativeGatewayPolicy.IceBudget);
    var watch = Stopwatch.StartNew();
    var cancelled = false;
    try { await http.GetAsync("https://gateway.test/ice", timeout.Token); }
    catch (OperationCanceledException) { cancelled = true; }
    Check(cancelled && watch.Elapsed < TimeSpan.FromSeconds(2), "caller cancellation interrupts ICE lookup");
}
using (var http = new HttpClient(new DelayedHandler(TimeSpan.FromSeconds(30))))
using (var timeout = new CancellationTokenSource(NativeGatewayPolicy.IceBudget))
{
    var watch = Stopwatch.StartNew();
    var cancelled = false;
    try { await http.GetAsync("https://gateway.test/ice", timeout.Token); }
    catch (OperationCanceledException) { cancelled = true; }
    Check(cancelled && watch.Elapsed >= TimeSpan.FromSeconds(11) &&
        watch.Elapsed < TimeSpan.FromSeconds(15), "stalled lookup cancelled at total deadline");
}
Console.WriteLine($"{passed} checks passed");

sealed class DelayedHandler(TimeSpan delay) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        await Task.Delay(delay, ct);
        return new HttpResponseMessage(HttpStatusCode.OK);
    }
}
