import crypto from "node:crypto";
import { env } from "../config.js";
import { AppError } from "../errors.js";

export type TelebirrDepositInput = {
  amount: number;
  transactionCode: string;
  transactionTime: string;
  receiptUrl: string;
};

export type TelebirrValidationResult = {
  autoApprove: boolean;
  status: "VERIFIED" | "MANUAL_REVIEW";
  reason: string;
  payload: Record<string, unknown>;
};

const MAX_RECEIPT_BYTES = 1_000_000;

export async function validateTelebirrDeposit(
  input: TelebirrDepositInput,
): Promise<TelebirrValidationResult> {
  const url = normalizeTelebirrReceiptUrl(input.receiptUrl);
  const receiver = env.TELEBIRR_DEPOSIT_RECEIVER.trim();

  if (!env.TELEBIRR_AUTO_DEPOSIT_ENABLED) {
    return manualReview("Telebirr auto deposit is disabled", url);
  }
  if (!receiver) {
    return manualReview("Telebirr receiver is not configured", url);
  }

  let html: string;
  try {
    html = await fetchReceiptHtml(url);
  } catch (error) {
    return manualReview(
      error instanceof Error ? error.message : "Could not validate receipt",
      url,
    );
  }
  const receiptText = htmlToText(html);
  const receiptCompact = compactAlphaNumeric(receiptText);
  const transactionCode = normalizeTelebirrTransactionCode(
    input.transactionCode,
  );
  const expectedEtb = input.amount / env.TELEBIRR_CREDIT_PER_ETB;
  const parsedAmounts = parseMoneyValues(receiptText);
  const checks = {
    codeMatched: receiptCompact.includes(compactAlphaNumeric(transactionCode)),
    timeMatched: timeMatches(input.transactionTime, receiptText),
    receiverMatched: receiptCompact.includes(compactAlphaNumeric(receiver)),
    amountMatched: parsedAmounts.some((value) =>
      moneyEquals(value, expectedEtb),
    ),
    receiptAgeOk: receiptAgeOk(input.transactionTime),
  };

  const payload = {
    provider: "TELEBIRR",
    receiptHost: url.hostname,
    transactionCode,
    expectedEtb,
    parsedAmounts,
    checks,
    receiptHash: sha256(html),
    fetchedAt: new Date().toISOString(),
  };

  const failed = Object.entries(checks)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (failed.length > 0) {
    return {
      autoApprove: false,
      status: "MANUAL_REVIEW",
      reason: `Telebirr validation needs review: ${failed.join(", ")}`,
      payload,
    };
  }

  return {
    autoApprove: true,
    status: "VERIFIED",
    reason: "Telebirr receipt verified",
    payload,
  };
}

export function normalizeTelebirrTransactionCode(value: string): string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 6 || normalized.length > 64) {
    throw new AppError("Telebirr transaction code looks invalid");
  }
  return normalized;
}

export function normalizeTelebirrReceiptUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError("Telebirr receipt URL is invalid");
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") {
    throw new AppError("Telebirr receipt URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new AppError("Telebirr receipt URL cannot include credentials");
  }
  if (!env.TELEBIRR_RECEIPT_ALLOWED_HOSTS.includes(host)) {
    throw new AppError("Telebirr receipt URL host is not allowed");
  }
  return url;
}

async function fetchReceiptHtml(url: URL): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    env.TELEBIRR_RECEIPT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": "BingoCore/1.0 TelebirrReceiptValidator",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error("Telebirr receipt URL redirected unexpectedly");
    }
    if (!response.ok) {
      throw new Error(`Telebirr receipt returned HTTP ${response.status}`);
    }

    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_RECEIPT_BYTES) {
      throw new Error("Telebirr receipt response is too large");
    }

    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > MAX_RECEIPT_BYTES) {
      throw new Error("Telebirr receipt response is too large");
    }
    return html;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Could not validate Telebirr receipt: ${error.message}`);
    }
    throw new Error("Could not validate Telebirr receipt");
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseMoneyValues(text: string): number[] {
  const values = new Set<number>();
  const patterns = [
    /(?:amount|total|paid|payment|transferred|transaction amount)[^0-9]{0,50}([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi,
    /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:etb|birr)/gi,
    /(?:etb|birr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const parsed = parseMoney(match[1] ?? "");
      if (parsed !== null) values.add(parsed);
    }
  }

  return [...values];
}

function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyEquals(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.01;
}

function timeMatches(transactionTime: string, receiptText: string): boolean {
  const receiptDigits = receiptText.replace(/\D/g, "");
  const timeDigits = transactionTime.replace(/\D/g, "");
  if (timeDigits.length >= 8 && receiptDigits.includes(timeDigits)) {
    return true;
  }

  const receiptCompact = compactAlphaNumeric(receiptText);
  const timeCompact = compactAlphaNumeric(transactionTime);
  return timeCompact.length >= 8 && receiptCompact.includes(timeCompact);
}

function receiptAgeOk(transactionTime: string): boolean {
  if (env.TELEBIRR_MAX_RECEIPT_AGE_HOURS === 0) return true;
  const parsed = Date.parse(transactionTime);
  if (!Number.isFinite(parsed)) return true;

  const ageMs = Date.now() - parsed;
  const maxAgeMs = env.TELEBIRR_MAX_RECEIPT_AGE_HOURS * 60 * 60 * 1000;
  const futureToleranceMs = 12 * 60 * 60 * 1000;
  return ageMs >= -futureToleranceMs && ageMs <= maxAgeMs;
}

function manualReview(reason: string, url?: URL): TelebirrValidationResult {
  return {
    autoApprove: false,
    status: "MANUAL_REVIEW",
    reason,
    payload: {
      provider: "TELEBIRR",
      receiptHost: url?.hostname,
      fetchedAt: new Date().toISOString(),
    },
  };
}

function compactAlphaNumeric(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
