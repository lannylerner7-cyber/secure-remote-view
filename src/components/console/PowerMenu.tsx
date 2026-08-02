import { useEffect, useRef, useState } from "react";

export function PowerMenu({
  onSelect,
  canShutdown,
}: {
  onSelect: (kind: "reboot" | "shutdown" | "lock" | "logoff") => void;
  canShutdown: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium hover:bg-white/10"
        title="Power actions"
      >
        Power ▾
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded border border-white/10 bg-[#0F172A] text-xs shadow-xl">
          <button
            onClick={() => {
              setOpen(false);
              onSelect("lock");
            }}
            className="block w-full px-3 py-2 text-left hover:bg-white/5"
          >
            🔒 Lock
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onSelect("logoff");
            }}
            className="block w-full px-3 py-2 text-left hover:bg-white/5"
          >
            👤 Sign out
          </button>
          {canShutdown && (
            <button
              onClick={() => {
                setOpen(false);
                onSelect("reboot");
              }}
              className="block w-full px-3 py-2 text-left text-amber-200 hover:bg-white/5"
            >
              🔁 Reboot
            </button>
          )}
          {canShutdown && (
            <button
              onClick={() => {
                setOpen(false);
                onSelect("shutdown");
              }}
              className="block w-full px-3 py-2 text-left text-rose-300 hover:bg-white/5"
            >
              ⏻ Shutdown
            </button>
          )}
        </div>
      )}
    </div>
  );
}
