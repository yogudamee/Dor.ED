import {
  GeneralizedLoftPayload,
  LoopCurveSegment2D,
  Point2D,
  Primitive3D,
  ViewType,
} from '../../types/cad';
import {
  arcSweepCCW,
  composeFromAxis,
  decomposeByAxis,
  dist2,
  dot3,
  getViewAxisSpec,
  isAngleInSweep,
  normAngle,
  normalize3,
  pointToArcSegDist,
  pointToLineSegDist,
  TWO_PI,
} from '../core/coordSystem';
import { evalCurvedRegion2DSDF, pointInPolygonExact } from '../arrangement2d/dcelFaces';
import { Axis3D, BoundingBox3D, Vec3 } from '../core/types';

// ============================================================================
// Exact Sutherland-Hodgman 2D & 3D Half-Space Polygon Clipping
// ============================================================================

/**
 * Clip a 2D polygon against the exact half-space `(p - lineOrigin) · inwardNormal >= 0`.
 * Preserves exact oblique / hexagonal slanted edges without AABB staircasing!
 */
export function clipPolygonByHalfSpace2D(
  poly: Point2D[],
  lineOrigin: Point2D,
  inwardNormal: Point2D
): Point2D[] {
  const n = poly.length;
  if (n === 0) return [];
  const evalSide = (p: Point2D) =>
    (p.u - lineOrigin.u) * inwardNormal.u + (p.v - lineOrigin.v) * inwardNormal.v;

  const out: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const dCur = evalSide(cur);
    const dPrev = evalSide(prev);
    const inCur = dCur >= -1e-7;
    const inPrev = dPrev >= -1e-7;

    if (inCur) {
      if (!inPrev) {
        const denom = dPrev - dCur;
        const t = Math.abs(denom) > 1e-12 ? dPrev / denom : 0;
        out.push({
          u: prev.u + t * (cur.u - prev.u),
          v: prev.v + t * (cur.v - prev.v),
        });
      }
      out.push(cur);
    } else if (inPrev) {
      const denom = dPrev - dCur;
      const t = Math.abs(denom) > 1e-12 ? dPrev / denom : 0;
      out.push({
        u: prev.u + t * (cur.u - prev.u),
        v: prev.v + t * (cur.v - prev.v),
      });
    }
  }
  return out;
}

/**
 * Clip a 3D planar polygon against an exact 3D half-space `(p - planePt) · inwardNormal >= 0`.
 */
export function clipPolygon3DByHalfSpace(
  poly: Vec3[],
  planePt: Vec3,
  inwardNormal: Vec3
): Vec3[] {
  const n = poly.length;
  if (n === 0) return [];
  const evalSide = (p: Vec3) =>
    (p.x - planePt.x) * inwardNormal.x +
    (p.y - planePt.y) * inwardNormal.y +
    (p.z - planePt.z) * inwardNormal.z;

  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const dCur = evalSide(cur);
    const dPrev = evalSide(prev);
    const inCur = dCur >= -1e-7;
    const inPrev = dPrev >= -1e-7;

    if (inCur) {
      if (!inPrev) {
        const denom = dPrev - dCur;
        const t = Math.abs(denom) > 1e-12 ? dPrev / denom : 0;
        out.push({
          x: prev.x + t * (cur.x - prev.x),
          y: prev.y + t * (cur.y - prev.y),
          z: prev.z + t * (cur.z - prev.z),
        });
      }
      out.push(cur);
    } else if (inPrev) {
      const denom = dPrev - dCur;
      const t = Math.abs(denom) > 1e-12 ? dPrev / denom : 0;
      out.push({
        x: prev.x + t * (cur.x - prev.x),
        y: prev.y + t * (cur.y - prev.y),
        z: prev.z + t * (cur.z - prev.z),
      });
    }
  }
  return out;
}

// ============================================================================
// Exact Analytic Signed Distance Functions (SDF) & Gradients
// ============================================================================

