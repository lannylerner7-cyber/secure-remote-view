import type { PaymentsHealth } from "@/shared/bitcoin";
import { Notice, Skeleton, btnSecondary } from "./shared";

export function HealthStrip({
  health,
  error,
  loading,
  isSuperAdmin,
  onConfigure,
  onRetry,
}: {
  health: PaymentsHealth | null;
  error: string | null;
  loading: boolean;
  isSuperAdmin: boolean;
  onConfigure: () => void;
  onRetry: () => void;
}) {
  if (loading && !health) return <Skeleton className="h-16 w-full" />;
  if (error && !health)
    return (
      <Notice
        tone="error"
        testId="error-health"
        action={<button className={btnSecondary} onClick={onRetry} data-testid="button-retry-health">Retry</button>}
      >
        Payment status could not be loaded: {error}
      </Notice>
    );
  if (!health) return null;
  const ready = health.wallets.BTC && !health.wallet_issue;
  return (
    <section data-testid="panel-health" className="space-y-2">
      {!ready && (
        <Notice
          tone="warn"
          testId="status-checkout-blocked"
          action={
            isSuperAdmin ? (
              <button className={btnSecondary} onClick={onConfigure} data-testid="button-configure-wallet">
                Configure wallet
              </button>
            ) : undefined
          }
        >
          <strong className="font-semibold">New Bitcoin checkout is not ready.</strong>{" "}
          {health.wallet_issue ?? "No receiving address is saved."}
        </Notice>
      )}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-[#e2dfdb] bg-[#e2dfdb] text-xs sm:grid-cols-4">
        <Cell label="Receiving wallet" value={health.wallets.BTC ? "Configured" : "Missing"} tone={health.wallets.BTC ? "ok" : "bad"} />
        <Cell label="Network" value="Bitcoin mainnet" />
        <Cell label="Confirmations required" value={String(health.confirmations_required)} />
        <Cell
          label="Monitor auth token"
          value={health.cron_secret_configured ? "Set" : "Not set"}
          tone={health.cron_secret_configured ? undefined : "bad"}
        />
      </dl>
      <p className="text-[11px] leading-relaxed text-[#57534e]" data-testid="text-monitoring-note">
        {health.monitoring_note} A configured token only authorizes the monitor; it does not prove the scheduler is running.
      </p>
    </section>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div className="bg-[#fdfcfb] px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-[#6b645d]">{label}</dt>
      <dd className={`mt-0.5 font-medium ${tone === "ok" ? "text-[#1d4a2c]" : tone === "bad" ? "text-[#7a1d14]" : "text-[#1c1917]"}`}>
        {value}
      </dd>
    </div>
  );
}
