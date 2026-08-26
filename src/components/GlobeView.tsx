"use client";

import dynamic from "next/dynamic";

// Cesium touches `window` and WebGL at import time, so it must never be prerendered.
const CesiumGlobe = dynamic(() => import("./CesiumGlobe"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center bg-black text-sm text-zinc-400">
      Loading globe…
    </div>
  ),
});

export default function GlobeView() {
  return <CesiumGlobe />;
}