function boxSDF(
  p: Vec3,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  zMin: number,
  zMax: number
): number {
  const cx = 0.5 * (xMin + xMax);
  const cy = 0.5 * (yMin + yMax);
  const cz = 0.5 * (zMin + zMax);
  const hx = 0.5 * (xMax - xMin);
  const hy = 0.5 * (yMax - yMin);
  const hz = 0.5 * (zMax - zMin);
  const qx = Math.abs(p.x - cx) - hx;
  const qy = Math.abs(p.y - cy) - hy;
  const qz = Math.abs(p.z - cz) - hz;
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inDist = Math.min(Math.max(qx, qy, qz), 0);
  return outDist + inDist;
}

function cylinderSDF(
  u: number,
  v: number,
  w: number,
  cu: number,
  cv: number,
  radius: number,
  wMin: number,
  wMax: number
): number {
  const dr = Math.hypot(u - cu, v - cv) - radius;
  const cw = 0.5 * (wMin + wMax);
  const hw = 0.5 * (wMax - wMin);
  const dw = Math.abs(w - cw) - hw;
  return Math.hypot(Math.max(dr, 0), Math.max(dw, 0)) + Math.min(Math.max(dr, dw), 0);
}

function semicircle2DSDF(
  u: number,
  v: number,
  cu: number,
  cv: number,
  r: number,
  arcStart: number,
  arcEnd: number
): number {
  if (r <= 1e-5) return Math.hypot(u - cu, v - cv);
  const p = { u, v };
  const p0 = { u: cu + r * Math.cos(arcStart), v: cv + r * Math.sin(arcStart) };
  const p1 = { u: cu + r * Math.cos(arcEnd), v: cv + r * Math.sin(arcEnd) };
  const dArc = pointToArcSegDist(p, { u: cu, v: cv }, r, arcStart, arcEnd).dist;
  const dChord = pointToLineSegDist(p, p1, p0).dist;
  const minD = Math.min(dArc, dChord);

  // Inside test: inside disk AND on the arc side of chord p0 -> p1!
  const inDisk = Math.hypot(u - cu, v - cv) <= r + 1e-7;
  // Midpoint of arc gives exact interior half-plane direction relative to chord
  const midAng = arcStart + 0.5 * arcSweepCCW(arcStart, arcEnd);
  const mPt = { u: cu + r * Math.cos(midAng), v: cv + r * Math.sin(midAng) };
  const chordDirU = p1.u - p0.u;
  const chordDirV = p1.v - p0.v;
  const refCross = chordDirU * (mPt.v - p0.v) - chordDirV * (mPt.u - p0.u);
  const ptCross = chordDirU * (v - p0.v) - chordDirV * (u - p0.u);
  const inHalf = refCross >= 0 ? ptCross >= -1e-7 : ptCross <= 1e-7;

  return inDisk && inHalf ? -minD : minD;
}

/**
 * Evaluate exact 3D SDF for `GeneralizedLoftPayload`:
 *   S(s, t) = (1 - t) * Gamma_0(s) + t * Gamma_1(s),  t = (w - w0) / (w1 - w0) in [0, 1]
 */
