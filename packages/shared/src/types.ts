export type BingoLetter = "B" | "I" | "N" | "G" | "O";

export type BingoCell = {
  letter: BingoLetter;
  value: number | "FREE";
  row: number;
  col: number;
};

export type BingoCard = BingoCell[][];

export type WinPattern =
  | "ROW"
  | "COLUMN"
  | "DIAGONAL"
  | "FOUR_CORNERS"
  | "BLACKOUT";

export type PublicUser = {
  id: string;
  telegramId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
};

export type WalletDto = {
  balance: number;
  locked: number;
};

export type SeatDto = {
  id: string;
  roomId: string;
  userId: string;
  seatNumber: number;
  username?: string | null;
  card?: BingoCard;
  isMine?: boolean;
};

export type RoomStatus = "OPEN" | "COUNTDOWN" | "ACTIVE" | "FINISHED" | "CANCELLED";

export type RoomDto = {
  id: string;
  code: string;
  type: "PUBLIC" | "PRIVATE" | "PRACTICE";
  status: RoomStatus;
  entryFee: number;
  maxSeats: number;
  startsAt: string;
  secondsRemaining: number;
  seats: SeatDto[];
};

export type MatchStatus = "ACTIVE" | "FINISHED" | "CANCELLED";

export type MatchWinnerDto = {
  userId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  seatNumber: number;
  prize: number;
  isMine?: boolean;
};

export type MatchDto = {
  id: string;
  roomId: string;
  roomCode: string;
  roomType: RoomDto["type"];
  status: MatchStatus;
  calledNumbers: number[];
  currentNumber?: number;
  currentIndex: number;
  totalNumbers: number;
  prizePool: number;
  seedHash: string;
  seedReveal?: string | null;
  pattern: WinPattern;
  mySeat?: number;
  myCard?: BingoCard;
  winnerSeat?: number | null;
  winnerUserId?: string | null;
  winners: MatchWinnerDto[];
};

export type MatchResultDto = {
  id: string;
  matchId: string;
  roomCode: string;
  status: "WINNER" | "LOST" | "FORFEIT" | "CANCELLED";
  seatNumber?: number | null;
  winnerSeat?: number | null;
  winnerSeats?: number[];
  pot: number;
  createdAt: string;
};

export type TransactionDto = {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  createdAt: string;
  description?: string | null;
};
