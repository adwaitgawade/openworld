/**
 * Fixed geography the console draws regardless of what the live feeds say:
 * the sensor sites, the chokepoint labels, and the anchor points the keyless
 * ADS-B adapter fans out over.
 *
 * The sensor sites are notional — there is no camera network behind them — so
 * the UI labels the bank as a simulation. Their placement follows the maritime
 * chokepoints the live AIS traffic actually funnels through, which is what
 * makes the correlation between a sensor and a nearby track meaningful.
 */

import type { CoverageGap, Sensor } from "./types";

export const SENSORS: Sensor[] = [
  { id: "CAM-01", place: "Gibraltar Strait", lon: -5.4, lat: 35.95, brg: 118 },
  { id: "CAM-07", place: "Malacca Narrows", lon: 100.4, lat: 3.5, brg: 302 },
  { id: "CAM-12", place: "Suez S. Approach", lon: 32.6, lat: 29.9, brg: 15 },
  { id: "CAM-19", place: "Bab el Mandeb", lon: 43.4, lat: 12.6, brg: 244, offline: true },
  { id: "CAM-23", place: "Hormuz Inbound", lon: 56.4, lat: 26.6, brg: 71 },
  { id: "CAM-31", place: "Lagos Anchorage", lon: 3.4, lat: 6.4, brg: 190 },
  { id: "CAM-38", place: "Dover TSS", lon: 1.4, lat: 51.1, brg: 40 },
  { id: "CAM-44", place: "Panama Pacific", lon: -79.5, lat: 8.9, brg: 330 },
];

/** Unmanned sites: drawn on the globe, no camera feed in the bank. */
export const SENSOR_SITES: [number, number][] = [
  [129.0, 34.3], [121.0, 24.5], [18.4, -34.2], [106.0, -6.1], [9.9, 54.4],
  [28.9, 41.1], [142.0, 45.0], [-70.0, -53.0], [55.3, 25.2], [-5.0, 49.5],
  [103.9, 1.2], [36.8, -1.3], [-43.2, -23.0], [151.2, -33.9], [-118.2, 33.7],
  [13.4, 45.5],
];

export const COVERAGE_GAPS: CoverageGap[] = [
  { id: "GAP-PAC-C", lon: -140, lat: 8, radiusDeg: 22 },
  { id: "GAP-ATL-S", lon: -25, lat: -40, radiusDeg: 26 },
  { id: "GAP-IND-S", lon: 78, lat: -30, radiusDeg: 24 },
  { id: "GAP-PAC-SW", lon: 175, lat: -12, radiusDeg: 20 },
  { id: "GAP-LAB", lon: -55, lat: 62, radiusDeg: 18 },
];

export const PLACES: { name: string; lon: number; lat: number }[] = [
  { name: "GIBRALTAR", lon: -5.4, lat: 35.95 },
  { name: "SUEZ", lon: 32.6, lat: 29.9 },
  { name: "HORMUZ", lon: 56.4, lat: 26.6 },
  { name: "MALACCA", lon: 100.4, lat: 3.5 },
  { name: "PANAMA", lon: -79.5, lat: 8.9 },
  { name: "DOVER", lon: 1.4, lat: 51.1 },
  { name: "BAB EL MANDEB", lon: 43.4, lat: 12.6 },
  { name: "TAIWAN STR.", lon: 120.5, lat: 24.5 },
  { name: "CAPE", lon: 18.4, lat: -34.2 },
];

/**
 * Anchor points for the keyless ADS-B fan-out. Each query is capped at a 250nm
 * radius by the provider, so global-ish coverage means querying a spread of
 * busy airspace and merging the results. These are the world's densest hubs;
 * the gaps between them are real and the console says so rather than implying
 * uniform coverage.
 */
export const AIR_ANCHORS: { code: string; lon: number; lat: number }[] = [
  { code: "LHR", lon: -0.46, lat: 51.47 },
  { code: "FRA", lon: 8.57, lat: 50.03 },
  { code: "IST", lon: 28.81, lat: 40.98 },
  { code: "DXB", lon: 55.36, lat: 25.25 },
  { code: "DEL", lon: 77.1, lat: 28.56 },
  { code: "SIN", lon: 103.99, lat: 1.36 },
  { code: "HKG", lon: 113.91, lat: 22.31 },
  { code: "PEK", lon: 116.6, lat: 40.08 },
  { code: "HND", lon: 139.78, lat: 35.55 },
  { code: "SYD", lon: 151.18, lat: -33.94 },
  { code: "LAX", lon: -118.4, lat: 33.94 },
  { code: "ORD", lon: -87.9, lat: 41.98 },
  { code: "JFK", lon: -73.78, lat: 40.64 },
  { code: "ATL", lon: -84.43, lat: 33.64 },
  { code: "MEX", lon: -99.07, lat: 19.44 },
  { code: "GRU", lon: -46.47, lat: -23.43 },
  { code: "EZE", lon: -58.53, lat: -34.82 },
  { code: "JNB", lon: 28.24, lat: -26.13 },
  { code: "NBO", lon: 36.93, lat: -1.32 },
  { code: "MAD", lon: -3.57, lat: 40.47 },
];
