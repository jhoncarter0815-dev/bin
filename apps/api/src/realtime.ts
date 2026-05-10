import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { env } from "./config.js";
import { verifyAuthToken } from "./auth/jwt.js";

let io: Server | undefined;

export function registerRealtime(
  fastify: FastifyInstance,
  server: HttpServer,
): Server {
  io = new Server(server, {
    cors: {
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (typeof token !== "string") return next(new Error("Missing auth token"));
    try {
      const auth = verifyAuthToken(token);
      socket.data.userId = auth.sub;
      socket.join(`user:${auth.sub}`);
      next();
    } catch {
      next(new Error("Invalid auth token"));
    }
  });

  io.on("connection", (socket) => {
    fastify.log.info(
      { socketId: socket.id, userId: socket.data.userId },
      "socket connected",
    );

    socket.on("room:subscribe", (roomId: string) => {
      if (typeof roomId === "string") socket.join(`room:${roomId}`);
    });

    socket.on("room:unsubscribe", (roomId: string) => {
      if (typeof roomId === "string") socket.leave(`room:${roomId}`);
    });

    socket.on("match:subscribe", (matchId: string) => {
      if (typeof matchId === "string") socket.join(`match:${matchId}`);
    });

    socket.on("match:unsubscribe", (matchId: string) => {
      if (typeof matchId === "string") socket.leave(`match:${matchId}`);
    });
  });

  return io;
}

export function emitRoom(roomId: string, payload: unknown): void {
  io?.to(`room:${roomId}`).emit("room:state", payload);
}

export function emitMatch(matchId: string, payload: unknown): void {
  io?.to(`match:${matchId}`).emit("match:state", payload);
}

export function emitUser(
  userId: string,
  event: string,
  payload: unknown,
): void {
  io?.to(`user:${userId}`).emit(event, payload);
}
