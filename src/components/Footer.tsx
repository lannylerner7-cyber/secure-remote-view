import { Link } from "@tanstack/react-router";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#050B1F] px-6 py-10 text-sm text-white/60">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 md:flex-row md:justify-between">
        <div className="flex items-center gap-2 text-white/80">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#4F7CFF]" />
          <span className="font-semibold">ConnectLive</span>
          <span className="ml-2 text-xs text-white/40">
            © {new Date().getFullYear()} ConnectLive
          </span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <Link to="/privacy" className="hover:text-white">Privacy</Link>
          <Link to="/terms" className="hover:text-white">Terms</Link>
          <Link to="/refund" className="hover:text-white">Refund policy</Link>
          <Link to="/contact" className="hover:text-white">Contact</Link>
          <Link to="/order" className="rounded-full border border-[#4F7CFF]/60 px-3 py-1 text-[#B9CCFF] hover:bg-[#4F7CFF]/10">Buy a license</Link>
        </nav>
      </div>
    </footer>
  );
}
