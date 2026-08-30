"use client";

import dynamic from "next/dynamic";

/**
 * The console is client-only, for the same reason `GlobeView` is: there is
 * nothing it can usefully render on the server.
 *
 * Its whole surface is a function of a clock and a live feed — the timeline's
 * unbuffered region, alert ages, the selection's fix age. Every one of those
 * reads a mount-time `Date.now()`, which the server and the browser answer
 * differently, so prerendering it produced HTML that could not match hydration
 * (React reported the timeline's `nohist` width, and the ages drifted a second
 * later). Above that sits Cesium, which touches `window` and WebGL at import
 * time and is excluded from SSR anyway.
 *
 * So the page is rendered in the browser and nowhere else, and the clock reads
 * are safe by construction rather than by being individually gated.
 */
const WatchConsole = dynamic(() => import("./WatchConsole"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: "100dvh",
        display: "grid",
        placeItems: "center",
        background: "#0b0a09",
        color: "#5c5a52",
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontSize: 11,
        letterSpacing: "0.16em",
      }}
    >
      MERIDIAN · BRINGING THE WATCH FLOOR UP
    </div>
  ),
});

export default function WatchConsoleView() {
  return <WatchConsole />;
}
