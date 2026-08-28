"use client";

import { useCallback, useRef } from "react";

import type { Alert } from "@/lib/watch/types";

export const WINDOW_MS = 6 * 60 * 60 * 1000;
export const SPEEDS = [1, 4, 60] as const;

function pad(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

type Props = {
  /** Milliseconds behind live. 0 is live. */
  offsetMs: number;
  onOffset: (offsetMs: number) => void;
  /** Playback rate while scrubbed back; null means live. */
  speed: number | null;
  onSpeed: (speed: number | null) => void;
  /** When the console started recording — everything before it is unbuffered. */
  since: number;
  alerts: Alert[];
  now: number;
};

export default function Timeline({
  offsetMs, onOffset, speed, onSpeed, since, alerts, now,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  const live = offsetMs < 30_000;
  const headPct = 100 - (offsetMs / WINDOW_MS) * 100;
  // Everything left of this had already happened when the console opened, so
  // there are no frames for it. Hatched rather than hidden: the scrubber should
  // show the shape of what it does not have.
  const noHistoryPct = Math.max(0, Math.min(100, ((now - since) / WINDOW_MS) * 100));

  const setFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      onOffset(((100 - pct) / 100) * WINDOW_MS);
    },
    [onOffset],
  );

  const minutes = Math.round(offsetMs / 60_000);

  return (
    <div className="wtl">
      <div className="lbl">T−06:00</div>

      <div
        ref={trackRef}
        className="wtrack"
        onPointerDown={(e) => {
          scrubbing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSpeed(null);
          setFromEvent(e.clientX);
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) setFromEvent(e.clientX);
        }}
        onPointerUp={() => {
          scrubbing.current = false;
        }}
      >
        <div className="axis" />
        <div
          className="nohist"
          style={{ width: `${100 - noHistoryPct}%` }}
          title="No recorded history — the console began buffering when it opened"
        />

        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="tick" style={{ left: `${(i / 6) * 100}%` }}>
            <i>{i === 6 ? "NOW" : `−${6 - i}h`}</i>
          </div>
        ))}

        {alerts.map((alert) => {
          const pct = 100 - ((now - alert.raisedAt) / WINDOW_MS) * 100;
          if (pct < 0 || pct > 100) return null;
          return (
            <div
              key={alert.id}
              className={`ev${alert.sev === 1 ? " b" : ""}`}
              style={{ left: `${pct}%` }}
              title={`${alert.rule} — ${alert.title}`}
            />
          );
        })}

        <div className="head" style={{ left: `${headPct}%` }} />
      </div>

      <div className="now">
        {live
          ? "LIVE · T−00:00"
          : now - offsetMs < since
            ? `NO HISTORY · T−${pad(minutes / 60)}:${pad(minutes % 60)}`
            : `REPLAY · T−${pad(minutes / 60)}:${pad(minutes % 60)}`}
      </div>

      <div className="sp">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={speed === s && !live ? "on" : undefined}
            onClick={() => {
              // Playback only means something with somewhere to play to.
              if (live) onOffset(Math.min(WINDOW_MS, now - since));
              onSpeed(s);
            }}
          >
            {s}×
          </button>
        ))}
        <button
          type="button"
          className={live ? "on" : undefined}
          onClick={() => {
            onSpeed(null);
            onOffset(0);
          }}
        >
          LIVE
        </button>
      </div>
    </div>
  );
}
