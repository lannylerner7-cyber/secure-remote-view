using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Startup presence recovery only. This helper never records authorization or
/// retries rejected identity/permission decisions or a dismissed local prompt.
/// </summary>
internal static class EnrollmentRetry
{
    internal static async Task<bool> RunAsync(
        Func<CancellationToken, Task> enroll,
        Func<bool> mayContinue,
        Action<Exception> reportTransient,
        CancellationToken ct,
        Func<CancellationToken, Task>? wait = null)
    {
        wait ??= token => Task.Delay(TimeSpan.FromSeconds(5), token);
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (!mayContinue()) return false;
            try
            {
                await enroll(ct);
                ct.ThrowIfCancellationRequested();
                return mayContinue();
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && IsTransient(ex))
            {
                if (!mayContinue()) return false;
                reportTransient(ex);
                await wait(ct);
            }
        }
    }

    private static bool IsTransient(Exception ex) => ex switch
    {
        HttpRequestException http => http.StatusCode == null ||
            http.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests ||
            (int)http.StatusCode.Value >= 500,
        // HttpClient timeout, not a Meeting-ID prompt dismissal.
        TaskCanceledException canceled => canceled.InnerException is TimeoutException,
        _ => false
    };
}
