"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}

/** Right-hand modal panel. Escape or the backdrop closes it; focus returns to where it was. */
export function Drawer({ open, onClose, label, children }: DrawerProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 animate-fade-in bg-[#05080b]/60" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 grid w-full max-w-[640px] animate-slide-in content-start gap-5 overflow-y-auto border-l border-line bg-panel px-7 pb-8 pt-[calc(24px+env(safe-area-inset-top,0px))] outline-none scrollbar-thin"
      >
        {children}
      </aside>
    </div>,
    document.body,
  );
}
