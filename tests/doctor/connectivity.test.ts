import { describe, expect, it } from "vitest";

import { zernioHealthIsUsable } from "../../src/doctor/connectivity.js";

const healthy = {
  status: "healthy",
  tokenStatus: { valid: true },
  permissions: { canPost: true, canFetchAnalytics: false, missingRequired: [] },
};

describe("Zernio doctor health validation", () => {
  it("accepts publishing health when analytics is disabled", () => {
    expect(zernioHealthIsUsable(healthy, false)).toBe(true);
  });

  it("requires analytics permission after setup consent enables the tool", () => {
    expect(zernioHealthIsUsable(healthy, true)).toBe(false);
    expect(zernioHealthIsUsable({
      ...healthy,
      permissions: { ...healthy.permissions, canFetchAnalytics: true },
    }, true)).toBe(true);
  });
});
