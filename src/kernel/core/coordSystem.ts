import { LoopCurveSegment2D, Point2D, ViewType } from '../../types/cad';
import { Axis3D, BoundingBox2D, BoundingBox3D, Vec3 } from './types';

export const TWO_PI = Math.PI * 2;
export const EPS_COORD = 1e-6;

/**
 * Normalize radian angle into [0, 2π)
 */
export function normAngle(rad: number): number {
  const r = ((rad % TWO_PI) + TWO_PI) % TWO_PI;
  return r >= TWO_PI - 1e-12 ? 0 : r;
}

/**
 * Positive +dθ sweep from startAngle to endAngle in (u, v) world coordinates.
 * Per Dor.ED Invariant 二.2: CadArcEntity ALWAYS sweeps from startAngle along +dθ to endAngle.
 */
export function arcSweepCCW(startAngle: number, endAngle: number): number {
  const s = normAngle(startAngle);
  const e = normAngle(endAngle);
  let diff = e - s;
  if (diff <= 1e-7) diff += TWO_PI;
  return diff;
}

/**
 * Test if angle `theta` lies on the +dθ sweep from `startAngle` to `endAngle`.
 */
export function isAngleInSweep(
  theta: number,
  startAngle: number,
  endAngle: number,
  tol = 1e-4
): boolean {
  const sweep = arcSweepCCW(startAngle, endAngle);
  if (sweep >= TWO_PI - 1e-5) return true;
  const rel = normAngle(normAngle(theta) - normAngle(startAngle));
  return rel <= sweep + tol || rel >= TWO_PI - tol;
}

/**
 * Sample a CadArcEntity / LoopCurveSegment2D strictly along +dθ (or reverse if ccw=false for oriented boundary traversal,
 * while keeping exact +dθ arc locus!). Never flips concave/convex polarity!
 */
export function sampleArcDTheta(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number,
  traverseForward = true,
  circleSegments = 64
): Point2D[] {
  const sweep = arcSweepCCW(startAngle, endAngle);
  const steps = Math.max(6, Math.ceil((sweep / TWO_PI) * circleSegments));
  const pts: Point2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = traverseForward ? i / steps : (steps - i) / steps;
    const ang = startAngle + t * sweep;
    pts.push({
      u: center.u + radius * Math.cos(ang),
      v: center.v + radius * Math.sin(ang),
    });
  }
  return pts;
}

export function dist2(a: Point2D, b: Point2D): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale3(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function len3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function pointToLineSegDist(
  p: Point2D,
  a: Point2D,
  b: Point2D
): { dist: number; proj: Point2D; t: number } {
  const dx = b.u - a.u;
  const dy = b.v - a.v;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) {
    return { dist: dist2(p, a), proj: { u: a.u, v: a.v }, t: 0 };
  }
  const tRaw = ((p.u - a.u) * dx + (p.v - a.v) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const proj = { u: a.u + t * dx, v: a.v + t * dy };
  return { dist: dist2(p, proj), proj, t };
}

export function pointToArcSegDist(
  p: Point2D,
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
): { dist: number; proj: Point2D } {
  const ang = normAngle(Math.atan2(p.v - center.v, p.u - center.u));
  if (isAngleInSweep(ang, startAngle, endAngle, 1e-4)) {
    const proj = {
      u: center.u + radius * Math.cos(ang),
      v: center.v + radius * Math.sin(ang),
    };
    return { dist: Math.abs(dist2(p, center) - radius), proj };
  }
  const pStart = {
    u: center.u + radius * Math.cos(startAngle),
    v: center.v + radius * Math.sin(startAngle),
  };
  const pEnd = {
    u: center.u + radius * Math.cos(endAngle),
    v: center.v + radius * Math.sin(endAngle),
  };
  const dStart = dist2(p, pStart);
  const dEnd = dist2(p, pEnd);
  return dStart <= dEnd
    ? { dist: dStart, proj: pStart }
    : { dist: dEnd, proj: pEnd };
}

export function polygonSignedArea(poly: Point2D[]): number {
  const n = poly.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    sum += a.u * b.v - b.u * a.v;
  }
  return 0.5 * sum;
}

