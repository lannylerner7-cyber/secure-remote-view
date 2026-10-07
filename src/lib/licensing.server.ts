/**
 * Licensing helpers (server-only).
 *
 * One customer account owns one license, identified by a human-readable
 * Meeting ID (`CL-XXXX-XXXX`). Devices bind to a license at enrollment.
 * A device over the seat cap, or on a suspended/expired license, is
 * `blocked`: it keeps heartbeating (so it wakes the second a seat frees)
 * but must not capture or accept sessions.
 */

export type LicenseState = "unlicensed" | "active" | "blocked" | "expired";

export type LicenseRow = {
  id: string;
  user_id: string | null;
  meeting_id: string;
  seat_limit: number;
  status: string;
  starts_at: string;
  expires_at: string;
};

export type LicenseVerdict = {
  state: LicenseState;
  reason: string | null;
  license: LicenseRow | null;
  seats_used: number;
};

type Admin = {
  from: (t: string) => any;
};

/** Normalise user input: `cl 8fq2 4kdn` → `CL-8FQ2-4KDN`. */
export function normalizeMeetingId(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 10 || !cleaned.startsWith("CL")) return raw.trim().toUpperCase();
  return `CL-${cleaned.slice(2, 6)}-${cleaned.slice(6, 10)}`;
}

export async function findLicenseByMeetingId(
  admin: Admin,
  meetingId: string,
): Promise<LicenseRow | null> {
  const { data } = await admin
    .from("licenses")
    .select("id, user_id, meeting_id, seat_limit, status, starts_at, expires_at")
    .eq("meeting_id", normalizeMeetingId(meetingId))
    .maybeSingle();
  return (data as LicenseRow | null) ?? null;
}

/**
 * Decide what a device on this license may do right now.
 * `deviceId` (the devices.id uuid) is excluded from the seat count when the
 * device is already enrolled, so an existing seat holder never blocks itself.
 */
export async function evaluateLicense(
  admin: Admin,
  license: LicenseRow | null,
  deviceId?: string | null,
): Promise<LicenseVerdict> {
  if (!license) return { state: "unlicensed", reason: "no_license", license: null, seats_used: 0 };

  const now = Date.now();
  if (license.status !== "active") {
    return { state: "blocked", reason: `license_${license.status}`, license, seats_used: 0 };
  }
  if (new Date(license.expires_at).getTime() < now) {
    return { state: "expired", reason: "subscription_expired", license, seats_used: 0 };
  }

  const { data: seats } = await admin
    .from("devices")
    .select("id, enrolled_at")
    .eq("license_id", license.id)
    .order("enrolled_at", { ascending: true });

  const rows = (seats ?? []) as Array<{ id: string }>;
  const seatsUsed = rows.length;

  if (deviceId) {
    // Oldest N enrollments hold the seats; anything past the cap is blocked.
    const rank = rows.findIndex((r) => r.id === deviceId);
    if (rank >= 0 && rank >= license.seat_limit) {
      return { state: "blocked", reason: "seat_limit_reached", license, seats_used: seatsUsed };
    }
    if (rank >= 0) return { state: "active", reason: null, license, seats_used: seatsUsed };
  }

  if (seatsUsed >= license.seat_limit) {
    return { state: "blocked", reason: "seat_limit_reached", license, seats_used: seatsUsed };
  }
  return { state: "active", reason: null, license, seats_used: seatsUsed };
}
