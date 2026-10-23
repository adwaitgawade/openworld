"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type Command = {
  /** Left-hand tag: JUMP, LAYER, VIEW, ACTION. */
  scope: string;
  label: string;
  keys?: string;
  run: () => void;
};

type Props = {
  onClose: () => void;
  /** Called with the current query so track search can match live data. */
  commands: (query: string) => Command[];
  /**
   * Reports the query as it is typed, for results that have to be fetched —
   * an airport code is resolved over the network, so it cannot come back from
   * the synchronous `commands` call.
   */
  onQuery?: (query: string) => void;
  /** A fetched result for the current query is still on its way. */
  searching?: boolean;
};

/**
 * Mounted only while open, so each opening starts with an empty query and the
 * cursor at the top without an effect having to reset anything.
 */
export default function CommandPalette({ onClose, commands, onQuery, searching }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => commands(query), [commands, query]);
  const active = Math.min(cursor, Math.max(0, items.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (index: number) => {
    const command = items[index];
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div
      className="wpal"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="wpalbox">
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Run a command, or jump to a track, airport or place…"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
            // Reported from the event rather than an effect: the parent turns
            // this into a fetch, and an effect would make that a render cascade.
            onQuery?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => (items.length ? (c + 1) % items.length : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => (items.length ? (c - 1 + items.length) % items.length : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(active);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />

        <div className="wpalist" ref={listRef}>
          {items.length === 0 ? (
            <div className="wempty">{searching ? "Searching places…" : "No command matches."}</div>
          ) : (
            items.map((command, i) => (
              <button
                key={`${command.scope}:${command.label}`}
                type="button"
                className={`wpi${i === active ? " on" : ""}`}
                onPointerEnter={() => setCursor(i)}
                onClick={() => run(i)}
              >
                <span className="sc">{command.scope}</span>
                <span className="lb">{command.label}</span>
                <span className="ks">{command.keys ?? ""}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
