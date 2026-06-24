import * as React from "react";

interface KeyboardShortcutsProps {
  onAnswer: () => void;
  onToggleHold: () => void;
  onToggleMute: () => void;
  onEnd: () => void;
  onHandoff: () => void;
  onNav: (idx: number) => void;
  onHelp: () => void;
}

export function useKeyboardShortcuts({
  onAnswer,
  onToggleHold,
  onToggleMute,
  onEnd,
  onHandoff,
  onNav,
  onHelp
}: KeyboardShortcutsProps) {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Avoid hijacking typing in inputs.
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (!e.ctrlKey && !e.metaKey) {
        if (!inEditable && e.key === "?") {
          e.preventDefault();
          onHelp();
        }
        return;
      }

      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "h") {
        e.preventDefault();
        onHandoff();
        return;
      }
      if (e.shiftKey) return;

      switch (k) {
        case "a":
          e.preventDefault();
          onAnswer();
          break;
        case "h":
          e.preventDefault();
          onToggleHold();
          break;
        case "m":
          e.preventDefault();
          onToggleMute();
          break;
        case "e":
          e.preventDefault();
          onEnd();
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
          e.preventDefault();
          onNav(parseInt(k, 10));
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onAnswer, onToggleHold, onToggleMute, onEnd, onHandoff, onNav, onHelp]);
}
