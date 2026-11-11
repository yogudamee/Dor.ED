import { LoopCurveSegment2D, Point2D, Primitive3D, ViewType } from '../types/cad';
import {
  arcSweepCCW,
  dist2,
  evalCurvedRegion2DSDF,
  evalPrimitive3DSDF,
  normAngle,
  pointToLineSegDist,
  polygonSignedArea,
  projectPoint3DToView as kernelProject3DToView,
  sampleLoopSegmentsToDensePolygon,
} from '../kernel';

export function dist2D(a: Point2D, b: Point2D): number {
  return dist2(a, b);
}

export function normalizeAngle(rad: number): number {
  return normAngle(rad);
}

export function isAngleOnArc(
  a: number,
  start: number,
  end: number,
  tol = 0.001
): boolean {
  const span = arcSweepCCW(start, end);
  const rel = normAngle(normAngle(a) - normAngle(start));
  return rel <= span + tol || rel >= Math.PI * 2 - tol;
}

export function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D) {
  return pointToLineSegDist(p, a, b);
}

export function polygonArea2D(poly: Point2D[]): number {
  return Math.abs(polygonSignedArea(poly));
}

export function pointInPolygon2D(pt: Point2D, poly: Point2D[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].u;
    const yi = poly[i].v;
    const xj = poly[j].u;
    const yj = poly[j].v;
    const intersect =
      yi > pt.v !== yj > pt.v &&
      pt.u < ((xj - xi) * (pt.v - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function sampleArcPoints(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw = true,
  circleSubdivs = 48
): Point2D[] {
  const sweep = arcSweepCCW(startAngle, endAngle);
  const steps = Math.max(6, Math.ceil((sweep / (Math.PI * 2)) * circleSubdivs));
  const pts: Point2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const frac = ccw ? i / steps : (steps - i) / steps;
    const ang = startAngle + frac * sweep;
    pts.push({
      u: center.u + radius * Math.cos(ang),
      v: center.v + radius * Math.sin(ang),
    });
  }
  return pts;
}

export function chainSegmentsIntoDensePolygon(
  segments: LoopCurveSegment2D[],
  fallbackPoly: Point2D[] = [],
  circleSubdivs = 48
): Point2D[] {
  if (!segments || segments.length === 0) return fallbackPoly;
  return sampleLoopSegmentsToDensePolygon(segments, circleSubdivs);
}

export function curvedLoopSignedDist2D(
  pt: Point2D,
  poly: Point2D[],
  segments: LoopCurveSegment2D[] = []
): number {
  return evalCurvedRegion2DSDF(pt, segments, poly);
}

export function evalPrimitiveSDF(
  p: { x: number; y: number; z: number } | [number, number, number],
  prim: Primitive3D
): number {
  const vec = Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p;
  return evalPrimitive3DSDF(vec, prim);
}

export function projectPoint3DToView(
  p: { x: number; y: number; z: number } | [number, number, number],
  view: ViewType
): Point2D {
  const vec = Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p;
  const q = kernelProject3DToView(vec, view);
  return { u: q.u, v: q.v };
}
