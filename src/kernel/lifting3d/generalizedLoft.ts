import { GeneralizedLoftPayload, Point2D, Primitive3D } from '../../types/cad';
import { Axis3D, BBox3D, SpaceCircleArc3D, SpaceLine3D, Vec2, Vec3 } from '../types';
import { arcSweepCCW, normAngle, pointToLineSegDist } from '../arrangement2d/snapAndSplit';

const TWO_PI = Math.PI * 2;

/**
 * Maps local (u, v, w) loft coordinates to 3D engineering space (x, y, z):
 * - axis === 'Z' (Top cross-section):   x = u, y = v, z = w  (det = +1)
 * - axis === 'Y' (Front cross-section): x = u, z = v, y = w  (det = -1, swapped orientation)
 * - axis === 'X' (Left cross-section):  y = u, z = v, x = w  (det = +1)
 */
export function loftUVWToXYZ(axis: Axis3D, u: number, v: number, w: number): Vec3 {
  if (axis === 'Z') return { x: u, y: v, z: w };
  if (axis === 'Y') return { x: u, y: w, z: v };
  return { x: w, y: u, z: v };
}

export function xyzToLoftUVW(axis: Axis3D, p: Vec3): { u: number; v: number; w: number } {
  if (axis === 'Z') return { u: p.x, v: p.y, w: p.z };
  if (axis === 'Y') return { u: p.x, v: p.z, w: p.y };
  return { u: p.y, v: p.z, w: p.x };
}

function loftFrameHandedness(axis: Axis3D): number {
  // Jacobian determinant of (u, v, w) -> (x, y, z)
  return axis === 'Y' ? -1 : 1;
}

export function computeGeneralizedLoftBBox(spec: GeneralizedLoftPayload): BBox3D {
  const wMin = Math.min(spec.w0, spec.w1);
  const wMax = Math.max(spec.w0, spec.w1);

  const sectionBounds = (sec: GeneralizedLoftPayload['section0']) => {
    if (sec.kind === 'point') {
      return { uMin: sec.centerU, uMax: sec.centerU, vMin: sec.centerV, vMax: sec.centerV };
    }
    if (sec.kind === 'polygon' && sec.polygon && sec.polygon.length > 0) {
      let uMin = Infinity;
      let uMax = -Infinity;
      let vMin = Infinity;
      let vMax = -Infinity;
      for (const pt of sec.polygon) {
        if (pt.u < uMin) uMin = pt.u;
        if (pt.u > uMax) uMax = pt.u;
        if (pt.v < vMin) vMin = pt.v;
        if (pt.v > vMax) vMax = pt.v;
      }
      return { uMin, uMax, vMin, vMax };
    }
    const rU = Math.abs(sec.radiusU);
    const rV = Math.abs(sec.radiusV ?? sec.radiusU);
    let uMin = sec.centerU - rU;
    let uMax = sec.centerU + rU;
    let vMin = sec.centerV - rV;
    let vMax = sec.centerV + rV;
    if (sec.kind === 'semicircle' && sec.flatChordAxis && sec.flatChordVal !== undefined) {
      if (sec.flatChordAxis === 'v') {
        if (sec.keepGreater) vMin = Math.max(vMin, sec.flatChordVal);
        else vMax = Math.min(vMax, sec.flatChordVal);
      } else {
        if (sec.keepGreater) uMin = Math.max(uMin, sec.flatChordVal);
        else uMax = Math.min(uMax, sec.flatChordVal);
      }
    }
    return { uMin, uMax, vMin, vMax };
  };

  const b0 = sectionBounds(spec.section0);
  const b1 = sectionBounds(spec.section1);
  const uMin = Math.min(b0.uMin, b1.uMin);
  const uMax = Math.max(b0.uMax, b1.uMax);
  const vMin = Math.min(b0.vMin, b1.vMin);
  const vMax = Math.max(b0.vMax, b1.vMax);

  const pMin = loftUVWToXYZ(spec.axis, uMin, vMin, wMin);
  const pMax = loftUVWToXYZ(spec.axis, uMax, vMax, wMax);
  return {
    xMin: Math.min(pMin.x, pMax.x),
    xMax: Math.max(pMin.x, pMax.x),
    yMin: Math.min(pMin.y, pMax.y),
    yMax: Math.max(pMin.y, pMax.y),
    zMin: Math.min(pMin.z, pMax.z),
    zMax: Math.max(pMin.z, pMax.z),
  };
}

function isAngleInSweep(angle: number, startAngle: number, sweep: number, tol = 1e-3): boolean {
  if (sweep >= TWO_PI - 1e-4) return true;
  const rel = normAngle(angle - startAngle);
  return rel <= sweep + tol || TWO_PI - rel <= tol;
}

function eval2DPolygonSDF(pt: Vec2, poly: Point2D[]): number {
  if (poly.length < 3) return Infinity;
  let minDist = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const d = pointToLineSegDist(pt, a, b).dist;
    if (d < minDist) minDist = d;
    const intersect =
      b.v > pt.v !== a.v > pt.v &&
      pt.u < ((a.u - b.u) * (pt.v - b.v)) / (a.v - b.v + 1e-12) + b.u;
    if (intersect) inside = !inside;
  }
  return inside ? -minDist : minDist;
}

/**
 * Deduplicates consecutive near-coincident vertices and enforces positive CCW orientation.
 */
