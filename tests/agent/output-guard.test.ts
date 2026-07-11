import { afterEach, describe, expect, it } from "vitest";
import { ExyDatabase } from "../../src/db/database.js";
import { ReplyOpportunityVerifier } from "../../src/verifier/reply-verifier.js";
import {
  guardRawXSearchNarrative,
  guardUnconfirmedPublicationClaims,
  guardUnverifiedXPostUrls,
} from "../../src/agent/output-guard.js";

const databases: ExyDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("reply-opportunity output guard", () => {
  it("removes an X post URL that neither the user nor verifier/provider authorized", () => {
    const database = new ExyDatabase(":memory:");
    databases.push(database);
    const verifier = new ReplyOpportunityVerifier(database);
    const scope = { discordUserId: "user", xAccountId: "account" };
    expect(
      guardUnverifiedXPostUrls(
        "Reply to https://twitter.com/someone/status/1234567890",
        scope,
        verifier,
        new Set(),
      ),
    ).not.toContain("1234567890");
  });

  it("allows an alternate URL only when its canonical ID is authorized for this output", () => {
    const database = new ExyDatabase(":memory:");
    databases.push(database);
    const verifier = new ReplyOpportunityVerifier(database);
    const scope = { discordUserId: "user", xAccountId: "account" };
    const output = "Opportunity: https://mobile.twitter.com/b/status/1234567890?s=20";
    expect(guardUnverifiedXPostUrls(output, scope, verifier, new Set(["1234567890"]))).toBe(output);
  });

  it.each([
    "https://m.x.com/a/status/1234567890",
    "twitter.com/a/statuses/1234567890?s=1",
    "https://www.x.com./i/status/1234567890#x",
  ])("recognizes alternate output form %s", (url) => {
    const database = new ExyDatabase(":memory:");
    databases.push(database);
    const verifier = new ReplyOpportunityVerifier(database);
    const scope = { discordUserId: "user", xAccountId: "account" };
    expect(guardUnverifiedXPostUrls(`Opportunity: ${url}`, scope, verifier, new Set()))
      .not.toContain("1234567890");
  });

  it("does not throw or partially authorize an overlong numeric URL", () => {
    const database = new ExyDatabase(":memory:");
    databases.push(database);
    const verifier = new ReplyOpportunityVerifier(database);
    const scope = { discordUserId: "user", xAccountId: "account" };
    const url = `https://x.com/a/status/${"1".repeat(41)}`;
    expect(guardUnverifiedXPostUrls(url, scope, verifier, new Set())).toBe("[malformed X post URL omitted]");
  });

  it("allows a user-supplied or provider-confirmed post ID without verifier storage", () => {
    const database = new ExyDatabase(":memory:");
    databases.push(database);
    const verifier = new ReplyOpportunityVerifier(database);
    const scope = { discordUserId: "user", xAccountId: "account" };
    const output = "Published: https://x.com/me/status/1234567890";
    expect(guardUnverifiedXPostUrls(output, scope, verifier, new Set(["1234567890"]))).toBe(output);
  });
});

describe("publication-claim output guard", () => {
  it("removes an action success claim without provider confirmation", () => {
    expect(guardUnconfirmedPublicationClaims("I successfully posted it.\nDraft follows.", false))
      .toBe("[Publication success claim omitted: Zernio did not confirm publication.]\nDraft follows.");
  });

  it.each([
    "Tweet published",
    "Done — it's live on X",
    "Sent it to X",
    "The reply is now live.",
    "Posted!",
  ])("removes alternate unconfirmed claim: %s", (claim) => {
    expect(guardUnconfirmedPublicationClaims(claim, false))
      .toBe("[Publication success claim omitted: Zernio did not confirm publication.]");
  });

  it("preserves a success claim only with provider confirmation", () => {
    expect(guardUnconfirmedPublicationClaims("The reply is live.", true)).toBe("The reply is live.");
  });

  it("does not let free model prose hide an unconfirmed claim in a Markdown fence", () => {
    expect(guardUnconfirmedPublicationClaims("```\nTweet published\n```", false)).toBe(
      "```\n[Publication success claim omitted: Zernio did not confirm publication.]\n```",
    );
  });
});

describe("raw X-search narrative guard", () => {
  it("suppresses model prose when raw candidates were searched but none was verified", () => {
    expect(guardRawXSearchNarrative(
      "A post by Alice looks like a great reply opportunity.",
      true,
      0,
    )).toBe("I searched X, but did not select a new verifier-approved reply opportunity to present.");
  });

  it("reports a duplicate selection without exposing it as new", () => {
    expect(guardRawXSearchNarrative("This is a fresh opportunity", true, 1))
      .toBe("The selected X post was already recommended, so I did not present it as a new reply opportunity.");
  });

  it("leaves unrelated model prose alone", () => {
    expect(guardRawXSearchNarrative("A strategy summary", false, 0)).toBe("A strategy summary");
  });
});
