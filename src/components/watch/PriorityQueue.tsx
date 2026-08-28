"use client";

import type { Alert } from "@/lib/watch/types";

export const ALERT_FILTERS = [
  "ALL",
  "DARK VESSEL",
  "EMERGENCY SQUAWK",
  "LOITER",
  "RENDEZVOUS",
  "SENSOR",
  "COVERAGE GAP",
] as const;

export type AlertFilter = (typeof ALERT_FILTERS)[number];

/** "04:12" style age, which is what a watch floor reads at a glance. */
function age(raisedAt: number, now: number): string {
  const mins = Math.max(0, Math.round((now - raisedAt) / 60_000));
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

type Props = {
  alerts: Alert[];
  filter: AlertFilter;
  onFilter: (filter: AlertFilter) => void;
  selectedId: string | null;
  onSelect: (alert: Alert) => void;
  now: number;
};

export default function PriorityQueue({
  alerts, filter, onFilter, selectedId, onSelect, now,
}: Props) {
  const shown = filter === "ALL" ? alerts : alerts.filter((a) => a.rule === filter);
  const p1 = alerts.filter((a) => a.sev === 1).length;

  return (
    <div className="wrail">
      <div className="wph">
        <h3>Priority queue</h3>
        <em>{`${alerts.length} OPEN · ${p1} P1`}</em>
      </div>

      <div className="wchips">
        {ALERT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`wchip${filter === f ? " on" : ""}`}
            onClick={() => onFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="wscroll" style={{ flex: 1, minHeight: 0 }}>
        {shown.length === 0 && (
          <div className="wempty">
            No alert matches this filter.
            <br />
            The queue is derived from the live feeds — when nothing is squawking,
            dark or stopped in a chokepoint, it is genuinely empty.
          </div>
        )}

        {shown.map((alert) => (
          <button
            key={alert.id}
            type="button"
            className={`wal${selectedId === alert.id ? " sel" : ""}`}
            data-sev={alert.sev}
            onClick={() => onSelect(alert)}
          >
            <div className="sev" />
            <div className="bd">
              <div className="r1">
                <span className="rule">{alert.rule}</span>
                <span className="age">{age(alert.raisedAt, now)}</span>
              </div>
              <div className="ttl">{alert.title}</div>
              <div className="sub">{alert.sub}</div>
              <div className="meta">
                {alert.meta.map((m) => (
                  <span key={m}>{m}</span>
                ))}
                <span style={{ marginLeft: "auto" }}>
                  {alert.sev === 1 ? <b>P1</b> : alert.sev === 2 ? "P2" : "P3"}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
