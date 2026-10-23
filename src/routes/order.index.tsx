import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createOrderPublic, getActivePlansPublic } from "@/lib/orders.functions";
import { SiteShell } from "@/components/site/layout";
import { OrderWizard, type OrderPlan } from "@/components/site/order-wizard";

export const Route = createFileRoute("/order/")({
  component: OrderPage,
  head: () => ({
    meta: [
      { title: "Order a ConnectLive license" },
      {
        name: "description",
        content: "Buy a ConnectLive remote-support license with Bitcoin, USDT, or USDC.",
      },
      { property: "og:title", content: "Order a ConnectLive license" },
      {
        property: "og:description",
        content: "Pay in BTC, USDT, or USDC. Instant invoice, live payment tracking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://www.connectliveagent.com/order" }],
  }),
});

function OrderPage() {
  const navigate = useNavigate();
  const loadPlans = useServerFn(getActivePlansPublic);
  const createOrder = useServerFn(createOrderPublic);
  const [plans, setPlans] = useState<OrderPlan[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);

  const fetchPlans = useCallback(() => {
    setPlans(null);
    setPlansError(null);
    loadPlans()
      .then((rows) => setPlans((rows as OrderPlan[]) ?? []))
      .catch((e) => setPlansError(e instanceof Error ? e.message : "Could not load plans"));
  }, [loadPlans]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  return (
    <SiteShell>
      <OrderWizard
        plans={plans}
        plansError={plansError}
        onRetryPlans={fetchPlans}
        onCreate={async (input) => {
          const res = await createOrder({ data: input });
          navigate({ to: "/order/$id", params: { id: (res as { id: string }).id } });
        }}
      />
    </SiteShell>
  );
}
