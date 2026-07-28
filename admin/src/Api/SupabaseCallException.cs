using System;

namespace ConnectLive.Admin.Api;

/// <summary>
/// Thrown by <see cref="ApiClient"/> when a Supabase REST call returns a
/// non-2xx status. Carries the HTTP status and PostgREST body so ViewModels
/// can render a real error message (RLS denial, constraint violation,
/// expired token) instead of a silent "the UI froze" experience.
///
/// Background loops (frame poll, signal poll) that used to swallow every
/// exception now catch this specifically and surface it via their
/// <c>onError</c> callback to the ViewModel's status banner.
/// </summary>
public sealed class SupabaseCallException : Exception
{
    public int StatusCode { get; }
    public string ResponseBody { get; }
    public string Context { get; }

    public SupabaseCallException(string context, int statusCode, string body)
        : base($"{context}: HTTP {statusCode} {(string.IsNullOrWhiteSpace(body) ? "" : "— " + body.Trim())}")
    {
        Context = context;
        StatusCode = statusCode;
        ResponseBody = body ?? "";
    }

    /// <summary>True for 401/403 — usually means the technician's Supabase
    /// session expired, was revoked, or lacks RLS access. UI should prompt
    /// re-login instead of silently retrying forever.</summary>
    public bool IsAuth => StatusCode == 401 || StatusCode == 403;
}
