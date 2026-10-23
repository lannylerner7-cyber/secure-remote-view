import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { lookupLicenseByEmail } from "@/lib/orders.functions";
import { SiteShell } from "@/components/site/layout";
import { LicenseLookup, type LicenseRow } from "@/components/site/license-lookup";

export const Route = createFileRoute("/license")({
  component: LicensePage,
  head: () => ({
    meta: [
      { title: "Look up your ConnectLive license" },
      {
        name: "description",
        content:
          "Enter the email you used at checkout to retrieve your ConnectLive license access link.",
      },
      { property: "og:title", content: "Look up your ConnectLive license" },
      {
        property: "og:description",
        content: "Recover the access link for a paid ConnectLive license.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function LicensePage() {
  const lookup = useServerFn(lookupLicenseByEmail);
  return (
    <SiteShell>
      <LicenseLookup onLookup={async (email) => (await lookup({ data: { email } })) as LicenseRow[]} />
    </SiteShell>
  );
}