export function evalGeneralizedLoftSDF(
  p: Vec3,
  loft: GeneralizedLoftPayload
): number {
  const { u, v, w } = decomposeByAxis(p, loft.axis);
  const wMin = Math.min(loft.w0, loft.w1);
  const wMax = Math.max(loft.w0, loft.w1);
  const H = loft.w1 - loft.w0;
  if (Math.abs(H) < 1e-6) return 1e6;

  const tRaw = (w - loft.w0) / H;
  const t = Math.max(0, Math.min(1, tRaw));
  const dw = Math.max(wMin - w, w - wMax);

  const s0 = loft.section0;
  const s1 = loft.section1;

  // 1. Circular / Eccentric Cone or Frustum
  if (
    (s0.kind === 'circle' || s0.kind === 'point') &&
    (s1.kind === 'circle' || s1.kind === 'point')
  ) {
    const r0 = s0.kind === 'point' ? 0 : s0.radiusU;
    const r1 = s1.kind === 'point' ? 0 : s1.radiusU;
    const cu = (1 - t) * s0.centerU + t * s1.centerU;
    const cv = (1 - t) * s0.centerV + t * s1.centerV;
    const rt = (1 - t) * r0 + t * r1;

    const du = u - cu;
    const dv = v - cv;
    const rho = Math.hypot(du, dv);
    const cosTh = rho > 1e-9 ? du / rho : 1;
    const sinTh = rho > 1e-9 ? dv / rho : 0;
    // Exact slope correction factor along the ruled generator!
    const slopeU = (s1.centerU - s0.centerU + (r1 - r0) * cosTh) / H;
    const slopeV = (s1.centerV - s0.centerV + (r1 - r0) * sinTh) / H;
    const perpScale = 1 / Math.sqrt(1 + slopeU * slopeU + slopeV * slopeV);
    const dLat = (rho - rt) * perpScale;

    if (dw <= 0) {
      return Math.max(dLat, dw);
    }
    return Math.hypot(Math.max(dLat, 0), dw);
  }

  // 2. Semi-Cone / Semi-Frustum (co-chord or coaxial semicircles)
  if (
    (s0.kind === 'semicircle' || s0.kind === 'point') &&
    (s1.kind === 'semicircle' || s1.kind === 'point')
  ) {
    const r0 = s0.kind === 'point' ? 0 : s0.radiusU;
    const r1 = s1.kind === 'point' ? 0 : s1.radiusU;
    const cu = (1 - t) * s0.centerU + t * s1.centerU;
    const cv = (1 - t) * s0.centerV + t * s1.centerV;
    const rt = (1 - t) * r0 + t * r1;
    const arcStart = s0.arcStart ?? s1.arcStart ?? 0;
    const arcEnd = s0.arcEnd ?? s1.arcEnd ?? Math.PI;

    const d2d = semicircle2DSDF(u, v, cu, cv, rt, arcStart, arcEnd);
    const slopeR = Math.abs(r1 - r0) / Math.abs(H);
    const dLat = d2d / Math.sqrt(1 + slopeR * slopeR);
    if (dw <= 0) return Math.max(dLat, dw);
    return Math.hypot(Math.max(dLat, 0), dw);
  }

  // 3. Polygonal Pyramid / Polygonal Frustum / General Loft
  if (s0.polygon && s0.polygon.length >= 3) {
    const poly0 = s0.polygon;
    const n = poly0.length;
    const polyT: Point2D[] = [];
    for (let i = 0; i < n; i++) {
      const p1i =
        s1.polygon && s1.polygon.length === n
          ? s1.polygon[i]
          : { u: s1.centerU, v: s1.centerV };
      polyT.push({
        u: (1 - t) * poly0[i].u + t * p1i.u,
        v: (1 - t) * poly0[i].v + t * p1i.v,
      });
    }
    const d2d = evalCurvedRegion2DSDF({ u, v }, [], polyT);
    const slopeEst =
      Math.hypot(
        (s1.radiusU ?? 0) - (s0.radiusU ?? 0),
        s1.centerU - s0.centerU,
        s1.centerV - s0.centerV
      ) / Math.max(1, Math.abs(H));
    const dLat = d2d / Math.sqrt(1 + slopeEst * slopeEst);
    if (dw <= 0) return Math.max(dLat, dw);
    return Math.hypot(Math.max(dLat, 0), dw);
  }

  return 1e6;
}

/**
 * Evaluate exact 3D Signed Distance Function (SDF) for any `Primitive3D` in engineering space `[0, 120]^3`.
 * Strictly `< 0` inside solid/void volume, `= 0` on exact boundary, `> 0` outside!
 */
