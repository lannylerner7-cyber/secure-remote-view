import { Link } from "@tanstack/react-router";
import { ShieldCheck, FileText, RotateCcw, Mail } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#050B1F] px-4 py-8 text-sm text-white/60 sm:px-6 sm:py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 text-center md:flex-row md:justify-between md:text-left">
        <div className="flex min-w-0 flex-col items-center gap-1 md:items-start">
          <div className="flex items-center gap-2 text-white/80">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-[#4F7CFF]" />
            <span className="font-semibold">ConnectLive</span>
          </div>
          <span className="text-xs text-white/40">
            © {new Date().getFullYear()} ConnectLive — consent-based remote support.
          </span>
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
    </footer>
  );
}
