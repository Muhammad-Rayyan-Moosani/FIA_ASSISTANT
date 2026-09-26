"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "@/assets/icons";

interface PopoverProps {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-controls": string }) => ReactNode;
  title: ReactNode;
  accent?: string;
  children: ReactNode;
}

const GAP = 8;
const MARGIN = 12;

/** Click-to-open floating panel. Closes on outside click, Escape, or scroll; returns focus to the trigger. */
export function Popover({ trigger, title, accent, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback(() => {
    setOpen(false);
    anchorRef.current?.querySelector("button")?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !panelRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = panelRef.current;
    const left = Math.min(window.innerWidth - w - MARGIN, Math.max(MARGIN, r.left + r.width / 2 - w / 2));
    const below = r.bottom + GAP;
    const top = below + h > window.innerHeight - MARGIN ? Math.max(MARGIN, r.top - h - GAP) : below;
    setPos({ top, left });
    panelRef.current.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onScroll = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        {trigger({
          onClick: () => {
            setPos(null);
            setOpen((o) => !o);
          },
          "aria-expanded": open,
          "aria-controls": id,
        })}
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-modal="false"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, borderTopColor: accent }}
            className="fixed z-50 max-h-[min(72vh,560px)] w-[min(380px,calc(100vw-24px))] animate-fade-in overflow-y-auto rounded-xl border border-t-[3px] border-line bg-panel-2 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.55)] scrollbar-thin"
          >
            <div className="flex items-start gap-2">
              <div className="flex-1">{title}</div>
              <button type="button" data-autofocus onClick={close} aria-label="Close" className="-m-1 rounded p-1 text-muted hover:text-ink">
                <IconClose />
              </button>
            </div>
            <div className="mt-2">{children}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
