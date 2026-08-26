import GlobeView from "@/components/GlobeView";

export default function Home() {
  // h-dvh gives the globe a definite height to resolve `h-full` against. A
  // percentage chain off `body.min-h-full` leaves it short of the viewport.
  return (
    <main className="h-dvh w-full">
      <GlobeView />
    </main>
  );
}
