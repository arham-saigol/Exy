import { afterEach, describe, expect, it } from "vitest";

import { acceptApprovalFromMessage, formatApprovalCode } from "../../src/agent/approval-code.js";
import { PublicationApprovalRepository } from "../../src/db/approvals.js";
import { ExyDatabase } from "../../src/db/database.js";

const databases: ExyDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function preparation() {
  const database = new ExyDatabase(":memory:");
  databases.push(database);
  const repository = new PublicationApprovalRepository(database);
  const scope = { discordUserId: "user-1", xAccountId: "account-1" };
  const prepared = repository.prepare({
    ...scope,
    kind: "original",
    payload: { kind: "original", content: "Exact post", accountId: "account-1" },
  });
  const code = formatApprovalCode(prepared.approval.id, prepared.approvalToken);
  return { repository, scope, prepared, code };
}

describe("publication approval command", () => {
  it("accepts only the exact standalone approval command", () => {
    const { repository, scope, prepared, code } = preparation();
    expect(acceptApprovalFromMessage(repository, scope, `  approve ${code}  `)).toMatchObject({
      sanitizedMessage: "approve [accepted Exy publication approval]",
      approval: { id: prepared.approval.id, state: "approved" },
    });
  });

  it.each([
    (code: string) => `do not approve ${code}`,
    (code: string) => `\`approve ${code}\``,
    (code: string) => `please approve ${code}`,
    (code: string) => `approve ${code} and publish it`,
  ])("does not interpret negated, quoted, or embedded text as approval", (message) => {
    const { repository, scope, prepared, code } = preparation();
    expect(acceptApprovalFromMessage(repository, scope, message(code))).toBeUndefined();
    expect(repository.get(prepared.approval.id)?.state).toBe("prepared");
  });
});
