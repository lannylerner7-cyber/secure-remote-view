import { useEffect, useRef, useState, type ReactNode } from "react";
import { SiteShell } from "./layout";
import { Badge, Button } from "./ui";

/**
 * Legal document layout from the Figma design. The policy text itself is
 * passed in as children unchanged — the table of contents is derived from the
 * document's own <h2> headings so no wording is shortened or replaced.
 */
export function LegalShell({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated?: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  const articleRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const headings = Array.from(root.querySelectorAll("h2"));
    setToc(
      headings.map((heading, index) => {
        const id = heading.id || `section-${index + 1}`;
        heading.id = id;
        return { id, label: heading.textContent ?? `Section ${index + 1}` };
      }),
    );
  }, [children]);

  return (
    <SiteShell>
      <section className="section">
        <div className="container">
          <div className="max-w-4xl">
            {updated && <Badge>Last updated {updated}</Badge>}
            <h1 className="display-lg mt-7">{title}</h1>
            {intro && <div className="body-lg mt-6 max-w-2xl">{intro}</div>}
          </div>
          <div className="mt-14 grid gap-10 lg:grid-cols-[15rem_1fr]">
            <aside className="h-fit lg:sticky lg:top-28">
              {toc.length > 0 && (
                <>
                  <p className="hairline-title">In this document</p>
                  <ol className="mt-5 grid gap-3 text-sm text-cl-muted">
                    {toc.map((item, index) => (
                      <li key={item.id}>
                        <a className="hover:text-white" href={`#${item.id}`}>
                          {String(index + 1).padStart(2, "0")} · {item.label}
                        </a>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <div className="mt-8">
                <Button to="/contact" variant="secondary">
                  Ask a question
                </Button>
              </div>
            </aside>
            <article className="surface min-w-0 p-7 md:p-12">
              <div ref={articleRef} className="legal-copy">
                {children}
              </div>
            </article>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
