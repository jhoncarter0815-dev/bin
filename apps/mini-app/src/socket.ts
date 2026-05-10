import { io, type Socket } from "socket.io-client";
import type { MatchDto, RoomDto } from "@bingo/shared";

const API_URL = (
  import.meta.env.VITE_API_URL || window.location.origin
).replace(/\/$/, "");

type ServerToClientEvents = {
  "room:state": (room: RoomDto) => void;
  "match:state": (match: MatchDto) => void;
};

type ClientToServerEvents = {
  "room:subscribe": (roomId: string) => void;
  "room:unsubscribe": (roomId: string) => void;
  "match:subscribe": (matchId: string) => void;
  "match:unsubscribe": (matchId: string) => void;
};

export type BingoSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createBingoSocket(token: string): BingoSocket {
  return io(API_URL, {
    auth: { token },
    transports: ["websocket", "polling"],
  });
}
