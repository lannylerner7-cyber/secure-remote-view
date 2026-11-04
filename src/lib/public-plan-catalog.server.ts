/** One catalog reader for public marketing prices and checkout plan selection. */
export async function readPublicPlanCatalog() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("plans")
    .select("code, name, description, amount_usd, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error("The current plan catalog could not be loaded.");
  const plans = data ?? [];
  if (plans.some((plan) => !Number.isFinite(plan.amount_usd) || plan.amount_usd <= 0)) {
    throw new Error("The current plan catalog contains an invalid price.");
  }
  return plans;
}
