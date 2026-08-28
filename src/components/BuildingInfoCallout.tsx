"use client";

import { useState } from "react";

import { formatCoords, type BuildingInfo } from "@/lib/buildingInfo";
import type { BuildingDetails, DetailRow } from "@/lib/buildingDetails";

/** Half the card's width (`w-80`), used to keep it inside the viewport. */
const HALF_WIDTH = 160;
/** Length of the leader line between the anchor and the card's near edge. */
const LEADER = 24;
/** Breathing room kept between the card and the edge of the viewport. */
const MARGIN = 16;
/** A card shorter than this is not worth showing; it scrolls instead. */
const MIN_HEIGHT = 180;

function Rows({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-[11px] text-zinc-500">{row.label}</dt>
          <dd className="text-[11px] text-zinc-200">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 border-t border-white/10 pt-2">
      <h3 className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The info card that sits over a clicked building.
 *
 * Position comes from the globe as window coordinates recomputed each frame, so
 * this is a plain absolutely-positioned div — it stays pinned to the building
 * while the camera moves. It floats above the click point with a short leader
 * line down to it, which is what makes it read as belonging to that building
 * rather than to the screen, and flips below when the building is near the top
 * of the viewport.
 *
 * The tile's own properties render immediately; `details` arrives later from
 * the network and expands the card in place rather than blocking it.
 *
 * The globe keys this on the selection, so picking a new building remounts it
 * and the disclosure state below starts fresh rather than carrying over.
 */
export default function BuildingInfoCallout({
  info,
  details,
  detailsError,
  x,
  y,
  onClose,
}: {
  info: BuildingInfo;
  details: BuildingDetails | null;
  detailsError: string | null;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [showFullExtract, setShowFullExtract] = useState(false);
  const [copied, setCopied] = useState(false);

  const coords = formatCoords(info.coords.lat, info.coords.lon);
  const copyCoords = async () => {
    try {
      await navigator.clipboard.writeText(`${info.coords.lat}, ${info.coords.lon}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the coordinates are on screen anyway.
    }
  };

  // The card is content-sized and can be tall, so it goes on whichever side of
  // the anchor has more room and is capped to that room — otherwise a building
  // low on the screen pushes the card's header off the top edge. Horizontally
  // it is clamped to the viewport while the leader line stays on the building.
  const viewport =
    typeof window === "undefined"
      ? { width: 1280, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight };
  const spaceAbove = y - LEADER - MARGIN;
  const spaceBelow = viewport.height - y - LEADER - MARGIN;
  const below = spaceBelow > spaceAbove;
  const maxHeight = Math.max(MIN_HEIGHT, below ? spaceBelow : spaceAbove);
  const clampedX = Math.min(
    Math.max(x, HALF_WIDTH + MARGIN),
    viewport.width - HALF_WIDTH - MARGIN,
  );

  // Wikidata repeats some of what the tags already gave us; the tag wins
  // because it describes this exact footprint rather than the wider entity.
  const tagLabels = new Set(info.rows.map((row) => row.label));
  const facts = (details?.facts ?? []).filter((fact) => !tagLabels.has(fact.label));
  const wiki = details?.wiki;
  const loading = !details && !detailsError;

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-20"
      style={{ transform: `translate3d(${x}px, ${y}px, 0)` }}
    >
      {/* Leader line from the card to the picked point on the building. */}
      <div
        className={`absolute -left-px h-6 w-px bg-white/40 ${below ? "top-0" : "bottom-0"}`}
      />
      <div className="absolute -left-[3px] -top-[3px] h-1.5 w-1.5 rounded-full bg-white/80" />

      <div
        className={`pointer-events-auto absolute w-80 overflow-y-auto rounded-lg bg-black/80 p-3 text-xs text-zinc-300 shadow-xl ring-1 ring-white/10 backdrop-blur ${
          below ? "top-6" : "bottom-6"
        }`}
        style={{ left: clampedX - x, maxHeight, transform: "translateX(-50%)" }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium leading-snug text-zinc-100">{info.title}</p>
            {(wiki?.description ?? info.subtitle) && (
              <p className="text-[11px] leading-snug text-zinc-400">
                {wiki?.description ?? info.subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close building info"
            className="-mr-1 -mt-1 shrink-0 rounded px-1.5 py-0.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          >
            ×
          </button>
        </div>

        {(info.rows.length > 0 || facts.length > 0) && (
          <div className="mt-2">
            <Rows rows={[...info.rows, ...facts]} />
          </div>
        )}

        <Section title="Address">
          {details?.addressLine ? (
            <>
              <p className="mb-1.5 text-[11px] leading-snug text-zinc-200">
                {details.addressLine}
              </p>
              <Rows rows={details.addressRows} />
            </>
          ) : (
            <p className="text-[11px] text-zinc-500">
              {loading
                ? "Looking up address…"
                : (detailsError ?? "No address on record for this footprint.")}
            </p>
          )}

          <div className="mt-2 flex items-baseline gap-2">
            <span className="w-[5.5rem] shrink-0 text-[11px] text-zinc-500">
              Coordinates
            </span>
            <span className="text-[11px] tabular-nums text-zinc-200">{coords}</span>
            <button
              type="button"
              onClick={copyCoords}
              className="text-[10px] text-zinc-500 transition-colors hover:text-zinc-200"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </Section>

        {wiki && (
          <Section title={wiki.nearby ? "Nearby on Wikipedia" : "About"}>
            {wiki.nearby && (
              <p className="mb-1.5 text-[10px] leading-snug text-amber-300/80">
                Found by proximity — this article may describe a neighbouring
                building{wiki.title ? `: ${wiki.title}` : ""}.
              </p>
            )}
            <p
              className={`text-[11px] leading-relaxed text-zinc-300 ${
                showFullExtract ? "" : "line-clamp-4"
              }`}
            >
              {wiki.extract}
            </p>
            <div className="mt-1.5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowFullExtract((v) => !v)}
                className="text-[11px] text-zinc-400 transition-colors hover:text-zinc-100"
              >
                {showFullExtract ? "Show less" : "Read more"}
              </button>
              <a
                href={wiki.url}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-zinc-400 transition-colors hover:text-zinc-100"
              >
                Wikipedia ↗
              </a>
            </div>
          </Section>
        )}

        {details?.partial && (
          <p className="mt-2 text-[10px] text-zinc-500">
            Some sources did not respond; showing what was available.
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-white/10 pt-2 text-[11px]">
          {info.raw.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="text-zinc-400 transition-colors hover:text-zinc-100"
            >
              {showRaw ? "Hide" : "All"} tags ({info.raw.length})
            </button>
          )}
          {info.osmUrl && (
            <a
              href={info.osmUrl}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-400 transition-colors hover:text-zinc-100"
            >
              OSM ↗
            </a>
          )}
          {info.wikidataUrl && (
            <a
              href={info.wikidataUrl}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-400 transition-colors hover:text-zinc-100"
            >
              Wikidata ↗
            </a>
          )}
        </div>

        {showRaw && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {info.raw.map((row) => (
              <div key={row.label} className="contents">
                <dt className="truncate text-[10px] text-zinc-500" title={row.label}>
                  {row.label}
                </dt>
                <dd className="break-words text-[10px] text-zinc-300">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
