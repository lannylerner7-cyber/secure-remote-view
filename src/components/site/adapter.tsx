/**
 * Router + backend adapter for the shared public-site components.
 *
 * Everything else in components/site/* is identical between production
 * (TanStack Start) and the Wouter preview artifact. This file is the only
 * piece that differs: it maps links/navigation onto TanStack Router and wires
 * the newsletter to the real `subscribeNewsletter` server function.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, type AnchorHTMLAttributes, type ReactNode } from "react";
import { subscribeNewsletter } from "@/lib/newsletter.functions";

/** True in production: writes reach the real backend. */
export const LIVE_BACKEND = true;

type SiteLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
};

function splitHref(href: string) {
  const [beforeHash, hash] = href.split("#");
  const [path, query] = beforeHash.split("?");
  const search = query ? Object.fromEntries(new URLSearchParams(query)) : undefined;
  return { path: path || "/", hash: hash || undefined, search };
}

export function SiteLink({ href, children, ...rest }: SiteLinkProps) {
  if (/^(https?:|mailto:|tel:)/.test(href)) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  const { path, hash, search } = splitHref(href);
  return (
    <Link
      to={path as "/"}
      hash={hash}
      search={search as never}
      hashScrollIntoView={{ behavior: "smooth", block: "start" }}
      {...rest}
    >
      {children}
    </Link>
  );
}

export function usePathname() {
  return useRouterState({ select: (s) => s.location.pathname });
}

export function useQueryParam(name: string): string | null {
  return useRouterState({
    select: (s) => {
      const value = (s.location.search as Record<string, unknown>)[name];
      return typeof value === "string" ? value : null;
    },
  });
}

export function useGo() {
  const navigate = useNavigate();
  return useCallback((href: string) => navigate({ to: href as "/" }), [navigate]);
}

export type NewsletterResult = { ok: boolean; message: string };

export function useNewsletter() {
  const doSubscribe = useServerFn(subscribeNewsletter);
  return useCallback(
    async (email: string): Promise<NewsletterResult> => {
      const res = await doSubscribe({ data: { email, source: "homepage" } });
      return { ok: res.ok, message: res.message };
    },
    [doSubscribe],
  );
}
