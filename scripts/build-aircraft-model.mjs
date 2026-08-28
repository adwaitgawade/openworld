// Cesium renders glTF, not OBJ, so the aircraft mesh in `src/assets` is converted
// once into a binary glTF under `public/models` where the browser can fetch it.
// Same shape as copy-cesium-assets.mjs: idempotent, `--if-missing` for `next dev`.
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import obj2gltf from "obj2gltf";

const source = join(process.cwd(), "src", "assets", "Boeing-787-9.obj");
const target = join(process.cwd(), "public", "models", "boeing-787-9.glb");

const exists = await access(target).then(
  () => true,
  () => false,
);
if (exists && process.argv.includes("--if-missing")) {
  process.exit(0);
}

/*
 * The OBJ is exported as 230 named groups, each with its own `usemtl`, and
 * obj2gltf faithfully turns that into 230 meshes — 230 draw calls for one
 * aircraft. The console draws a poolful of these at once, which took the tab
 * from "busy" to "unresponsive" the moment enough of them came into view.
 *
 * None of that structure is worth keeping: the `3d-model.mtl` it names was
 * never shipped alongside it, and the material names it references are 3ds Max
 * viewport colours rather than a livery, so every group renders identically and
 * the airframe is tinted per track state at render time anyway.
 *
 * So the grouping directives are stripped before conversion and the whole hull
 * comes out as a single mesh with one material — one draw call per aircraft.
 */
const MERGED = /^(g|o|s|usemtl|mtllib)\s/;
const flattened = (await readFile(source, "utf8"))
  .split("\n")
  .filter((line) => !MERGED.test(line))
  .join("\n");

const staging = join(tmpdir(), `openworld-aircraft-${process.pid}.obj`);
await writeFile(staging, flattened);

try {
  const gltf = await obj2gltf(staging, {
    binary: true,
    checkTransparency: false,
    secure: true,
  });

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, gltf);
  console.log(`Converted Boeing-787-9.obj -> public/models/boeing-787-9.glb`);
} finally {
  await rm(staging, { force: true });
}
