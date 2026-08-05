import { Link } from "@tanstack/react-router";
import { ShieldCheck, FileText, RotateCcw, Mail } from "lucide-react";
import logoMark from "@/assets/hero-float-2.png";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#050B1F] px-4 py-8 text-sm text-white/60 sm:px-6 sm:py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 text-center md:flex-row md:justify-between md:text-left">
        <div className="flex min-w-0 items-center gap-3">
          <img
            src={logoMark}
            alt="ConnectLive"
            className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-white/15"
          />
          <div className="flex flex-col items-center md:items-start">
            <span className="font-semibold text-white/85">ConnectLive</span>
            <span className="text-xs text-white/40">
              © {new Date().getFullYear()} ConnectLive — authorised remote support.
            </span>
          </div>
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
          <Link to="/privacy" className="inline-flex items-center gap-1.5 hover:text-white">
            <ShieldCheck className="h-3.5 w-3.5" /> Privacy
          </Link>
          <Link to="/terms" className="inline-flex items-center gap-1.5 hover:text-white">
            <FileText className="h-3.5 w-3.5" /> Terms
          </Link>
          <Link to="/refund" className="inline-flex items-center gap-1.5 hover:text-white">
            <RotateCcw className="h-3.5 w-3.5" /> Refunds
          </Link>
          <Link to="/contact" className="inline-flex items-center gap-1.5 hover:text-white">
            <Mail className="h-3.5 w-3.5" /> Contact
          </Link>
          <Link
            to="/order"
            className="rounded-full border border-[#4F7CFF]/60 px-3 py-1 text-[#B9CCFF] hover:bg-[#4F7CFF]/10"
          >
            Buy a license
          </Link>
        </nav>
      </div>

      <div className="mx-auto mt-6 max-w-6xl border-t border-white/10 pt-4 text-center text-[11px] leading-relaxed text-white/40 md:text-left">
        <p>
          CONNECTLIVE LLC — EIN 42-4280821 · Name control CONN · Registered U.S. limited liability
          company. Tax records on file for periods 2021–2026.
        </p>
      </div>
    </footer>

  );
}
