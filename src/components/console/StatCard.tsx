
export function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "blue" | "green" | "amber" | "slate";
}) {
  const bg = {
    blue: "bg-[#4F7CFF]/10 border-[#4F7CFF]/30",
    green: "bg-green-500/10 border-green-500/30",
    amber: "bg-amber-500/10 border-amber-500/30",
    slate: "bg-white/5 border-white/10",
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${bg}`}>
      <div className="text-xs uppercase tracking-widest text-white/50">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}
