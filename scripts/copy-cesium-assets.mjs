// Cesium loads its Workers, Assets, Widgets and ThirdParty files at runtime over
// HTTP rather than through the bundler, so they have to sit under `public/` and be
// pointed at via `window.CESIUM_BASE_URL`. This mirrors them into `public/cesium`.
import { cp, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cesiumBuild = join(dirname(require.resolve("cesium/package.json")), "Build", "Cesium");
const target = join(process.cwd(), "public", "cesium");

const DIRS = ["Assets", "ThirdParty", "Widgets", "Workers"];

const upToDate = await access(join(target, "Workers")).then(
  () => true,
  () => false,
);
if (upToDate && process.argv.includes("--if-missing")) {
  process.exit(0);
}

await rm(target, { recursive: true, force: true });
for (const dir of DIRS) {
  await cp(join(cesiumBuild, dir), join(target, dir), { recursive: true });
}
console.log(`Copied Cesium runtime assets -> public/cesium`);
