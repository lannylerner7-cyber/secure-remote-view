namespace ConnectLive.Agent;

// Platform-free shape used by the real permission gate in this harness.
internal sealed record GrantScopes(bool View, bool Control, bool Clipboard, bool Files, bool Recording)
{
    internal bool Allows(string scope) => scope switch
    {
        "view" => View, "control" => Control, "clipboard" => Clipboard,
        "files" => Files, "recording" => Recording, _ => false,
    };
}

internal static class PeerLifecycleTests
{
    internal static void Run()
    {
        var checks = 0;
        void Check(bool value, string label)
        {
            if (!value) throw new InvalidOperationException(label);
            checks++;
        }
        using var signaling = new CancellationTokenSource();
        var session = new PeerInputPermission("control", new(true, true, true, true, true), () => true);
        var binding = new PeerSignalBinding(() => !signaling.IsCancellationRequested && session.Allows("view"));
        Check(binding.TryBind("admin", "viewer-1"), "First viewer binds");
        var first = session.Fork();
        Check(first.Allows("control"), "First peer inherits authorized control");
        Check(binding.TryRelease("admin", "viewer-1"), "Current viewer bye accepted");
        first.Revoke(); // The production peer teardown revokes only this child.
        Check(session.Allows("view") && session.Allows("control") && !signaling.IsCancellationRequested,
            "Viewer close preserves capture authorization and signaling");
        Check(first.Token.IsCancellationRequested && !first.Allows("files"),
            "Old data-channel callbacks lose their peer capability");

        Check(binding.TryBind("admin", "viewer-2"), "Viewer reopen accepts another offer");
        var second = session.Fork();
        Check(!binding.TryRelease("admin", "viewer-1") && second.Allows("control"),
            "Late bye from same admin's old viewer cannot close the replacement");
        Check(!binding.TryRelease("other-admin", "viewer-2") && binding.Matches("admin", "viewer-2"),
            "Foreign admin bye rejected");
        Check(!binding.TryRelease("admin", null) && !binding.TryRelease(null, null),
            "Untagged or anonymous bye cannot close tagged viewer");
        session.SetMode("view");
        Check(!second.Allows("control") && second.Allows("files"),
            "Parent mode change applies without disabling independent file scope");
        session.SetMode("control");
        Check(second.Allows("control") && !first.Allows("control"),
            "Mode recovery never revives the closed peer");

        Check(binding.TryBind("admin", "viewer-3"), "New offer can win before old bye arrives");
        second.Revoke();
        var third = session.Fork();
        Check(!binding.TryRelease("admin", "viewer-2") && binding.Matches("admin", "viewer-3"),
            "Late bye racing new offer leaves newest binding intact");
        session.Revoke();
        Check(third.Token.IsCancellationRequested && !third.Allows("view"),
            "Session revocation cancels the active child");
        Check(!binding.TryBind("admin", "viewer-4"), "Revoked authorization cannot reopen");
        Console.WriteLine($"PASS: {checks} viewer close/reopen, late-bye, child-scope and revocation lifecycle checks");
    }
}
