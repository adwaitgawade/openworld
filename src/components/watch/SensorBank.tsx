"use client";

import { useEffect, useRef } from "react";

import { SENSORS } from "@/lib/watch/stations";
import type { Sensor } from "@/lib/watch/types";

/**
 * The camera strip.
 *
 * There is no camera network behind this console, so the frames are drawn
 * procedurally — the renderer is ported from the design and produces an EO/IR
 * -style plate with a bearing ruler, reticle, detection boxes, scan lines and
 * grain. Every frame is marked SIM for that reason.
 *
 * The one honest number on each tile is the bottom-left count: how many live
 * tracks are currently inside the sensor's stated range, computed from the same
 * feed the globe is drawing.
 */

const ACCENT = "#4FD1E0";
/** Per-site variation so six tiles do not render as six copies. */
const PHASE = 1.37;

type Frame = {
  sensor: Sensor;
  detections: number;
  phase: number;
  confidences: number[];
};

function pad(n: number, width: number): string {
  return String(Math.round(n)).padStart(width, "0");
}

function drawFrame(canvas: HTMLCanvasElement, frame: Frame, t: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const ground = g.createLinearGradient(0, 0, 0, h);
  ground.addColorStop(0, "#0a0f10");
  ground.addColorStop(0.62, "#070a0a");
  ground.addColorStop(1, "#0c0d0b");
  g.fillStyle = ground;
  g.fillRect(0, 0, w, h);

  const horizon = h * (0.54 + (frame.phase % 3) * 0.018);
  g.strokeStyle = "rgba(158,198,198,.30)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, horizon);
  g.lineTo(w, horizon);
  g.stroke();
  g.strokeStyle = "rgba(158,198,198,.12)";
  for (let i = 1; i <= 3; i++) {
    g.beginPath();
    g.moveTo(0, horizon + i * i * 9);
    g.lineTo(w, horizon + i * i * 9);
    g.stroke();
  }

  // Bearing ruler across the horizon.
  g.font = "8px ui-monospace, monospace";
  g.textAlign = "center";
  for (let i = 0; i < 9; i++) {
    const x = ((i + 0.5) * w) / 9;
    const deg = (frame.sensor.brg + (i - 4) * 4 + 360) % 360;
    g.strokeStyle = "rgba(158,198,198,.34)";
    g.beginPath();
    g.moveTo(x, horizon - 4);
    g.lineTo(x, horizon + 4);
    g.stroke();
    if (i % 2 === 0) {
      g.fillStyle = "rgba(170,206,206,.52)";
      g.fillText(pad(deg, 3), x, horizon + 14);
    }
  }

  g.strokeStyle = "rgba(158,198,198,.32)";
  g.beginPath();
  g.moveTo(w / 2 - 9, horizon);
  g.lineTo(w / 2 + 9, horizon);
  g.moveTo(w / 2, horizon - 9);
  g.lineTo(w / 2, horizon + 9);
  g.stroke();

  g.strokeStyle = "rgba(190,220,220,.3)";
  const corners: [number, number, number, number][] = [
    [6, 6, 1, 1],
    [w - 6, 6, -1, 1],
    [6, h - 6, 1, -1],
    [w - 6, h - 6, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    g.beginPath();
    g.moveTo(x, y + 11 * sy);
    g.lineTo(x, y);
    g.lineTo(x + 11 * sx, y);
    g.stroke();
  }

  for (let i = 0; i < frame.detections; i++) {
    const ph = t * 0.00007 * (i + 1) + i * 2.3 + frame.phase;
    const bw = 34 + i * 22 + Math.sin(ph) * 6;
    const bh = bw * 0.42;
    const bx = w * (0.13 + 0.4 * i + (frame.phase % 1) * 0.14) + Math.sin(ph * 0.7) * w * 0.07;
    const by = horizon - bh + 4 + Math.sin(ph * 1.3) * 3;
    g.strokeStyle = i === 0 ? ACCENT : "rgba(198,226,226,.62)";
    g.lineWidth = 1.2;
    g.strokeRect(Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh));
    g.fillStyle = i === 0 ? ACCENT : "rgba(200,228,228,.72)";
    g.font = "8px ui-monospace, monospace";
    g.textAlign = "left";
    const confidence = frame.confidences[i] ?? 0.6;
    g.fillText(`${i === 0 ? "HULL " : "OBJ "}${confidence.toFixed(2)}`, bx, by - 3);
    g.fillRect(bx, by + bh + 2, bw * confidence, 1.5);
  }

  const band = ((t * 0.045) % (h + 60)) - 30;
  const sweep = g.createLinearGradient(0, band - 18, 0, band + 18);
  sweep.addColorStop(0, "rgba(255,255,255,0)");
  sweep.addColorStop(0.5, "rgba(190,220,220,.045)");
  sweep.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = sweep;
  g.fillRect(0, band - 18, w, 36);

  g.fillStyle = "rgba(0,0,0,.30)";
  for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);

  g.fillStyle = "rgba(200,230,230,.05)";
  for (let i = 0; i < 90; i++) {
    g.fillRect(((i * 7919 + t * 0.3) % w) | 0, ((i * 104729 + t * 0.7) % h) | 0, 1, 1);
  }

  const vignette = g.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.95);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.55)");
  g.fillStyle = vignette;
  g.fillRect(0, 0, w, h);
}

const FRAMES: Frame[] = SENSORS.slice(0, 6).map((sensor, i) => ({
  sensor,
  detections: 1 + ((i + 1) % 3),
  phase: i * PHASE,
  confidences: [0.94 - i * 0.06, 0.61 + i * 0.05, 0.44 + i * 0.09],
}));

type Props = {
  selectedId: string | null;
  onSelect: (sensor: Sensor) => void;
  /** Live tracks currently within range of each sensor, keyed by sensor id. */
  inRange: Record<string, number>;
  utc: string;
};

export default function SensorBank({ selectedId, onSelect, inRange, utc }: Props) {
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // ~13fps: enough for the scan band to read as motion, cheap enough to
      // leave the globe's frame budget alone.
      if (now - last < 78) return;
      last = now;
      FRAMES.forEach((frame, i) => {
        const canvas = canvasRefs.current[i];
        if (canvas && !frame.sensor.offline) drawFrame(canvas, frame, now);
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="wcams">
      <div className="wcsh">
        <span>SENSOR BANK · SIM</span>
      </div>
      <div className="wcamrow">
        {FRAMES.map((frame, i) => {
          const { sensor } = frame;
          const count = inRange[sensor.id] ?? 0;
          return (
            <button
              key={sensor.id}
              type="button"
              className={`wcam${selectedId === sensor.id ? " sel" : ""}`}
              onClick={() => onSelect(sensor)}
            >
              <canvas
                ref={(node) => {
                  canvasRefs.current[i] = node;
                }}
              />
              <div className="wtop1">
                <b>{sensor.id}</b>
                <span>{sensor.place}</span>
                <em>{sensor.offline ? "OFFLINE" : "SIM"}</em>
              </div>
              <div className="wbot1">
                <span>BRG {pad(sensor.brg, 3)}</span>
                <span>
                  {sensor.offline ? "—" : `${count} IN RANGE`}
                </span>
                <em>{utc}Z</em>
              </div>
              {sensor.offline && <div className="lost">SIGNAL LOST</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
