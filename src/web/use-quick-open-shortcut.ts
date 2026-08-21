import { useEffect, useRef } from "react";

export function useQuickOpenShortcut(onOpen: () => void): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const openQuickOpen = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "p"
      ) {
        return;
      }
      event.preventDefault();
      onOpenRef.current();
    };
    document.addEventListener("keydown", openQuickOpen);
    return () => document.removeEventListener("keydown", openQuickOpen);
  }, []);
}
