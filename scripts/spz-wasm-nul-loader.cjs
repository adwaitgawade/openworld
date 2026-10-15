// @spz-loader/core (pulled in by Cesium for SPZ-compressed Gaussian splats) inlines
// its wasm binary as an Emscripten "binary string" template literal, writing a NUL
// byte that precedes a digit as `\x00` (e.g. `\x006`). Turbopack's minifier
// shortens every `\x00` to `\0` without looking at the next character, emitting
// `\06` — an octal escape, which is a SyntaxError inside a template literal. The
// whole chunk holding Cesium then fails to parse and the globe never mounts.
//
// Emscripten decodes each char with `~c >> 8 & c` into a Uint8Array, so U+0100
// lands on byte 0 just like NUL does. Re-spelling those NULs as `Ā` keeps the
// decoded bytes identical while leaving the minifier nothing to mangle.
module.exports = function spzWasmNulLoader(source) {
  return source.replace(/\\x00(?=[0-9])/g, "\\u0100");
};