export function evalPrimitive3DSDF(p: Vec3, prim: Primitive3D): number {
  if (prim.loftSpec) {
    return evalGeneralizedLoftSDF(p, prim.loftSpec);
  }

  switch (prim.shape) {
    case 'box':
      return boxSDF(
        p,
        prim.xMin,
        prim.xMax,
        prim.yMin,
        prim.yMax,
        prim.zMin,
        prim.zMax
      );

    case 'cylinder_z': {
      const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
      const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
      const r = prim.radius ?? 0.5 * (prim.xMax - prim.xMin);
      return cylinderSDF(p.x, p.y, p.z, cx, cy, r, prim.zMin, prim.zMax);
    }

    case 'cylinder_y': {
      const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
      const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
      const r = prim.radius ?? 0.5 * (prim.xMax - prim.xMin);
      return cylinderSDF(p.x, p.z, p.y, cx, cz, r, prim.yMin, prim.yMax);
    }

    case 'cylinder_x': {
      const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
      const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
      const r = prim.radius ?? 0.5 * (prim.yMax - prim.yMin);
      return cylinderSDF(p.y, p.z, p.x, cy, cz, r, prim.xMin, prim.xMax);
    }

    case 'sphere': {
      const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
      const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
      const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
      const r = prim.radius ?? 0.5 * (prim.xMax - prim.xMin);
      return Math.hypot(p.x - cx, p.y - cy, p.z - cz) - r;
    }

    case 'hemisphere': {
      const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
      const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
      const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
      const r =
        prim.radius ??
        0.5 *
          Math.max(
            prim.xMax - prim.xMin,
            prim.yMax - prim.yMin,
            prim.zMax - prim.zMin
          );
      const dSphere = Math.hypot(p.x - cx, p.y - cy, p.z - cz) - r;
      const hs = prim.hemisphereSpec ?? {
        flatAxis: 'Z' as const,
        flatCoord: prim.zMin,
        keepPositiveSide: true,
      };
      const coord =
        hs.flatAxis === 'X' ? p.x : hs.flatAxis === 'Y' ? p.y : p.z;
      const dPlane = hs.keepPositiveSide
        ? hs.flatCoord - coord
        : coord - hs.flatCoord;
      if (dSphere <= 0 && dPlane <= 0) return Math.max(dSphere, dPlane);
      return Math.hypot(Math.max(dSphere, 0), Math.max(dPlane, 0));
    }

    case 'cone_z':
    case 'cone_y':
    case 'cone_x': {
      const axis: Axis3D =
        prim.shape === 'cone_z' ? 'Z' : prim.shape === 'cone_y' ? 'Y' : 'X';
      const wMin =
        axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
      const wMax =
        axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
      const defaultU =
        axis === 'X'
          ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
          : prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
      const defaultV =
        axis === 'Z'
          ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
          : prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
      const r0 = prim.rMin ?? prim.radius ?? 0.5 * (prim.xMax - prim.xMin);
      const r1 = prim.rMax ?? 0;
      return evalGeneralizedLoftSDF(p, {
        axis,
        w0: wMin,
        w1: wMax,
        section0: {
          kind: r0 <= 1e-4 ? 'point' : 'circle',
          centerU: prim.uCenterMin ?? defaultU,
          centerV: prim.vCenterMin ?? defaultV,
          radiusU: r0,
        },
        section1: {
          kind: r1 <= 1e-4 ? 'point' : 'circle',
          centerU: prim.uCenterMax ?? defaultU,
          centerV: prim.vCenterMax ?? defaultV,
          radiusU: r1,
        },
      });
    }

    case 'wedge_y': {
      // Right-triangular prism along X: back vertical at yMax, sloped from (yMax,zMax) down to (yMin,zMin)
      const dBox = boxSDF(
        p,
        prim.xMin,
        prim.xMax,
        prim.yMin,
        prim.yMax,
        prim.zMin,
        prim.zMax
      );
      const dy = prim.yMax - prim.yMin;
      const dz = prim.zMax - prim.zMin;
      const len = Math.hypot(dy, dz) || 1;
      // Sloped plane through (yMin, zMin) and (yMax, zMax): z <= zMin + (y - yMin) * dz/dy -> dz*(y-yMin) - dy*(z-zMin) >= 0 inside
      const dSlope = (dy * (p.z - prim.zMin) - dz * (p.y - prim.yMin)) / len;
      return Math.max(dBox, dSlope);
    }

    case 'wedge_x': {
      const dBox = boxSDF(
        p,
        prim.xMin,
        prim.xMax,
        prim.yMin,
        prim.yMax,
        prim.zMin,
        prim.zMax
      );
      const dx = prim.xMax - prim.xMin;
      const dz = prim.zMax - prim.zMin;
      const len = Math.hypot(dx, dz) || 1;
      const dSlope = (dx * (p.z - prim.zMin) - dz * (p.x - prim.xMin)) / len;
      return Math.max(dBox, dSlope);
    }

    case 'pyramid': {
      const topScale = prim.pyramidTopScale ?? 0;
      const poly: Point2D[] = [
        { u: prim.xMin, v: prim.yMin },
        { u: prim.xMax, v: prim.yMin },
        { u: prim.xMax, v: prim.yMax },
        { u: prim.xMin, v: prim.yMax },
      ];
      const cx = prim.apex3D ? prim.apex3D[0] : 0.5 * (prim.xMin + prim.xMax);
      const cy = prim.apex3D ? prim.apex3D[1] : 0.5 * (prim.yMin + prim.yMax);
      const topPoly = poly.map((q) => ({
        u: cx + (q.u - cx) * topScale,
        v: cy + (q.v - cy) * topScale,
      }));
      return evalGeneralizedLoftSDF(p, {
        axis: 'Z',
        w0: prim.zMin,
        w1: prim.zMax,
        section0: {
          kind: 'polygon',
          centerU: 0.5 * (prim.xMin + prim.xMax),
          centerV: 0.5 * (prim.yMin + prim.yMax),
          radiusU: 0.5 * (prim.xMax - prim.xMin),
          polygon: poly,
        },
        section1: {
          kind: topScale <= 1e-4 ? 'point' : 'polygon',
          centerU: cx,
          centerV: cy,
          radiusU: 0.5 * (prim.xMax - prim.xMin) * topScale,
          polygon: topScale <= 1e-4 ? undefined : topPoly,
        },
      });
    }

    case 'prism':
    case 'rib_xz': {
      const axis: Axis3D =
        prim.prismAxis ??
        (prim.extrudeAxis
          ? (prim.extrudeAxis.toUpperCase() as Axis3D)
          : prim.shape === 'rib_xz'
          ? 'Y'
          : 'Z');
      const { u, v, w } = decomposeByAxis(p, axis);
      const wMin =
        axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
      const wMax =
        axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
      const dw = Math.max(wMin - w, w - wMax);
      const poly = prim.prismPolygon ?? prim.polygon2D ?? [];
      const segs = prim.prismSegments ?? [];
      const d2d = evalCurvedRegion2DSDF({ u, v }, segs, poly);
      if (dw <= 0 && d2d <= 0) return Math.max(d2d, dw);
      return Math.hypot(Math.max(d2d, 0), Math.max(dw, 0));
    }

    default:
      return boxSDF(
        p,
        prim.xMin,
        prim.xMax,
        prim.yMin,
        prim.yMax,
        prim.zMin,
        prim.zMax
      );
  }
}

