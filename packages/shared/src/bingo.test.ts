import { describe, expect, it } from "vitest";
import { createCard, createDeck, findWinningPatterns, hasBingo, validateCard } from "./bingo.js";

const deterministic = () => 0.42;

describe("bingo rules", () => {
  it("creates valid 75 ball decks", () => {
    const deck = createDeck(deterministic);
    expect(deck).toHaveLength(75);
    expect(new Set(deck).size).toBe(75);
  });

  it("creates valid cards with a free center", () => {
    const card = createCard(deterministic);
    expect(validateCard(card)).toBe(true);
    expect(card[2]?.[2]?.value).toBe("FREE");
  });

  it("detects winning rows", () => {
    const card = createCard(deterministic);
    const rowValues = card[0]!.map((cell) => cell.value).filter((value): value is number => typeof value === "number");
    expect(hasBingo(card, rowValues)).toBe(true);
    expect(findWinningPatterns(card, rowValues)).toContain("ROW");
  });
});

