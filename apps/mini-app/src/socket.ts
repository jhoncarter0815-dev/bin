import { io, type Socket } from "socket.io-client";
import type { MatchDto, RoomDto } from "@bingo/shared";

const API_URL = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, "");

export type BingoSocket = Socket<{
  "room:state": (room: RoomDto) => void;
  "match:state": (match: MatchDto) => void;
}>;

export function createBingoSocket(token: string): BingoSocket {
  return io(API_URL, {
    auth: { token },
    transports: ["websocket", "polling"]
  });
}