export function ensureCCWPolygon2D(rawPoly: Point2D[], eps = 1e-4): Point2D[] {
  const cleaned: Point2D[] = [];
  for (const pt of rawPoly) {
    if (!Number.isFinite(pt.u) || !Number.isFinite(pt.v)) continue;
    if (
      cleaned.length === 0 ||
      Math.hypot(pt.u - cleaned[cleaned.length - 1].u, pt.v - cleaned[cleaned.length - 1].v) > eps
    ) {
      cleaned.push({ u: pt.u, v: pt.v });
    }
  }
  while (
    cleaned.length >= 2 &&
    Math.hypot(
      cleaned[0].u - cleaned[cleaned.length - 1].u,
      cleaned[0].v - cleaned[cleaned.length - 1].v
    ) <= eps
  ) {
    cleaned.pop();
  }
  if (cleaned.length < 3) return cleaned;

  let area2 = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const a = cleaned[i];
    const b = cleaned[(i + 1) % cleaned.length];
    area2 += a.u * b.v - b.u * a.v;
  }
  if (area2 < 0) cleaned.reverse();
  return cleaned;
}

/**
 * Exact Sutherland-Hodgman 2D polygon clipping against an arbitrary oblique or orthogonal
 * linear half-space `nu * u + nv * v + d <= 0`.
 */
export function clipPolygonByHalfSpace2D(
  poly: Point2D[],
  nu: number,
  nv: number,
  d: number,
  eps = 1e-6
): Point2D[] {
  if (poly.length < 3) return [];
  const out: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const S = poly[i];
    const E = poly[(i + 1) % poly.length];
    const fS = nu * S.u + nv * S.v + d;
    const fE = nu * E.u + nv * E.v + d;
    const sIn = fS <= eps;
    const eIn = fE <= eps;

    if (sIn && eIn) {
      out.push({ u: E.u, v: E.v });
    } else if (sIn && !eIn) {
      const denom = fS - fE;
      const t = Math.abs(denom) > 1e-12 ? Math.max(0, Math.min(1, fS / denom)) : 0;
      out.push({ u: S.u + t * (E.u - S.u), v: S.v + t * (E.v - S.v) });
    } else if (!sIn && eIn) {
      const denom = fS - fE;
      const t = Math.abs(denom) > 1e-12 ? Math.max(0, Math.min(1, fS / denom)) : 0;
      out.push({ u: S.u + t * (E.u - S.u), v: S.v + t * (E.v - S.v) });
      out.push({ u: E.u, v: E.v });
    }
  }
  return ensureCCWPolygon2D(out, 1e-5);
}

/**
 * Pure-TypeScript 2D Ear-Clipping triangulator supporting arbitrary convex and concave
 * simple polygons using ONLY exact boundary vertices (zero extra interior Steiner vertices).
 */
export function triangulateSimplePolygon2D(rawPoly: Point2D[]): [number, number, number][] {
  const n = rawPoly.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const cross2 = (a: Point2D, b: Point2D, c: Point2D) =>
    (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);

  const pointInTri2D = (p: Point2D, a: Point2D, b: Point2D, c: Point2D) => {
    const c1 = cross2(a, b, p);
    const c2 = cross2(b, c, p);
    const c3 = cross2(c, a, p);
    return c1 >= -1e-7 && c2 >= -1e-7 && c3 >= -1e-7;
  };

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = rawPoly[i];
    const b = rawPoly[(i + 1) % n];
    area2 += a.u * b.v - b.u * a.v;
  }
  const avail = Array.from({ length: n }, (_, i) => (area2 >= 0 ? i : n - 1 - i));
  const tris: [number, number, number][] = [];
  let guard = 0;

  while (avail.length > 3 && guard++ < n * n + 8) {
    let earClipped = false;
    const m = avail.length;
    for (let i = 0; i < m; i++) {
      const iPrev = avail[(i - 1 + m) % m];
      const iCurr = avail[i];
      const iNext = avail[(i + 1) % m];
      const a = rawPoly[iPrev];
      const b = rawPoly[iCurr];
      const c = rawPoly[iNext];

      if (cross2(a, b, c) <= 1e-7) continue;

      let containsOther = false;
      for (let j = 0; j < m; j++) {
        const idx = avail[j];
        if (idx === iPrev || idx === iCurr || idx === iNext) continue;
        if (pointInTri2D(rawPoly[idx], a, b, c)) {
          containsOther = true;
          break;
        }
      }
      if (!containsOther) {
        tris.push([iPrev, iCurr, iNext]);
        avail.splice(i, 1);
        earClipped = true;
        break;
      }
    }
    if (!earClipped) {
      // Fallback for near-collinear grazing vertices: clip widest positive-turn corner
      let bestI = 0;
      let bestCross = -Infinity;
      const m2 = avail.length;
      for (let i = 0; i < m2; i++) {
        const cr = cross2(
          rawPoly[avail[(i - 1 + m2) % m2]],
          rawPoly[avail[i]],
          rawPoly[avail[(i + 1) % m2]]
        );
        if (cr > bestCross) {
          bestCross = cr;
          bestI = i;
        }
      }
      const m3 = avail.length;
      tris.push([
        avail[(bestI - 1 + m3) % m3],
        avail[bestI],
        avail[(bestI + 1) % m3],
      ]);
      avail.splice(bestI, 1);
    }
  }

  if (avail.length === 3) {
    tris.push([avail[0], avail[1], avail[2]]);
  }
  return tris;
}

/**
 * Aligns two polygonal cross-sections (or polygon <-> apex point) into canonical CCW vertex order
 * and optimal cyclic shift so homologous corners connect cleanly without twisting.
 */
