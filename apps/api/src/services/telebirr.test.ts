import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/bingo";
process.env.JWT_SECRET ??= "test-jwt-secret-with-enough-length";
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.TELEGRAM_BOT_TOKEN ??= "123456:test-token";
process.env.TELEBIRR_RECEIPT_ALLOWED_HOSTS ??=
  "transactioninfo.ethiotelecom.et";
process.env.TELEBIRR_DEPOSIT_RECEIVER ??= "core bingo";
process.env.TELEBIRR_DEPOSIT_PHONE ??= "251900000000";
process.env.TELEBIRR_MAX_RECEIPT_AGE_HOURS ??= "0";

const { parseTelebirrMessage, validateTelebirrDeposit } =
  await import("./telebirr.js");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseTelebirrMessage", () => {
  it("accepts Telebirr messages without the Dear sender line", () => {
    const parsed = parseTelebirrMessage(
      [
        "You have transferred ETB 1,000.00 to core bingo (2519****7282) on 09/05/2026 14:07:49.",
        "Your transaction number is DE99PVJ1U3.",
        "The service fee is ETB 3.48 and 15% VAT on the service fee is ETB 0.52.",
        "Your current E-Money Account balance is ETB 8,248.87.",
        "To download your payment information please click this link:",
        "https://transactioninfo.ethiotelecom.et/receipt/DE99PVJ1U3.",
        "Thank you for using telebirr",
        "Ethio telecom",
      ].join(" "),
    );

    expect(parsed).toMatchObject({
      senderName: null,
      amountEtb: 1000,
      receiverName: "core bingo",
      receiverPhone: "2519****7282",
      transactionTime: "09/05/2026 14:07:49",
      transactionCode: "DE99PVJ1U3",
      receiptUrl: "https://transactioninfo.ethiotelecom.et/receipt/DE99PVJ1U3",
    });
  });

  it("keeps the sender name when Telebirr includes it", () => {
    const parsed = parseTelebirrMessage(
      [
        "Dear KALEAB",
        "You have transferred ETB 100.00 to Core Bingo (2519****7282) on 09/05/2026 14:07:49.",
        "Your transaction number is DE99PVJ1U3.",
        "To download your payment information please click this link:",
        "https://transactioninfo.ethiotelecom.et/receipt/DE99PVJ1U3.",
      ].join(" "),
    );

    expect(parsed.senderName).toBe("KALEAB");
  });
});

describe("validateTelebirrDeposit", () => {
  it("sends aborted receipt checks to manual review with a clear reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("This operation was aborted"), {
          name: "AbortError",
        });
      }),
    );

    const result = await validateTelebirrDeposit({
      amount: 1000,
      transactionCode: "DE99PVJ1U3",
      transactionTime: "09/05/2026 14:07:49",
      receiptUrl: "https://transactioninfo.ethiotelecom.et/receipt/DE99PVJ1U3",
      senderPhoneNumber: "251911111111",
      parsedMessage: {
        senderName: null,
        amountEtb: 1000,
        receiverName: "core bingo",
        receiverPhone: "2519****0000",
        transactionTime: "09/05/2026 14:07:49",
        transactionCode: "DE99PVJ1U3",
        receiptUrl:
          "https://transactioninfo.ethiotelecom.et/receipt/DE99PVJ1U3",
      },
    });

    expect(result).toMatchObject({
      autoApprove: false,
      status: "MANUAL_REVIEW",
      reason: "Telebirr receipt validation timed out",
    });
  });

  it("tries a digit-zero receipt URL when the pasted code uses letter O", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("DEB7SU39O7")) {
          return new Response(
            "<html><body>This request is not correct</body></html>",
            { status: 200 },
          );
        }
        return new Response(
          [
            "<html><body>",
            "Payer Name Test User",
            "Payer telebirr no. 2519****1111",
            "Credited Party name core bingo",
            "Credited party account no 2519****0000",
            "transaction status Completed",
            "Settled Amount DEB7SU3907 09-05-2026 14:07:49 1,000.00 Birr",
            "</body></html>",
          ].join(" "),
          { status: 200 },
        );
      }),
    );

    const result = await validateTelebirrDeposit({
      amount: 1000,
      transactionCode: "DEB7SU39O7",
      transactionTime: "09/05/2026 14:07:49",
      receiptUrl: "https://transactioninfo.ethiotelecom.et/receipt/DEB7SU39O7",
      senderPhoneNumber: "251911111111",
      parsedMessage: {
        senderName: "Test User",
        amountEtb: 1000,
        receiverName: "core bingo",
        receiverPhone: "2519****0000",
        transactionTime: "09/05/2026 14:07:49",
        transactionCode: "DEB7SU39O7",
        receiptUrl:
          "https://transactioninfo.ethiotelecom.et/receipt/DEB7SU39O7",
      },
    });

    expect(result).toMatchObject({
      autoApprove: true,
      status: "VERIFIED",
      transactionCode: "DEB7SU3907",
      receiptUrl: "https://transactioninfo.ethiotelecom.et/receipt/DEB7SU3907",
    });
  });
});