/**
 * High-precision central-difference / analytic surface normal gradient `∇SDF(p)` (unit length).
 */
export function evalPrimitive3DGrad(p: Vec3, prim: Primitive3D, eps = 1e-3): Vec3 {
  const gx =
    evalPrimitive3DSDF({ x: p.x + eps, y: p.y, z: p.z }, prim) -
    evalPrimitive3DSDF({ x: p.x - eps, y: p.y, z: p.z }, prim);
  const gy =
    evalPrimitive3DSDF({ x: p.x, y: p.y + eps, z: p.z }, prim) -
    evalPrimitive3DSDF({ x: p.x, y: p.y - eps, z: p.z }, prim);
  const gz =
    evalPrimitive3DSDF({ x: p.x, y: p.y, z: p.z + eps }, prim) -
    evalPrimitive3DSDF({ x: p.x, y: p.y, z: p.z - eps }, prim);
  return normalize3({ x: gx, y: gy, z: gz });
}

/**
 * Evaluate exact boolean CSG SDF for a list of primitives:
 * - Primitives sharing a `weldGroup` with `operation === 'intersect'` are intersected (`max(sdf_a, sdf_b)`)
 *   to form a single exact clipped polyhedron / composite solid before unioning (`min`)!
 * - All positive (`'add'` + intersected `weldGroup`) solids are unioned (`min`),
 * - All negative (`'subtract'`) void channels are subtracted (`max(sdf_solid, -sdf_void)`).
 */
