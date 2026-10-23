import sessionCore from "@/assets/connectlive-session-core.png";

export function SessionCore({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`orb-shell ${compact ? "max-w-md" : ""}`}
      role="img"
      aria-label="Illustration of an authorized live support session"
    >
      <div className="orb-ring" aria-hidden="true" />
      <img
        className="orb-image"
        src={sessionCore}
        alt="Luminous secure session core floating above a metallic base"
        decoding="async"
      />
      <div className="orbit-label orbit-one">
        <span>Transport</span>
        <strong>Encrypted</strong>
      </div>
      <div className="orbit-label orbit-two">
        <span>Device</span>
        <strong>Authorized</strong>
      </div>
      <div className="orbit-label orbit-three">
        <span>Channel</span>
        <strong>WebRTC</strong>
      </div>
    </div>
  );
}