export function computeBounds2D(pts: Point2D[]): BoundingBox2D {
  if (pts.length === 0) return { uMin: 0, uMax: 0, vMin: 0, vMax: 0 };
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of pts) {
    if (p.u < uMin) uMin = p.u;
    if (p.u > uMax) uMax = p.u;
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  return { uMin, uMax, vMin, vMax };
}

export function sampleLoopSegmentsToDensePolygon(
  segments: LoopCurveSegment2D[],
  circleSubdivs = 64
): Point2D[] {
  const pts: Point2D[] = [];
  const pushPt = (q: Point2D) => {
    if (pts.length === 0 || dist2(pts[pts.length - 1], q) > 1e-4) {
      pts.push(q);
    }
  };
  for (const seg of segments) {
    if (
      seg.kind === 'arc' &&
      seg.center &&
      seg.radius !== undefined &&
      seg.startAngle !== undefined &&
      seg.endAngle !== undefined
    ) {
      const forward = seg.ccw !== false;
      const arcPts = sampleArcDTheta(
        seg.center,
        seg.radius,
        seg.startAngle,
        seg.endAngle,
        forward,
        circleSubdivs
      );
      for (const ap of arcPts) pushPt(ap);
    } else {
      pushPt(seg.p1);
      pushPt(seg.p2);
    }
  }
  if (pts.length > 2 && dist2(pts[0], pts[pts.length - 1]) < 1e-3) {
    pts.pop();
  }
  return pts;
}

// ============================================================================
// GB/T 4458.1 First-Angle Projection Exact Coordinate System
// ============================================================================

/**
 * Determine the third view given two orthogonal known views.
 */
export function getThirdView(v1: ViewType, v2: ViewType): ViewType {
  const set = new Set<ViewType>([v1, v2]);
  if (!set.has('left')) return 'left';
  if (!set.has('top')) return 'top';
  return 'front';
}

/**
 * Return the axis specification for a view:
 * - front: u = X, v = Z, depth w = Y, rayDir = (0, -1, 0) (+Y -> -Y, larger Y closer to observer)
 * - top:   u = X, v = Y, depth w = Z, rayDir = (0, 0, -1) (+Z -> -Z, larger Z closer to observer)
 * - left:  u = Y, v = Z, depth w = X, rayDir = (+1, 0, 0) (-X -> +X, smaller X closer to observer)
 */
export function getViewAxisSpec(view: ViewType): {
  uAxis: Axis3D;
  vAxis: Axis3D;
  wAxis: Axis3D;
  rayDir: Vec3;
  eyeOriginOffset: number;
  largerWCloser: boolean;
} {
  if (view === 'front') {
    return {
      uAxis: 'X',
      vAxis: 'Z',
      wAxis: 'Y',
      rayDir: { x: 0, y: -1, z: 0 },
      eyeOriginOffset: 160,
      largerWCloser: true,
    };
  }
  if (view === 'top') {
    return {
      uAxis: 'X',
      vAxis: 'Y',
      wAxis: 'Z',
      rayDir: { x: 0, y: 0, z: -1 },
      eyeOriginOffset: 160,
      largerWCloser: true,
    };
  }
  // left
  return {
    uAxis: 'Y',
    vAxis: 'Z',
    wAxis: 'X',
    rayDir: { x: 1, y: 0, z: 0 },
    eyeOriginOffset: -40,
    largerWCloser: false,
  };
}

/**
 * Project a 3D engineering point (X, Y, Z) onto 2D view coordinates (u, v).
 */
export function projectPoint3DToView(p: Vec3, view: ViewType): Point2D {
  if (view === 'front') return { u: p.x, v: p.z };
  if (view === 'top') return { u: p.x, v: p.y };
  return { u: p.y, v: p.z };
}

