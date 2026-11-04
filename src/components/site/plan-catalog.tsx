import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/** One live plan row from GET /api/public/plans (same reader as checkout). */
export type CatalogPlan = {
  code: string;
  name: string;
  description: string | null;
  amount_usd: number;
  sort_order: number;
};

export type CatalogStatus = "loading" | "ready" | "error";

export type CatalogSnapshot = { plans: CatalogPlan[] | null; error: string | null };

type CatalogValue = {
  status: CatalogStatus;
  plans: CatalogPlan[] | null;
  error: string | null;
  retry: () => void;
  /** Verified current price for a plan code, or null when it cannot be verified. */
  priceFor: (code: string) => number | null;
};

const UNAVAILABLE = "Current prices are temporarily unavailable. Please try again.";
const CatalogContext = createContext<CatalogValue | null>(null);

function isPlan(value: unknown): value is CatalogPlan {
  const row = value as CatalogPlan;
  return (
    !!row &&
    typeof row.code === "string" &&
    typeof row.name === "string" &&
    Number.isFinite(Number(row.amount_usd)) &&
    Number(row.amount_usd) > 0
  );
}

async function fetchCatalog(signal: AbortSignal): Promise<CatalogPlan[]> {
  const res = await fetch("/api/public/plans", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" && message ? message : UNAVAILABLE);
  }
  const rows = (body as { plans?: unknown } | null)?.plans;
  if (!Array.isArray(rows) || !rows.every(isPlan)) throw new Error(UNAVAILABLE);
  return rows
    .map((row) => ({ ...row, amount_usd: Number(row.amount_usd), sort_order: Number(row.sort_order) || 0 }))
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Shared live price catalog for the public site. Always revalidates on mount,
 * window focus and tab visibility; a failure clears previously shown prices so
 * a stale amount is never presented as current.
 */
export function PlanCatalogProvider({
  initial,
  children,
}: {
  initial?: CatalogSnapshot | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ status: CatalogStatus; plans: CatalogPlan[] | null; error: string | null }>(() => {
    if (initial?.plans) return { status: "ready", plans: initial.plans, error: null };
    if (initial?.error) return { status: "error", plans: null, error: initial.error };
    return { status: "loading", plans: null, error: null };
  });
  const controller = useRef<AbortController | null>(null);
  const lastLoad = useRef(0);

  const load = useCallback((showLoading: boolean) => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    lastLoad.current = Date.now();
    if (showLoading) setState({ status: "loading", plans: null, error: null });
    fetchCatalog(ctrl.signal)
      .then((plans) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", plans, error: null });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", plans: null, error: e instanceof Error && e.message ? e.message : UNAVAILABLE });
      });
  }, []);

  useEffect(() => {
    load(false);
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastLoad.current < 1500) return;
      load(false);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      controller.current?.abort();
    };
  }, [load]);

  const retry = useCallback(() => load(true), [load]);
  const priceFor = useCallback(
    (code: string) => {
      if (state.status !== "ready" || !state.plans) return null;
      return state.plans.find((p) => p.code === code)?.amount_usd ?? null;
    },
    [state],
  );

  return (
    <CatalogContext.Provider value={{ ...state, retry, priceFor }}>{children}</CatalogContext.Provider>
  );
}

export function usePlanCatalog(): CatalogValue {
  const value = useContext(CatalogContext);
  if (!value) throw new Error("usePlanCatalog must be used inside PlanCatalogProvider");
  return value;
}

export function formatPrice(amount: number) {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}