export function evalCSGSolidSDF(p: Vec3, primitives: Primitive3D[]): number {
  const addPrims: Primitive3D[] = [];
  const subPrims: Primitive3D[] = [];
  const intersectGroups = new Map<string, Primitive3D[]>();

  for (const pr of primitives) {
    if (pr.operation === 'subtract') {
      subPrims.push(pr);
    } else if (pr.operation === 'intersect' && pr.weldGroup) {
      const g = intersectGroups.get(pr.weldGroup) ?? [];
      g.push(pr);
      intersectGroups.set(pr.weldGroup, g);
    } else if (pr.operation === 'intersect') {
      // Intersect against running solid later
      const g = intersectGroups.get('__global_intersect__') ?? [];
      g.push(pr);
      intersectGroups.set('__global_intersect__', g);
    } else {
      addPrims.push(pr);
    }
  }

  let solidSDF = Infinity;
  for (const pr of addPrims) {
    const d = evalPrimitive3DSDF(p, pr);
    if (d < solidSDF) solidSDF = d;
  }

  for (const [key, grp] of intersectGroups.entries()) {
    if (key === '__global_intersect__') continue;
    let grpSDF = -Infinity;
    for (const pr of grp) {
      const d = evalPrimitive3DSDF(p, pr);
      if (d > grpSDF) grpSDF = d;
    }
    if (grpSDF < solidSDF) solidSDF = grpSDF;
  }

  const globalInt = intersectGroups.get('__global_intersect__');
  if (globalInt) {
    for (const pr of globalInt) {
      solidSDF = Math.max(solidSDF, evalPrimitive3DSDF(p, pr));
    }
  }

  if (solidSDF === Infinity) return 1e6;

  for (const vp of subPrims) {
    const dVoid = evalPrimitive3DSDF(p, vp);
    solidSDF = Math.max(solidSDF, -dVoid);
  }
  return solidSDF;
}

export function evalPositiveBaseOnlySDF(
  p: Vec3,
  primitives: Primitive3D[]
): number {
  const positives = primitives.filter((pr) => pr.operation !== 'subtract');
  return evalCSGSolidSDF(p, positives);
}

// ============================================================================
// Exact Closed-Form Silhouette Generator Angles (A cos θ + B sin θ = C)
// ============================================================================

/**
 * Solve `A cos θ + B sin θ = C` for all real silhouette angles `θ ∈ [0, 2π)`.
 * Derived analytically from `N(θ) · rayDir = 0` on a ruled canal / GeneralizedLoft surface
 * `S(θ, t) = c(t) + r(t) * (cos θ, sin θ)`:
 *   A = H * ray_u - Δc_u * ray_w
 *   B = H * ray_v - Δc_v * ray_w
 *   C = Δr * ray_w
 */
export function solveLoftSilhouetteAngles(
  loft: GeneralizedLoftPayload,
  view: ViewType
): number[] {
  const { rayDir } = getViewAxisSpec(view);
  const { u: rayU, v: rayV, w: rayW } = decomposeByAxis(rayDir, loft.axis);
  const H = loft.w1 - loft.w0;
  const r0 = loft.section0.kind === 'point' ? 0 : loft.section0.radiusU;
  const r1 = loft.section1.kind === 'point' ? 0 : loft.section1.radiusU;
  const dcu = loft.section1.centerU - loft.section0.centerU;
  const dcv = loft.section1.centerV - loft.section0.centerV;
  const dr = r1 - r0;

  const A = H * rayU - dcu * rayW;
  const B = H * rayV - dcv * rayW;
  const C = dr * rayW;
  const R = Math.hypot(A, B);
  if (R < 1e-8) return [];
  const ratio = C / R;
  if (Math.abs(ratio) > 1 - 1e-7) {
    if (Math.abs(ratio) <= 1 + 1e-5) {
      const phi = Math.atan2(B, A);
      return [normAngle(phi + (ratio > 0 ? 0 : Math.PI))];
    }
    return [];
  }
  const phi = Math.atan2(B, A);
  const alpha = Math.acos(Math.max(-1, Math.min(1, ratio)));
  const a1 = normAngle(phi + alpha);
  const a2 = normAngle(phi - alpha);

  // Filter by arc span if semicircle!
  const isSemi =
    loft.section0.kind === 'semicircle' || loft.section1.kind === 'semicircle';
  if (isSemi) {
    const sAng = loft.section0.arcStart ?? loft.section1.arcStart ?? 0;
    const eAng = loft.section0.arcEnd ?? loft.section1.arcEnd ?? Math.PI;
    return [a1, a2].filter((ang) => isAngleInSweep(ang, sAng, eAng, -1e-3));
  }
  return [a1, a2];
}

