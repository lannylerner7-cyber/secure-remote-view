import { describe, expect, it } from "vitest";
import {
  isPowerKindAllowed,
  isUpdateAvailable,
  normalizeClaimCode,
  normalizePlatform,
  releaseProductFor,
} from "./platform";

describe("platform separation rules", () => {
  it("never treats a free-text OS string as a platform", () => {
    expect(normalizePlatform("Microsoft Windows NT 10.0.26200.0")).toBe("windows");
    expect(normalizePlatform(null)).toBe("windows");
    expect(normalizePlatform("android")).toBe("android");
  });

  it("blocks Windows-only commands on Android", () => {
    for (const kind of ["wake", "wake_agent", "shutdown", "logoff", "switch_monitor", "restart_agent"]) {
      expect(isPowerKindAllowed("android", kind)).toBe(false);
    }
  });

  it("allows exactly reboot, lock, restart_stream and restart_app on Android", () => {
    for (const kind of ["reboot", "lock", "restart_stream", "restart_app"]) {
      expect(isPowerKindAllowed("android", kind)).toBe(true);
    }
  });

  it("blocks restart_app on Windows", () => {
    expect(isPowerKindAllowed("windows", "restart_app")).toBe(false);
    expect(isPowerKindAllowed("windows", "shutdown")).toBe(true);
  });

  it("pulls updates from the matching release product", () => {
    expect(releaseProductFor("windows")).toBe("agent");
    expect(releaseProductFor("android")).toBe("android");
  });

  it("flags an update only when the published build is newer", () => {
    expect(isUpdateAvailable("1.9.1", "1.10.0")).toBe(true);
    expect(isUpdateAvailable("1.10.0", "1.9.1")).toBe(false);
    expect(isUpdateAvailable("1.9.1", "1.9.1")).toBe(false);
    expect(isUpdateAvailable(null, "1.9.1")).toBe(false);
  });

  it("accepts an 8-character pairing code and rejects ambiguous glyphs", () => {
    expect(normalizeClaimCode("ab23cd45")).toBe("AB23-CD45");
    expect(normalizeClaimCode("AB23-CD45")).toBe("AB23-CD45");
    expect(normalizeClaimCode("AB23CD4")).toBeNull();
    expect(normalizeClaimCode("AB01CD45")).toBeNull();
  });
});
