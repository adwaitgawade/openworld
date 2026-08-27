"use client";

import { SSE_RANGE } from "@/lib/splatTilesets";

export type SplatStatus = "idle" | "loading" | "loaded" | "error";

export default function SplatControls({
  status,
  error,
  shown,
  splatsInView,
  noTilesSelected,
  sse,
  onLoad,
  onToggleShown,
  onSseChange,
  onFlyTo,
}: {
  status: SplatStatus;
  error: string | null;
  shown: boolean;
  splatsInView: number;
  noTilesSelected: boolean;
  sse: number;
  onLoad: () => void;
  onToggleShown: () => void;
  onSseChange: (value: number) => void;
  onFlyTo: () => void;
}) {
  return (
    <div className="w-64 rounded-md bg-black/55 p-3 text-xs text-zinc-300 backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-200">Gaussian splats</span>
        {status === "loaded" && (
          <button
            type="button"
            onClick={onToggleShown}
            className="rounded px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/10"
          >
            {shown ? "Hide" : "Show"}
          </button>
        )}
      </div>

      {status === "idle" && (
        <button
          type="button"
          onClick={onLoad}
          className="mt-2 w-full rounded bg-white/90 px-2 py-1 text-[11px] font-medium text-black hover:bg-white"
        >
          Load splat tileset
        </button>
      )}

      {status === "loading" && <p className="mt-2 text-zinc-400">Loading…</p>}

      {status === "error" && (
        <p className="mt-2 text-red-400">{error ?? "Failed to load"}</p>
      )}

      {status === "loaded" && (
        <>
          <div className="mt-3 flex items-baseline justify-between">
            <label htmlFor="splat-sse" className="text-zinc-400">
              Detail
            </label>
            {/* Screen-space error is inverted for the reader: low error = high detail. */}
            <span className="tabular-nums text-zinc-500">{sse} px SSE</span>
          </div>
          <input
            id="splat-sse"
            type="range"
            min={SSE_RANGE.min}
            max={SSE_RANGE.max}
            step={1}
            // Flipped so dragging right means "more detail".
            value={SSE_RANGE.min + SSE_RANGE.max - sse}
            onChange={(e) =>
              onSseChange(SSE_RANGE.min + SSE_RANGE.max - Number(e.target.value))
            }
            className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-600 accent-white"
          />

          <p className="mt-2 tabular-nums text-zinc-400">
            {splatsInView.toLocaleString()} splats in view
          </p>

          {noTilesSelected && (
            /* Cesium skips a tileset entirely once the root tile's screen-space
               error drops below maximumScreenSpaceError — at coarse detail a
               small capture stops being traversed and the last frame's splats
               stay on screen. Say so rather than leaving a stale picture. */
            <p className="mt-1 text-[11px] leading-snug text-zinc-500">
              No tiles selected at this detail. Raise detail or move closer.
            </p>
          )}

          <button
            type="button"
            onClick={onFlyTo}
            className="mt-2 w-full rounded px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10"
          >
            Fly to tileset
          </button>
        </>
      )}
    </div>
  );
}
