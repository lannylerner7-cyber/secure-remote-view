export type TgState = {
  telegram_bot_token: string;
  telegram_chat_id: string;
  notify_on_session_start: boolean;
  notify_on_control_taken: boolean;
  notify_on_device_offline: boolean;
  notify_on_agent_stopped: boolean;
};

export function TelegramSettings({
  tg,
  setTg,
  onSave,
  onTest,
  status,
}: {
  tg: TgState;
  setTg: (v: TgState) => void;
  onSave: () => void;
  onTest: () => void;
  status: null | "saved" | "testing" | "test_ok" | "test_fail";
}) {
  return (
    <div className="max-w-lg rounded-lg border border-white/10 bg-[#1F2A44] p-6">
      <h3 className="mb-3 text-sm font-semibold">Telegram notifications</h3>
      <p className="mb-4 text-xs text-white/60">
        Create a bot with @BotFather, paste the token here, then message it once and paste your chat
        ID.
      </p>
      <label className="block text-xs text-white/60">Bot token</label>
      <input
        value={tg.telegram_bot_token}
        onChange={(e) => setTg({ ...tg, telegram_bot_token: e.target.value })}
        className="mb-3 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-sm"
        placeholder="123456:ABC-DEF..."
      />
      <label className="block text-xs text-white/60">Chat ID</label>
      <input
        value={tg.telegram_chat_id}
        onChange={(e) => setTg({ ...tg, telegram_chat_id: e.target.value })}
        className="mb-4 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-sm"
        placeholder="123456789"
      />
      <div className="mb-4 space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={tg.notify_on_session_start}
            onChange={(e) => setTg({ ...tg, notify_on_session_start: e.target.checked })}
          />{" "}
          Notify on session start
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={tg.notify_on_control_taken}
            onChange={(e) => setTg({ ...tg, notify_on_control_taken: e.target.checked })}
          />{" "}
          Notify on control taken / released
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={tg.notify_on_device_offline}
            onChange={(e) => setTg({ ...tg, notify_on_device_offline: e.target.checked })}
          />{" "}
          Notify on device unreachable
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={tg.notify_on_agent_stopped}
            onChange={(e) => setTg({ ...tg, notify_on_agent_stopped: e.target.checked })}
          />{" "}
          Notify when agent process is stopped (Task Manager kill)
        </label>
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onTest}
          className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
        >
          Send test
        </button>
        <div className="flex items-center gap-2">
          {status === "saved" && <span className="text-xs text-green-300">Saved</span>}
          {status === "test_ok" && <span className="text-xs text-green-300">Delivered ✓</span>}
          {status === "test_fail" && <span className="text-xs text-red-300">Failed</span>}
          {status === "testing" && <span className="text-xs text-white/60">Sending…</span>}
          <button onClick={onSave} className="rounded bg-[#4F7CFF] px-4 py-1.5 text-xs font-medium">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
