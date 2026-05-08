import jwt from "jsonwebtoken";
import { env } from "../config.js";

export type AuthTokenPayload = {
  sub: string;
  telegramId: string;
  username?: string | null;
  isAdmin?: boolean;
};

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    audience: "bingo-mini-app",
    issuer: "telegram-bingo-platform",
    expiresIn: "7d"
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, env.JWT_SECRET, {
    audience: "bingo-mini-app",
    issuer: "telegram-bingo-platform"
  }) as AuthTokenPayload;
}

