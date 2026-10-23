/**
 * Display copy for the public marketing pages (from the Figma Make design).
 * Display prices mirror the live promo plan prices. The checkout itself always
 * reads real plans from the backend — these values are never sent anywhere.
 */
export type DisplayPlan = {
  slug: string;
  name: string;
  description: string;
  monthly: number | null;
  devices: string;
  operators: string;
  retention: string;
  support: string;
  featured?: boolean;
};

/** Pre-promo list prices shown struck through next to the promo price. */
export const WAS_PRICE: Record<string, number> = {
  starter: 250,
  team: 570,
  business: 840,
};

export const plans: DisplayPlan[] = [
  {
    slug: "starter",
    name: "Starter",
    description: "Remote support for compact IT operations.",
    monthly: 150,
    devices: "10 devices",
    operators: "Technician console included",
    retention: "30-day audit history",
    support: "Setup video library",
  },
  {
    slug: "team",
    name: "Team",
    description: "Multi-department coverage for growing help desks.",
    monthly: 310,
    devices: "20 devices",
    operators: "Multi-operator support",
    retention: "1-year audit history",
    support: "Priority support",
    featured: true,
  },
  {
    slug: "business",
    name: "Business",
    description: "Fleet controls for established support operations.",
    monthly: 560,
    devices: "50 devices",
    operators: "Multi-team access",
    retention: "3-year audit history",
    support: "Priority onboarding",
  },
  {
    slug: "custom",
    name: "Enterprise",
    description: "Custom deployment, retention, and governance.",
    monthly: null,
    devices: "Unlimited devices",
    operators: "Unlimited operators",
    retention: "Custom retention",
    support: "Dedicated success lead",
  },
];

export const comparisonRows = [
  { label: "Device allowance", values: plans.map((plan) => plan.devices) },
  { label: "Operators", values: plans.map((plan) => plan.operators) },
  { label: "Audit retention", values: plans.map((plan) => plan.retention) },
  { label: "Support", values: plans.map((plan) => plan.support) },
  { label: "Authorized enrollment", values: ["Included", "Included", "Included", "Custom policy"] },
  { label: "Session recording", values: ["Optional", "Included", "Included", "Custom policy"] },
];

export const faqs = [
  {
    question: "How quickly can a workspace be provisioned?",
    answer:
      "Once payment confirms, the delivery pack normally lands within 24 hours (48 hours at the outside) on business days. Keep an eye on your spam folder and mark our address as safe.",
  },
  {
    question: "How is remote access authorized?",
    answer:
      "A device is authorized when it enrolls against a valid Meeting ID with available seats. Active sessions remain visibly indicated and every connection is recorded.",
  },
  {
    question: "Can we limit what operators are allowed to do?",
    answer:
      "Operator access is tied to your workspace. Tell us how your team is structured when you order or contact us, and we will set the workspace up around it.",
  },
  {
    question: "Can we change plans later?",
    answer:
      "Yes. Move between device tiers as your team grows without changing its operating workflow — contact us and we will move the license across.",
  },
  {
    question: "What is included in the deployment pack?",
    answer:
      "The agent installer, the admin console installer, your Meeting ID and sign-in details, plus step-by-step video setup guides covering installation, device enrollment, and your first live session.",
  },
  {
    question: "How do I pay?",
    answer:
      "Checkout issues a live invoice payable in Bitcoin, USDT (ERC-20), or USDC (ERC-20). The price is locked for 15 minutes and the invoice page tracks network confirmations in real time. No card details are ever requested.",
  },
];

export const workflow: [string, string, string][] = [
  ["01", "Choose a plan", "Select the right device and operator capacity."],
  ["02", "Receive your pack", "Get workspace access and deployment resources."],
  ["03", "Enroll devices", "Install the agent and apply your operating policy."],
  ["04", "Run and review", "Support users and retain a complete session record."],
];

export const securityFeatures: [string, string][] = [
  ["Authorized enrollment", "Only devices enrolled to a valid account and Meeting ID can receive sessions."],
  ["Encrypted transport", "Session traffic is designed to remain private in motion."],
  ["Operator policy", "Map privileges to the responsibilities of each support role."],
  ["Recorded history", "Review who connected, what happened, and when it ended."],
];

export const PAYMENT_NETWORKS = [
  { id: "BTC", name: "Bitcoin", network: "BTC" },
  { id: "USDT_ERC20", name: "Tether", network: "USDT · ERC-20" },
  { id: "USDC_ERC20", name: "USD Coin", network: "USDC · ERC-20" },
] as const;

export type CoinId = (typeof PAYMENT_NETWORKS)[number]["id"];
