export type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: {
    start_param?: string;
  };
  colorScheme?: "light" | "dark";
  viewportHeight?: number;
  viewportStableHeight?: number;
  ready: () => void;
  expand: () => void;
  close: () => void;
  onEvent?: (
    event: "viewportChanged",
    handler: (payload?: { isStateStable?: boolean }) => void,
  ) => void;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
  };
};

let viewportListenerAttached = false;

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export function getTelegramApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

export function prepareTelegramShell(): void {
  const app = getTelegramApp();
  app?.ready();
  app?.expand();
  syncViewportHeight(app);

  if (viewportListenerAttached) return;

  const sync = () => syncViewportHeight(getTelegramApp());
  app?.onEvent?.("viewportChanged", sync);
  window.addEventListener("resize", sync);
  viewportListenerAttached = true;
}

export function getInitData(): string {
  return getTelegramApp()?.initData ?? "";
}

export function getReferralCode(): string | undefined {
  const urlParams = new URLSearchParams(window.location.search);
  return (
    urlParams.get("ref") ??
    urlParams.get("startapp") ??
    getTelegramApp()?.initDataUnsafe?.start_param ??
    new URLSearchParams(getInitData()).get("start_param") ??
    undefined
  );
}

export function haptic(type: "light" | "medium" | "heavy" = "light"): void {
  getTelegramApp()?.HapticFeedback?.impactOccurred(type);
}

function syncViewportHeight(app?: TelegramWebApp): void {
  const height =
    app?.viewportHeight ?? app?.viewportStableHeight ?? window.innerHeight;
  if (!Number.isFinite(height) || height <= 0) return;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}
