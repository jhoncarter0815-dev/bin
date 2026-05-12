import { describe, expect, it } from "vitest";
import { calculateNonDepositCreditClearance } from "./wallet.js";

describe("calculateNonDepositCreditClearance", () => {
  it("clears starting or bonus credits when there are no deposits", () => {
    expect(calculateNonDepositCreditClearance(1000, [])).toMatchObject({
      depositBackedAvailable: 0,
      removable: 1000,
    });
  });

  it("keeps only the deposit-backed available balance", () => {
    expect(
      calculateNonDepositCreditClearance(250, [
        {
          amount: 100,
          type: "DEPOSIT",
          description: "Deposit approved",
          metadata: null,
        },
        {
          amount: -50,
          type: "ENTRY_FEE",
          description: "Entry",
          metadata: null,
        },
        {
          amount: 200,
          type: "WIN_PAYOUT",
          description: "Win",
          metadata: null,
        },
      ]),
    ).toMatchObject({
      totalDepositCredits: 100,
      totalDebits: 50,
      depositBackedAvailable: 50,
      removable: 200,
    });
  });

  it("does not let previous clearance debits consume deposit-backed credits", () => {
    expect(
      calculateNonDepositCreditClearance(100, [
        {
          amount: 100,
          type: "DEPOSIT",
          description: "Deposit approved",
          metadata: null,
        },
        {
          amount: -200,
          type: "ADMIN_ADJUSTMENT",
          description: "Admin cleared non-deposit credits",
          metadata: { clearedNonDepositCredits: 200 },
        },
      ]),
    ).toMatchObject({
      depositBackedAvailable: 100,
      removable: 0,
    });
  });
});
