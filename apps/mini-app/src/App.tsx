import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeDollarSign,
  Bot,
  Crown,
  Grid3X3,
  History,
  Home,
  LogOut,
  Play,
  Share2,
  UserRound,
  Wallet,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  MatchDto,
  MatchmakingStateDto,
  MatchResultDto,
  MatchWinnerDto,
  RoomDto,
  SpectatorMatchDto,
  TransactionDto,
  WalletDto,
  WalletRequestDto,
} from "@bingo/shared";
import {
  BINGO_LETTERS,
  BINGO_MAX_BALL,
  formatBall,
  hasBingo,
  isMarked,
} from "@bingo/shared";
import {
  authenticate,
  endpoints,
  type AuditEntryDto,
  type DepositRequestInput,
  type FairProofDto,
  type Session,
} from "./api";
import { createBingoSocket, type BingoSocket } from "./socket";
import { haptic, prepareTelegramShell } from "./telegram";

type Page = "home" | "play" | "game" | "wallet" | "history" | "profile";
const AUTO_BINGO_KEY = "bingo_auto_bingo";
const MANUAL_MARKS_KEY = "bingo_manual_marks";
type ManualMarksByMatch = Record<string, number[]>;
type ProfileState = {
  totalMatches: number;
  wins: number;
  losses: number;
  referralCode?: string | null;
  referralCount: number;
  referralRewards: number;
  referralLink?: string;
};
type ProofState = {
  fair: FairProofDto;
  audit: AuditEntryDto[];
};

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [match, setMatch] = useState<MatchDto | null>(null);
  const [matchmaking, setMatchmaking] = useState<MatchmakingStateDto | null>(
    null,
  );
  const [wallet, setWallet] = useState<WalletDto>({ balance: 0, locked: 0 });
  const [history, setHistory] = useState<MatchResultDto[]>([]);
  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [walletRequests, setWalletRequests] = useState<WalletRequestDto[]>([]);
  const [profile, setProfile] = useState<ProfileState>({
    totalMatches: 0,
    wins: 0,
    losses: 0,
    referralCode: null,
    referralCount: 0,
    referralRewards: 0,
    referralLink: undefined,
  });
  const [winnerDialog, setWinnerDialog] = useState<MatchDto | null>(null);
  const [proofDialog, setProofDialog] = useState<ProofState | null>(null);
  const [seenWinnerMatchId, setSeenWinnerMatchId] = useState<string | null>(
    null,
  );
  const [autoBingo, setAutoBingo] = useState(readAutoBingoPreference);
  const [manualMarksByMatch, setManualMarksByMatch] =
    useState<ManualMarksByMatch>(readManualMarks);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const autoBingoAttempt = useRef<string | null>(null);
  const messageTimer = useRef<number | null>(null);
  const socketRef = useRef<BingoSocket | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const spectatorMatchIdRef = useRef<string | null>(null);

  useEffect(() => {
    prepareTelegramShell();
    void boot();
  }, []);

  useEffect(() => {
    if (!session?.token) return;
    const socket: BingoSocket = createBingoSocket(session.token);
    socketRef.current = socket;
    const subscribeToCurrentRoom = () => {
      if (roomIdRef.current) socket.emit("room:subscribe", roomIdRef.current);
      if (spectatorMatchIdRef.current) {
        socket.emit("spectator:subscribe", spectatorMatchIdRef.current);
      }
    };

    socket.on("connect", subscribeToCurrentRoom);
    socket.on("room:state", (nextRoom) => {
      setRoom((currentRoom) =>
        mergeRoomUpdateForCurrentUser(currentRoom, nextRoom),
      );
    });
    socket.on("match:state", (nextMatch) => {
      setMatch(nextMatch);
      setMatchmaking(null);
      if (nextMatch.status === "ACTIVE" || nextMatch.status === "FINISHED")
        setPage("game");
    });
    socket.on("queue:state", (state) => applyMatchmakingState(state));
    socket.on("spectator:state", (nextSpectatorMatch) => {
      setMatchmaking((current) =>
        current?.spectatorMatch?.id === nextSpectatorMatch.id
          ? { ...current, spectatorMatch: nextSpectatorMatch }
          : current,
      );
    });
    subscribeToCurrentRoom();

    return () => {
      socketRef.current = null;
      socket.disconnect();
    };
  }, [session?.token]);

  useEffect(() => {
    roomIdRef.current = room?.id ?? null;
    const socket = socketRef.current;
    if (!socket || !room?.id) return;

    socket.emit("room:subscribe", room.id);
    return () => {
      socket.emit("room:unsubscribe", room.id);
    };
  }, [room?.id]);

  useEffect(() => {
    const matchId = matchmaking?.spectatorMatch?.id ?? null;
    spectatorMatchIdRef.current = matchId;
    const socket = socketRef.current;
    if (!socket || !matchId) return;

    socket.emit("spectator:subscribe", matchId);
    return () => {
      socket.emit("spectator:unsubscribe", matchId);
    };
  }, [matchmaking?.spectatorMatch?.id]);

  useEffect(() => {
    return () => {
      if (messageTimer.current) window.clearTimeout(messageTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(async () => {
      try {
        if (page === "play") {
          applyMatchmakingState(await endpoints.matchmakingState());
        } else {
          const active = await endpoints.activeMatch();
          if (active) setMatch(active);
        }
        setWallet(await endpoints.wallet());
      } catch {
        // Realtime is primary; polling is only a quiet safety net.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [session, page]);

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

  useEffect(() => {
    writeManualMarks(manualMarksByMatch);
  }, [manualMarksByMatch]);

  async function boot() {
    try {
      setLoading(true);
      showMessage("");
      const nextSession = await authenticate();
      setSession(nextSession);
      setWallet(nextSession.wallet);
      const active = await endpoints.activeMatch();
      if (active) {
        setMatch(active);
        setPage("game");
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Startup failed", {
        timeoutMs: 6000,
      });
    } finally {
      setLoading(false);
    }
  }

  async function refreshAccount() {
    const [
      nextWallet,
      nextHistory,
      nextTransactions,
      nextWalletRequests,
      nextProfile,
    ] = await Promise.all([
      endpoints.wallet(),
      endpoints.history(),
      endpoints.transactions(),
      endpoints.walletRequests(),
      endpoints.profile(),
    ]);
    setWallet(nextWallet);
    setHistory(nextHistory);
    setTransactions(nextTransactions);
    setWalletRequests(nextWalletRequests);
    setProfile(nextProfile);
  }

  async function openPublicRoom() {
    await runAction(async () => {
      applyMatchmakingState(await endpoints.joinMatchmaking());
    });
  }

  async function joinNextRoom() {
    setWinnerDialog(null);
    setProofDialog(null);
    await runAction(async () => {
      applyMatchmakingState(await endpoints.joinMatchmaking());
      setWallet(await endpoints.wallet());
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
      setMatchmaking(null);
      setPage("home");
      setWallet(await endpoints.wallet());
    }, "Seat released");
  }

  async function startPractice() {
    await runAction(async () => {
      const practice = await endpoints.startPractice();
      setMatch(practice);
      setRoom(null);
      setMatchmaking(null);
      setPage("game");
    });
  }

  async function claimBingo() {
    if (!match) return;
    await runAction(async () => {
      const markedNumbers = autoBingo
        ? undefined
        : validManualMarksForMatch(match, manualMarksByMatch[match.id] ?? []);
      const nextMatch = await endpoints.claimBingo(match.id, markedNumbers);
      setMatch(nextMatch);
      setWallet(await endpoints.wallet());
      await refreshAccount();
    }, "Bingo submitted");
  }

  async function submitAutoBingo(matchId: string) {
    try {
      showMessage("");
      const nextMatch = await endpoints.claimBingo(matchId);
      setMatch(nextMatch);
      setWallet(await endpoints.wallet());
      await refreshAccount();
      haptic("medium");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Auto Bingo failed";
      if (!text.toLowerCase().includes("already finished")) {
        showMessage(text, { timeoutMs: 5000 });
      }
    }
  }

  function changeAutoBingo(enabled: boolean) {
    setAutoBingo(enabled);
    writeAutoBingoPreference(enabled);
    haptic("light");
  }

  function toggleManualMark(value: number) {
    if (!match || autoBingo || !match.calledNumbers.includes(value)) return;

    setManualMarksByMatch((current) => {
      const nextNumbers = new Set(current[match.id] ?? []);
      if (nextNumbers.has(value)) nextNumbers.delete(value);
      else nextNumbers.add(value);

      return {
        ...current,
        [match.id]: [...nextNumbers].sort((a, b) => a - b),
      };
    });
    haptic("light");
  }

  async function exitMatch() {
    if (!match) return;
    await runAction(async () => {
      await endpoints.exitMatch(match.id);
      setMatch(null);
      setMatchmaking(null);
      setPage("home");
      await refreshAccount();
    }, "Match exited");
  }

  async function shareReferral() {
    const link = profile.referralLink;
    if (!link) return;

    await runAction(async () => {
      if (navigator.share) {
        await navigator.share({
          title: "Bingo Core",
          text: "Join me on Bingo Core.",
          url: link,
        });
        return;
      }
      await navigator.clipboard.writeText(link);
    }, "Invite link ready");
  }

  async function submitWalletRequest(
    type: "deposit" | "withdraw",
    amount: number,
    details: string,
    telebirr?: Omit<DepositRequestInput, "amount" | "details">,
  ) {
    await runAction(
      async () => {
        const nextRequest =
          type === "deposit"
            ? await endpoints.requestDeposit({
                amount,
                details,
                transactionCode: telebirr?.transactionCode ?? "",
                transactionTime: telebirr?.transactionTime ?? "",
                receiptUrl: telebirr?.receiptUrl ?? "",
                telebirrMessage: telebirr?.telebirrMessage ?? "",
              })
            : await endpoints.requestWithdraw(amount, details);
        setWalletRequests((current) => [
          nextRequest,
          ...current.filter((item) => item.id !== nextRequest.id),
        ]);
        await refreshAccount();
      },
      `${type === "deposit" ? "Deposit" : "Withdrawal"} request sent`,
    );
  }

  async function cancelPendingWalletRequest(requestId: string) {
    await runAction(async () => {
      const nextRequest = await endpoints.cancelWalletRequest(requestId);
      setWalletRequests((current) =>
        current.map((item) =>
          item.id === nextRequest.id ? nextRequest : item,
        ),
      );
      await refreshAccount();
    }, "Request cancelled");
  }

  async function openProof(matchId: string) {
    await runAction(async () => {
      const [fair, audit] = await Promise.all([
        endpoints.fair(matchId),
        endpoints.audit(matchId),
      ]);
      setProofDialog({ fair, audit });
    });
  }

  async function runAction(action: () => Promise<void>, success?: string) {
    try {
      showMessage("");
      await action();
      haptic("light");
      if (success) showMessage(success);
    } catch (error) {
      haptic("heavy");
      showMessage(error instanceof Error ? error.message : "Action failed", {
        timeoutMs: 5000,
      });
    }
  }

  function applyMatchmakingState(state: MatchmakingStateDto) {
    setMatchmaking(state);
    if (state.mode === "GAME" && state.match) {
      setMatch(state.match);
      setRoom(null);
      setPage("game");
      return;
    }

    if (state.mode === "ROOM" && state.room) {
      setRoom(state.room);
      setMatch(null);
      setPage("play");
      return;
    }

    setRoom(null);
    setMatch(null);
    setPage("play");
  }

  function showMessage(
    nextMessage: string,
    options: { timeoutMs?: number } = {},
  ) {
    if (messageTimer.current) {
      window.clearTimeout(messageTimer.current);
      messageTimer.current = null;
    }

    setMessage(nextMessage);
    if (!nextMessage) return;

    messageTimer.current = window.setTimeout(() => {
      setMessage("");
      messageTimer.current = null;
    }, options.timeoutMs ?? 3000);
  }

  const activeSeat = room?.seats.find((seat) => seat.isMine)?.seatNumber;
  const manualMarkedNumbers = match ? (manualMarksByMatch[match.id] ?? []) : [];

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

      <main className={page === "game" ? "screen game-screen" : "screen"}>
        {loading && <BootScreen />}
        {!loading && message && <div className="notice">{message}</div>}
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
        {!loading && page === "play" && !room && matchmaking && (
          <MatchmakingPage state={matchmaking} onRefresh={openPublicRoom} />
        )}
        {!loading && page === "game" && match && (
          <GamePage
            match={match}
            autoBingo={autoBingo}
            manualMarkedNumbers={manualMarkedNumbers}
            onAutoBingoChange={changeAutoBingo}
            onManualMark={toggleManualMark}
            onBingo={claimBingo}
            onExit={exitMatch}
            onNextRoom={joinNextRoom}
            onProof={() => openProof(match.id)}
          />
        )}
        {!loading && page === "wallet" && (
          <WalletPage
            wallet={wallet}
            transactions={transactions}
            requests={walletRequests}
            onRefresh={refreshAccount}
            onSubmitRequest={submitWalletRequest}
            onCancelRequest={cancelPendingWalletRequest}
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
            onInvite={shareReferral}
          />
        )}
      </main>

      {winnerDialog && (
        <WinnerModal
          match={winnerDialog}
          onClose={() => setWinnerDialog(null)}
          onNextRoom={joinNextRoom}
          onProof={() => openProof(winnerDialog.id)}
        />
      )}

      {proofDialog && (
        <ProofModal
          proof={proofDialog.fair}
          audit={proofDialog.audit}
          onClose={() => setProofDialog(null)}
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

function mergeRoomUpdateForCurrentUser(
  currentRoom: RoomDto | null,
  nextRoom: RoomDto,
): RoomDto | null {
  if (!currentRoom || currentRoom.id !== nextRoom.id) return currentRoom;

  const currentSeat = currentRoom.seats.find((seat) => seat.isMine);
  if (!currentSeat) return nextRoom;

  const stillMine = nextRoom.seats.some(
    (seat) => seat.id === currentSeat.id && seat.userId === currentSeat.userId,
  );
  if (!stillMine) return nextRoom;

  return {
    ...nextRoom,
    seats: nextRoom.seats.map((seat) =>
      seat.id === currentSeat.id
        ? { ...seat, card: currentSeat.card, isMine: true }
        : seat,
    ),
  };
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
  const occupied = new Map(room.seats.map((seat) => [seat.seatNumber, seat]));
  const pot = room.seats.length * room.entryFee;

  return (
    <section className="stack">
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
        <div className="seat-grid" aria-label="Seat grid">
          {Array.from({ length: room.maxSeats }, (_, index) => {
            const seatNumber = index + 1;
            const seat = occupied.get(seatNumber);
            const mine = seat?.isMine;
            return (
              <button
                key={seatNumber}
                className={`seat ${mine ? "mine" : seat ? "taken" : ""}`}
                disabled={Boolean((seat && !mine) || (activeSeat && !mine))}
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

function MatchmakingPage({
  state,
  onRefresh,
}: {
  state: MatchmakingStateDto;
  onRefresh: () => void;
}) {
  const needed = Math.max(0, state.minPlayers - state.queuedCount);

  return (
    <section className="stack">
      <div className="panel queue-panel">
        <div>
          <p className="eyebrow">
            {state.mode === "SPECTATE" ? "Spectating" : "Queue"}
          </p>
          <h2>
            {state.queuePosition
              ? `Queue #${state.queuePosition}`
              : "Finding Match"}
          </h2>
          <p>
            {needed > 0
              ? `${needed} more player${needed === 1 ? "" : "s"} needed to open the next room.`
              : "The next room is being prepared."}
          </p>
        </div>
        <button className="text-action" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      <div className="compact-stats">
        <Metric label="Queued" value={`${state.queuedCount}`} tone="cyan" />
        <Metric label="Minimum" value={`${state.minPlayers}`} tone="green" />
        <Metric label="Room Size" value={`${state.maxSeats}`} tone="gold" />
      </div>

      {state.spectatorMatch ? (
        <SpectatorMatchPanel match={state.spectatorMatch} />
      ) : (
        <div className="empty-state">
          Waiting for more players. Keep this screen open and you will move into
          a room automatically.
        </div>
      )}
    </section>
  );
}

function SpectatorMatchPanel({ match }: { match: SpectatorMatchDto }) {
  const current = match.currentNumber ? formatBall(match.currentNumber) : "...";
  const winnersSummary = match.winners
    .map((winner) => `Seat ${winner.seatNumber}`)
    .join(", ");

  return (
    <div className="panel spectator-panel">
      <div className="spectator-head">
        <div>
          <p className="eyebrow">Live Room {match.roomCode}</p>
          <h2>{match.status === "ACTIVE" ? current : "Finished"}</h2>
        </div>
        <div className="timer-tile">
          <strong>{match.remainingPlayers}</strong>
          <span>Players</span>
        </div>
      </div>

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

      <div className="called-strip spectator-called">
        {match.calledNumbers.slice(-8).map((value) => (
          <span key={value}>{formatBall(value)}</span>
        ))}
      </div>

      {winnersSummary && (
        <div className="result-strip">
          <Crown size={18} />
          <span>Winner: {winnersSummary}</span>
        </div>
      )}

      <div className="spectator-player-list">
        {match.seats.map((seat) => (
          <div
            className={`spectator-player ${seat.status === "FORFEIT" ? "forfeit" : ""}`}
            key={seat.id}
          >
            <div className="spectator-seat-head">
              <strong>Seat {seat.seatNumber}</strong>
              <span>{seat.username ? `@${seat.username}` : "Player"}</span>
            </div>
            <span className="spectator-player-status">
              {seat.status === "FORFEIT" ? "Exited" : "Playing"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GamePage({
  match,
  autoBingo,
  manualMarkedNumbers,
  onAutoBingoChange,
  onManualMark,
  onBingo,
  onExit,
  onNextRoom,
  onProof,
}: {
  match: MatchDto;
  autoBingo: boolean;
  manualMarkedNumbers: number[];
  onAutoBingoChange: (enabled: boolean) => void;
  onManualMark: (value: number) => void;
  onBingo: () => void;
  onExit: () => void;
  onNextRoom: () => void;
  onProof: () => void;
}) {
  const called = useMemo(
    () => new Set(match.calledNumbers),
    [match.calledNumbers],
  );
  const manualMarked = useMemo(
    () => new Set(manualMarkedNumbers.filter((value) => called.has(value))),
    [called, manualMarkedNumbers],
  );
  const manualBingoReady = Boolean(
    match.myCard && hasBingo(match.myCard, manualMarked, [match.pattern]),
  );
  const canClaim = autoBingo || manualBingoReady;
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
              const cellNumber =
                typeof cell.value === "number" ? cell.value : null;
              const calledCell = cellNumber !== null && called.has(cellNumber);
              const marked = autoBingo
                ? isMarked(cell, called)
                : cell.value === "FREE" ||
                  (cellNumber !== null && manualMarked.has(cellNumber));
              const clickable =
                !autoBingo && match.status === "ACTIVE" && calledCell;
              return (
                <button
                  type="button"
                  className={[
                    "card-cell",
                    !autoBingo ? "manual-mode" : "",
                    clickable ? "callable" : "",
                    !autoBingo && cellNumber !== null && !calledCell
                      ? "uncalled"
                      : "",
                    marked ? "marked" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={!clickable}
                  key={`${cell.row}-${cell.col}`}
                  onClick={() => {
                    if (cellNumber !== null) onManualMark(cellNumber);
                  }}
                  aria-pressed={marked}
                  title={
                    !autoBingo && cellNumber !== null
                      ? calledCell
                        ? `Mark ${formatBall(cellNumber)}`
                        : "Waiting for this number"
                      : undefined
                  }
                >
                  {cell.value}
                </button>
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
            <button
              className="text-action center"
              disabled={!canClaim}
              onClick={onBingo}
              title={
                canClaim ? undefined : "Mark a complete bingo before claiming"
              }
            >
              <Crown size={18} />
              {autoBingo ? "Check" : "Bingo"}
            </button>
            <button className="danger-action compact" onClick={onExit}>
              <LogOut size={17} />
              Exit
            </button>
          </div>
        </div>
      ) : (
        <div className="game-controls finished-controls">
          <div className="result-strip">
            <Crown size={18} />
            <span>
              {winnersSummary ? `Winner: ${winnersSummary}` : "Match finished"}
            </span>
          </div>
          <button className="primary-action compact" onClick={onNextRoom}>
            <Play size={17} />
            Next Room
          </button>
          <button className="secondary-action compact" onClick={onProof}>
            <History size={17} />
            Proof
          </button>
        </div>
      )}
    </section>
  );
}

function WalletPage({
  wallet,
  transactions,
  requests,
  onRefresh,
  onSubmitRequest,
  onCancelRequest,
}: {
  wallet: WalletDto;
  transactions: TransactionDto[];
  requests: WalletRequestDto[];
  onRefresh: () => void;
  onSubmitRequest: (
    type: "deposit" | "withdraw",
    amount: number,
    details: string,
    telebirr?: Omit<DepositRequestInput, "amount" | "details">,
  ) => Promise<void>;
  onCancelRequest: (requestId: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [details, setDetails] = useState("");
  const [transactionCode, setTransactionCode] = useState("");
  const [transactionTime, setTransactionTime] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");
  const [telebirrMessage, setTelebirrMessage] = useState("");
  const numericAmount = Number(amount);
  const validAmount = Number.isInteger(numericAmount) && numericAmount > 0;
  const depositReady =
    mode === "withdraw" ||
    telebirrMessage.trim().length >= 20 ||
    (transactionCode.trim().length >= 6 &&
      transactionTime.trim().length >= 6 &&
      receiptUrl.trim().length >= 12);
  const actionLabel = mode === "deposit" ? "Deposit" : "Withdraw";

  useEffect(() => {
    void onRefresh();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validAmount || !depositReady) return;
    await onSubmitRequest(
      mode,
      numericAmount,
      details,
      mode === "deposit"
        ? {
            transactionCode,
            transactionTime,
            receiptUrl,
            telebirrMessage,
          }
        : undefined,
    );
    setAmount("");
    setDetails("");
    setTransactionCode("");
    setTransactionTime("");
    setReceiptUrl("");
    setTelebirrMessage("");
  }

  return (
    <section className="stack">
      <div className="panel wallet-panel">
        <p className="eyebrow">Wallet</p>
        <h1>{wallet.balance} CR</h1>
        <span>{wallet.locked} locked</span>
      </div>

      <form className="panel wallet-request-panel" onSubmit={submit}>
        <div
          className="wallet-mode-tabs"
          role="tablist"
          aria-label="Wallet action"
        >
          <button
            type="button"
            className={mode === "deposit" ? "active" : ""}
            onClick={() => setMode("deposit")}
          >
            <ArrowDownToLine size={17} />
            Deposit
          </button>
          <button
            type="button"
            className={mode === "withdraw" ? "active" : ""}
            onClick={() => setMode("withdraw")}
          >
            <ArrowUpFromLine size={17} />
            Withdraw
          </button>
        </div>

        <label className="field-label">
          <span>Amount</span>
          <input
            inputMode="numeric"
            min="1"
            pattern="[0-9]*"
            placeholder="Credits"
            value={amount}
            onChange={(event) =>
              setAmount(event.currentTarget.value.replace(/\D/g, ""))
            }
          />
        </label>
        <label className="field-label">
          <span>
            {mode === "deposit" ? "Payment proof or note" : "Payout details"}
          </span>
          <textarea
            maxLength={500}
            placeholder={
              mode === "deposit"
                ? "Transaction ID, sender name, or support note"
                : "Wallet address, bank note, or support instruction"
            }
            value={details}
            onChange={(event) => setDetails(event.currentTarget.value)}
          />
        </label>

        {mode === "deposit" && (
          <div className="telebirr-fields">
            <label className="field-label">
              <span>Full Telebirr message</span>
              <textarea
                maxLength={3000}
                placeholder="Paste the full Telebirr SMS after you pay"
                value={telebirrMessage}
                onChange={(event) =>
                  setTelebirrMessage(event.currentTarget.value)
                }
              />
            </label>
            <label className="field-label">
              <span>Telebirr transaction code</span>
              <input
                autoCapitalize="characters"
                placeholder="BHV3BNI9ON"
                value={transactionCode}
                onChange={(event) =>
                  setTransactionCode(
                    event.currentTarget.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, ""),
                  )
                }
              />
            </label>
            <label className="field-label">
              <span>Transaction time</span>
              <input
                placeholder="2026-05-10 20:42"
                value={transactionTime}
                onChange={(event) =>
                  setTransactionTime(event.currentTarget.value)
                }
              />
            </label>
            <label className="field-label">
              <span>Receipt validation URL</span>
              <input
                inputMode="url"
                placeholder="https://transactioninfo.ethiotelecom.et/receipt/..."
                value={receiptUrl}
                onChange={(event) => setReceiptUrl(event.currentTarget.value)}
              />
            </label>
          </div>
        )}

        <button
          className="primary-action"
          disabled={!validAmount || !depositReady}
        >
          {mode === "deposit" ? (
            <ArrowDownToLine size={18} />
          ) : (
            <ArrowUpFromLine size={18} />
          )}
          Request {actionLabel}
        </button>
      </form>

      <h2 className="section-title">Requests</h2>
      <ListEmpty items={requests} text="No wallet requests yet." />
      {requests.map((request) => (
        <div className="list-row wallet-request-row" key={request.id}>
          <div>
            <strong>{formatWalletRequestType(request.type)}</strong>
            <small>
              {request.transactionCode
                ? `${request.transactionCode} · ${formatShortDate(request.createdAt)}`
                : formatShortDate(request.createdAt)}
            </small>
            {request.validationReason && (
              <small>{request.validationReason}</small>
            )}
          </div>
          <div className="wallet-request-side">
            <span>{request.amount} CR</span>
            <b className={`request-status ${request.status.toLowerCase()}`}>
              {request.status}
            </b>
            {request.status === "PENDING" && (
              <button
                className="tiny-action"
                type="button"
                onClick={() => onCancelRequest(request.id)}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      ))}

      <h2 className="section-title">Transactions</h2>
      <ListEmpty items={transactions} text="No transactions yet." />
      {transactions.map((txn) => (
        <div className="list-row" key={txn.id}>
          <div>
            <strong>{txn.type.replaceAll("_", " ")}</strong>
            {txn.description && <small>{txn.description}</small>}
          </div>
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
    <section className="stack">
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
  onInvite,
}: {
  profile: ProfileState;
  wallet: WalletDto;
  onRefresh: () => void;
  onInvite: () => void;
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
      <div className="invite-panel">
        <div>
          <span>Invite Code</span>
          <strong>{profile.referralCode ?? "Pending"}</strong>
        </div>
        <div>
          <span>Invited</span>
          <strong>{profile.referralCount}</strong>
        </div>
        <div>
          <span>Bonus</span>
          <strong>{profile.referralRewards} CR</strong>
        </div>
        <button
          className="primary-action compact"
          disabled={!profile.referralLink}
          onClick={onInvite}
        >
          <Share2 size={17} />
          Invite
        </button>
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
  onNextRoom,
  onProof,
}: {
  match: MatchDto;
  onClose: () => void;
  onNextRoom: () => void;
  onProof: () => void;
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
        <div className="modal-actions">
          <button className="primary-action" onClick={onNextRoom}>
            <Play size={18} />
            Next Room
          </button>
          <button className="secondary-action" onClick={onClose}>
            Close
          </button>
          <button className="secondary-action" onClick={onProof}>
            <History size={17} />
            Proof
          </button>
        </div>
      </div>
    </div>
  );
}

function ProofModal({
  proof,
  audit,
  onClose,
}: {
  proof: FairProofDto;
  audit: AuditEntryDto[];
  onClose: () => void;
}) {
  const winnerSeats = proof.winnerSeats?.length
    ? proof.winnerSeats
    : proof.winnerSeat
      ? [proof.winnerSeat]
      : [];

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="proof-title"
    >
      <div className="proof-modal">
        <p className="eyebrow">Fair Proof</p>
        <h2 id="proof-title">Audit Trail</h2>
        <div className="proof-grid">
          <ProofItem label="Seed Hash" value={proof.seedHash} />
          <ProofItem
            label="Seed Reveal"
            value={proof.seedReveal ?? "Pending"}
          />
          <ProofItem label="Called" value={`${proof.calledNumbers.length}`} />
          <ProofItem
            label="Winners"
            value={
              winnerSeats.length
                ? winnerSeats.map((seat) => `Seat ${seat}`).join(", ")
                : "None"
            }
          />
        </div>
        <div className="audit-list">
          {audit.slice(-10).map((item) => (
            <div className="audit-row" key={item.id}>
              <strong>{item.action.replaceAll("_", " ")}</strong>
              <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
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

function ProofItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
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

function formatWalletRequestType(type: WalletRequestDto["type"]): string {
  return type === "DEPOSIT" ? "Deposit" : "Withdraw";
}

function formatShortDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

function readManualMarks(): ManualMarksByMatch {
  try {
    const raw = localStorage.getItem(MANUAL_MARKS_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([matchId, values]) => {
        if (!Array.isArray(values)) return [];
        const numbers = sanitizeManualMarks(values);
        return numbers.length > 0 ? [[matchId, numbers]] : [];
      }),
    );
  } catch {
    return {};
  }
}

function writeManualMarks(marks: ManualMarksByMatch): void {
  try {
    localStorage.setItem(MANUAL_MARKS_KEY, JSON.stringify(marks));
  } catch {
    // Local storage can be unavailable in strict embedded browser modes.
  }
}

function sanitizeManualMarks(values: unknown[]): number[] {
  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 1 &&
          value <= BINGO_MAX_BALL,
      ),
    ),
  ].sort((a, b) => a - b);
}

function validManualMarksForMatch(match: MatchDto, values: number[]): number[] {
  const called = new Set(match.calledNumbers);
  return sanitizeManualMarks(values).filter((value) => called.has(value));
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
