"use client";

import {
  BUILDINGS_NOTE,
  BUILDING_STYLES,
  type BuildingStyleId,
} from "@/lib/buildings";

export type BuildingsStatus = "idle" | "loading" | "loaded" | "error";

export default function BuildingsControls({
  status,
  error,
  shown,
  style,
  onToggle,
  onStyleChange,
}: {
  status: BuildingsStatus;
  error: string | null;
  shown: boolean;
  style: BuildingStyleId;
  onToggle: () => void;
  onStyleChange: (id: BuildingStyleId) => void;
}) {
  return (
    <div className="w-64 rounded-md bg-black/55 p-3 text-xs text-zinc-300 backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-200">3D buildings</span>
        <button
          type="button"
          onClick={onToggle}
          disabled={status === "loading"}
          className={`rounded px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:text-zinc-600 ${
            shown && status === "loaded"
              ? "bg-white/90 text-black hover:bg-white"
              : "text-zinc-300 hover:bg-white/10"
          }`}
        >
          {status === "loading" ? "Loading…" : shown && status === "loaded" ? "On" : "Off"}
        </button>
      </div>

      {status === "error" && (
        <p className="mt-2 text-red-400">{error ?? "Failed to load"}</p>
      )}

      {status === "loaded" && shown && (
        <>
          <div className="mt-3 flex gap-1">
            {BUILDING_STYLES.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.note}
                onClick={() => onStyleChange(preset.id)}
                className={`flex-1 rounded px-1.5 py-1 text-[11px] transition-colors ${
                  style === preset.id
                    ? "bg-white/90 text-black"
                    : "text-zinc-300 hover:bg-white/10"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <p className="mt-2 text-[11px] leading-snug text-zinc-500">
            {BUILDINGS_NOTE}
          </p>
        </>
      )}
    </div>
  );
}
