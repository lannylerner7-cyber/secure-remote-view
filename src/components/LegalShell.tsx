import { Link } from "@tanstack/react-router";
import { Footer } from "./Footer";

export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#050B1F] text-white">
      <header className="border-b border-white/10 px-6 py-4">
        <Link to="/" className="flex items-center gap-2 text-sm text-white/70 hover:text-white">
          ← ConnectLive
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-semibold">{title}</h1>
        {updated && <p className="mt-1 text-xs text-white/40">Last updated: {updated}</p>}
        <article className="prose prose-invert mt-8 max-w-none prose-headings:text-white prose-a:text-[#4F7CFF] prose-h2:mt-8 prose-h2:text-lg prose-p:text-white/80 prose-li:text-white/80 prose-strong:text-white">
          {children}
        </article>
      </main>
      <Footer />
    </div>
  );
}
