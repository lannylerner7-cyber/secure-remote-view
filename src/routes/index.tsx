import { createFileRoute, Link } from "@tanstack/react-router";

// Direct download URL for the compiled agent. Swap this one line to point at
// the hosted ConnectLiveAgent.exe / .zip artifact.
const AGENT_DOWNLOAD_URL = "/downloads/ConnectLiveAgent.zip";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "ConnectLive — Remote Support for Windows" },
      {
        name: "description",
        content:
          "Download ConnectLive for Windows and join your support session with a 6-digit meeting ID. Consent-based, transparent remote support.",
      },
      { property: "og:title", content: "ConnectLive — Remote Support for Windows" },
      {
        property: "og:description",
        content:
          "Download ConnectLive for Windows and join your support session with a 6-digit meeting ID.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function Home() {
  return (
    <div className="min-h-screen bg-[#F6F7FB] text-[#1F2A44]">
      {/* Ambient background — placeholder for the upcoming animated
          geography-in-space layer. Keep the DOM shape here so the animation
          can slot in without touching card layout. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_20%_10%,#E7ECFF_0%,transparent_45%),radial-gradient(circle_at_80%_90%,#DCE4FF_0%,transparent_50%)]"
      />

      <main className="flex min-h-screen items-center justify-center px-4 py-16">
        <section className="w-full max-w-[520px] rounded-2xl bg-white p-10 text-center shadow-[0_4px_30px_rgba(31,42,68,0.08)]">
          <h1 className="text-[28px] font-semibold leading-tight text-[#1F2A44]">
            Join your session on
            <br />
            <span className="text-[#4F7CFF]">ConnectLive</span>
          </h1>

          {/* 3D spinning cube — ConnectLive-native faces only. No third-party
              logos on the cube: we do not impersonate other remote-support
              brands. */}
          <div className="scene mx-auto mt-8">
            <div className="cube">
              <div className="face front">
                <CLMark />
              </div>
              <div className="face back">
                <CLMark />
              </div>
              <div className="face right">
                <CLWord />
              </div>
              <div className="face left">
                <CLWord />
              </div>
              <div className="face top">
                <CLShield />
              </div>
              <div className="face bottom">
                <CLShield />
              </div>
            </div>
          </div>

          <p className="mt-8 text-[15px] text-[#4B5568]">
            First, download the ConnectLive app for Windows.
          </p>

          <a
            href={AGENT_DOWNLOAD_URL}
            className="mt-5 block w-full rounded-lg bg-[#4F7CFF] px-4 py-3.5 text-[15px] font-semibold text-white shadow-sm transition-colors hover:bg-[#3E67E0]"
          >
            Download for Windows (64-bit)
          </a>

          <div className="mt-6 rounded-lg bg-[#F3F5FA] p-4 text-left text-[13px] leading-relaxed text-[#4B5568]">
            <strong className="text-[#1F2A44]">Quick setup:</strong> open the
            downloaded application and enter your 6-digit meeting ID to join
            your session instantly. Your technician sees only what you approve.
          </div>

          <div className="mt-8 border-t border-[#EEF0F6] pt-4 text-[11px] text-[#8792A6]">
            <Link
              to="/admin"
              className="hover:text-[#4F7CFF]"
              rel="nofollow"
            >
              Technician sign-in
            </Link>
          </div>
        </section>
      </main>

      <style>{`
        .scene {
          width: 140px;
          height: 140px;
          perspective: 480px;
        }
        .cube {
          width: 100%;
          height: 100%;
          position: relative;
          transform-style: preserve-3d;
          animation: cl-spin 14s infinite linear;
        }
        .cube:hover { animation-play-state: paused; cursor: grab; }
        .face {
          position: absolute;
          width: 140px;
          height: 140px;
          border-radius: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #ffffff 0%, #EEF2FF 100%);
          border: 1px solid #E4E9F5;
          box-shadow: 0 6px 18px rgba(31, 42, 68, 0.08);
          backface-visibility: visible;
        }
        .face.top, .face.bottom {
          background: linear-gradient(135deg, #4F7CFF 0%, #1F2A44 100%);
          border-color: rgba(255,255,255,0.15);
        }
        .front  { transform: rotateY(  0deg) translateZ(70px); }
        .back   { transform: rotateY(180deg) translateZ(70px); }
        .right  { transform: rotateY( 90deg) translateZ(70px); }
        .left   { transform: rotateY(-90deg) translateZ(70px); }
        .top    { transform: rotateX( 90deg) translateZ(70px); }
        .bottom { transform: rotateX(-90deg) translateZ(70px); }
        @keyframes cl-spin {
          0%   { transform: rotateX(0deg)   rotateY(0deg)   rotateZ(0deg); }
          100% { transform: rotateX(360deg) rotateY(360deg) rotateZ(360deg); }
        }
      `}</style>
    </div>
  );
}

function CLMark() {
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#4F7CFF] to-[#1F2A44] text-2xl font-bold text-white shadow-inner">
      CL
    </div>
  );
}

function CLWord() {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-full bg-[#4F7CFF]" />
      <span className="text-[13px] font-semibold tracking-wide text-[#1F2A44]">
        ConnectLive
      </span>
    </div>
  );
}

function CLShield() {
  return (
    <svg
      viewBox="0 0 48 48"
      className="h-14 w-14 text-white"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M24 4l16 6v12c0 10-7 18-16 22-9-4-16-12-16-22V10l16-6z" />
      <path d="M17 24l5 5 10-11" />
    </svg>
  );
}
