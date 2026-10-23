"use client";

import { useEffect, useId, useState } from "react";
import { Search, X } from "lucide-react";

import type { GeocodeResult } from "@/lib/geocode";

const DEBOUNCE_MS = 350;

/** Splits "Eiffel Tower, Paris, France" into a bold head and a muted tail. */
function splitName(displayName: string) {
  const [head, ...rest] = displayName.split(",");
  return { head: head.trim(), tail: rest.join(",").trim() };
}

export default function PlaceSearch({
  onSelect,
}: {
  onSelect: (place: GeocodeResult) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  // Tracked separately from `query`: picking a suggestion rewrites the input
  // without re-running the search for the text we just filled in.
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (term.length < 2) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Search failed");
        setResults(body.results);
        setError(body.results.length ? null : "No matches");
        setActive(0);
        setOpen(true);
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setResults([]);
        setError(e instanceof Error ? e.message : "Search failed");
        // The list is where the error is shown; without this a failed search
        // looks exactly like one that is still loading.
        setOpen(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [term]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setTerm(value.trim());
    if (value.trim().length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      setOpen(false);
    }
  };

  const choose = (place: GeocodeResult) => {
    setQuery(splitName(place.name).head);
    setOpen(false);
    setResults([]);
    setError(null);
    onSelect(place);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    }
  };

  return (
    <div className="w-80">
      <div className="flex items-center gap-2 rounded-md bg-black/60 px-3 py-2 backdrop-blur ring-1 focus-within:ring-white/30">
        <Search className="size-4 shrink-0 text-zinc-400" aria-hidden />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length && setOpen(true)}
          placeholder="Search for a place…"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className="w-full bg-transparent text-sm outline-none text-zinc-100 placeholder:text-zinc-100"
        />
        {loading && (
          <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />
        )}
        {!loading && query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange("")}
            className="shrink-0 text-zinc-500 hover:text-zinc-200"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {open && (results.length > 0 || error) && (
        <ul
          id={listId}
          role="listbox"
          className="mt-1 max-h-80 overflow-y-auto rounded-md bg-black/75 py-1 backdrop-blur ring-1 ring-white/10"
        >
          {error && !results.length && (
            <li className="px-3 py-2 text-xs text-zinc-400">{error}</li>
          )}
          {results.map((place, i) => {
            const { head, tail } = splitName(place.name);
            return (
              <li key={place.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  // mousedown, not click: the input's blur would otherwise
                  // close the list before the click landed.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(place);
                  }}
                  className={`block w-full px-3 py-1.5 text-left ${i === active ? "bg-white/10" : ""
                    }`}
                >
                  <span className="block truncate text-sm text-zinc-100">{head}</span>
                  {tail && (
                    <span className="block truncate text-xs text-zinc-400">{tail}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
