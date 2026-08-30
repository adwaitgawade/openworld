/**
 * Major sea-lane reference geometry, carried over from the design.
 *
 * These are drawn as static reference lines, not as data: they are approximate
 * centrelines of the world's busiest commercial routes, there to give the AIS
 * returns somewhere to sit. The LANES layer toggle is off by default on a
 * feed-driven console for exactly that reason.
 */

export type Lane = { name: string; points: [number, number][] };

export const LANES: Lane[] = [
  { name: "ASIA-EUROPE", points: [[121.5, 31.2], [120.5, 24.5], [114.5, 20.5], [108, 12], [104.5, 5], [103.8, 1.3], [100.4, 3.5], [96, 6.5], [85, 7], [79.9, 6.9], [72, 8], [60, 10], [52, 12], [45, 12.5], [43.4, 12.6], [38.5, 19.5], [35, 25.5], [32.6, 29.9], [32.3, 31.4], [28, 33.5], [24, 34.5], [14.5, 35.8], [5, 37], [-5.4, 35.95], [-9.8, 38.7], [-9.5, 43.5], [-6.5, 46.5], [-4, 48.5], [-1.5, 50], [2, 51.2], [4.4, 51.9]] },
  { name: "TRANSPACIFIC N", points: [[121.5, 31.2], [128, 33], [140, 34.5], [155, 38], [170, 41], [-175, 44], [-160, 45], [-145, 44], [-130, 40], [-122, 35], [-118.25, 33.7]] },
  { name: "TRANSATLANTIC N", points: [[-74, 40.7], [-68, 41.5], [-60, 42.5], [-48, 45], [-35, 47], [-22, 48.5], [-12, 49.5], [-5, 49.8], [0.5, 50.4], [4.4, 51.9]] },
  { name: "GULF-EAST ASIA", points: [[56.4, 26.6], [58, 24.5], [62, 22], [67, 17], [72, 12], [76, 8], [79.9, 6.9], [87, 6], [94, 5.5], [99.5, 4.2], [103.8, 1.3], [106, 4], [110, 8], [114, 15], [114.2, 22.2]] },
  { name: "S.AMERICA-EUROPE", points: [[-46.3, -24], [-40, -25], [-32, -18], [-27, -8], [-24, 2], [-21, 12], [-18, 22], [-14, 28], [-10, 33], [-5.4, 35.95]] },
  { name: "CAPE ROUTE W", points: [[31, -29.9], [26, -34], [20, -35], [16, -33], [11, -25], [6, -14], [3.5, -4], [3.4, 4], [3.4, 6.4]] },
  { name: "AUS-SE ASIA", points: [[151.2, -33.9], [153.5, -27], [153, -19], [147, -12], [138, -9], [128, -8], [118, -6], [112, -4], [106, -3], [104.6, -1.2], [103.8, 1.3]] },
  { name: "N.AMERICA-ASIA S", points: [[-123.1, 49.3], [-130, 48], [-145, 49], [-165, 50], [-178, 47], [165, 42], [150, 38], [140, 35.5]] },
  { name: "PANAMA-ASIA", points: [[-79.5, 9], [-85, 8], [-95, 10], [-110, 14], [-125, 17], [-145, 20], [-165, 22], [-178, 24], [160, 25], [140, 28], [128, 31], [121.5, 31.2]] },
  { name: "BALTIC-UK", points: [[9.97, 53.55], [7, 54.3], [4, 54], [1.5, 53], [1.4, 51.4], [-1.5, 50.2], [-5, 49.5], [-9.5, 45], [-9.8, 38.7]] },
  { name: "RED SE-INDIA", points: [[43.4, 12.6], [48, 11], [54, 10], [62, 9], [68, 10], [72.87, 19.1]] },
  { name: "W.AFRICA-US GULF", points: [[3.4, 6.4], [-2, 4], [-10, 3], [-20, 6], [-30, 10], [-45, 15], [-60, 19], [-75, 22], [-85, 25], [-92, 27]] },
];

/**
 * Cesium's PolylineCollection draws straight chords between the positions it is
 * given, so a 15° leg cuts under the surface and the lane reads as a series of
 * disconnected stubs. Subdividing each leg along its great circle keeps the line
 * lying on the globe, and the extra vertices cost nothing at this scale.
 */
export function densifyLane(points: [number, number][], stepDeg = 1.5): [number, number][] {
  const rad = Math.PI / 180;
  const out: [number, number][] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const [lon1, lat1] = points[i];
    const [lon2, lat2] = points[i + 1];
    // Positions end up as 3D cartesians, so the slerp takes the short way round
    // the antimeridian without any longitude bookkeeping.
    const a = toVector(lon1, lat1);
    const b = toVector(lon2, lat2);
    const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const omega = Math.acos(dot);
    const steps = Math.max(1, Math.ceil((omega / rad) / stepDeg));

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      if (omega < 1e-9) {
        out.push([lon1, lat1]);
        continue;
      }
      const w1 = Math.sin((1 - t) * omega) / Math.sin(omega);
      const w2 = Math.sin(t * omega) / Math.sin(omega);
      const x = a[0] * w1 + b[0] * w2;
      const y = a[1] * w1 + b[1] * w2;
      const z = a[2] * w1 + b[2] * w2;
      out.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad]);
    }
  }

  out.push(points[points.length - 1]);
  return out;
}

function toVector(lon: number, lat: number): [number, number, number] {
  const rad = Math.PI / 180;
  const cl = Math.cos(lat * rad);
  return [cl * Math.cos(lon * rad), cl * Math.sin(lon * rad), Math.sin(lat * rad)];
}
