import { createFileRoute, Link } from "@tanstack/react-router";
import videoAsset from "@/assets/connectlive.mp4.asset.json";
import bannerAsset from "@/assets/connectlive-banner.jpg.asset.json";

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

          {/* Hero loop — replaces the previous 3D cube. Muted + playsInline so
              browsers allow autoplay. */}
          <video
            src={videoAsset.url}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            className="mx-auto mt-8 w-full max-w-[220px] rounded-2xl shadow-[0_10px_30px_rgba(31,42,68,0.15)]"
          />

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

          <div className="mt-6">
            <img
              src={bannerAsset.url}
              alt="ConnectLive session preview"
              className="mx-auto block w-full rounded-xl"
            />
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
    </div>
  );
}
