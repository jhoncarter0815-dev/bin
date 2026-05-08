export type TelegramWebApp = {
  initData: string;
  colorScheme?: "light" | "dark";
  ready: () => void;
  expand: () => void;
  close: () => void;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
  };
};

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
}

export function getInitData(): string {
  return getTelegramApp()?.initData ?? "";
}

export function haptic(type: "light" | "medium" | "heavy" = "light"): void {
  getTelegramApp()?.HapticFeedback?.impactOccurred(type);
}

