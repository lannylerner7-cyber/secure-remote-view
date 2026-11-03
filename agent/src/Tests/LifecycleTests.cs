using ConnectLive.Agent;

internal static class LifecycleTests
{
    internal static void Run()
    {
        int count = 0;
        void Check(bool condition, string name) {
            if (!condition) throw new Exception("Lifecycle policy failed: " + name);
            count++;
        }
        var lease = new CurtainLease();
        var a = new object(); var b = new object();
        Check(lease.Begin(a, 100), "first owner accepted");
        Check(!lease.Begin(b, 200), "competing peer rejected");
        Check(!lease.Renew(b, 300), "other peer cannot renew");
        Check(!lease.End(b), "other peer cannot cancel");
        Check(lease.Renew(a, 1000), "owner renews");
        Check(lease.Owns(a, 5999), "lease active before deadline");
        Check(!lease.Renew(a, 6000), "expired renewal cannot reactivate");
        Check(!lease.Owns(a, 6000), "exact deadline expires");
        Check(lease.End(a) && lease.Begin(b, 6100), "explicit new owner after release");
        Check(!lease.Renew(a, 6200), "old peer remains rejected");
        var escape = new LocalEscapeGesture();
        Check(!escape.Feed(0xA2, true, false), "Ctrl alone");
        Check(!escape.Feed(0xA4, true, false), "Ctrl Alt");
        Check(!escape.Feed(0xA0, true, false), "Ctrl Alt Shift");
        Check(!escape.Feed(0x1B, true, true), "injected Escape cannot trigger local stop");
        Check(escape.Feed(0x1B, true, false), "physical complete chord");
        escape.Reset();
        Check(!escape.Feed(0x1B, true, false), "reset clears modifier state");
        escape.Feed(0xA3, true, false);
        escape.Feed(0xA5, true, false);
        escape.Feed(0xA1, true, false);
        escape.Feed(0xA3, false, false);
        Check(!escape.Feed(0x1B, true, false), "modifier release clears chord");
        var budget = new RecoveryBudget();
        var now = DateTimeOffset.Parse("2026-11-03T00:00:00Z");
        Check(budget.TryBegin(now, false), "initial automatic recovery");
        Check(!budget.TryBegin(now.AddSeconds(1), false), "no hot crash loop");
        Check(budget.TryBegin(now.AddSeconds(5), false), "second recovery after backoff");
        Check(!budget.TryBegin(now.AddSeconds(10), false), "increasing delay");
        Check(budget.TryBegin(now.AddSeconds(35), false), "third recovery");
        Check(!budget.TryBegin(now.AddSeconds(120), false), "automatic burst limited");
        Check(budget.TryBegin(now.AddSeconds(121), true), "explicit authorized retry");
        Check(budget.TryBegin(now.AddMinutes(11), false), "bounded recovery window expires");
        Console.WriteLine($"{count} lifecycle policy checks passed (not Windows hook/process tests).");
    }
}
