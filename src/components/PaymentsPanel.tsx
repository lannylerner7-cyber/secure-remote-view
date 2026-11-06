import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getPaymentsHealth } from "@/lib/orders.functions";
import type { PaymentsHealth } from "@/shared/bitcoin";
import { EmailSettingsPanel } from "@/components/EmailSettingsPanel";
import { CustomersPanel } from "@/components/CustomersPanel";
import { HealthStrip } from "@/components/payments/HealthStrip";
import { OrdersTab } from "@/components/payments/OrdersTab";
import { WalletTab } from "@/components/payments/WalletTab";
import { errMsg } from "@/components/payments/shared";

type Tab = "orders" | "wallets" | "customers" | "email";

export function PaymentsPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const loadHealth = useServerFn(getPaymentsHealth);
  const fn = useRef(loadHealth);
  fn.current = loadHealth;
  const [health, setHealth] = useState<PaymentsHealth | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("orders");

  const reloadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      setHealth((await fn.current()) as PaymentsHealth);
      setHealthErr(null);
    } catch (e) {
      setHealthErr(errMsg(e, "Health check failed"));
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    reloadHealth();
    const t = setInterval(reloadHealth, 60_000);
    return () => clearInterval(t);
  }, [reloadHealth]);

  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: "orders", label: "Orders", show: true },
    { id: "wallets", label: "Wallet", show: isSuperAdmin },
    { id: "customers", label: "Customers", show: isSuperAdmin },
    { id: "email", label: "Email", show: isSuperAdmin },
  ];

  return (
    <div className="space-y-5">
      <HealthStrip
        health={health}
        error={healthErr}
        loading={healthLoading}
        isSuperAdmin={isSuperAdmin}
        onConfigure={() => setTab("wallets")}
        onRetry={reloadHealth}
      />

      <div role="tablist" aria-label="Payments sections" className="flex gap-1 overflow-x-auto border-b border-[#e2dfdb]">
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.id ? "border-[#1c1917] font-semibold text-[#1c1917]" : "border-transparent text-[#57534e] hover:text-[#1c1917]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="min-w-0 max-w-full">
        {tab === "orders" && <OrdersTab isSuperAdmin={isSuperAdmin} />}
        {tab === "wallets" && isSuperAdmin && <WalletTab onSaved={reloadHealth} />}
        {tab === "customers" && isSuperAdmin && (
          <div className="rounded-lg bg-[#1c1917] p-4 text-[#fafaf9]"><CustomersPanel isSuperAdmin={isSuperAdmin} /></div>
        )}
        {tab === "email" && isSuperAdmin && (
          <div className="rounded-lg bg-[#1c1917] p-4 text-[#fafaf9]"><EmailSettingsPanel /></div>
        )}
      </div>
    </div>
  );
}
