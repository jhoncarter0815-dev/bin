import crypto from "node:crypto";
import { createDeck, type RandomSource } from "@bingo/shared";

export type FairSeed = {
  seed: string;
  seedHash: string;
  drawOrder: number[];
};

export function createFairSeed(roomId: string): FairSeed {
  const seed = `${roomId}:${Date.now()}:${crypto.randomBytes(32).toString("hex")}`;
  return {
    seed,
    seedHash: hashSeed(seed),
    drawOrder: createDeck(randomFromSeed(seed))
  };
}

export function hashSeed(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

export function randomFromSeed(seed: string): RandomSource {
  let counter = 0;
  let pool = Buffer.alloc(0);
  let offset = 0;

  return () => {
    if (offset + 4 > pool.length) {
      pool = crypto
        .createHash("sha256")
        .update(`${seed}:${counter}`)
        .digest();
      counter += 1;
      offset = 0;
    }

    const value = pool.readUInt32BE(offset);
    offset += 4;
    return value / 0x100000000;
  };
}
