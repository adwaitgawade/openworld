/** Great-circle helpers shared by the alert rules and the client overlays. */

const R_EARTH_NM = 3440.065;
const RAD = Math.PI / 180;

/** Great-circle distance in nautical miles. */
export function distanceNm(
  aLon: number, aLat: number, bLon: number, bLat: number,
): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Angular separation in degrees — the unit the coverage-gap circles use. */
export function separationDeg(
  aLon: number, aLat: number, bLon: number, bLat: number,
): number {
  return (distanceNm(aLon, aLat, bLon, bLat) / R_EARTH_NM) / RAD;
}

/** Point `nm` nautical miles from (lon, lat) along `bearingDeg`. */
export function destinationNm(
  lon: number, lat: number, bearingDeg: number, nm: number,
): [number, number] {
  const d = nm / R_EARTH_NM;
  if (!(d > 0)) return [lon, lat];
  const brg = bearingDeg * RAD;
  const lat1 = lat * RAD;
  const lon1 = lon * RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [((lon2 / RAD + 540) % 360) - 180, lat2 / RAD];
}

/**
 * Dead-reckons a position forward from its last fix. Live feeds report every
 * few seconds at best; without this the globe advances in visible jumps.
 */
export function project(
  lon: number, lat: number, headingDeg: number, speedKt: number, seconds: number,
): [number, number] {
  return destinationNm(lon, lat, headingDeg, (speedKt * seconds) / 3600);
}

/** A geodesic circle of `radiusDeg` arc degrees, as lon/lat pairs. */
export function circlePoints(
  lon: number, lat: number, radiusDeg: number, steps = 96,
): [number, number][] {
  const nm = radiusDeg * 60;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) out.push(destinationNm(lon, lat, (i / steps) * 360, nm));
  return out;
}
