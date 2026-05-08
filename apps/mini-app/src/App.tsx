import {
  Activity,
  BadgeDollarSign,
  Bot,
  ChevronLeft,
  ChevronRight,
  Crown,
  Grid3X3,
  History,
  Home,
  LogOut,
  Play,
  UserRound,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MatchDto,
  MatchResultDto,
  MatchWinnerDto,
  RoomDto,
  TransactionDto,
  WalletDto,
} from "@bingo/shared";
import { BINGO_LETTERS, formatBall, hasBingo, isMarked } from "@bingo/shared";
import { authenticate, endpoints, type Session } from "./api";
import { createBingoSocket, type BingoSocket } from "./socket";
import { haptic, prepareTelegramShell } from "./telegram";

type Page = "home" | "play" | "game" | "wallet" | "history" | "profile";
const AUTO_BINGO_KEY = "bingo_auto_bingo";
const SEATS_PER_PAGE = 40;

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [match, setMatch] = useState<MatchDto | null>(null);
  const [wallet, setWallet] = useState<WalletDto>({ balance: 0, locked: 0 });
  const [history, setHistory] = useState<MatchResultDto[]>([]);
  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [profile, setProfile] = useState({
    totalMatches: 0,
    wins: 0,
    losses: 0,
  });
  const [winnerDialog, setWinnerDialog] = useState<MatchDto | null>(null);
  const [seenWinnerMatchId, setSeenWinnerMatchId] = useState<string | null>(
    null,
  );
  const [autoBingo, setAutoBingo] = useState(readAutoBingoPreference);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const autoBingoAttempt = useRef<string | null>(null);

  useEffect(() => {
    prepareTelegramShell();
    void boot();
  }, []);

  useEffect(() => {
    if (!session?.token) return;
    const socket: BingoSocket = createBingoSocket(session.token);
    socket.on("room:state", (nextRoom) => setRoom(nextRoom));
    socket.on("match:state", (nextMatch) => {
      setMatch(nextMatch);
      if (nextMatch.status === "ACTIVE" || nextMatch.status === "FINISHED")
        setPage("game");
    });
    return () => {
      socket.disconnect();
    };
  }, [session?.token]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(async () => {
      try {
        const active = await endpoints.activeMatch();
        if (active) setMatch(active);
        if (room?.id && page === "play") setRoom(await endpoints.room(room.id));
        setWallet(await endpoints.wallet());
      } catch {
        // Realtime is primary; polling is only a quiet safety net.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [session, room?.id, page]);

  useEffect(() => {
    if (!match || match.status !== "FINISHED" || match.winners.length === 0)
      return;
    if (seenWinnerMatchId === match.id) return;

    setSeenWinnerMatchId(match.id);
    setWinnerDialog(match);
    haptic(match.winners.some((winner) => winner.isMine) ? "heavy" : "medium");
    void refreshAccount();
  }, [match?.id, match?.status, match?.winners.length, seenWinnerMatchId]);

  useEffect(() => {
    if (!autoBingo || !match?.myCard || match.status !== "ACTIVE") return;
    if (!hasBingo(match.myCard, match.calledNumbers, [match.pattern])) return;

    const attemptKey = `${match.id}:${match.currentIndex}`;
    if (autoBingoAttempt.current === attemptKey) return;
    autoBingoAttempt.current = attemptKey;
    void submitAutoBingo(match.id);
  }, [
    autoBingo,
    match?.id,
    match?.status,
    match?.currentIndex,
    match?.myCard,
    match?.calledNumbers,
    match?.pattern,
  ]);

  async function boot() {
    try {
      setLoading(true);
      setMessage("");
      const nextSession = await authenticate();
      setSession(nextSession);
      setWallet(nextSession.wallet);
      const active = await endpoints.activeMatch();
      if (active) {
        setMatch(active);
        setPage("game");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Startup failed");
    } finally {
      setLoading(false);
    }
  }

  async function refreshAccount() {
    const [nextWallet, nextHistory, nextTransactions, nextProfile] =
      await Promise.all([
        endpoints.wallet(),
        endpoints.history(),
        endpoints.transactions(),
        endpoints.profile(),
      ]);
    setWallet(nextWallet);
    setHistory(nextHistory);
    setTransactions(nextTransactions);
    setProfile(nextProfile);
  }

  async function openPublicRoom() {
    await runAction(async () => {
      const nextRoom = await endpoints.currentRoom();
      setRoom(nextRoom);
      setMatch(null);
      setPage("play");
    });
  }

  async function joinSeat(seatNumber: number) {
    if (!room) return;
    await runAction(async () => {
      const nextRoom = await endpoints.joinSeat(room.id, seatNumber);
      setRoom(nextRoom);
      setWallet(await endpoints.wallet());
    }, "Seat locked");
  }

  async function leaveCurrentRoom() {
    if (!room) return;
    await runAction(async () => {
      await endpoints.leaveRoom(room.id);
      setRoom(null);
      setPage("home");
      setWallet(await endpoints.wallet());
    }, "Seat released");
  }

  async function startPractice() {
    await runAction(async () => {
      const practice = await endpoints.startPractice();
      setMatch(practice);
      setRoom(null);
      setPage("game");
    });
  }

  async function claimBingo() {
    if (!match) return;
    await runAction(async () => {
      const nextMatch = await endpoints.claimBingo(match.id);
      setMatch(nextMatch);
      setWallet(await endpoints.wallet());
      await refreshAccount();
    }, "Bingo submitted");
  }

  async function submitAutoBingo(matchId: string) {
    try {
      setMessage("");
      const nextMatch = await endpoints.claimBingo(matchId);
      setMatch(nextMatch);
      setWallet(await endpoints.wallet());
      await refreshAccount();
      haptic("medium");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Auto Bingo failed";
      if (!text.toLowerCase().includes("already finished")) setMessage(text);
    }
  }

  function changeAutoBingo(enabled: boolean) {
    setAutoBingo(enabled);
    writeAutoBingoPreference(enabled);
    haptic("light");
  }

  async function exitMatch() {
    if (!match) return;
    await runAction(async () => {
      await endpoints.exitMatch(match.id);
      setMatch(null);
      setPage("home");
      await refreshAccount();
    }, "Match exited");
  }

  async function runAction(action: () => Promise<void>, success?: string) {
    try {
      setMessage("");
      await action();
      haptic("light");
      if (success) setMessage(success);
    } catch (error) {
      haptic("heavy");
      setMessage(error instanceof Error ? error.message : "Action failed");
    }
  }

  const activeSeat = room?.seats.find((seat) => seat.isMine)?.seatNumber;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <Grid3X3 size={19} />
        </div>
        <div className="brand-copy">
          <strong>Bingo Core</strong>
          <span>
            {session?.user.username
              ? `@${session.user.username}`
              : "Telegram Mini App"}
          </span>
        </div>
        <div className="balance-pill">
          <BadgeDollarSign size={16} />
          <span>{wallet.balance}</span>
        </div>
      </header>

      <main className="screen">
        {loading && <BootScreen />}
        {!loading && (
          <div className="notice-slot">
            {message && <div className="notice">{message}</div>}
          </div>
        )}
        {!loading && page === "home" && (
          <HomePage
            wallet={wallet}
            onPublic={openPublicRoom}
            onPractice={startPractice}
          />
        )}
        {!loading && page === "play" && room && (
          <PlayPage
            room={room}
            activeSeat={activeSeat}
            onSeat={joinSeat}
            onLeave={leaveCurrentRoom}
          />
        )}
        {!loading && page === "game" && match && (
          <GamePage
            match={match}
            autoBingo={autoBingo}
            onAutoBingoChange={changeAutoBingo}
            onBingo={claimBingo}
            onExit={exitMatch}
          />
        )}
        {!loading && page === "wallet" && (
          <WalletPage
            wallet={wallet}
            transactions={transactions}
            onRefresh={refreshAccount}
          />
        )}
        {!loading && page === "history" && (
          <HistoryPage history={history} onRefresh={refreshAccount} />
        )}
        {!loading && page === "profile" && (
          <ProfilePage
            profile={profile}
            wallet={wallet}
            onRefresh={refreshAccount}
          />
        )}
      </main>

      {winnerDialog && (
        <WinnerModal
          match={winnerDialog}
          onClose={() => setWinnerDialog(null)}
        />
      )}

      <BottomNav
        page={page}
        setPage={(next) => {
          if (next === "play") void openPublicRoom();
          else {
            setPage(next);
            if (["wallet", "history", "profile"].includes(next))
              void refreshAccount();
          }
        }}
      />
    </div>
  );
}

function BootScreen() {
  return (
    <section className="boot-panel">
      <Activity className="spin" size={28} />
      <h1>Booting Core</h1>
    </section>
  );
}

function HomePage({
  wallet,
  onPublic,
  onPractice,
}: {
  wallet: WalletDto;
  onPublic: () => void;
  onPractice: () => void;
}) {
  return (
    <section className="home-stack">
      <div className="hero-panel">
        <div className="hero-art" aria-hidden="true">
          <div className="ball big">B</div>
          <div className="ball small">15</div>
          <div className="ball gold">G</div>
        </div>
        <div className="hero-copy">
          <p className="eyebrow">Live Table</p>
          <h1>Bingo Core</h1>
          <div className="hero-balance">
            <span>Ready Balance</span>
            <strong>{wallet.balance} CR</strong>
          </div>
        </div>
        <div className="metric-grid">
          <Metric label="Entry" value="50" tone="cyan" />
          <Metric label="Seats" value="200" tone="green" />
          <Metric label="Launch" value="30s" tone="gold" />
        </div>
      </div>
      <div className="home-actions">
        <button className="primary-action" onClick={onPublic}>
          <Play size={18} />
          Public Room
        </button>
        <button className="secondary-action" onClick={onPractice}>
          <Bot size={18} />
          Practice
        </button>
      </div>
      <div className="home-mini-grid">
        <div className="mini-panel">
          <span>Wallet</span>
          <strong>{wallet.balance} CR</strong>
        </div>
        <div className="mini-panel">
          <span>Status</span>
          <strong>Online</strong>
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone = "cyan",
}: {
  label: string;
  value: string;
  tone?: "cyan" | "green" | "gold";
}) {
  return (
    <div className={`metric tone-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function PlayPage({
  room,
  activeSeat,
  onSeat,
  onLeave,
}: {
  room: RoomDto;
  activeSeat?: number;
  onSeat: (seatNumber: number) => void;
  onLeave: () => void;
}) {
  const pageCount = Math.max(1, Math.ceil(room.maxSeats / SEATS_PER_PAGE));
  const [seatPage, setSeatPage] = useState(() =>
    activeSeat ? Math.floor((activeSeat - 1) / SEATS_PER_PAGE) : 0,
  );
  const occupied = new Map(room.seats.map((seat) => [seat.seatNumber, seat]));
  const pot = room.seats.length * room.entryFee;
  const startSeat = seatPage * SEATS_PER_PAGE + 1;
  const endSeat = Math.min(room.maxSeats, startSeat + SEATS_PER_PAGE - 1);
  const visibleSeats = Array.from(
    { length: endSeat - startSeat + 1 },
    (_, index) => startSeat + index,
  );

  useEffect(() => {
    setSeatPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    if (activeSeat) setSeatPage(Math.floor((activeSeat - 1) / SEATS_PER_PAGE));
  }, [activeSeat]);

  return (
    <section className="stack play-stack">
      <div className="panel room-panel">
        <div>
          <p className="eyebrow">Public Room</p>
          <h2>{activeSeat ? `Seat ${activeSeat}` : "Pick Your Seat"}</h2>
          <div className="room-code">{room.code}</div>
        </div>
        <div className="timer-tile">
          <strong>{room.secondsRemaining}s</strong>
          <span>Left</span>
        </div>
      </div>
      <div className="compact-stats">
        <Metric label="Entry" value={`${room.entryFee}`} tone="cyan" />
        <Metric
          label="Players"
          value={`${room.seats.length}/${room.maxSeats}`}
          tone="green"
        />
        <Metric label="Pot" value={`${pot}`} tone="gold" />
      </div>
      <div className="seat-panel">
        <div className="seat-panel-head">
          <div className="seat-legend">
            <span className="legend-dot available" />
            <span>Open</span>
            <span className="legend-dot taken" />
            <span>Taken</span>
            <span className="legend-dot mine" />
            <span>You</span>
          </div>
          <button className="text-action danger" onClick={onLeave}>
            <LogOut size={15} />
            Leave
          </button>
        </div>
        <div className="seat-range">
          <button
            className="icon-action"
            aria-label="Previous seats"
            title="Previous seats"
            disabled={seatPage === 0}
            onClick={() => setSeatPage((current) => Math.max(0, current - 1))}
          >
            <ChevronLeft size={17} />
          </button>
          <span>
            {startSeat}-{endSeat}
          </span>
          <button
            className="icon-action"
            aria-label="Next seats"
            title="Next seats"
            disabled={seatPage >= pageCount - 1}
            onClick={() =>
              setSeatPage((current) => Math.min(pageCount - 1, current + 1))
            }
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <div className="seat-grid" aria-label="Seat grid">
          {visibleSeats.map((seatNumber) => {
            const seat = occupied.get(seatNumber);
            const mine = seat?.isMine;
            return (
              <button
                key={seatNumber}
                className={`seat ${mine ? "mine" : seat ? "taken" : ""}`}
                disabled={Boolean(seat && !mine)}
                onClick={() => onSeat(seatNumber)}
                title={seat ? (seat.username ?? "Taken") : `Seat ${seatNumber}`}
              >
                {seatNumber}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function GamePage({
  match,
  autoBingo,
  onAutoBingoChange,
  onBingo,
  onExit,
}: {
  match: MatchDto;
  autoBingo: boolean;
  onAutoBingoChange: (enabled: boolean) => void;
  onBingo: () => void;
  onExit: () => void;
}) {
  const called = useMemo(
    () => new Set(match.calledNumbers),
    [match.calledNumbers],
  );
  const current = match.currentNumber ? formatBall(match.currentNumber) : "...";
  const winnersSummary = match.winners
    .map((winner) => `Seat ${winner.seatNumber}`)
    .join(", ");

  return (
    <section className="stack game-stack">
      <div className="panel game-header">
        <div className="game-meta">
          <span>Room {match.roomCode}</span>
          <span>Seat {match.mySeat ?? "N/A"}</span>
        </div>
        <p>{match.status === "ACTIVE" ? "Current Number" : "Final Number"}</p>
        <h1>{current}</h1>
        <div className="draw-progress">
          <span>{match.currentIndex}</span>
          <div>
            <i
              style={{
                width: `${Math.min(100, (match.currentIndex / Math.max(1, match.totalNumbers)) * 100)}%`,
              }}
            />
          </div>
          <span>{match.totalNumbers}</span>
        </div>
        <div className="called-strip">
          {match.calledNumbers.slice(-5).map((value) => (
            <span key={value}>{formatBall(value)}</span>
          ))}
        </div>
      </div>

      {match.myCard && (
        <div className="card-zone">
          <div className="bingo-card">
            {BINGO_LETTERS.map((letter) => (
              <div className="card-head" key={letter}>
                {letter}
              </div>
            ))}
            {match.myCard.flat().map((cell) => {
              const marked = isMarked(cell, called);
              return (
                <div
                  className={`card-cell ${marked ? "marked" : ""}`}
                  key={`${cell.row}-${cell.col}`}
                >
                  {cell.value}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {match.status === "ACTIVE" ? (
        <div className="game-controls">
          <label className="switch-row">
            <span>
              <Crown size={17} />
              Auto Bingo
            </span>
            <input
              type="checkbox"
              checked={autoBingo}
              onChange={(event) =>
                onAutoBingoChange(event.currentTarget.checked)
              }
            />
            <i aria-hidden="true" />
          </label>
          <div className="game-actions">
            <button className="text-action center" onClick={onBingo}>
              <Crown size={18} />
              Check
            </button>
            <button className="danger-action compact" onClick={onExit}>
              <LogOut size={17} />
              Exit
            </button>
          </div>
        </div>
      ) : (
        <div className="result-strip">
          <Crown size={18} />
          <span>
            {winnersSummary ? `Winner: ${winnersSummary}` : "Match finished"}
          </span>
        </div>
      )}
    </section>
  );
}

function WalletPage({
  wallet,
  transactions,
  onRefresh,
}: {
  wallet: WalletDto;
  transactions: TransactionDto[];
  onRefresh: () => void;
}) {
  useEffect(() => {
    void onRefresh();
  }, []);

  return (
    <section className="stack data-stack">
      <div className="panel wallet-panel">
        <p className="eyebrow">Wallet</p>
        <h1>{wallet.balance} CR</h1>
        <span>{wallet.locked} locked</span>
      </div>
      <ListEmpty items={transactions} text="No transactions yet." />
      {transactions.map((txn) => (
        <div className="list-row" key={txn.id}>
          <strong>{txn.type.replaceAll("_", " ")}</strong>
          <span>{txn.amount > 0 ? `+${txn.amount}` : txn.amount} CR</span>
        </div>
      ))}
    </section>
  );
}

function HistoryPage({
  history,
  onRefresh,
}: {
  history: MatchResultDto[];
  onRefresh: () => void;
}) {
  useEffect(() => {
    void onRefresh();
  }, []);

  return (
    <section className="stack data-stack">
      <h2 className="section-title">Match Logs</h2>
      <ListEmpty items={history} text="No matches finished yet." />
      {history.map((item) => (
        <div className="list-row" key={item.id}>
          <strong>
            {item.status} {item.seatNumber ? `Seat ${item.seatNumber}` : ""}
          </strong>
          <span>{formatWinnerSeats(item)}</span>
        </div>
      ))}
    </section>
  );
}

function ProfilePage({
  profile,
  wallet,
  onRefresh,
}: {
  profile: { totalMatches: number; wins: number; losses: number };
  wallet: WalletDto;
  onRefresh: () => void;
}) {
  useEffect(() => {
    void onRefresh();
  }, []);

  return (
    <section className="stack data-stack">
      <div className="profile-grid">
        <Metric label="Matches" value={`${profile.totalMatches}`} />
        <Metric label="Wins" value={`${profile.wins}`} />
        <Metric label="Losses" value={`${profile.losses}`} />
        <Metric label="Credits" value={`${wallet.balance}`} />
      </div>
    </section>
  );
}

function ListEmpty<T>({ items, text }: { items: T[]; text: string }) {
  if (items.length > 0) return null;
  return <div className="empty-state">{text}</div>;
}

function WinnerModal({
  match,
  onClose,
}: {
  match: MatchDto;
  onClose: () => void;
}) {
  const split = match.winners.length > 1;
  const myWin = match.winners.some((winner) => winner.isMine);
  const totalPaid = match.winners.reduce(
    (sum, winner) => sum + winner.prize,
    0,
  );

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="winner-title"
    >
      <div className="winner-modal">
        <div className="winner-crown">
          <Crown size={30} />
        </div>
        <p className="eyebrow">Room {match.roomCode}</p>
        <h2 id="winner-title">
          {myWin ? "You Won!" : split ? "Split Bingo!" : "Bingo!"}
        </h2>
        <p className="winner-copy">
          {split
            ? `${match.prizePool} credits split between ${match.winners.length} winners.`
            : `${totalPaid} credits paid to the winning seat.`}
        </p>
        <div className="winner-list">
          {match.winners.map((winner) => (
            <div
              className={winner.isMine ? "winner-row mine" : "winner-row"}
              key={winner.userId}
            >
              <div>
                <strong>{displayWinnerName(winner)}</strong>
                <span>Seat {winner.seatNumber}</span>
              </div>
              <b>{winner.prize} CR</b>
            </div>
          ))}
        </div>
        <button className="primary-action" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function displayWinnerName(winner: MatchWinnerDto): string {
  return winner.username
    ? `@${winner.username}`
    : [winner.firstName, winner.lastName].filter(Boolean).join(" ") ||
        `Player ${winner.userId.slice(0, 6)}`;
}

function formatWinnerSeats(item: MatchResultDto): string {
  const seats = item.winnerSeats?.length
    ? item.winnerSeats
    : item.winnerSeat
      ? [item.winnerSeat]
      : [];
  if (seats.length === 0) return "Winner none";
  return `Winner ${seats.map((seat) => `Seat ${seat}`).join(", ")}`;
}

function readAutoBingoPreference(): boolean {
  try {
    return localStorage.getItem(AUTO_BINGO_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeAutoBingoPreference(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_BINGO_KEY, String(enabled));
  } catch {
    // Local storage can be unavailable in strict embedded browser modes.
  }
}

function BottomNav({
  page,
  setPage,
}: {
  page: Page;
  setPage: (page: Page) => void;
}) {
  const items: Array<{ page: Page; label: string; icon: typeof Home }> = [
    { page: "home", label: "Home", icon: Home },
    { page: "play", label: "Play", icon: Play },
    { page: "wallet", label: "Wallet", icon: Wallet },
    { page: "history", label: "Logs", icon: History },
    { page: "profile", label: "User", icon: UserRound },
  ];

  return (
    <nav className="bottom-nav">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.page}
            className={page === item.page ? "active" : ""}
            onClick={() => setPage(item.page)}
            title={item.label}
          >
            <Icon size={18} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
