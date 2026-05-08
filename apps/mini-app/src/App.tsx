import {
  Activity,
  BadgeDollarSign,
  Bot,
  Crown,
  Grid3X3,
  History,
  Home,
  LogOut,
  Play,
  Shield,
  UserRound,
  Wallet
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { MatchDto, MatchResultDto, RoomDto, TransactionDto, WalletDto } from "@bingo/shared";
import { BINGO_LETTERS, formatBall, isMarked } from "@bingo/shared";
import { authenticate, endpoints, type Session } from "./api";
import { createBingoSocket, type BingoSocket } from "./socket";
import { haptic, prepareTelegramShell } from "./telegram";

type Page = "home" | "play" | "game" | "wallet" | "history" | "profile" | "admin";

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [match, setMatch] = useState<MatchDto | null>(null);
  const [wallet, setWallet] = useState<WalletDto>({ balance: 0, locked: 0 });
  const [history, setHistory] = useState<MatchResultDto[]>([]);
  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [profile, setProfile] = useState({ totalMatches: 0, wins: 0, losses: 0 });
  const [adminSecret, setAdminSecret] = useState(localStorage.getItem("admin_secret") ?? "");
  const [adminUsers, setAdminUsers] = useState<Array<{ id: string; username?: string | null; wallet?: WalletDto | null }>>(
    []
  );
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

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
      if (nextMatch.status === "ACTIVE") setPage("game");
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
    const [nextWallet, nextHistory, nextTransactions, nextProfile] = await Promise.all([
      endpoints.wallet(),
      endpoints.history(),
      endpoints.transactions(),
      endpoints.profile()
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

  async function exitMatch() {
    if (!match) return;
    await runAction(async () => {
      await endpoints.exitMatch(match.id);
      setMatch(null);
      setPage("home");
      await refreshAccount();
    }, "Match exited");
  }

  async function loadAdminUsers() {
    await runAction(async () => {
      localStorage.setItem("admin_secret", adminSecret);
      setAdminUsers(await endpoints.adminUsers(adminSecret));
    });
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
          <span>{session?.user.username ? `@${session.user.username}` : "Telegram Mini App"}</span>
        </div>
        <div className="balance-pill">
          <BadgeDollarSign size={16} />
          <span>{wallet.balance}</span>
        </div>
      </header>

      <main className="screen">
        {loading && <BootScreen />}
        {!loading && message && <div className="notice">{message}</div>}
        {!loading && page === "home" && (
          <HomePage wallet={wallet} onPublic={openPublicRoom} onPractice={startPractice} />
        )}
        {!loading && page === "play" && room && (
          <PlayPage room={room} activeSeat={activeSeat} onSeat={joinSeat} onLeave={leaveCurrentRoom} />
        )}
        {!loading && page === "game" && match && (
          <GamePage match={match} onBingo={claimBingo} onExit={exitMatch} />
        )}
        {!loading && page === "wallet" && (
          <WalletPage wallet={wallet} transactions={transactions} onRefresh={refreshAccount} />
        )}
        {!loading && page === "history" && (
          <HistoryPage history={history} onRefresh={refreshAccount} />
        )}
        {!loading && page === "profile" && (
          <ProfilePage profile={profile} wallet={wallet} onRefresh={refreshAccount} />
        )}
        {!loading && page === "admin" && (
          <AdminPage
            secret={adminSecret}
            setSecret={setAdminSecret}
            users={adminUsers}
            onLoad={loadAdminUsers}
          />
        )}
      </main>

      <BottomNav
        page={page}
        setPage={(next) => {
          if (next === "play") void openPublicRoom();
          else {
            setPage(next);
            if (["wallet", "history", "profile"].includes(next)) void refreshAccount();
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
  onPractice
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
        <p className="eyebrow">Live Room Protocol</p>
        <h1>Play Bingo. Win Credits.</h1>
        <div className="metric-grid">
          <Metric label="Entry" value="50" />
          <Metric label="Seats" value="200" />
          <Metric label="Timer" value="30s" />
        </div>
      </div>
      <button className="primary-action" onClick={onPublic}>
        <Play size={18} />
        Join Public Room
      </button>
      <button className="secondary-action" onClick={onPractice}>
        <Bot size={18} />
        Practice Table
      </button>
      <div className="wallet-strip">
        <Wallet size={18} />
        <span>{wallet.balance} credits ready</span>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function PlayPage({
  room,
  activeSeat,
  onSeat,
  onLeave
}: {
  room: RoomDto;
  activeSeat?: number;
  onSeat: (seatNumber: number) => void;
  onLeave: () => void;
}) {
  const occupied = new Map(room.seats.map((seat) => [seat.seatNumber, seat]));
  const pot = room.seats.length * room.entryFee;

  return (
    <section className="stack">
      <div className="panel room-panel">
        <div>
          <p className="eyebrow">Room {room.code}</p>
          <h2>{activeSeat ? `Seat ${activeSeat} locked` : "Choose a Seat"}</h2>
        </div>
        <div className="timer-tile">
          <strong>{room.secondsRemaining}s</strong>
          <span>Left</span>
        </div>
      </div>
      <div className="compact-stats">
        <Metric label="Entry" value={`${room.entryFee}`} />
        <Metric label="Players" value={`${room.seats.length}/${room.maxSeats}`} />
        <Metric label="Pot" value={`${pot}`} />
      </div>
      <button className="danger-action" onClick={onLeave}>
        <LogOut size={17} />
        Leave Room
      </button>
      <div className="seat-grid" aria-label="Seat grid">
        {Array.from({ length: room.maxSeats }, (_, index) => {
          const seatNumber = index + 1;
          const seat = occupied.get(seatNumber);
          const mine = seat?.isMine;
          return (
            <button
              key={seatNumber}
              className={`seat ${mine ? "mine" : seat ? "taken" : ""}`}
              disabled={Boolean(seat && !mine)}
              onClick={() => onSeat(seatNumber)}
              title={seat ? seat.username ?? "Taken" : `Seat ${seatNumber}`}
            >
              {seatNumber}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function GamePage({
  match,
  onBingo,
  onExit
}: {
  match: MatchDto;
  onBingo: () => void;
  onExit: () => void;
}) {
  const called = useMemo(() => new Set(match.calledNumbers), [match.calledNumbers]);
  const current = match.currentNumber ? formatBall(match.currentNumber) : "...";

  return (
    <section className="stack">
      <div className="panel game-header">
        <div className="game-meta">
          <span>Room {match.roomCode}</span>
          <span>Seat {match.mySeat ?? "N/A"}</span>
        </div>
        <p>Current Number</p>
        <h1>{current}</h1>
        <div className="called-strip">
          {match.calledNumbers.slice(-10).map((value) => (
            <span key={value}>{formatBall(value)}</span>
          ))}
        </div>
      </div>

      {match.myCard && (
        <div className="bingo-card">
          {BINGO_LETTERS.map((letter) => (
            <div className="card-head" key={letter}>
              {letter}
            </div>
          ))}
          {match.myCard.flat().map((cell) => {
            const marked = isMarked(cell, called);
            return (
              <div className={`card-cell ${marked ? "marked" : ""}`} key={`${cell.row}-${cell.col}`}>
                {cell.value}
              </div>
            );
          })}
        </div>
      )}

      <button className="win-action" onClick={onBingo}>
        <Crown size={19} />
        Bingo
      </button>
      <button className="danger-action" onClick={onExit}>
        <LogOut size={17} />
        Exit Match
      </button>
    </section>
  );
}

function WalletPage({
  wallet,
  transactions,
  onRefresh
}: {
  wallet: WalletDto;
  transactions: TransactionDto[];
  onRefresh: () => void;
}) {
  useEffect(() => {
    void onRefresh();
  }, []);

  return (
    <section className="stack">
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

function HistoryPage({ history, onRefresh }: { history: MatchResultDto[]; onRefresh: () => void }) {
  useEffect(() => {
    void onRefresh();
  }, []);

  return (
    <section className="stack">
      <h2 className="section-title">Match Logs</h2>
      <ListEmpty items={history} text="No matches finished yet." />
      {history.map((item) => (
        <div className="list-row" key={item.id}>
          <strong>
            {item.status} {item.seatNumber ? `Seat ${item.seatNumber}` : ""}
          </strong>
          <span>Winner {item.winnerSeat ? `Seat ${item.winnerSeat}` : "none"}</span>
        </div>
      ))}
    </section>
  );
}

function ProfilePage({
  profile,
  wallet,
  onRefresh
}: {
  profile: { totalMatches: number; wins: number; losses: number };
  wallet: WalletDto;
  onRefresh: () => void;
}) {
  useEffect(() => {
    void onRefresh();
  }, []);

  return (
    <section className="stack">
      <div className="profile-grid">
        <Metric label="Matches" value={`${profile.totalMatches}`} />
        <Metric label="Wins" value={`${profile.wins}`} />
        <Metric label="Losses" value={`${profile.losses}`} />
        <Metric label="Credits" value={`${wallet.balance}`} />
      </div>
    </section>
  );
}

function AdminPage({
  secret,
  setSecret,
  users,
  onLoad
}: {
  secret: string;
  setSecret: (value: string) => void;
  users: Array<{ id: string; username?: string | null; wallet?: WalletDto | null }>;
  onLoad: () => void;
}) {
  return (
    <section className="stack">
      <div className="panel">
        <p className="eyebrow">Admin</p>
        <input
          className="text-input"
          placeholder="ADMIN_SECRET"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          type="password"
        />
        <button className="secondary-action compact" onClick={onLoad}>
          <Shield size={17} />
          Load Users
        </button>
      </div>
      {users.map((user) => (
        <div className="list-row" key={user.id}>
          <strong>{user.username ?? user.id.slice(0, 8)}</strong>
          <span>{user.wallet?.balance ?? 0} CR</span>
        </div>
      ))}
    </section>
  );
}

function ListEmpty<T>({ items, text }: { items: T[]; text: string }) {
  if (items.length > 0) return null;
  return <div className="empty-state">{text}</div>;
}

function BottomNav({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const items: Array<{ page: Page; label: string; icon: typeof Home }> = [
    { page: "home", label: "Home", icon: Home },
    { page: "play", label: "Play", icon: Play },
    { page: "wallet", label: "Wallet", icon: Wallet },
    { page: "history", label: "Logs", icon: History },
    { page: "profile", label: "User", icon: UserRound },
    { page: "admin", label: "Admin", icon: Shield }
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
