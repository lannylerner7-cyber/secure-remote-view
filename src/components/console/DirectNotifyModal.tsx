import { useState } from "react";
import type { AdminRow } from "@/lib/admins.functions";
import type { NotificationSeverity } from "@/lib/notifications.functions";

export function DirectNotifyModal({
  target,
  onClose,
  onSend,
}: {
  target: AdminRow;
  onClose: () => void;
  onSend: (title: string, body: string, severity: NotificationSeverity) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<NotificationSeverity>("info");
  const [busy, setBusy] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-white/10 bg-[#0F172A] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-xs uppercase tracking-widest text-white/50">Notify admin</div>
        <div className="mb-4 text-sm text-white">{target.display_name ?? target.email}</div>
        <div className="space-y-3">
          <input
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
          />
          <textarea
            placeholder="Body (optional)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={2000}
            rows={4}
            className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
          />
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as NotificationSeverity)}
            className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm"
          >
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              disabled={busy || !title.trim()}
              onClick={async () => {
                setBusy(true);
                await onSend(title, body, severity);
                setBusy(false);
              }}
              className="rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