export function alignLoftPolygonPair(
  s0: GeneralizedLoftPayload['section0'],
  s1: GeneralizedLoftPayload['section1']
): { poly0: Point2D[]; poly1: Point2D[] } {
  const poly0 =
    s0.kind === 'polygon' && s0.polygon && s0.polygon.length >= 3
      ? ensureCCWPolygon2D(s0.polygon)
      : [{ u: s0.centerU, v: s0.centerV }];
  let poly1 =
    s1.kind === 'polygon' && s1.polygon && s1.polygon.length >= 3
      ? ensureCCWPolygon2D(s1.polygon)
      : [{ u: s1.centerU, v: s1.centerV }];

  if (poly0.length >= 3 && poly1.length === poly0.length) {
    const n = poly0.length;
    const r0 = Math.max(
      1e-3,
      poly0.reduce((mx, p) => Math.max(mx, Math.hypot(p.u - s0.centerU, p.v - s0.centerV)), 0)
    );
    const r1 = Math.max(
      1e-3,
      poly1.reduce((mx, p) => Math.max(mx, Math.hypot(p.u - s1.centerU, p.v - s1.centerV)), 0)
    );
    let bestShift = 0;
    let bestCost = Infinity;
    for (let shift = 0; shift < n; shift++) {
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const d0u = (poly0[i].u - s0.centerU) / r0;
        const d0v = (poly0[i].v - s0.centerV) / r0;
        const q = poly1[(i + shift) % n];
        const d1u = (q.u - s1.centerU) / r1;
        const d1v = (q.v - s1.centerV) / r1;
        cost += (d0u - d1u) * (d0u - d1u) + (d0v - d1v) * (d0v - d1v);
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestShift = shift;
      }
    }
    if (bestShift > 0) {
      poly1 = poly1.map((_, i) => poly1[(i + bestShift) % n]);
    }
  }

  return { poly0, poly1 };
}

/**
 * Evaluates the exact signed distance function (SDF) of a GeneralizedLoft volume:
 *   S(s, t) = (1 - t) * Gamma_0(s) + t * Gamma_1(s),   t in [0, 1]
 * Returns < 0 strictly inside the lofted volume, 0 on its boundary, > 0 outside.
 */
export function evalGeneralizedLoftSDF(p: Vec3, spec: GeneralizedLoftPayload): number {
  const { u, v, w } = xyzToLoftUVW(spec.axis, p);
  const dw = spec.w1 - spec.w0;
  const absH = Math.abs(dw);
  if (absH < 1e-6) return 1e6;

  const tRaw = (w - spec.w0) / dw;
  const wMin = Math.min(spec.w0, spec.w1);
  const wMax = Math.max(spec.w0, spec.w1);
  // Axial half-space signed distance (negative between wMin and wMax)
  const dAxial = Math.max(wMin - w, w - wMax);

  const tClamped = Math.max(0, Math.min(1, tRaw));
  const s0 = spec.section0;
  const s1 = spec.section1;

  // Case A: Polygon <-> Polygon / Point (Pyramid, Wedge, Tapered Slot/Frustum)
  if (s0.kind === 'polygon' || s1.kind === 'polygon') {
    const { poly0, poly1 } = alignLoftPolygonPair(s0, s1);

    const n = Math.max(poly0.length, poly1.length);
    if (n >= 3) {
      const interpPoly: Point2D[] = [];
      for (let i = 0; i < n; i++) {
        const p0 = poly0[i % poly0.length];
        const p1 = poly1[i % poly1.length];
        interpPoly.push({
          u: (1 - tClamped) * p0.u + tClamped * p1.u,
          v: (1 - tClamped) * p0.v + tClamped * p1.v,
        });
      }
      // Scale lateral distance by slant cosine factor for accurate true 3D SDF
      const duCenter = s1.centerU - s0.centerU;
      const dvCenter = s1.centerV - s0.centerV;
      const drApprox = Math.abs((s1.radiusU || 0) - (s0.radiusU || 0)) + Math.hypot(duCenter, dvCenter);
      const slantCos = absH / Math.hypot(absH, drApprox);
      const dLat = eval2DPolygonSDF({ u, v }, interpPoly) * slantCos;

      if (dAxial <= 0 && dLat <= 0) {
        return Math.max(dAxial, dLat);
      }
      if (dAxial > 0 && dLat > 0) {
        return Math.hypot(dAxial, dLat);
      }
      return Math.max(dAxial, dLat);
    }
  }

  // Case B: Circular / Semicircular / Conical Generalized Loft
  const cu = (1 - tClamped) * s0.centerU + tClamped * s1.centerU;
  const cv = (1 - tClamped) * s0.centerV + tClamped * s1.centerV;
  const r0 = s0.kind === 'point' ? 0 : Math.abs(s0.radiusU);
  const r1 = s1.kind === 'point' ? 0 : Math.abs(s1.radiusU);
  const rInterp = (1 - tClamped) * r0 + tClamped * r1;

  // Slant factor along radial normal so SDF is exact Euclidean distance for right cones/frustums
  // and tightly Lipschitz-calibrated for eccentric/oblique frustums
  const dcU = s1.centerU - s0.centerU;
  const dcV = s1.centerV - s0.centerV;
  const dr = r1 - r0;
  const dx = u - cu;
  const dy = v - cv;
  const distToAxis = Math.hypot(dx, dy);
  const dirU = distToAxis > 1e-8 ? dx / distToAxis : 1;
  const dirV = distToAxis > 1e-8 ? dy / distToAxis : 0;
  // Directional radial slope dR_eff / dw along unit ray (dirU, dirV)
  const radialShift = dr + dcU * dirU + dcV * dirV;
  const slantCos = absH / Math.hypot(absH, radialShift);

  let dLat = (distToAxis - rInterp) * slantCos;

  // Semicircle / Shared-Chord Half-Cone / Half-Frustum planar diametral constraint
  const semiSec = s0.kind === 'semicircle' ? s0 : s1.kind === 'semicircle' ? s1 : null;
  if (semiSec && semiSec.flatChordAxis && semiSec.flatChordVal !== undefined) {
    const chordVal0 =
      s0.kind === 'semicircle' && s0.flatChordVal !== undefined
        ? s0.flatChordVal
        : s0.kind === 'point'
          ? semiSec.flatChordAxis === 'v'
            ? s0.centerV
            : s0.centerU
          : semiSec.flatChordVal;
    const chordVal1 =
      s1.kind === 'semicircle' && s1.flatChordVal !== undefined
        ? s1.flatChordVal
        : s1.kind === 'point'
          ? semiSec.flatChordAxis === 'v'
            ? s1.centerV
            : s1.centerU
          : semiSec.flatChordVal;

    const chordInterp = (1 - tClamped) * chordVal0 + tClamped * chordVal1;
    const dChordSlope = chordVal1 - chordVal0;
    const chordCos = absH / Math.hypot(absH, dChordSlope);
    const coord = semiSec.flatChordAxis === 'v' ? v : u;
    const dChord = semiSec.keepGreater
      ? (chordInterp - coord) * chordCos
      : (coord - chordInterp) * chordCos;

    // Exact CSG intersection of full frustum/cone and chord half-space
    if (dLat <= 0 && dChord <= 0) {
      dLat = Math.max(dLat, dChord);
    } else if (dLat > 0 && dChord > 0) {
      // Closest point to the chord endpoints of the semicircle at slice tClamped
      let endA: Vec2;
      let endB: Vec2;
      if (semiSec.flatChordAxis === 'v') {
        endA = { u: cu - rInterp, v: chordInterp };
        endB = { u: cu + rInterp, v: chordInterp };
      } else {
        endA = { u: chordInterp, v: cv - rInterp };
        endB = { u: chordInterp, v: cv + rInterp };
      }
      const dSeg = pointToLineSegDist({ u, v }, endA, endB).dist * slantCos;
      dLat = Math.min(Math.hypot(dLat, dChord), Math.max(dChord, dSeg));
    } else {
      dLat = Math.max(dLat, dChord);
    }
  }

  if (dAxial <= 0 && dLat <= 0) {
    return Math.max(dAxial, dLat);
  }
  if (dAxial > 0 && dLat > 0) {
    return Math.hypot(dAxial, dLat);
  }
  return Math.max(dAxial, dLat);
}

