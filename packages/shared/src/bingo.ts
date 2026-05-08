import type { BingoCard, BingoCell, BingoLetter, WinPattern } from "./types.js";

export const BINGO_LETTERS: BingoLetter[] = ["B", "I", "N", "G", "O"];
export const BALLS_PER_COLUMN = 15;
export const BINGO_MAX_BALL = 75;
export const FREE_SPACE_COORD = { row: 2, col: 2 } as const;

export type RandomSource = () => number;

export function numberToLetter(value: number): BingoLetter {
  if (!Number.isInteger(value) || value < 1 || value > BINGO_MAX_BALL) {
    throw new Error(`Bingo number must be between 1 and ${BINGO_MAX_BALL}`);
  }
  return BINGO_LETTERS[Math.floor((value - 1) / BALLS_PER_COLUMN)]!;
}

export function formatBall(value: number): string {
  return `${numberToLetter(value)}-${value}`;
}

export function createDeck(random: RandomSource = Math.random): number[] {
  return shuffle(
    Array.from({ length: BINGO_MAX_BALL }, (_, index) => index + 1),
    random
  );
}

export function createCard(random: RandomSource = Math.random): BingoCard {
  const columns = BINGO_LETTERS.map((letter, col) => {
    const start = col * BALLS_PER_COLUMN + 1;
    const values = shuffle(
      Array.from({ length: BALLS_PER_COLUMN }, (_, index) => start + index),
      random
    ).slice(0, 5);

    return values.map<BingoCell>((value, row) => ({
      letter,
      value,
      row,
      col
    }));
  });

  const rows: BingoCard = Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 5 }, (_, col) => columns[col]![row]!)
  );

  rows[FREE_SPACE_COORD.row]![FREE_SPACE_COORD.col] = {
    letter: "N",
    value: "FREE",
    row: FREE_SPACE_COORD.row,
    col: FREE_SPACE_COORD.col
  };

  return rows;
}

export function isMarked(cell: BingoCell, calledNumbers: Iterable<number>): boolean {
  if (cell.value === "FREE") return true;
  return new Set(calledNumbers).has(cell.value);
}

export function findWinningPatterns(
  card: BingoCard,
  calledNumbers: Iterable<number>
): WinPattern[] {
  const called = new Set(calledNumbers);
  const winners = new Set<WinPattern>();

  for (let row = 0; row < 5; row += 1) {
    if (card[row]?.every((cell) => isMarked(cell, called))) winners.add("ROW");
  }

  for (let col = 0; col < 5; col += 1) {
    if (card.every((row) => isMarked(row[col]!, called))) winners.add("COLUMN");
  }

  const diagonalA = [0, 1, 2, 3, 4].every((index) => isMarked(card[index]![index]!, called));
  const diagonalB = [0, 1, 2, 3, 4].every((index) => isMarked(card[index]![4 - index]!, called));
  if (diagonalA || diagonalB) winners.add("DIAGONAL");

  const corners = [
    card[0]![0]!,
    card[0]![4]!,
    card[4]![0]!,
    card[4]![4]!
  ].every((cell) => isMarked(cell, called));
  if (corners) winners.add("FOUR_CORNERS");

  if (card.every((row) => row.every((cell) => isMarked(cell, called)))) winners.add("BLACKOUT");

  return [...winners];
}

export function hasBingo(
  card: BingoCard,
  calledNumbers: Iterable<number>,
  allowedPatterns: WinPattern[] = ["ROW", "COLUMN", "DIAGONAL"]
): boolean {
  const found = findWinningPatterns(card, calledNumbers);
  return allowedPatterns.some((pattern) => found.includes(pattern));
}

export function countMarks(card: BingoCard, calledNumbers: Iterable<number>): number {
  const called = new Set(calledNumbers);
  return card.flat().filter((cell) => isMarked(cell, called)).length;
}

export function validateCard(card: BingoCard): boolean {
  if (!Array.isArray(card) || card.length !== 5) return false;
  const seen = new Set<number>();

  for (let row = 0; row < 5; row += 1) {
    if (!Array.isArray(card[row]) || card[row]!.length !== 5) return false;
    for (let col = 0; col < 5; col += 1) {
      const cell = card[row]![col]!;
      if (cell.row !== row || cell.col !== col) return false;
      if (row === FREE_SPACE_COORD.row && col === FREE_SPACE_COORD.col) {
        if (cell.value !== "FREE") return false;
        continue;
      }
      if (cell.value === "FREE") return false;
      if (cell.letter !== BINGO_LETTERS[col]) return false;
      if (numberToLetter(cell.value) !== cell.letter) return false;
      if (seen.has(cell.value)) return false;
      seen.add(cell.value);
    }
  }

  return true;
}

export function maskOpponentCard(card: BingoCard): BingoCard {
  return card.map((row) =>
    row.map((cell) => ({
      ...cell,
      value: cell.value === "FREE" ? "FREE" : 0
    })) as BingoCell[]
  );
}

function shuffle<T>(input: T[], random: RandomSource): T[] {
  const items = [...input];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex]!, items[index]!];
  }
  return items;
}

