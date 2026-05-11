import crypto from "node:crypto";
import { env } from "../config.js";
import { AppError } from "../errors.js";

export type TelebirrDepositInput = {
  amount: number;
  transactionCode: string;
  transactionTime: string;
  receiptUrl: string;
  senderPhoneNumber?: string | null;
  telebirrMessage?: string | null;
  parsedMessage?: TelebirrParsedMessage | null;
};

export type TelebirrValidationResult = {
  autoApprove: boolean;
  status: "VERIFIED" | "MANUAL_REVIEW";
  reason: string;
  payload: Record<string, unknown>;
};

export type TelebirrParsedMessage = {
  senderName: string | null;
  amountEtb: number;
  receiverName: string;
  receiverPhone: string;
  transactionTime: string;
  transactionCode: string;
  receiptUrl: string;
};

const MAX_RECEIPT_BYTES = 1_000_000;

export async function validateTelebirrDeposit(
  input: TelebirrDepositInput,
): Promise<TelebirrValidationResult> {
  const url = normalizeTelebirrReceiptUrl(input.receiptUrl);
  const receiver = env.TELEBIRR_DEPOSIT_RECEIVER.trim();
  const receiverPhone = normalizeTelebirrPhone(env.TELEBIRR_DEPOSIT_PHONE);
  const senderPhone = normalizeTelebirrPhone(input.senderPhoneNumber ?? "");
  const parsedMessage =
    input.parsedMessage ??
    (input.telebirrMessage
      ? parseTelebirrMessage(input.telebirrMessage)
      : null);

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
    receiverPhoneMatched:
      !receiverPhone ||
      phoneMatchesText(receiptText, receiverPhone) ||
      Boolean(
        parsedMessage?.receiverPhone &&
        maskedPhoneMatches(parsedMessage.receiverPhone, receiverPhone),
      ),
    senderPhoneMatched:
      Boolean(senderPhone) && phoneMatchesText(receiptText, senderPhone),
    messageSenderNameMatched:
      !parsedMessage?.senderName ||
      receiptCompact.includes(compactAlphaNumeric(parsedMessage.senderName)),
    messageReceiverNameMatched:
      !parsedMessage?.receiverName ||
      receiptCompact.includes(compactAlphaNumeric(parsedMessage.receiverName)),
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
    contactPhoneLast4: senderPhone ? senderPhone.slice(-4) : null,
    receiverPhoneLast4: receiverPhone ? receiverPhone.slice(-4) : null,
    message: parsedMessage
      ? {
          senderName: parsedMessage.senderName,
          amountEtb: parsedMessage.amountEtb,
          receiverName: parsedMessage.receiverName,
          receiverPhone: parsedMessage.receiverPhone,
          transactionTime: parsedMessage.transactionTime,
          transactionCode: parsedMessage.transactionCode,
          receiptUrl: parsedMessage.receiptUrl,
        }
      : null,
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

export function parseTelebirrMessage(message: string): TelebirrParsedMessage {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) throw new AppError("Telebirr message is required");

  const senderName =
    text.match(/^Dear\s+(.+?)\s+You have transferred\b/i)?.[1]?.trim() ?? "";
  const amountRaw =
    text.match(/\btransferred\s+ETB\s+([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i)?.[1] ??
    "";
  const receiverMatch = text.match(
    /\bto\s+(.+?)\s+\(([^)]+)\)\s+on\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}\s+[0-9]{1,2}:[0-9]{2}:[0-9]{2})/i,
  );
  const transactionCode =
    text.match(/\btransaction number is\s+([A-Z0-9]+)/i)?.[1] ?? "";
  const receiptUrl = cleanReceiptUrl(
    text.match(
      /https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/[A-Z0-9]+/i,
    )?.[0] ?? "",
  );
  const amountEtb = parseMoney(amountRaw);

  if (amountEtb === null)
    throw new AppError("Could not read Telebirr transfer amount");
  if (!receiverMatch?.[1] || !receiverMatch[2] || !receiverMatch[3]) {
    throw new AppError("Could not read Telebirr receiver or transfer time");
  }
  if (!transactionCode)
    throw new AppError("Could not read Telebirr transaction number");
  if (!receiptUrl) throw new AppError("Could not read Telebirr receipt URL");

  const normalizedCode = normalizeTelebirrTransactionCode(transactionCode);
  const normalizedUrl = normalizeTelebirrReceiptUrl(receiptUrl).toString();
  const codeFromUrl = receiptCodeFromUrl(normalizedUrl);
  if (codeFromUrl && codeFromUrl !== normalizedCode) {
    throw new AppError("Telebirr transaction code does not match receipt URL");
  }

  return {
    senderName: senderName || null,
    amountEtb,
    receiverName: receiverMatch[1].trim(),
    receiverPhone: receiverMatch[2].trim(),
    transactionTime: receiverMatch[3].trim(),
    transactionCode: normalizedCode,
    receiptUrl: normalizedUrl,
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

export function normalizeTelebirrPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("251")) return digits;
  if (digits.startsWith("0")) return `251${digits.slice(1)}`;
  if (digits.length === 9) return `251${digits}`;
  return digits;
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
    if (isAbortError(error)) {
      throw new Error("Telebirr receipt validation timed out");
    }
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

export function moneyEquals(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.01;
}

export function maskedPhoneMatches(
  maskedOrFull: string,
  fullPhone: string,
): boolean {
  const normalizedFull = normalizeTelebirrPhone(fullPhone);
  if (!normalizedFull) return false;
  const value = maskedOrFull.trim();
  if (!value.includes("*") && !value.toLowerCase().includes("x")) {
    return normalizeTelebirrPhone(value) === normalizedFull;
  }

  const [prefixRaw = "", suffixRaw = ""] = value.split(/[*xX]+/);
  const prefix = normalizeTelebirrPhone(prefixRaw);
  const suffix = suffixRaw.replace(/\D/g, "");
  return (
    (!prefix || normalizedFull.startsWith(prefix)) &&
    (!suffix || normalizedFull.endsWith(suffix))
  );
}

function phoneMatchesText(text: string, fullPhone: string): boolean {
  const normalizedFull = normalizeTelebirrPhone(fullPhone);
  if (!normalizedFull) return false;
  const digits = text.replace(/\D/g, "");
  if (digits.includes(normalizedFull)) return true;

  const phoneCandidates = text.match(/\d{3,}[*xX]+\d{2,}/g) ?? [];
  return phoneCandidates.some((candidate) =>
    maskedPhoneMatches(candidate, normalizedFull),
  );
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
  const parsed =
    parseTelebirrDateTime(transactionTime) ?? Date.parse(transactionTime);
  if (!Number.isFinite(parsed)) return true;

  const ageMs = Date.now() - parsed;
  const maxAgeMs = env.TELEBIRR_MAX_RECEIPT_AGE_HOURS * 60 * 60 * 1000;
  const futureToleranceMs = 12 * 60 * 60 * 1000;
  return ageMs >= -futureToleranceMs && ageMs <= maxAgeMs;
}

function parseTelebirrDateTime(value: string): number | null {
  const match = value.match(
    /^\s*([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})\s+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\s*$/,
  );
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const timestamp = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cleanReceiptUrl(value: string): string {
  return value.trim().replace(/[).,\s]+$/g, "");
}

function receiptCodeFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const code = url.pathname.split("/").filter(Boolean).at(-1);
    return code ? normalizeTelebirrTransactionCode(code) : null;
  } catch {
    return null;
  }
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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.toLowerCase().includes("aborted"))
  );
}

function compactAlphaNumeric(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
