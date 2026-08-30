/**
 * Fixed geography the console draws regardless of what the live feeds say:
 * the chokepoint labels, the circles nothing reports from, and the anchor
 * points the keyless ADS-B adapter fans out over.
 */

import type { CoverageGap } from "./types";

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
