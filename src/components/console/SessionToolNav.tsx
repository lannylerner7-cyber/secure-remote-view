import { useRef, type KeyboardEvent } from "react";
import { SESSION_TOOLS, type SessionToolId } from "./session-tools";

/**
 * Labeled tool navigation for the live viewer. Desktop/tablet shows a vertical
 * tab list; phones get a native labeled select. Keyboard events stop here so
 * tool navigation can never reach the remote input surface.
 */
export function SessionToolNav({
  value, onChange, unavailable, busy,
}: {
  value: SessionToolId;
  onChange: (tool: SessionToolId) => void;
  /** Tool id -> reason it is unavailable (still selectable to read why). */
  unavailable?: Partial<Record<SessionToolId, string>>;
  /** Tool id -> short badge text for background activity. */
  busy?: Partial<Record<SessionToolId, string>>;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    const i = SESSION_TOOLS.findIndex(t => t.id === value);
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % SESSION_TOOLS.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + SESSION_TOOLS.length) % SESSION_TOOLS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SESSION_TOOLS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = SESSION_TOOLS[next].id;
    onChange(id);
    refs.current[id]?.focus();
  }
  return (
    <>
      <label className="block px-1 md:hidden" onKeyDown={e => e.stopPropagation()}>
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-white/45">Session tool</span>
        <select
          data-testid="select-session-tool"
          value={value}
          onChange={e => onChange(e.target.value as SessionToolId)}
          className="w-full rounded border border-white/15 bg-[#0F172A] px-2 py-1.5 text-xs text-white focus:border-[#4F7CFF] focus:outline-none"
        >
          {SESSION_TOOLS.map(t => (
            <option key={t.id} value={t.id}>
              {t.label}{busy?.[t.id] ? ` (${busy[t.id]})` : ""}{unavailable?.[t.id] ? " (unavailable)" : ""}
            </option>
          ))}
        </select>
      </label>
      <div role="tablist" aria-label="Session tools" aria-orientation="vertical"
        onKeyDown={onKey} className="hidden flex-col gap-0.5 md:flex">
        {SESSION_TOOLS.map(t => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={el => { refs.current[t.id] = el; }}
              type="button"
              role="tab"
              id={`session-tool-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`session-tool-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              data-testid={`tab-session-tool-${t.id}`}
              title={unavailable?.[t.id]}
              onClick={() => onChange(t.id)}
              className={`group flex w-full items-center justify-between gap-2 rounded border-l-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                selected ? "border-[#4F7CFF] bg-[#4F7CFF]/15 font-medium text-white" :
                  "border-transparent text-white/65 hover:bg-white/5 hover:text-white"}`}
            >
              <span className={unavailable?.[t.id] && !selected ? "text-white/40" : undefined}>{t.label}</span>
              {busy?.[t.id] && (
                <span className="rounded-full bg-white/10 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-white/80">
                  {busy[t.id]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