export function getPrimitiveLoftEquivalent(
  prim: Primitive3D
): GeneralizedLoftPayload | null {
  if (prim.loftSpec) return prim.loftSpec;
  if (
    prim.shape === 'cylinder_x' ||
    prim.shape === 'cylinder_y' ||
    prim.shape === 'cylinder_z'
  ) {
    const axis: Axis3D =
      prim.shape === 'cylinder_z'
        ? 'Z'
        : prim.shape === 'cylinder_y'
        ? 'Y'
        : 'X';
    const w0 = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const w1 = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
    const cu =
      axis === 'X'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cv =
      axis === 'Z'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const r =
      prim.radius ??
      0.5 *
        (axis === 'X' ? prim.yMax - prim.yMin : prim.xMax - prim.xMin);
    return {
      axis,
      w0,
      w1,
      section0: { kind: 'circle', centerU: cu, centerV: cv, radiusU: r },
      section1: { kind: 'circle', centerU: cu, centerV: cv, radiusU: r },
    };
  }
  if (
    prim.shape === 'cone_x' ||
    prim.shape === 'cone_y' ||
    prim.shape === 'cone_z'
  ) {
    const axis: Axis3D =
      prim.shape === 'cone_z' ? 'Z' : prim.shape === 'cone_y' ? 'Y' : 'X';
    const w0 = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const w1 = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
    const defU =
      axis === 'X'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const defV =
      axis === 'Z'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const r0 = prim.rMin ?? prim.radius ?? 0.5 * (prim.xMax - prim.xMin);
    const r1 = prim.rMax ?? 0;
    return {
      axis,
      w0,
      w1,
      section0: {
        kind: r0 <= 1e-4 ? 'point' : 'circle',
        centerU: prim.uCenterMin ?? defU,
        centerV: prim.vCenterMin ?? defV,
        radiusU: r0,
      },
      section1: {
        kind: r1 <= 1e-4 ? 'point' : 'circle',
        centerU: prim.uCenterMax ?? defU,
        centerV: prim.vCenterMax ?? defV,
        radiusU: r1,
      },
    };
  }
  return null;
}

export function evaluateLoftGeneratorLine3D(
  loft: GeneralizedLoftPayload,
  theta: number
): { p0: Vec3; p1: Vec3 } {
  const r0 = loft.section0.kind === 'point' ? 0 : loft.section0.radiusU;
  const r1 = loft.section1.kind === 'point' ? 0 : loft.section1.radiusU;
  const u0 = loft.section0.centerU + r0 * Math.cos(theta);
  const v0 = loft.section0.centerV + r0 * Math.sin(theta);
  const u1 = loft.section1.centerU + r1 * Math.cos(theta);
  const v1 = loft.section1.centerV + r1 * Math.sin(theta);
  return {
    p0: composeFromAxis(loft.axis, u0, v0, loft.w0),
    p1: composeFromAxis(loft.axis, u1, v1, loft.w1),
  };
}

export function computePrimitiveBounds3D(prim: Primitive3D): BoundingBox3D {
  return {
    xMin: prim.xMin,
    xMax: prim.xMax,
    yMin: prim.yMin,
    yMax: prim.yMax,
    zMin: prim.zMin,
    zMax: prim.zMax,
  };
}
