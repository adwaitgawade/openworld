// Cesium renders glTF, not OBJ, so the aircraft mesh in `src/assets` is converted
// once into a binary glTF under `public/models` where the browser can fetch it.
// Same shape as copy-cesium-assets.mjs: idempotent, `--if-missing` for `next dev`.
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
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

// The OBJ names a `3d-model.mtl` that was never shipped with it, and the material
// names it references are 3ds Max viewport colours rather than a livery. So the
// mesh is converted untextured and tinted per track kind at render time.
const gltf = await obj2gltf(source, {
  binary: true,
  checkTransparency: false,
  secure: true,
});

await mkdir(dirname(target), { recursive: true });
await writeFile(target, gltf);
console.log(`Converted Boeing-787-9.obj -> public/models/boeing-787-9.glb`);