export function evalGeneralizedLoftGrad(p: Vec3, spec: GeneralizedLoftPayload): Vec3 {
  const eps = 1e-4;
  const dx =
    evalGeneralizedLoftSDF({ x: p.x + eps, y: p.y, z: p.z }, spec) -
    evalGeneralizedLoftSDF({ x: p.x - eps, y: p.y, z: p.z }, spec);
  const dy =
    evalGeneralizedLoftSDF({ x: p.x, y: p.y + eps, z: p.z }, spec) -
    evalGeneralizedLoftSDF({ x: p.x, y: p.y - eps, z: p.z }, spec);
  const dz =
    evalGeneralizedLoftSDF({ x: p.x, y: p.y, z: p.z + eps }, spec) -
    evalGeneralizedLoftSDF({ x: p.x, y: p.y, z: p.z - eps }, spec);
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: dx / len, y: dy / len, z: dz / len };
}

/**
 * Converts legacy cone/frustum/pyramid Primitive3D into a canonical GeneralizedLoftPayload
 * when `p.loftSpec` is not explicitly populated.
 */
export function primitiveToGeneralizedLoft(p: Primitive3D): GeneralizedLoftPayload | null {
  if (p.loftSpec) return p.loftSpec;

  if (p.shape === 'cone_z' || p.shape === 'cone_y' || p.shape === 'cone_x') {
    const axis: Axis3D = p.shape === 'cone_z' ? 'Z' : p.shape === 'cone_y' ? 'Y' : 'X';
    const w0 = axis === 'Z' ? p.zMin : axis === 'Y' ? p.yMin : p.xMin;
    const w1 = axis === 'Z' ? p.zMax : axis === 'Y' ? p.yMax : p.xMax;
    const r0 = p.rMax ?? p.radius ?? 0.5 * (p.xMax - p.xMin);
    const r1 = p.rMin ?? 0;
    const defU =
      axis === 'X' ? 0.5 * (p.yMin + p.yMax) : 0.5 * (p.xMin + p.xMax);
    const defV =
      axis === 'Z' ? 0.5 * (p.yMin + p.yMax) : 0.5 * (p.zMin + p.zMax);
    const u0 = p.uCenterMax ?? defU;
    const v0 = p.vCenterMax ?? defV;
    const u1 = p.uCenterMin ?? defU;
    const v1 = p.vCenterMin ?? defV;

    return {
      axis,
      w0,
      w1,
      section0:
        r0 <= 1e-4
          ? { kind: 'point', centerU: u0, centerV: v0, radiusU: 0 }
          : { kind: 'circle', centerU: u0, centerV: v0, radiusU: r0 },
      section1:
        r1 <= 1e-4
          ? { kind: 'point', centerU: u1, centerV: v1, radiusU: 0 }
          : { kind: 'circle', centerU: u1, centerV: v1, radiusU: r1 },
    };
  }

  if (p.shape === 'pyramid' && p.apex3D) {
    const rawPoly = p.prismPolygon ?? p.polygon2D ?? [];
    const ccwPoly = ensureCCWPolygon2D(rawPoly);
    if (ccwPoly.length >= 3) {
      const axis: Axis3D =
        p.prismAxis ??
        (p.extrudeAxis ? (p.extrudeAxis.toUpperCase() as Axis3D) : 'Z');
      const [ax, ay, az] = p.apex3D;
      const apexUVW = xyzToLoftUVW(axis, { x: ax, y: ay, z: az });
      const pMin = axis === 'Z' ? p.zMin : axis === 'Y' ? p.yMin : p.xMin;
      const pMax = axis === 'Z' ? p.zMax : axis === 'Y' ? p.yMax : p.xMax;
      const baseW = Math.abs(apexUVW.w - pMin) >= Math.abs(apexUVW.w - pMax) ? pMin : pMax;
      const cU = ccwPoly.reduce((s, pt) => s + pt.u, 0) / ccwPoly.length;
      const cV = ccwPoly.reduce((s, pt) => s + pt.v, 0) / ccwPoly.length;
      const rApprox = ccwPoly.reduce(
        (m, pt) => Math.max(m, Math.hypot(pt.u - cU, pt.v - cV)),
        1
      );
      return {
        axis,
        w0: baseW,
        w1: apexUVW.w,
        section0: {
          kind: 'polygon',
          centerU: cU,
          centerV: cV,
          radiusU: rApprox,
          polygon: ccwPoly,
        },
        section1: {
          kind: 'point',
          centerU: apexUVW.u,
          centerV: apexUVW.v,
          radiusU: 0,
        },
      };
    }
  }

  return null;
}

