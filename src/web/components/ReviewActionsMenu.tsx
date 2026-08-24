import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ThemePreference } from "../theme.js";

const themeOptions: { preference: ThemePreference; label: string }[] = [
  { preference: "light", label: "ライトモード" },
  { preference: "dark", label: "ダークモード" },
  { preference: "system", label: "システム" },
];

function MoreActionsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <circle cx="3" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="13" cy="8" r="1.35" fill="currentColor" />
    </svg>
  );
}

export function ReviewActionsMenu({
  themePreference,
  themePending,
  syncPending,
  resetPending,
  agentNotificationStatus,
  resetLabel = "ローカル状態を削除して再構築",
  onOpenQuickOpen,
  onSync,
  onThemeChange,
  onToggleAgentNotifications,
  onReset,
}: {
  themePreference: ThemePreference;
  themePending: boolean;
  syncPending: boolean;
  resetPending: boolean;
  agentNotificationStatus?: "active" | "inactive" | "denied" | "unsupported";
  resetLabel?: string;
  onOpenQuickOpen: (returnFocusElement: HTMLElement | null) => void;
  onSync: () => void;
  onThemeChange: (preference: ThemePreference) => void;
  onToggleAgentNotifications?: () => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ),
    ];
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };
  return (
    <div className="topbar-menu" ref={menuRef}>
      <button
        ref={buttonRef}
        className="topbar-menu-toggle"
        aria-label="その他の操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreActionsIcon />
      </button>
      {open && (
        <div className="topbar-menu-popover" role="menu" onKeyDown={handleKeyDown}>
          <button
            role="menuitem"
            className="topbar-menu-command"
            onClick={() => {
              setOpen(false);
              onOpenQuickOpen(buttonRef.current);
            }}
          >
            <span>ファイルを開く…</span>
            <kbd>⌘ / Ctrl P</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSync();
            }}
            disabled={syncPending}
          >
            GitHubと同期
          </button>
          {onToggleAgentNotifications && agentNotificationStatus && (
            <div className="topbar-menu-section" role="group" aria-label="通知">
              <span className="topbar-menu-section-label">通知</span>
              <button
                role="menuitemcheckbox"
                aria-checked={agentNotificationStatus === "active"}
                onClick={() => {
                  setOpen(false);
                  onToggleAgentNotifications();
                }}
              >
                <span>Agentのコメントを通知</span>
                <span className="topbar-menu-check" aria-hidden="true">
                  {agentNotificationStatus === "active"
                    ? "✓"
                    : agentNotificationStatus === "denied"
                      ? "拒否"
                      : agentNotificationStatus === "unsupported"
                        ? "未対応"
                        : ""}
                </span>
              </button>
            </div>
          )}
          <div className="topbar-menu-section" role="group" aria-label="UIテーマ">
            <span className="topbar-menu-section-label">UIテーマ</span>
            {themeOptions.map((option) => (
              <button
                key={option.preference}
                role="menuitemradio"
                aria-checked={themePreference === option.preference}
                disabled={themePending}
                onClick={() => {
                  onThemeChange(option.preference);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                <span className="topbar-menu-check" aria-hidden="true">
                  {themePreference === option.preference ? "✓" : ""}
                </span>
              </button>
            ))}
          </div>
          <button
            className="topbar-menu-danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReset();
            }}
            disabled={resetPending}
          >
            {resetLabel}
          </button>
        </div>
      )}
    </div>
  );
}
