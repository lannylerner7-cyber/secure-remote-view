import { useState } from "react";

export function OnScreenKeyboard({
  onKey,
  onCombo,
}: {
  onKey: (vk: number) => void;
  onCombo: (vks: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const VK = {
    BACK: 8,
    TAB: 9,
    ENTER: 13,
    CTRL: 17,
    ESC: 27,
    SPACE: 32,
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    DEL: 46,
    A: 65,
    C: 67,
    V: 86,
    X: 88,
    Z: 90,
    HOME: 36,
    END: 35,
  };

  const Key = ({
    label,
    vk,
    wide,
    tone,
  }: {
    label: string;
    vk: number;
    wide?: boolean;
    tone?: "accent";
  }) => (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        onKey(vk);
      }}
      className={`rounded px-2 py-1.5 text-xs font-medium transition ${
        tone === "accent"
          ? "bg-[#4F7CFF]/80 hover:bg-[#4F7CFF] text-white"
          : "bg-white/10 hover:bg-white/20 text-white/90"
      } ${wide ? "col-span-2" : ""}`}
    >
      {label}
    </button>
  );
  const Combo = ({ label, vks }: { label: string; vks: number[] }) => (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        onCombo(vks);
      }}
      className="rounded bg-amber-500/20 px-2 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/30"
    >
      {label}
    </button>
  );

  return (
    <>
      {/* Toggle tab pinned to right edge */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="absolute right-0 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-l-md border border-r-0 border-white/15 bg-black/70 px-2 py-3 text-[10px] uppercase tracking-widest text-white/70 hover:bg-black/90"
        aria-label="Toggle on-screen keyboard"
      >
        <span>{open ? "›" : "‹"}</span>
        <span className="[writing-mode:vertical-rl] rotate-180">Keys</span>
      </button>

      {/* Slide-out panel */}
      <div
        className={`absolute right-0 top-0 z-10 h-full w-64 border-l border-white/10 bg-black/85 backdrop-blur-md transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <span className="text-[11px] uppercase tracking-widest text-white/60">
            On-screen keys
          </span>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-1.5 text-xs text-white/60 hover:bg-white/10"
          >
            ✕
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1.5 p-3">
          <Key label="Esc" vk={VK.ESC} />
          <Key label="Tab" vk={VK.TAB} />
          <Key label="Enter" vk={VK.ENTER} tone="accent" />
          <Key label="⌫ Back" vk={VK.BACK} />
          <Key label="Del" vk={VK.DEL} />
          <Key label="Space" vk={VK.SPACE} wide />
          <Key label="Home" vk={VK.HOME} />
          <Key label="End" vk={VK.END} />
        </div>
        <div className="border-t border-white/10 px-3 py-2">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-white/50">Shortcuts</div>
          <div className="grid grid-cols-3 gap-1.5">
            <Combo label="Ctrl+A" vks={[VK.CTRL, VK.A]} />
            <Combo label="Ctrl+C" vks={[VK.CTRL, VK.C]} />
            <Combo label="Ctrl+V" vks={[VK.CTRL, VK.V]} />
            <Combo label="Ctrl+X" vks={[VK.CTRL, VK.X]} />
            <Combo label="Ctrl+Z" vks={[VK.CTRL, VK.Z]} />
          </div>
        </div>
      </div>
    </>
  );
}