/**
 * Unproject 2D view coordinates (u, v) plus depth coordinate `w` along the view's normal axis
 * back into 3D engineering coordinates (X, Y, Z).
 */
export function unprojectViewPointTo3D(
  view: ViewType,
  u: number,
  v: number,
  w: number
): Vec3 {
  if (view === 'front') return { x: u, y: w, z: v };
  if (view === 'top') return { x: u, y: v, z: w };
  return { x: w, y: u, z: v };
}

/**
 * Construct a viewing ray starting outside the [0,120]^3 bounding box from observer eye toward object.
 * Ray parameter `s >= 0` increases along the line of sight (smaller `s` = closer to observer!).
 *   P(s) = rayOrigin + s * rayDir
 */
export function makeViewingRay(
  view: ViewType,
  u: number,
  v: number
): { origin: Vec3; dir: Vec3 } {
  if (view === 'front') {
    // Observer at Y = +160 looking toward -Y
    return { origin: { x: u, y: 160, z: v }, dir: { x: 0, y: -1, z: 0 } };
  }
  if (view === 'top') {
    // Observer at Z = +160 looking toward -Z
    return { origin: { x: u, y: v, z: 160 }, dir: { x: 0, y: 0, z: -1 } };
  }
  // Observer at X = -40 looking toward +X
  return { origin: { x: -40, y: u, z: v }, dir: { x: 1, y: 0, z: 0 } };
}

/**
 * Convert a 3D point `p` into its scalar distance `s` along the viewing ray from the eye plane.
 * Smaller `s` strictly means CLOSER to the observer (unobstructed).
 */
export function computeEyeDistance(p: Vec3, view: ViewType): number {
  if (view === 'front') return 160 - p.y;
  if (view === 'top') return 160 - p.z;
  return p.x + 40;
}

/**
 * Map axis name ('X' | 'Y' | 'Z') to coordinate selector and cross-plane (u_perp, v_perp) convention:
 * - Axis 'Z' -> (u_perp = X, v_perp = Y, w = Z) [matches 'top' view!]
 * - Axis 'Y' -> (u_perp = X, v_perp = Z, w = Y) [matches 'front' view!]
 * - Axis 'X' -> (u_perp = Y, v_perp = Z, w = X) [matches 'left' view!]
 */
export function decomposeByAxis(
  p: Vec3,
  axis: Axis3D
): { u: number; v: number; w: number } {
  if (axis === 'Z') return { u: p.x, v: p.y, w: p.z };
  if (axis === 'Y') return { u: p.x, v: p.z, w: p.y };
  return { u: p.y, v: p.z, w: p.x };
}

export function composeFromAxis(
  axis: Axis3D,
  u: number,
  v: number,
  w: number
): Vec3 {
  if (axis === 'Z') return { x: u, y: v, z: w };
  if (axis === 'Y') return { x: u, y: w, z: v };
  return { x: w, y: u, z: v };
}

export function getEndOnViewForAxis(axis: Axis3D): ViewType {
  if (axis === 'Z') return 'top';
  if (axis === 'Y') return 'front';
  return 'left';
}

