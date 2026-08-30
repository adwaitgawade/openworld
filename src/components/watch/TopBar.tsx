"use client";

import { useEffect, useState } from "react";

import type { FeedHealth } from "@/lib/watch/types";

export type ViewId = "live" | "replay" | "coverage";

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "live", label: "LIVE" },
  { id: "replay", label: "REPLAY" },
  { id: "coverage", label: "COVERAGE" },
];

function Dot({ status }: { status: FeedHealth["status"] }) {
  return (
    <span className={`wdot${status === "degraded" ? " w" : status === "down" ? " b" : ""}`} />
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function Clock() {
  const [utc, setUtc] = useState<string>("--:--:--");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setUtc(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="wclock">
      <b>{utc}</b>
      <i>UTC</i>
    </div>
  );
}

type Props = {
  view: ViewId;
  onView: (view: ViewId) => void;
  air: FeedHealth | null;
  sea: FeedHealth | null;
  airCount: number;
  seaCount: number;
  onOpenPalette: () => void;
};

export default function TopBar({
  view, onView, air, sea, airCount, seaCount, onOpenPalette,
}: Props) {
  const latency = air?.latencySec ?? sea?.latencySec ?? null;
  const worst: FeedHealth["status"] =
    air?.status === "down" || sea?.status === "down"
      ? "down"
      : air?.status === "degraded" || sea?.status === "degraded"
        ? "degraded"
        : "ok";

  return (
    <div className="wtop">
      <div className="wbrand">
        <span className="mk" />
        <b>MERIDIAN</b>
        <span>/ WATCH</span>
      </div>

      <div className="wtabs">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`wtab${view === v.id ? " on" : ""}`}
            onClick={() => onView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <button type="button" className="wsearch" onClick={onOpenPalette}>
        <span>Search tracks, callsigns, hulls</span>
        <span className="wkbd" style={{ marginLeft: "auto" }}>⌘K</span>
      </button>

      <div className="wspacer" />

      <div className="whealth">
        <div className="whp" title={air?.note ?? undefined}>
          <i>{`ADS-B · ${(air?.source ?? "—").toUpperCase()}`}</i>
          <b>
            <Dot status={air?.status ?? "down"} />
            {airCount.toLocaleString("en-US")}
          </b>
        </div>
        <div className="whp" title={sea?.note ?? undefined}>
          <i>AIS</i>
          <b>
            <Dot status={sea?.status ?? "down"} />
            {sea?.status === "down" && seaCount === 0
              ? "NO KEY"
              : seaCount.toLocaleString("en-US")}
          </b>
        </div>
        <div className="whp">
          <i>FIX AGE</i>
          <b>
            <Dot status={worst} />
            {latency == null ? "—" : `${latency}s`}
          </b>
        </div>
      </div>

      <Clock />
    </div>
  );
}
