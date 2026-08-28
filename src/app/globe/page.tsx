import GlobeView from "@/components/GlobeView";

export default function GlobePage() {
  // The original explorer globe — place search, map stacks, buildings, splats.
  // The watch console took over `/`; this keeps the exploratory UI reachable.
  return (
    <main className="h-dvh w-full">
      <GlobeView />
    </main>
  );
}