export function getSharedAxisBetweenViews(v1: ViewType, v2: ViewType): {
  sharedAxis: Axis3D;
  v1Coord: 'u' | 'v';
  v2Coord: 'u' | 'v';
  v1FreeAxis: Axis3D;
  v1FreeCoord: 'u' | 'v';
  v2FreeAxis: Axis3D;
  v2FreeCoord: 'u' | 'v';
} {
  const s1 = getViewAxisSpec(v1);
  const s2 = getViewAxisSpec(v2);
  if (s1.uAxis === s2.uAxis) {
    return {
      sharedAxis: s1.uAxis,
      v1Coord: 'u',
      v2Coord: 'u',
      v1FreeAxis: s1.vAxis,
      v1FreeCoord: 'v',
      v2FreeAxis: s2.vAxis,
      v2FreeCoord: 'v',
    };
  }
  if (s1.uAxis === s2.vAxis) {
    return {
      sharedAxis: s1.uAxis,
      v1Coord: 'u',
      v2Coord: 'v',
      v1FreeAxis: s1.vAxis,
      v1FreeCoord: 'v',
      v2FreeAxis: s2.uAxis,
      v2FreeCoord: 'u',
    };
  }
  if (s1.vAxis === s2.uAxis) {
    return {
      sharedAxis: s1.vAxis,
      v1Coord: 'v',
      v2Coord: 'u',
      v1FreeAxis: s1.uAxis,
      v1FreeCoord: 'u',
      v2FreeAxis: s2.vAxis,
      v2FreeCoord: 'v',
    };
  }
  return {
    sharedAxis: s1.vAxis,
    v1Coord: 'v',
    v2Coord: 'v',
    v1FreeAxis: s1.uAxis,
    v1FreeCoord: 'u',
    v2FreeAxis: s2.uAxis,
    v2FreeCoord: 'u',
  };
}

// ============================================================================
// Engineering <-> Three.js Space Mapping & Right-Handed Winding Correction
// Per Invariant 二.3:
//   (Three.X, Three.Y, Three.Z) = (X - 60, Z - 50, Y - 60)
//   det(J) = -1 -> Swap (i0, i2, i1) or enforce (v1 - v0) x (v2 - v0) · n_out > 0!
// ============================================================================

export function engPointToSpace(
  p: Vec3,
  space: 'threejs' | 'engineering'
): Vec3 {
  if (space === 'threejs') {
    return { x: p.x - 60, y: p.z - 50, z: p.y - 60 };
  }
  return { x: p.x, y: p.y, z: p.z };
}

export function spacePointToEng(
  p: Vec3,
  space: 'threejs' | 'engineering'
): Vec3 {
  if (space === 'threejs') {
    return { x: p.x + 60, y: p.z + 60, z: p.y + 50 };
  }
  return { x: p.x, y: p.y, z: p.z };
}

export function engNormalToSpace(
  n: Vec3,
  space: 'threejs' | 'engineering'
): Vec3 {
  if (space === 'threejs') {
    return normalize3({ x: n.x, y: n.z, z: n.y });
  }
  return normalize3(n);
}

/**
 * Given three vertices in the TARGET space (`threejs` or `engineering`) and the expected
 * outward unit normal `expectedOutNormalInSpace`, return `[v0, v1, v2]` ordered so that
 * `(v1 - v0) x (v2 - v0) · expectedOutNormalInSpace > 0` (Right-Handed Outward CCW).
 */
export function orientTriangleOutward(
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  expectedOutNormalInSpace: Vec3
): [Vec3, Vec3, Vec3] {
  const e1 = sub3(v1, v0);
  const e2 = sub3(v2, v0);
  const n = cross3(e1, e2);
  if (dot3(n, expectedOutNormalInSpace) < 0) {
    return [v0, v2, v1];
  }
  return [v0, v1, v2];
}

export function expandBounds3D(b: BoundingBox3D, pad: number): BoundingBox3D {
  return {
    xMin: b.xMin - pad,
    xMax: b.xMax + pad,
    yMin: b.yMin - pad,
    yMax: b.yMax + pad,
    zMin: b.zMin - pad,
    zMax: b.zMax + pad,
  };
}

export function boxesOverlap3D(
  a: BoundingBox3D,
  b: BoundingBox3D,
  tol = 1e-3
): boolean {
  return (
    a.xMin <= b.xMax + tol &&
    a.xMax >= b.xMin - tol &&
    a.yMin <= b.yMax + tol &&
    a.yMax >= b.yMin - tol &&
    a.zMin <= b.zMax + tol &&
    a.zMax >= b.zMin - tol
  );
}
