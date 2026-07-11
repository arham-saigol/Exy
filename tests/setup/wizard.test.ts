import { describe, expect, it } from "vitest";

import type { ExyConfig } from "../../src/core/types.js";
import { heartbeatForSetup, listZernioAccounts } from "../../src/setup/wizard.js";

const previous: ExyConfig = {
  version: 1,
  discord: {
    applicationId: "11111",
    guildId: "22222",
    parentChannelId: "33333",
    authorizedUserId: "44444",
  },
  providers: { zernioAccountId: "account-a", zernioXAnalyticsEnabled: false },
  heartbeat: { enabled: true, intervalMinutes: 17, deliveryThreadId: "55555" },
};

describe("setup heartbeat reconciliation", () => {
  it("preserves heartbeat state when its Discord and X-account scope is unchanged", () => {
    expect(heartbeatForSetup(previous, previous.discord, "account-a")).toEqual(previous.heartbeat);
  });

  it.each([
    [{ ...previous.discord, applicationId: "99991" }, "account-a"],
    [{ ...previous.discord, guildId: "99992" }, "account-a"],
    [{ ...previous.discord, parentChannelId: "99993" }, "account-a"],
    [{ ...previous.discord, authorizedUserId: "99994" }, "account-a"],
    [previous.discord, "account-b"],
  ])("disables and detaches heartbeat when conversation scope changes", (discord, accountId) => {
    expect(heartbeatForSetup(previous, discord, accountId)).toEqual({
      enabled: false,
      intervalMinutes: 17,
    });
  });
});

describe("Zernio setup account discovery", () => {
  it("reads analytics entitlement from the official top-level account-list field", async () => {
    const listing = await listZernioAccounts("zernio-secret", async () => new Response(JSON.stringify({
      accounts: [{ _id: "account-a", username: "alice", isActive: true }],
      hasAnalyticsAccess: true,
      pagination: { hasNextPage: false },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    expect(listing).toEqual({
      accounts: [{ _id: "account-a", username: "alice", isActive: true }],
      hasAnalyticsAccess: true,
    });
  });
});
