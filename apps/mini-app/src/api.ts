import type {
  MatchDto,
  MatchmakingStateDto,
  MatchResultDto,
  PublicUser,
  RoomDto,
  TransactionDto,
  WalletDto,
  WalletRequestDto,
} from "@bingo/shared";
import { getInitData, getReferralCode } from "./telegram";

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const TOKEN_KEY = "bingo_auth_token";
const DEV_USER_KEY = "bingo_dev_user_id";

export type Session = {
  token: string;
  user: PublicUser;
  wallet: WalletDto;
  isAdmin?: boolean;
};

export type FairProofDto = {
  matchId: string;
  seedHash: string;
  seedReveal?: string | null;
  drawOrder: number[];
  calledNumbers: number[];
  winnerSeat?: number | null;
  winnerSeats?: number[];
};

export type AuditEntryDto = {
  id: string;
  action: string;
  target?: string | null;
  metadata?: unknown;
  createdAt: string;
};

export type DepositRequestInput = {
  amount: number;
  details?: string;
  transactionCode?: string;
  transactionTime?: string;
  receiptUrl?: string;
  telebirrMessage?: string;
  senderPhoneNumber?: string;
};

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export async function authenticate(): Promise<Session> {
  const initData = getInitData();
  const referralCode = getReferralCode();
  const devUserId = ensureDevUserId();
  const session = await request<Session>("/api/auth/telegram", {
    method: "POST",
    auth: false,
    body: initData
      ? { initData, referralCode }
      : { dev: true, referralCode, devUser: { id: devUserId } },
  });
  setToken(session.token);
  return session;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  return request<T>(path, init);
}

export const endpoints = {
  me: () => api<Session>("/api/me"),
  currentRoom: () => api<RoomDto>("/api/rooms/current"),
  matchmakingState: () => api<MatchmakingStateDto>("/api/matchmaking/state"),
  joinMatchmaking: () =>
    api<MatchmakingStateDto>("/api/matchmaking/join", {
      method: "POST",
    }),
  room: (id: string) => api<RoomDto>(`/api/rooms/${id}`),
  joinSeat: (roomId: string, seatNumber: number) =>
    api<RoomDto>(`/api/rooms/${roomId}/join-seat`, {
      method: "POST",
      body: { seatNumber },
    }),
  leaveRoom: (roomId: string) =>
    api<{ ok: true }>(`/api/rooms/${roomId}/leave`, {
      method: "POST",
    }),
  startPractice: () =>
    api<MatchDto>("/api/practice/start", {
      method: "POST",
    }),
  activeMatch: () => api<MatchDto | null>("/api/match/active"),
  claimBingo: (matchId: string, markedNumbers?: number[]) =>
    api<MatchDto>(`/api/match/${matchId}/bingo`, {
      method: "POST",
      ...(markedNumbers === undefined ? {} : { body: { markedNumbers } }),
    }),
  exitMatch: (matchId: string) =>
    api<{ ok: true }>(`/api/match/${matchId}/exit`, {
      method: "POST",
    }),
  fair: (matchId: string) => api<FairProofDto>(`/api/match/${matchId}/fair`),
  audit: (matchId: string) =>
    api<AuditEntryDto[]>(`/api/match/${matchId}/audit`),
  history: () => api<MatchResultDto[]>("/api/matches/history"),
  wallet: () => api<WalletDto>("/api/wallet"),
  walletRequests: () => api<WalletRequestDto[]>("/api/wallet/requests"),
  requestDeposit: (input: DepositRequestInput) =>
    api<WalletRequestDto>("/api/wallet/deposit", {
      method: "POST",
      body: input,
    }),
  requestWithdraw: (amount: number, details?: string) =>
    api<WalletRequestDto>("/api/wallet/withdraw", {
      method: "POST",
      body: { amount, details },
    }),
  cancelWalletRequest: (id: string) =>
    api<WalletRequestDto>(`/api/wallet/requests/${id}/cancel`, {
      method: "POST",
    }),
  transactions: () => api<TransactionDto[]>("/api/transactions"),
  profile: () =>
    api<{
      totalMatches: number;
      wins: number;
      losses: number;
      referralCode?: string | null;
      referralCount: number;
      referralRewards: number;
      referralLink?: string;
    }>("/api/profile"),
};

type ApiInit = Omit<RequestInit, "body"> & {
  body?: unknown;
  auth?: boolean;
};

async function request<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (init.auth !== false) {
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error ?? `Request failed with status ${response.status}`,
    );
  }
  return payload as T;
}

function ensureDevUserId(): number {
  const existing = localStorage.getItem(DEV_USER_KEY);
  if (existing) return Number(existing);
  const value = Math.floor(100_000_000 + Math.random() * 899_999_999);
  localStorage.setItem(DEV_USER_KEY, String(value));
  return value;
}