/**
 * Analytically extracts exact 3D silhouette rulings, chord boundary lines, and circular/arc end-caps
 * of a GeneralizedLoft for quantitative HLR in a given view sightline `eyeDir`.
 */
export function extractGeneralizedLoftFeatureEdges(
  spec: GeneralizedLoftPayload,
  eyeDir: Vec3,
  options: {
    idPrefix: string;
    isCavityBoundary: boolean;
    surfaceIds: string[];
    featureId?: string;
    featureLabel?: string;
  }
): { lines: SpaceLine3D[]; circles: SpaceCircleArc3D[] } {
  const lines: SpaceLine3D[] = [];
  const circles: SpaceCircleArc3D[] = [];

  const s0 = spec.section0;
  const s1 = spec.section1;
  const dw = spec.w1 - spec.w0;
  if (Math.abs(dw) < 1e-5) return { lines, circles };

  // Polygon <-> Polygon / Point sharp edges
  if (s0.kind === 'polygon' || s1.kind === 'polygon') {
    const { poly0, poly1 } = alignLoftPolygonPair(s0, s1);
    const n = Math.max(poly0.length, poly1.length);
    for (let i = 0; i < n; i++) {
      const a0 = poly0[i % poly0.length];
      const b0 = poly0[(i + 1) % poly0.length];
      const a1 = poly1[i % poly1.length];
      const b1 = poly1[(i + 1) % poly1.length];
      // Lateral ruling edge
      lines.push({
        id: `${options.idPrefix}_lat_${i}`,
        kind: 'line3d',
        p1: loftUVWToXYZ(spec.axis, a0.u, a0.v, spec.w0),
        p2: loftUVWToXYZ(spec.axis, a1.u, a1.v, spec.w1),
        isCavityBoundary: options.isCavityBoundary,
        surfaceIds: options.surfaceIds,
        featureId: options.featureId,
        featureLabel: options.featureLabel,
      });
      // Base0 edge
      if (poly0.length >= 2 && Math.hypot(b0.u - a0.u, b0.v - a0.v) > 1e-3) {
        lines.push({
          id: `${options.idPrefix}_b0_${i}`,
          kind: 'line3d',
          p1: loftUVWToXYZ(spec.axis, a0.u, a0.v, spec.w0),
          p2: loftUVWToXYZ(spec.axis, b0.u, b0.v, spec.w0),
          isCavityBoundary: options.isCavityBoundary,
          surfaceIds: options.surfaceIds,
          featureId: options.featureId,
          featureLabel: options.featureLabel,
        });
      }
      // Base1 edge
      if (poly1.length >= 2 && Math.hypot(b1.u - a1.u, b1.v - a1.v) > 1e-3) {
        lines.push({
          id: `${options.idPrefix}_b1_${i}`,
          kind: 'line3d',
          p1: loftUVWToXYZ(spec.axis, a1.u, a1.v, spec.w1),
          p2: loftUVWToXYZ(spec.axis, b1.u, b1.v, spec.w1),
          isCavityBoundary: options.isCavityBoundary,
          surfaceIds: options.surfaceIds,
          featureId: options.featureId,
          featureLabel: options.featureLabel,
        });
      }
    }
    return { lines, circles };
  }

  // Circular / Semicircular / Conical Loft
  const r0 = s0.kind === 'point' ? 0 : Math.abs(s0.radiusU);
  const r1 = s1.kind === 'point' ? 0 : Math.abs(s1.radiusU);

  const semiSec = s0.kind === 'semicircle' ? s0 : s1.kind === 'semicircle' ? s1 : null;
  let startAngle = 0;
  let sweep = TWO_PI;
  if (semiSec) {
    if (semiSec.arcStart !== undefined && semiSec.arcEnd !== undefined) {
      startAngle = normAngle(semiSec.arcStart);
      sweep = arcSweepCCW(semiSec.arcStart, semiSec.arcEnd);
    } else if (semiSec.flatChordAxis === 'v') {
      startAngle = semiSec.keepGreater ? 0 : Math.PI;
      sweep = Math.PI;
    } else {
      startAngle = semiSec.keepGreater ? normAngle(-Math.PI / 2) : Math.PI / 2;
      sweep = Math.PI;
    }
  }

  const uAxis3D = Vec3Sub(
    loftUVWToXYZ(spec.axis, 1, 0, 0),
    loftUVWToXYZ(spec.axis, 0, 0, 0)
  );
  const vAxis3D = Vec3Sub(
    loftUVWToXYZ(spec.axis, 0, 1, 0),
    loftUVWToXYZ(spec.axis, 0, 0, 0)
  );
  const wAxis3D = Vec3Sub(
    loftUVWToXYZ(spec.axis, 0, 0, 1),
    loftUVWToXYZ(spec.axis, 0, 0, 0)
  );

  // Add end-cap circles or semicircular arcs + chord lines
  const emitCap = (
    sec: GeneralizedLoftPayload['section0'],
    r: number,
    wVal: number,
    tag: string
  ) => {
    if (r <= 1e-4) return;
    circles.push({
      id: `${options.idPrefix}_cap_${tag}`,
      kind: 'circle3d',
      center: loftUVWToXYZ(spec.axis, sec.centerU, sec.centerV, wVal),
      radius: r,
      uAxis: uAxis3D,
      vAxis: vAxis3D,
      normal: wAxis3D,
      startAngle,
      sweep,
      isCavityBoundary: options.isCavityBoundary,
      surfaceIds: options.surfaceIds,
      featureId: options.featureId,
      featureLabel: options.featureLabel,
    });
    if (semiSec && sweep < TWO_PI - 1e-3) {
      const aEnd = startAngle + sweep;
      const pStart = loftUVWToXYZ(
        spec.axis,
        sec.centerU + r * Math.cos(startAngle),
        sec.centerV + r * Math.sin(startAngle),
        wVal
      );
      const pEnd = loftUVWToXYZ(
        spec.axis,
        sec.centerU + r * Math.cos(aEnd),
        sec.centerV + r * Math.sin(aEnd),
        wVal
      );
      lines.push({
        id: `${options.idPrefix}_chord_${tag}`,
        kind: 'line3d',
        p1: pStart,
        p2: pEnd,
        isCavityBoundary: options.isCavityBoundary,
        surfaceIds: options.surfaceIds,
        featureId: options.featureId,
        featureLabel: options.featureLabel,
      });
    }
  };

  emitCap(s0, r0, spec.w0, '0');
  emitCap(s1, r1, spec.w1, '1');

  // Exact analytical silhouette angles from N(theta) · d_eye = 0:
  // (dw * d_u - d_w * du) cos(theta) + (dw * d_v - d_w * dv) sin(theta) = d_w * dR
  const eyeUVW = xyzToLoftUVW(spec.axis, eyeDir);
  const du = s1.centerU - s0.centerU;
  const dv = s1.centerV - s0.centerV;
  const dR = r1 - r0;

  const A = dw * eyeUVW.u - eyeUVW.w * du;
  const B = dw * eyeUVW.v - eyeUVW.w * dv;
  const C = eyeUVW.w * dR;
  const M = Math.hypot(A, B);

  const candidateAngles: number[] = [];
  if (M > 1e-7 && Math.abs(C) <= M + 1e-7) {
    const ratio = Math.max(-1, Math.min(1, C / M));
    const phi0 = Math.atan2(B, A);
    const alpha = Math.acos(ratio);
    const theta1 = normAngle(phi0 + alpha);
    const theta2 = normAngle(phi0 - alpha);
    if (isAngleInSweep(theta1, startAngle, sweep)) candidateAngles.push(theta1);
    if (Math.abs(alpha) > 1e-4 && isAngleInSweep(theta2, startAngle, sweep)) {
      candidateAngles.push(theta2);
    }
  }

  // For semicircular half-cones / half-frustums, the two chord-bounding rulings
  // at startAngle and startAngle + sweep are true sharp crease edges!
  if (semiSec && sweep < TWO_PI - 1e-3) {
    candidateAngles.push(startAngle);
    candidateAngles.push(normAngle(startAngle + sweep));
  }

  // Deduplicate angles within 1e-3 rad and emit 3D ruling segments
  const uniqueAngles: number[] = [];
  for (const ang of candidateAngles) {
    const exists = uniqueAngles.some((uAng) => {
      const diff = Math.abs(normAngle(ang - uAng));
      return diff < 2e-3 || TWO_PI - diff < 2e-3;
    });
    if (!exists) uniqueAngles.push(ang);
  }

  uniqueAngles.forEach((theta, idx) => {
    const p0 = loftUVWToXYZ(
      spec.axis,
      s0.centerU + r0 * Math.cos(theta),
      s0.centerV + r0 * Math.sin(theta),
      spec.w0
    );
    const p1 = loftUVWToXYZ(
      spec.axis,
      s1.centerU + r1 * Math.cos(theta),
      s1.centerV + r1 * Math.sin(theta),
      spec.w1
    );
    lines.push({
      id: `${options.idPrefix}_gen_${idx}`,
      kind: 'line3d',
      p1: p0,
      p2: p1,
      isCavityBoundary: options.isCavityBoundary,
      surfaceIds: options.surfaceIds,
      featureId: options.featureId,
      featureLabel: options.featureLabel,
    });
  });

  return { lines, circles };
}

function Vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function Vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function Vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Builds sharp, watertight, outward-CCW triangle positions (non-indexed Float32Array)
 * for any GeneralizedLoftPayload (frustum, oblique cone, half-cone, half-frustum, or polygonal loft).
 * Strictly preserves sharp planar caps and diametral chord faces without Marching Cubes rounding.
 */
export function buildGeneralizedLoftTrianglePositions(
  spec: GeneralizedLoftPayload,
  radialSegments = 72
): Float32Array {
  const tris: number[] = [];
  const pushTriOutward = (a: Vec3, b: Vec3, c: Vec3, expectedOutward: Vec3) => {
    const ab = Vec3Sub(b, a);
    const ac = Vec3Sub(c, a);
    const n = Vec3Cross(ab, ac);
    const area2 = Math.hypot(n.x, n.y, n.z);
    if (!Number.isFinite(area2) || area2 < 1e-8) return;
    if (Vec3Dot(n, expectedOutward) >= 0) {
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    } else {
      tris.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    }
  };

  const s0 = spec.section0;
  const s1 = spec.section1;
  const dw = spec.w1 - spec.w0;
  if (Math.abs(dw) < 1e-5) return new Float32Array(0);

  const wSign = dw > 0 ? 1 : -1;
  const handed = loftFrameHandedness(spec.axis);
  const cap0Normal = loftUVWToXYZ(spec.axis, 0, 0, -wSign);
  const cap0Orig = loftUVWToXYZ(spec.axis, 0, 0, 0);
  const outCap0 = Vec3Sub(cap0Normal, cap0Orig);
  const outCap1 = { x: -outCap0.x, y: -outCap0.y, z: -outCap0.z };

  // Polygonal Loft (Pyramids, Frustums, Wedges, Concave Tapered Prisms)
  if (s0.kind === 'polygon' || s1.kind === 'polygon') {
    const { poly0, poly1 } = alignLoftPolygonPair(s0, s1);
    const n = Math.max(poly0.length, poly1.length);
    if (n < 3) return new Float32Array(0);

    // Outward normal of lateral quad/triangle: since poly0/poly1 are CCW in (u, v),
    // edge tangent T = B - A in (u, v) has 2D outward normal (T.v, -T.u).
    // Incorporating loftFrameHandedness(axis) and wSign gives exact outward normal even on concave polygons!
    const orientFactor = handed * wSign;

    for (let i = 0; i < n; i++) {
      const p0a = poly0[i % poly0.length];
      const p0b = poly0[(i + 1) % poly0.length];
      const p1a = poly1[i % poly1.length];
      const p1b = poly1[(i + 1) % poly1.length];

      const A0 = loftUVWToXYZ(spec.axis, p0a.u, p0a.v, spec.w0);
      const B0 = loftUVWToXYZ(spec.axis, p0b.u, p0b.v, spec.w0);
      const A1 = loftUVWToXYZ(spec.axis, p1a.u, p1a.v, spec.w1);
      const B1 = loftUVWToXYZ(spec.axis, p1b.u, p1b.v, spec.w1);

      const len0 = Math.hypot(B0.x - A0.x, B0.y - A0.y, B0.z - A0.z);
      const len1 = Math.hypot(B1.x - A1.x, B1.y - A1.y, B1.z - A1.z);

      if (orientFactor > 0) {
        if (len0 > 1e-5) tris.push(A0.x, A0.y, A0.z, B0.x, B0.y, B0.z, B1.x, B1.y, B1.z);
        if (len1 > 1e-5) tris.push(A0.x, A0.y, A0.z, B1.x, B1.y, B1.z, A1.x, A1.y, A1.z);
      } else {
        if (len0 > 1e-5) tris.push(A0.x, A0.y, A0.z, B1.x, B1.y, B1.z, B0.x, B0.y, B0.z);
        if (len1 > 1e-5) tris.push(A0.x, A0.y, A0.z, A1.x, A1.y, A1.z, B1.x, B1.y, B1.z);
      }
    }

    // Exact 2D Ear-Clipping triangulation for end caps (supports arbitrary convex & concave polygons!)
    if (poly0.length >= 3) {
      const capTris0 = triangulateSimplePolygon2D(poly0);
      for (const [ia, ib, ic] of capTris0) {
        const A = loftUVWToXYZ(spec.axis, poly0[ia].u, poly0[ia].v, spec.w0);
        const B = loftUVWToXYZ(spec.axis, poly0[ib].u, poly0[ib].v, spec.w0);
        const C = loftUVWToXYZ(spec.axis, poly0[ic].u, poly0[ic].v, spec.w0);
        pushTriOutward(A, B, C, outCap0);
      }
    }
    if (poly1.length >= 3) {
      const capTris1 = triangulateSimplePolygon2D(poly1);
      for (const [ia, ib, ic] of capTris1) {
        const A = loftUVWToXYZ(spec.axis, poly1[ia].u, poly1[ia].v, spec.w1);
        const B = loftUVWToXYZ(spec.axis, poly1[ib].u, poly1[ib].v, spec.w1);
        const C = loftUVWToXYZ(spec.axis, poly1[ic].u, poly1[ic].v, spec.w1);
        pushTriOutward(A, B, C, outCap1);
      }
    }

    return new Float32Array(tris);
  }

  // Circular / Semicircular / Conical Loft
  const r0 = s0.kind === 'point' ? 0 : Math.abs(s0.radiusU);
  const r1 = s1.kind === 'point' ? 0 : Math.abs(s1.radiusU);
  const semiSec = s0.kind === 'semicircle' ? s0 : s1.kind === 'semicircle' ? s1 : null;

  let startAngle = 0;
  let sweep = TWO_PI;
  if (semiSec) {
    if (semiSec.arcStart !== undefined && semiSec.arcEnd !== undefined) {
      startAngle = normAngle(semiSec.arcStart);
      sweep = arcSweepCCW(semiSec.arcStart, semiSec.arcEnd);
    } else if (semiSec.flatChordAxis === 'v') {
      startAngle = semiSec.keepGreater ? 0 : Math.PI;
      sweep = Math.PI;
    } else {
      startAngle = semiSec.keepGreater ? normAngle(-Math.PI / 2) : Math.PI / 2;
      sweep = Math.PI;
    }
  }

  const isClosedRing = sweep >= TWO_PI - 1e-4;
  const steps = Math.max(16, Math.ceil((sweep / TWO_PI) * radialSegments));

  for (let i = 0; i < steps; i++) {
    const a0 = startAngle + (i / steps) * sweep;
    const a1 = isClosedRing && i === steps - 1 ? startAngle : startAngle + ((i + 1) / steps) * sweep;
    const aMid = 0.5 * (a0 + (i + 1 === steps && isClosedRing ? startAngle + TWO_PI : a1));

    const P0a = loftUVWToXYZ(
      spec.axis,
      s0.centerU + r0 * Math.cos(a0),
      s0.centerV + r0 * Math.sin(a0),
      spec.w0
    );
    const P0b = loftUVWToXYZ(
      spec.axis,
      s0.centerU + r0 * Math.cos(a1),
      s0.centerV + r0 * Math.sin(a1),
      spec.w0
    );
    const P1a = loftUVWToXYZ(
      spec.axis,
      s1.centerU + r1 * Math.cos(a0),
      s1.centerV + r1 * Math.sin(a0),
      spec.w1
    );
    const P1b = loftUVWToXYZ(
      spec.axis,
      s1.centerU + r1 * Math.cos(a1),
      s1.centerV + r1 * Math.sin(a1),
      spec.w1
    );

    const outLat = Vec3Sub(
      loftUVWToXYZ(spec.axis, Math.cos(aMid), Math.sin(aMid), -(r1 - r0) / dw),
      cap0Orig
    );

    if (r0 > 1e-5) {
      pushTriOutward(P0a, P0b, P1b, outLat);
    }
    if (r1 > 1e-5) {
      pushTriOutward(P0a, P1b, P1a, outLat);
    } else if (r0 > 1e-5) {
      // Pure cone apex at w1
      pushTriOutward(P0a, P0b, P1a, outLat);
    }

    // End caps
    if (r0 > 1e-5) {
      const C0 = loftUVWToXYZ(spec.axis, s0.centerU, s0.centerV, spec.w0);
      pushTriOutward(C0, P0a, P0b, outCap0);
    }
    if (r1 > 1e-5) {
      const C1 = loftUVWToXYZ(spec.axis, s1.centerU, s1.centerV, spec.w1);
      pushTriOutward(C1, P1a, P1b, outCap1);
    }
  }

  // Flat diametral chord wall for semicircular half-cones and half-frustums
  // Split at C0 and C1 so chord quads share exact edges with the end-cap triangle fans (zero T-junctions for BVH-CSG!)
  if (!isClosedRing) {
    const aEnd = startAngle + sweep;
    const C0 = loftUVWToXYZ(spec.axis, s0.centerU, s0.centerV, spec.w0);
    const C1 = loftUVWToXYZ(spec.axis, s1.centerU, s1.centerV, spec.w1);
    const S0a = loftUVWToXYZ(
      spec.axis,
      s0.centerU + r0 * Math.cos(startAngle),
      s0.centerV + r0 * Math.sin(startAngle),
      spec.w0
    );
    const S0b = loftUVWToXYZ(
      spec.axis,
      s0.centerU + r0 * Math.cos(aEnd),
      s0.centerV + r0 * Math.sin(aEnd),
      spec.w0
    );
    const S1a = loftUVWToXYZ(
      spec.axis,
      s1.centerU + r1 * Math.cos(startAngle),
      s1.centerV + r1 * Math.sin(startAngle),
      spec.w1
    );
    const S1b = loftUVWToXYZ(
      spec.axis,
      s1.centerU + r1 * Math.cos(aEnd),
      s1.centerV + r1 * Math.sin(aEnd),
      spec.w1
    );

    const midArcAngle = startAngle + 0.5 * sweep;
    const inwardArcDir = Vec3Sub(
      loftUVWToXYZ(spec.axis, Math.cos(midArcAngle), Math.sin(midArcAngle), 0),
      cap0Orig
    );
    const outChord = {
      x: -inwardArcDir.x,
      y: -inwardArcDir.y,
      z: -inwardArcDir.z,
    };
    void handed;

    if (r0 > 1e-5 && r1 > 1e-5) {
      pushTriOutward(S0a, C0, C1, outChord);
      pushTriOutward(S0a, C1, S1a, outChord);
      pushTriOutward(C0, S0b, S1b, outChord);
      pushTriOutward(C0, S1b, C1, outChord);
    } else if (r0 > 1e-5) {
      pushTriOutward(S0a, C0, C1, outChord);
      pushTriOutward(C0, S0b, C1, outChord);
    } else if (r1 > 1e-5) {
      pushTriOutward(C0, S1a, C1, outChord);
      pushTriOutward(C0, C1, S1b, outChord);
    }
  }

  return new Float32Array(tris);
}
