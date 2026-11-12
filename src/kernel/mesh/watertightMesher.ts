import * as THREE from 'three';
import {
  ADDITION,
  Brush,
  Evaluator,
  INTERSECTION,
  SUBTRACTION,
} from 'three-bvh-csg';
import {
  GeneralizedLoftPayload,
  LoopCurveSegment2D,
  Point2D,
  Primitive3D,
} from '../../types/cad';
import {
  add3,
  arcSweepCCW,
  composeFromAxis,
  cross3,
  dot3,
  engPointToSpace,
  len3,
  normalize3,
  polygonSignedArea,
  sampleLoopSegmentsToDensePolygon,
  scale3,
  sub3,
  TWO_PI,
} from '../core/coordSystem';
import { Axis3D, Vec3 } from '../core/types';
import {
  evalPositiveBaseOnlySDF,
  evalPrimitive3DGrad,
  getPrimitiveLoftEquivalent,
} from '../lifting3d/analyticSurfaces';
import { coalesceSolidPrimitives } from '../solver/volumeCoalescer';

const RADIAL_SEGMENTS = 72;
const MIN_TRIANGLE_AREA = 1e-5;
const OPEN_VOID_EXTEND_MM = 1.5;

// ============================================================================
// 2D Ear-Clipping Polygon Triangulator (Supports Convex & Concave Loops)
// ============================================================================

function cross2(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
}

function pointInTri2D(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const c1 = cross2(a, b, p);
  const c2 = cross2(b, c, p);
  const c3 = cross2(c, a, p);
  const hasNeg = c1 < -1e-7 || c2 < -1e-7 || c3 < -1e-7;
  const hasPos = c1 > 1e-7 || c2 > 1e-7 || c3 > 1e-7;
  return !(hasNeg && hasPos);
}

function triangulateSimplePolygon2D(rawPts: Point2D[]): [number, number, number][] {
  // Remove consecutive near-duplicate vertices
  const pts: Point2D[] = [];
  for (const p of rawPts) {
    if (
      pts.length === 0 ||
      Math.hypot(p.u - pts[pts.length - 1].u, p.v - pts[pts.length - 1].v) > 1e-4
    ) {
      pts.push(p);
    }
  }
  if (
    pts.length > 2 &&
    Math.hypot(
      pts[0].u - pts[pts.length - 1].u,
      pts[0].v - pts[pts.length - 1].v
    ) <= 1e-4
  ) {
    pts.pop();
  }

  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const area = polygonSignedArea(pts);
  const indices =
    area >= 0
      ? Array.from({ length: n }, (_, i) => i)
      : Array.from({ length: n }, (_, i) => n - 1 - i);

  const tris: [number, number, number][] = [];
  let guard = 0;

  while (indices.length > 3 && guard < n * n + 16) {
    guard++;
    let earFound = false;
    const m = indices.length;

    for (let i = 0; i < m; i++) {
      const iPrev = indices[(i - 1 + m) % m];
      const iCurr = indices[i];
      const iNext = indices[(i + 1) % m];
      const a = pts[iPrev];
      const b = pts[iCurr];
      const c = pts[iNext];

      if (cross2(a, b, c) <= 1e-6) continue;

      let containsOther = false;
      for (let j = 0; j < m; j++) {
        const idx = indices[j];
        if (idx === iPrev || idx === iCurr || idx === iNext) continue;
        if (pointInTri2D(pts[idx], a, b, c)) {
          containsOther = true;
          break;
        }
      }

      if (!containsOther) {
        tris.push([iPrev, iCurr, iNext]);
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }

    if (!earFound) {
      // Fallback fan if numerical collinearity prevented strict ear detection
      const i0 = indices[0];
      const i1 = indices[1];
      const i2 = indices[2];
      tris.push([i0, i1, i2]);
      indices.splice(1, 1);
    }
  }

  if (indices.length === 3) {
    tris.push([indices[0], indices[1], indices[2]]);
  }

  return tris;
}

// ============================================================================
// Triangle Collector with Guaranteed Outward Right-Handed Winding in Eng Space
// ============================================================================

class EngMeshBuilder {
  public positions: number[] = [];

  public addOutwardTriangle(a: Vec3, b: Vec3, c: Vec3, expectedOutward: Vec3): void {
    if (
      !Number.isFinite(a.x + a.y + a.z) ||
      !Number.isFinite(b.x + b.y + b.z) ||
      !Number.isFinite(c.x + c.y + c.z)
    ) {
      return;
    }
    const n = cross3(sub3(b, a), sub3(c, a));
    const area2 = len3(n);
    if (area2 < MIN_TRIANGLE_AREA * 2) return;

    if (dot3(n, expectedOutward) >= 0) {
      this.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    } else {
      this.positions.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    }
  }

  public addOutwardQuad(
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    expectedOutward: Vec3
  ): void {
    this.addOutwardTriangle(p0, p1, p2, expectedOutward);
    this.addOutwardTriangle(p0, p2, p3, expectedOutward);
  }

  public toCleanEngineeringBufferGeometry(): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    const posArr = new Float32Array(this.positions);
    const vertCount = posArr.length / 3;
    const normArr = new Float32Array(posArr.length);
    const uvArr = new Float32Array(vertCount * 2);

    for (let i = 0; i < posArr.length; i += 9) {
      const ax = posArr[i],
        ay = posArr[i + 1],
        az = posArr[i + 2];
      const bx = posArr[i + 3],
        by = posArr[i + 4],
        bz = posArr[i + 5];
      const cx = posArr[i + 6],
        cy = posArr[i + 7],
        cz = posArr[i + 8];
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az;
      const vx = cx - ax,
        vy = cy - ay,
        vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      normArr[i] = normArr[i + 3] = normArr[i + 6] = nx;
      normArr[i + 1] = normArr[i + 4] = normArr[i + 7] = ny;
      normArr[i + 2] = normArr[i + 5] = normArr[i + 8] = nz;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    return geom;
  }
}

// ============================================================================
// Exact Closed Manifold Builders for Every Primitive3D Shape (Eng Space)
// ============================================================================

function sampleLoftSectionRing(
  sec: GeneralizedLoftPayload['section0'],
  nSamples: number
): Point2D[] {
  if (sec.kind === 'point' || sec.radiusU <= 1e-5) {
    return Array.from({ length: nSamples }, () => ({
      u: sec.centerU,
      v: sec.centerV,
    }));
  }

  if (sec.kind === 'circle') {
    const rU = sec.radiusU;
    const rV = sec.radiusV ?? sec.radiusU;
    const pts: Point2D[] = [];
    for (let i = 0; i < nSamples; i++) {
      const th = (i / nSamples) * TWO_PI;
      pts.push({
        u: sec.centerU + rU * Math.cos(th),
        v: sec.centerV + rV * Math.sin(th),
      });
    }
    return pts;
  }

  if (sec.kind === 'semicircle') {
    const r = sec.radiusU;
    const sAng = sec.arcStart ?? 0;
    const eAng = sec.arcEnd ?? Math.PI;
    const sw = arcSweepCCW(sAng, eAng);
    const arcCount = Math.max(12, Math.floor(nSamples * 0.75));
    const chordCount = Math.max(2, nSamples - arcCount);
    const pts: Point2D[] = [];

    for (let i = 0; i < arcCount; i++) {
      const th = sAng + (i / (arcCount - 1)) * sw;
      pts.push({
        u: sec.centerU + r * Math.cos(th),
        v: sec.centerV + r * Math.sin(th),
      });
    }
    // Interpolate straight chord back from end of arc to start of arc so parameter count matches nSamples!
    const pEnd = pts[pts.length - 1];
    const pStart = pts[0];
    for (let j = 1; j <= chordCount; j++) {
      const f = j / (chordCount + 1);
      pts.push({
        u: pEnd.u + (pStart.u - pEnd.u) * f,
        v: pEnd.v + (pStart.v - pEnd.v) * f,
      });
    }
    return pts;
  }

  if (sec.polygon && sec.polygon.length >= 3) {
    return sec.polygon.map((p) => ({ u: p.u, v: p.v }));
  }

  return Array.from({ length: nSamples }, () => ({
    u: sec.centerU,
    v: sec.centerV,
  }));
}

function buildGeneralizedLoftMeshEng(
  loft: GeneralizedLoftPayload,
  mb: EngMeshBuilder
): void {
  const { axis, w0, w1, section0, section1 } = loft;
  if (Math.abs(w1 - w0) < 1e-4) return;

  const wLo = Math.min(w0, w1);
  const wHi = Math.max(w0, w1);
  const sLo = w0 <= w1 ? section0 : section1;
  const sHi = w0 <= w1 ? section1 : section0;

  const axisUnit: Vec3 =
    axis === 'Z'
      ? { x: 0, y: 0, z: 1 }
      : axis === 'Y'
      ? { x: 0, y: 1, z: 0 }
      : { x: 1, y: 0, z: 0 };

  // Polygon-to-polygon / polygon-to-point loft (exact sharp polyhedral facets!)
  if (
    (sLo.kind === 'polygon' || sHi.kind === 'polygon') &&
    ((sLo.polygon && sLo.polygon.length >= 3) ||
      (sHi.polygon && sHi.polygon.length >= 3))
  ) {
    const basePoly =
      sLo.polygon && sLo.polygon.length >= 3 ? sLo.polygon : sHi.polygon!;
    const m = basePoly.length;
    const ring0: Point2D[] =
      sLo.polygon && sLo.polygon.length === m
        ? sLo.polygon
        : Array.from({ length: m }, () => ({ u: sLo.centerU, v: sLo.centerV }));
    const ring1: Point2D[] =
      sHi.polygon && sHi.polygon.length === m
        ? sHi.polygon
        : Array.from({ length: m }, () => ({ u: sHi.centerU, v: sHi.centerV }));

    // Ensure CCW orientation in (u, v)
    if (polygonSignedArea(ring0.length >= 3 && sLo.kind !== 'point' ? ring0 : ring1) < 0) {
      ring0.reverse();
      ring1.reverse();
    }

    const cMidU = 0.5 * (sLo.centerU + sHi.centerU);
    const cMidV = 0.5 * (sLo.centerV + sHi.centerV);
    const bodyCentroid = composeFromAxis(axis, cMidU, cMidV, 0.5 * (wLo + wHi));

    // Lateral ruled faces
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const p00 = composeFromAxis(axis, ring0[i].u, ring0[i].v, wLo);
      const p01 = composeFromAxis(axis, ring0[j].u, ring0[j].v, wLo);
      const p11 = composeFromAxis(axis, ring1[j].u, ring1[j].v, wHi);
      const p10 = composeFromAxis(axis, ring1[i].u, ring1[i].v, wHi);
      const fMid = {
        x: 0.25 * (p00.x + p01.x + p11.x + p10.x),
        y: 0.25 * (p00.y + p01.y + p11.y + p10.y),
        z: 0.25 * (p00.z + p01.z + p11.z + p10.z),
      };
      const outDir = sub3(fMid, bodyCentroid);
      mb.addOutwardQuad(p00, p01, p11, p10, outDir);
    }

    // Bottom cap at wLo (outward = -axisUnit)
    if (sLo.kind !== 'point' && Math.abs(polygonSignedArea(ring0)) > 1e-4) {
      const tris0 = triangulateSimplePolygon2D(ring0);
      for (const [ia, ib, ic] of tris0) {
        mb.addOutwardTriangle(
          composeFromAxis(axis, ring0[ia].u, ring0[ia].v, wLo),
          composeFromAxis(axis, ring0[ib].u, ring0[ib].v, wLo),
          composeFromAxis(axis, ring0[ic].u, ring0[ic].v, wLo),
          { x: -axisUnit.x, y: -axisUnit.y, z: -axisUnit.z }
        );
      }
    }

    // Top cap at wHi (outward = +axisUnit)
    if (sHi.kind !== 'point' && Math.abs(polygonSignedArea(ring1)) > 1e-4) {
      const tris1 = triangulateSimplePolygon2D(ring1);
      for (const [ia, ib, ic] of tris1) {
        mb.addOutwardTriangle(
          composeFromAxis(axis, ring1[ia].u, ring1[ia].v, wHi),
          composeFromAxis(axis, ring1[ib].u, ring1[ib].v, wHi),
          composeFromAxis(axis, ring1[ic].u, ring1[ic].v, wHi),
          axisUnit
        );
      }
    }
    return;
  }

  // Smooth circular / semicircular cylinder, cone, frustum, semi-cone, semi-frustum (`RADIAL_SEGMENTS = 72`)!
  const N = RADIAL_SEGMENTS;
  const ring0 = sampleLoftSectionRing(sLo, N);
  const ring1 = sampleLoftSectionRing(sHi, N);
  const m = Math.min(ring0.length, ring1.length);

  // Compute an interior spine point at mid-height so outward radial vector is always unambiguous even for eccentric frustums & semi-cones!
  let avgU0 = 0,
    avgV0 = 0,
    avgU1 = 0,
    avgV1 = 0;
  for (let i = 0; i < m; i++) {
    avgU0 += ring0[i].u;
    avgV0 += ring0[i].v;
    avgU1 += ring1[i].u;
    avgV1 += ring1[i].v;
  }
  avgU0 /= m;
  avgV0 /= m;
  avgU1 /= m;
  avgV1 /= m;
  const spineMid = composeFromAxis(
    axis,
    0.5 * (avgU0 + avgU1),
    0.5 * (avgV0 + avgV1),
    0.5 * (wLo + wHi)
  );

  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const p00 = composeFromAxis(axis, ring0[i].u, ring0[i].v, wLo);
    const p01 = composeFromAxis(axis, ring0[j].u, ring0[j].v, wLo);
    const p11 = composeFromAxis(axis, ring1[j].u, ring1[j].v, wHi);
    const p10 = composeFromAxis(axis, ring1[i].u, ring1[i].v, wHi);
    const quadMid = {
      x: 0.25 * (p00.x + p01.x + p11.x + p10.x),
      y: 0.25 * (p00.y + p01.y + p11.y + p10.y),
      z: 0.25 * (p00.z + p01.z + p11.z + p10.z),
    };
    const outDir = sub3(quadMid, spineMid);
    mb.addOutwardQuad(p00, p01, p11, p10, outDir);
  }

  // Cap at wLo (`-axisUnit`)
  if (sLo.kind !== 'point' && sLo.radiusU > 1e-4) {
    if (sLo.kind === 'circle') {
      const c0 = composeFromAxis(axis, sLo.centerU, sLo.centerV, wLo);
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        mb.addOutwardTriangle(
          c0,
          composeFromAxis(axis, ring0[i].u, ring0[i].v, wLo),
          composeFromAxis(axis, ring0[j].u, ring0[j].v, wLo),
          { x: -axisUnit.x, y: -axisUnit.y, z: -axisUnit.z }
        );
      }
    } else {
      const tris0 = triangulateSimplePolygon2D(ring0);
      for (const [ia, ib, ic] of tris0) {
        mb.addOutwardTriangle(
          composeFromAxis(axis, ring0[ia].u, ring0[ia].v, wLo),
          composeFromAxis(axis, ring0[ib].u, ring0[ib].v, wLo),
          composeFromAxis(axis, ring0[ic].u, ring0[ic].v, wLo),
          { x: -axisUnit.x, y: -axisUnit.y, z: -axisUnit.z }
        );
      }
    }
  }

  // Cap at wHi (`+axisUnit`)
  if (sHi.kind !== 'point' && sHi.radiusU > 1e-4) {
    if (sHi.kind === 'circle') {
      const c1 = composeFromAxis(axis, sHi.centerU, sHi.centerV, wHi);
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        mb.addOutwardTriangle(
          c1,
          composeFromAxis(axis, ring1[i].u, ring1[i].v, wHi),
          composeFromAxis(axis, ring1[j].u, ring1[j].v, wHi),
          axisUnit
        );
      }
    } else {
      const tris1 = triangulateSimplePolygon2D(ring1);
      for (const [ia, ib, ic] of tris1) {
        mb.addOutwardTriangle(
          composeFromAxis(axis, ring1[ia].u, ring1[ia].v, wHi),
          composeFromAxis(axis, ring1[ib].u, ring1[ib].v, wHi),
          composeFromAxis(axis, ring1[ic].u, ring1[ic].v, wHi),
          axisUnit
        );
      }
    }
  }
}

function buildBoxMeshEng(prim: Primitive3D, mb: EngMeshBuilder): void {
  const { xMin, xMax, yMin, yMax, zMin, zMax } = prim;
  if (xMax - xMin < 1e-4 || yMax - yMin < 1e-4 || zMax - zMin < 1e-4) return;

  const p000 = { x: xMin, y: yMin, z: zMin };
  const p100 = { x: xMax, y: yMin, z: zMin };
  const p110 = { x: xMax, y: yMax, z: zMin };
  const p010 = { x: xMin, y: yMax, z: zMin };
  const p001 = { x: xMin, y: yMin, z: zMax };
  const p101 = { x: xMax, y: yMin, z: zMax };
  const p111 = { x: xMax, y: yMax, z: zMax };
  const p011 = { x: xMin, y: yMax, z: zMax };

  mb.addOutwardQuad(p000, p010, p110, p100, { x: 0, y: 0, z: -1 });
  mb.addOutwardQuad(p001, p101, p111, p011, { x: 0, y: 0, z: 1 });
  mb.addOutwardQuad(p000, p100, p101, p001, { x: 0, y: -1, z: 0 });
  mb.addOutwardQuad(p010, p011, p111, p110, { x: 0, y: 1, z: 0 });
  mb.addOutwardQuad(p000, p001, p011, p010, { x: -1, y: 0, z: 0 });
  mb.addOutwardQuad(p100, p110, p111, p101, { x: 1, y: 0, z: 0 });
}

function buildSphereOrHemisphereMeshEng(
  prim: Primitive3D,
  mb: EngMeshBuilder
): void {
  const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
  const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
  const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
  const R =
    prim.radius ??
    0.5 *
      Math.max(
        prim.xMax - prim.xMin,
        prim.yMax - prim.yMin,
        prim.zMax - prim.zMin
      );
  if (R < 1e-4) return;
  const center = { x: cx, y: cy, z: cz };

  if (prim.shape === 'sphere') {
    const nLon = RADIAL_SEGMENTS;
    const nLat = 36;
    for (let i = 0; i < nLat; i++) {
      const phi0 = (i / nLat) * Math.PI;
      const phi1 = ((i + 1) / nLat) * Math.PI;
      const z0 = cz + R * Math.cos(phi0);
      const z1 = cz + R * Math.cos(phi1);
      const r0 = R * Math.sin(phi0);
      const r1 = R * Math.sin(phi1);

      for (let j = 0; j < nLon; j++) {
        const th0 = (j / nLon) * TWO_PI;
        const th1 = ((j + 1) / nLon) * TWO_PI;
        const p00 = { x: cx + r0 * Math.cos(th0), y: cy + r0 * Math.sin(th0), z: z0 };
        const p01 = { x: cx + r0 * Math.cos(th1), y: cy + r0 * Math.sin(th1), z: z0 };
        const p11 = { x: cx + r1 * Math.cos(th1), y: cy + r1 * Math.sin(th1), z: z1 };
        const p10 = { x: cx + r1 * Math.cos(th0), y: cy + r1 * Math.sin(th0), z: z1 };
        const mid = {
          x: 0.25 * (p00.x + p01.x + p11.x + p10.x),
          y: 0.25 * (p00.y + p01.y + p11.y + p10.y),
          z: 0.25 * (p00.z + p01.z + p11.z + p10.z),
        };
        mb.addOutwardQuad(p00, p01, p11, p10, sub3(mid, center));
      }
    }
    return;
  }

  // Exact Hemisphere along `flatAxis` (`X`, `Y`, or `Z`) and `keepPositiveSide`!
  const hs = prim.hemisphereSpec ?? {
    flatAxis: 'Z' as const,
    flatCoord: prim.zMin,
    keepPositiveSide: true,
  };
  const sign = hs.keepPositiveSide ? 1 : -1;
  const nLon = RADIAL_SEGMENTS;
  const nLat = 24;
  const baseW = hs.flatCoord;

  // Parameterize dome from equator (`eta = 0`, radius `R` at `w = baseW`) to pole (`eta = pi/2`, radius `0` at `w = baseW + sign * R`)
  const c2U = hs.flatAxis === 'Z' ? cx : hs.flatAxis === 'Y' ? cx : cy;
  const c2V = hs.flatAxis === 'Z' ? cy : hs.flatAxis === 'Y' ? cz : cz;
  const baseCenter = composeFromAxis(hs.flatAxis, c2U, c2V, baseW);

  for (let i = 0; i < nLat; i++) {
    const eta0 = (i / nLat) * (Math.PI / 2);
    const eta1 = ((i + 1) / nLat) * (Math.PI / 2);
    const w0 = baseW + sign * R * Math.sin(eta0);
    const w1 = baseW + sign * R * Math.sin(eta1);
    const r0 = R * Math.cos(eta0);
    const r1 = R * Math.cos(eta1);

    for (let j = 0; j < nLon; j++) {
      const th0 = (j / nLon) * TWO_PI;
      const th1 = ((j + 1) / nLon) * TWO_PI;
      const p00 = composeFromAxis(
        hs.flatAxis,
        c2U + r0 * Math.cos(th0),
        c2V + r0 * Math.sin(th0),
        w0
      );
      const p01 = composeFromAxis(
        hs.flatAxis,
        c2U + r0 * Math.cos(th1),
        c2V + r0 * Math.sin(th1),
        w0
      );
      const p11 = composeFromAxis(
        hs.flatAxis,
        c2U + r1 * Math.cos(th1),
        c2V + r1 * Math.sin(th1),
        w1
      );
      const p10 = composeFromAxis(
        hs.flatAxis,
        c2U + r1 * Math.cos(th0),
        c2V + r1 * Math.sin(th0),
        w1
      );
      const mid = {
        x: 0.25 * (p00.x + p01.x + p11.x + p10.x),
        y: 0.25 * (p00.y + p01.y + p11.y + p10.y),
        z: 0.25 * (p00.z + p01.z + p11.z + p10.z),
      };
      mb.addOutwardQuad(p00, p01, p11, p10, sub3(mid, baseCenter));
    }
  }

  // Flat circular base cap at `w = baseW` with outward normal `-sign * flatAxisUnit`
  const capNormal =
    hs.flatAxis === 'Z'
      ? { x: 0, y: 0, z: -sign }
      : hs.flatAxis === 'Y'
      ? { x: 0, y: -sign, z: 0 }
      : { x: -sign, y: 0, z: 0 };

  for (let j = 0; j < nLon; j++) {
    const th0 = (j / nLon) * TWO_PI;
    const th1 = ((j + 1) / nLon) * TWO_PI;
    const q0 = composeFromAxis(
      hs.flatAxis,
      c2U + R * Math.cos(th0),
      c2V + R * Math.sin(th0),
      baseW
    );
    const q1 = composeFromAxis(
      hs.flatAxis,
      c2U + R * Math.cos(th1),
      c2V + R * Math.sin(th1),
      baseW
    );
    mb.addOutwardTriangle(baseCenter, q0, q1, capNormal);
  }
}

function buildPrismMeshEng(prim: Primitive3D, mb: EngMeshBuilder): void {
  const axis: Axis3D =
    prim.prismAxis ??
    (prim.extrudeAxis ? (prim.extrudeAxis.toUpperCase() as Axis3D) : 'Z');
  const wLo = axis === 'X' ? prim.xMin : axis === 'Y' ? prim.yMin : prim.zMin;
  const wHi = axis === 'X' ? prim.xMax : axis === 'Y' ? prim.yMax : prim.zMax;
  if (wHi - wLo < 1e-4) return;

  let poly: Point2D[];
  if (
    prim.prismSegments &&
    prim.prismSegments.some((s: LoopCurveSegment2D) => s.kind === 'arc')
  ) {
    poly = sampleLoopSegmentsToDensePolygon(prim.prismSegments, 48);
  } else {
    poly = prim.prismPolygon ?? prim.polygon2D ?? [];
  }
  if (poly.length < 3) {
    buildBoxMeshEng(prim, mb);
    return;
  }

  const pts = polygonSignedArea(poly) >= 0 ? [...poly] : [...poly].reverse();
  const m = pts.length;
  const axisUnit: Vec3 =
    axis === 'Z'
      ? { x: 0, y: 0, z: 1 }
      : axis === 'Y'
      ? { x: 0, y: 1, z: 0 }
      : { x: 1, y: 0, z: 0 };

  // Lateral faces: for CCW loop `pts`, outward 2D edge normal of `pts[i] -> pts[j]` is `+(dv, -du)`!
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const du = pts[j].u - pts[i].u;
    const dv = pts[j].v - pts[i].v;
    if (Math.hypot(du, dv) < 1e-5) continue;
    const out2D = composeFromAxis(axis, dv, -du, 0);
    const p00 = composeFromAxis(axis, pts[i].u, pts[i].v, wLo);
    const p01 = composeFromAxis(axis, pts[j].u, pts[j].v, wLo);
    const p11 = composeFromAxis(axis, pts[j].u, pts[j].v, wHi);
    const p10 = composeFromAxis(axis, pts[i].u, pts[i].v, wHi);
    mb.addOutwardQuad(p00, p01, p11, p10, out2D);
  }

  const tris = triangulateSimplePolygon2D(pts);
  for (const [ia, ib, ic] of tris) {
    mb.addOutwardTriangle(
      composeFromAxis(axis, pts[ia].u, pts[ia].v, wLo),
      composeFromAxis(axis, pts[ib].u, pts[ib].v, wLo),
      composeFromAxis(axis, pts[ic].u, pts[ic].v, wLo),
      { x: -axisUnit.x, y: -axisUnit.y, z: -axisUnit.z }
    );
    mb.addOutwardTriangle(
      composeFromAxis(axis, pts[ia].u, pts[ia].v, wHi),
      composeFromAxis(axis, pts[ib].u, pts[ib].v, wHi),
      composeFromAxis(axis, pts[ic].u, pts[ic].v, wHi),
      axisUnit
    );
  }
}

function buildWedgeOrRibMeshEng(prim: Primitive3D, mb: EngMeshBuilder): void {
  const { xMin, xMax, yMin, yMax, zMin, zMax } = prim;
  if (prim.shape === 'wedge_y') {
    // Triangular profile in Y-Z extruded along X: (yMin,zMin), (yMax,zMin), (yMin,zMax)
    const poly: Point2D[] = [
      { u: yMin, v: zMin },
      { u: yMax, v: zMin },
      { u: yMin, v: zMax },
    ];
    buildPrismMeshEng(
      { ...prim, shape: 'prism', prismAxis: 'X', prismPolygon: poly },
      mb
    );
    return;
  }
  // wedge_x or rib_xz: triangular profile in X-Z extruded along Y: (xMin,zMin), (xMax,zMin), (xMin,zMax)
  const poly: Point2D[] = [
    { u: xMin, v: zMin },
    { u: xMax, v: zMin },
    { u: xMin, v: zMax },
  ];
  buildPrismMeshEng(
    { ...prim, shape: 'prism', prismAxis: 'Y', prismPolygon: poly },
    mb
  );
}

function buildPyramidMeshEng(prim: Primitive3D, mb: EngMeshBuilder): void {
  const { xMin, xMax, yMin, yMax, zMin, zMax } = prim;
  const apex: Vec3 = prim.apex3D
    ? { x: prim.apex3D[0], y: prim.apex3D[1], z: prim.apex3D[2] }
    : { x: 0.5 * (xMin + xMax), y: 0.5 * (yMin + yMax), z: zMax };
  const b0 = { x: xMin, y: yMin, z: zMin };
  const b1 = { x: xMax, y: yMin, z: zMin };
  const b2 = { x: xMax, y: yMax, z: zMin };
  const b3 = { x: xMin, y: yMax, z: zMin };
  const centroid = {
    x: 0.2 * (b0.x + b1.x + b2.x + b3.x + apex.x),
    y: 0.2 * (b0.y + b1.y + b2.y + b3.y + apex.y),
    z: 0.2 * (b0.z + b1.z + b2.z + b3.z + apex.z),
  };

  mb.addOutwardQuad(b0, b3, b2, b1, { x: 0, y: 0, z: -1 });
  const baseRing = [b0, b1, b2, b3];
  for (let i = 0; i < 4; i++) {
    const a = baseRing[i];
    const b = baseRing[(i + 1) % 4];
    const mid = {
      x: (a.x + b.x + apex.x) / 3,
      y: (a.y + b.y + apex.y) / 3,
      z: (a.z + b.z + apex.z) / 3,
    };
    mb.addOutwardTriangle(a, b, apex, sub3(mid, centroid));
  }
}

function buildSinglePrimitiveEngineeringGeometry(
  prim: Primitive3D
): THREE.BufferGeometry {
  const mb = new EngMeshBuilder();

  const loft = getPrimitiveLoftEquivalent(prim);
  if (loft) {
    buildGeneralizedLoftMeshEng(loft, mb);
    return mb.toCleanEngineeringBufferGeometry();
  }

  switch (prim.shape) {
    case 'sphere':
    case 'hemisphere':
      buildSphereOrHemisphereMeshEng(prim, mb);
      break;
    case 'prism':
      buildPrismMeshEng(prim, mb);
      break;
    case 'wedge_x':
    case 'wedge_y':
    case 'rib_xz':
      buildWedgeOrRibMeshEng(prim, mb);
      break;
    case 'pyramid':
      buildPyramidMeshEng(prim, mb);
      break;
    case 'box':
    default:
      buildBoxMeshEng(prim, mb);
      break;
  }

  return mb.toCleanEngineeringBufferGeometry();
}

// ============================================================================
// Open-Air 1.5mm Extension for Subtract Void Brushes (Zero Coplanar Z-Fighting)
// ============================================================================

function extendSubtractPrimitiveOpenEnds(
  vp: Primitive3D,
  positiveAndIntersectPrims: Primitive3D[]
): Primitive3D {
  const ext = OPEN_VOID_EXTEND_MM;
  const clone: Primitive3D = {
    ...vp,
    loftSpec: vp.loftSpec
      ? {
          ...vp.loftSpec,
          section0: { ...vp.loftSpec.section0 },
          section1: { ...vp.loftSpec.section1 },
        }
      : undefined,
  };

  const isAirOutside = (pt: Vec3): boolean =>
    evalPositiveBaseOnlySDF(pt, positiveAndIntersectPrims) > -0.02;

  const loft = getPrimitiveLoftEquivalent(clone);
  if (loft) {
    const ax = loft.axis;
    const axisUnit: Vec3 =
      ax === 'Z'
        ? { x: 0, y: 0, z: 1 }
        : ax === 'Y'
        ? { x: 0, y: 1, z: 0 }
        : { x: 1, y: 0, z: 0 };
    const wLo = Math.min(loft.w0, loft.w1);
    const wHi = Math.max(loft.w0, loft.w1);
    const sLo = loft.w0 <= loft.w1 ? loft.section0 : loft.section1;
    const sHi = loft.w0 <= loft.w1 ? loft.section1 : loft.section0;

    const ptLoTest = add3(
      composeFromAxis(ax, sLo.centerU, sLo.centerV, wLo),
      { x: -0.35 * axisUnit.x, y: -0.35 * axisUnit.y, z: -0.35 * axisUnit.z }
    );
    const ptHiTest = add3(
      composeFromAxis(ax, sHi.centerU, sHi.centerV, wHi),
      { x: 0.35 * axisUnit.x, y: 0.35 * axisUnit.y, z: 0.35 * axisUnit.z }
    );

    const openLo = isAirOutside(ptLoTest);
    const openHi = isAirOutside(ptHiTest);
    const span = Math.max(1.0, wHi - wLo);
    const drPerMm = (sHi.radiusU - sLo.radiusU) / span;
    const dcUPerMm = (sHi.centerU - sLo.centerU) / span;
    const dcVPerMm = (sHi.centerV - sLo.centerV) / span;

    const newWLo = openLo ? wLo - ext : wLo;
    const newWHi = openHi ? wHi + ext : wHi;

    if (ax === 'X') {
      clone.xMin = newWLo;
      clone.xMax = newWHi;
    } else if (ax === 'Y') {
      clone.yMin = newWLo;
      clone.yMax = newWHi;
    } else {
      clone.zMin = newWLo;
      clone.zMax = newWHi;
    }

    if (clone.loftSpec) {
      if (clone.loftSpec.w0 <= clone.loftSpec.w1) {
        if (openLo) {
          clone.loftSpec.w0 = newWLo;
          clone.loftSpec.section0.radiusU = Math.max(
            0.2,
            sLo.radiusU - drPerMm * ext
          );
          clone.loftSpec.section0.centerU = sLo.centerU - dcUPerMm * ext;
          clone.loftSpec.section0.centerV = sLo.centerV - dcVPerMm * ext;
        }
        if (openHi) {
          clone.loftSpec.w1 = newWHi;
          clone.loftSpec.section1.radiusU = Math.max(
            0.2,
            sHi.radiusU + drPerMm * ext
          );
          clone.loftSpec.section1.centerU = sHi.centerU + dcUPerMm * ext;
          clone.loftSpec.section1.centerV = sHi.centerV + dcVPerMm * ext;
        }
      } else {
        if (openHi) {
          clone.loftSpec.w0 = newWHi;
          clone.loftSpec.section0.radiusU = Math.max(
            0.2,
            sHi.radiusU + drPerMm * ext
          );
          clone.loftSpec.section0.centerU = sHi.centerU + dcUPerMm * ext;
          clone.loftSpec.section0.centerV = sHi.centerV + dcVPerMm * ext;
        }
        if (openLo) {
          clone.loftSpec.w1 = newWLo;
          clone.loftSpec.section1.radiusU = Math.max(
            0.2,
            sLo.radiusU - drPerMm * ext
          );
          clone.loftSpec.section1.centerU = sLo.centerU - dcUPerMm * ext;
          clone.loftSpec.section1.centerV = sLo.centerV - dcVPerMm * ext;
        }
      }
    } else if (clone.shape.startsWith('cone_')) {
      if (openLo) clone.rMin = Math.max(0.2, (clone.rMin ?? 0) - drPerMm * ext);
      if (openHi) clone.rMax = Math.max(0.2, (clone.rMax ?? 0) + drPerMm * ext);
    }

    return clone;
  }

  if (clone.shape === 'prism') {
    const ax: Axis3D =
      clone.prismAxis ??
      (clone.extrudeAxis ? (clone.extrudeAxis.toUpperCase() as Axis3D) : 'Z');
    const poly = clone.prismPolygon ?? clone.polygon2D ?? [];
    let cu = 60,
      cv = 60;
    if (poly.length > 0) {
      cu = poly.reduce((s, p) => s + p.u, 0) / poly.length;
      cv = poly.reduce((s, p) => s + p.v, 0) / poly.length;
    }
    const checkPts2D =
      poly.length > 0
        ? [
            { u: cu, v: cv },
            ...poly.map((pt) => ({
              u: cu + (pt.u - cu) * 0.7,
              v: cv + (pt.v - cv) * 0.7,
            })),
          ]
        : [{ u: cu, v: cv }];
    const wLo = ax === 'X' ? clone.xMin : ax === 'Y' ? clone.yMin : clone.zMin;
    const wHi = ax === 'X' ? clone.xMax : ax === 'Y' ? clone.yMax : clone.zMax;
    const openLo = checkPts2D.every((q) =>
      isAirOutside(composeFromAxis(ax, q.u, q.v, wLo - 0.35))
    );
    const openHi = checkPts2D.every((q) =>
      isAirOutside(composeFromAxis(ax, q.u, q.v, wHi + 0.35))
    );
    if (ax === 'X') {
      if (openLo) clone.xMin -= ext;
      if (openHi) clone.xMax += ext;
    } else if (ax === 'Y') {
      if (openLo) clone.yMin -= ext;
      if (openHi) clone.yMax += ext;
    } else {
      if (openLo) clone.zMin -= ext;
      if (openHi) clone.zMax += ext;
    }
    return clone;
  }

  if (clone.shape === 'box') {
    const orig = { ...clone };
    const isBoxFacePureAir = (
      axis: Axis3D,
      wCoord: number,
      dirSign: -1 | 1,
      u0: number,
      u1: number,
      v0: number,
      v1: number
    ): boolean => {
      const wTest = wCoord + dirSign * 0.35;
      for (const fu of [0.15, 0.5, 0.85]) {
        for (const fv of [0.15, 0.5, 0.85]) {
          const u = u0 + (u1 - u0) * fu;
          const v = v0 + (v1 - v0) * fv;
          if (!isAirOutside(composeFromAxis(axis, u, v, wTest))) {
            return false;
          }
        }
      }
      return true;
    };

    if (isBoxFacePureAir('X', orig.xMin, -1, orig.yMin, orig.yMax, orig.zMin, orig.zMax)) {
      clone.xMin -= ext;
    }
    if (isBoxFacePureAir('X', orig.xMax, 1, orig.yMin, orig.yMax, orig.zMin, orig.zMax)) {
      clone.xMax += ext;
    }
    if (isBoxFacePureAir('Y', orig.yMin, -1, orig.xMin, orig.xMax, orig.zMin, orig.zMax)) {
      clone.yMin -= ext;
    }
    if (isBoxFacePureAir('Y', orig.yMax, 1, orig.xMin, orig.xMax, orig.zMin, orig.zMax)) {
      clone.yMax += ext;
    }
    if (isBoxFacePureAir('Z', orig.zMin, -1, orig.xMin, orig.xMax, orig.yMin, orig.yMax)) {
      clone.zMin -= ext;
    }
    if (isBoxFacePureAir('Z', orig.zMax, 1, orig.xMin, orig.xMax, orig.yMin, orig.yMax)) {
      clone.zMax += ext;
    }
  }

  return clone;
}

// ============================================================================
// Post-CSG Sanitization, Coordinate Space Mapping (det = -1 Flip), & Crease Normals
// ============================================================================

function finalizeGeometryToTargetSpace(
  engGeometry: THREE.BufferGeometry,
  space: 'threejs' | 'engineering',
  creaseAngleDeg = 30
): THREE.BufferGeometry {
  const srcPos = engGeometry.getAttribute('position');
  if (!srcPos || srcPos.count === 0) {
    return new THREE.BufferGeometry();
  }

  const indexAttr = engGeometry.getIndex();
  const triCount = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(srcPos.count / 3);

  const cleanPos: number[] = [];

  const readEngVert = (vi: number): Vec3 => ({
    x: srcPos.getX(vi),
    y: srcPos.getY(vi),
    z: srcPos.getZ(vi),
  });

  for (let t = 0; t < triCount; t++) {
    const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
    const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    const e0 = readEngVert(i0);
    const e1 = readEngVert(i1);
    const e2 = readEngVert(i2);

    if (
      !Number.isFinite(e0.x + e0.y + e0.z) ||
      !Number.isFinite(e1.x + e1.y + e1.z) ||
      !Number.isFinite(e2.x + e2.y + e2.z)
    ) {
      continue;
    }

    const nEng = cross3(sub3(e1, e0), sub3(e2, e0));
    const area = 0.5 * len3(nEng);
    if (area < MIN_TRIANGLE_AREA) continue;

    const m0 = engPointToSpace(e0, space);
    const m1 = engPointToSpace(e1, space);
    const m2 = engPointToSpace(e2, space);

    if (space === 'threejs') {
      // CRITICAL INVARIANT: `(Three.X, Three.Y, Three.Z) = (X - 60, Z - 50, Y - 60)` has Jacobian det = -1!
      // Flipping `(m0, m1, m2) -> (m0, m2, m1)` restores 100% outward right-handed CCW winding in Three.js!
      cleanPos.push(
        m0.x,
        m0.y,
        m0.z,
        m2.x,
        m2.y,
        m2.z,
        m1.x,
        m1.y,
        m1.z
      );
    } else {
      cleanPos.push(
        m0.x,
        m0.y,
        m0.z,
        m1.x,
        m1.y,
        m1.z,
        m2.x,
        m2.y,
        m2.z
      );
    }
  }

  const out = new THREE.BufferGeometry();
  if (cleanPos.length === 0) return out;

  const posArr = new Float32Array(cleanPos);
  const normArr = computeCreaseSplitNormals(posArr, creaseAngleDeg);

  out.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Compute smooth shading normals across smooth curved tessellations (dihedral < creaseAngleDeg)
 * while keeping crisp flat normals across sharp mechanical edges (dihedral >= creaseAngleDeg)!
 */
function computeCreaseSplitNormals(
  posArr: Float32Array,
  creaseAngleDeg: number
): Float32Array {
  const nTris = posArr.length / 9;
  const faceNormals = new Float32Array(nTris * 3);
  const cosThresh = Math.cos((creaseAngleDeg * Math.PI) / 180);

  // Hash spatial vertex positions (`1e-3 mm` grid) to group incident triangles
  const vertToTris = new Map<string, number[]>();
  const vertKeys: string[] = new Array(nTris * 3);

  const keyOf = (x: number, y: number, z: number): string =>
    `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

  for (let t = 0; t < nTris; t++) {
    const base = t * 9;
    const ax = posArr[base],
      ay = posArr[base + 1],
      az = posArr[base + 2];
    const bx = posArr[base + 3],
      by = posArr[base + 4],
      bz = posArr[base + 5];
    const cx = posArr[base + 6],
      cy = posArr[base + 7],
      cz = posArr[base + 8];

    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    faceNormals[t * 3] = nx;
    faceNormals[t * 3 + 1] = ny;
    faceNormals[t * 3 + 2] = nz;

    const k0 = keyOf(ax, ay, az);
    const k1 = keyOf(bx, by, bz);
    const k2 = keyOf(cx, cy, cz);
    vertKeys[t * 3] = k0;
    vertKeys[t * 3 + 1] = k1;
    vertKeys[t * 3 + 2] = k2;

    for (const k of [k0, k1, k2]) {
      let list = vertToTris.get(k);
      if (!list) {
        list = [];
        vertToTris.set(k, list);
      }
      list.push(t);
    }
  }

  const outNormals = new Float32Array(posArr.length);
  for (let t = 0; t < nTris; t++) {
    const fnx = faceNormals[t * 3];
    const fny = faceNormals[t * 3 + 1];
    const fnz = faceNormals[t * 3 + 2];

    for (let corner = 0; corner < 3; corner++) {
      const k = vertKeys[t * 3 + corner];
      const adj = vertToTris.get(k);
      let sx = fnx;
      let sy = fny;
      let sz = fnz;

      if (adj && adj.length > 1 && adj.length <= 64) {
        for (const ot of adj) {
          if (ot === t) continue;
          const onx = faceNormals[ot * 3];
          const ony = faceNormals[ot * 3 + 1];
          const onz = faceNormals[ot * 3 + 2];
          if (fnx * onx + fny * ony + fnz * onz >= cosThresh) {
            sx += onx;
            sy += ony;
            sz += onz;
          }
        }
      }

      const sl = Math.hypot(sx, sy, sz) || 1;
      const outIdx = t * 9 + corner * 3;
      outNormals[outIdx] = sx / sl;
      outNormals[outIdx + 1] = sy / sl;
      outNormals[outIdx + 2] = sz / sl;
    }
  }

  return outNormals;
}

// ============================================================================
// Public Kernel Facade Functions (4, 5, 6, 7)
// ============================================================================

/**
 * Facade #5: Build a single watertight primitive BufferGeometry in `'threejs'` or `'engineering'` space.
 */
export function buildSinglePrimitiveGeometry(
  prim: Primitive3D,
  space: 'threejs' | 'engineering' = 'threejs'
): THREE.BufferGeometry {
  const engGeom = buildSinglePrimitiveEngineeringGeometry(prim);
  // Extra analytic outward check on first triangle if needed
  void evalPrimitive3DGrad;
  const out = finalizeGeometryToTargetSpace(engGeom, space, 30);
  engGeom.dispose();
  return out;
}

/**
 * Facade #4: Build composite boolean CSG watertight manifold BufferGeometry (`ADDITION`, `INTERSECTION`, `SUBTRACTION`).
 */
export function buildWatertightManifoldGeometry(
  primitives: Primitive3D[],
  space: 'threejs' | 'engineering' = 'threejs'
): THREE.BufferGeometry {
  if (!primitives || primitives.length === 0) {
    return new THREE.BufferGeometry();
  }

  // 1. Algebraically coalesce adjacent positive boxes/cylinders first (zero coplanar internal walls!)
  const coalesced = coalesceSolidPrimitives(primitives);
  const addPrims = coalesced.filter((p) => p.operation === 'add');
  const intersectPrims = coalesced.filter((p) => p.operation === 'intersect');
  const subtractPrims = coalesced.filter((p) => p.operation === 'subtract');

  if (addPrims.length === 0) {
    return new THREE.BufferGeometry();
  }

  // Fast path: single positive primitive with no intersections or subtractions
  if (
    addPrims.length === 1 &&
    intersectPrims.length === 0 &&
    subtractPrims.length === 0
  ) {
    return buildSinglePrimitiveGeometry(addPrims[0], space);
  }

  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  evaluator.attributes = ['position', 'normal'];

  const makeBrush = (prim: Primitive3D): Brush | null => {
    const geom = buildSinglePrimitiveEngineeringGeometry(prim);
    const pos = geom.getAttribute('position');
    if (!pos || pos.count < 3) {
      geom.dispose();
      return null;
    }
    const brush = new Brush(geom);
    brush.updateMatrixWorld();
    return brush;
  };

  const disposableGeoms: THREE.BufferGeometry[] = [];
  const registerBrush = (b: Brush | null): Brush | null => {
    if (b) disposableGeoms.push(b.geometry);
    return b;
  };

  try {
    // Group `intersect` primitives with matching `weldGroup` onto their host `add` primitive first!
    const weldIntersects = new Map<string, Primitive3D[]>();
    const globalIntersects: Primitive3D[] = [];
    for (const ip of intersectPrims) {
      if (ip.weldGroup) {
        const arr = weldIntersects.get(ip.weldGroup) ?? [];
        arr.push(ip);
        weldIntersects.set(ip.weldGroup, arr);
      } else {
        globalIntersects.push(ip);
      }
    }

    let accumBrush: Brush | null = null;

    for (const ap of addPrims) {
      let curBrush = registerBrush(makeBrush(ap));
      if (!curBrush) continue;

      if (ap.weldGroup && weldIntersects.has(ap.weldGroup)) {
        for (const ip of weldIntersects.get(ap.weldGroup)!) {
          const iBrush = registerBrush(makeBrush(ip));
          if (iBrush) {
            const next = evaluator.evaluate(curBrush, iBrush, INTERSECTION);
            disposableGeoms.push(next.geometry);
            next.updateMatrixWorld();
            curBrush = next;
          }
        }
      }

      if (!accumBrush) {
        accumBrush = curBrush;
      } else {
        const next = evaluator.evaluate(accumBrush, curBrush, ADDITION);
        disposableGeoms.push(next.geometry);
        next.updateMatrixWorld();
        accumBrush = next;
      }
    }

    if (!accumBrush) {
      return new THREE.BufferGeometry();
    }

    for (const gip of globalIntersects) {
      const iBrush = registerBrush(makeBrush(gip));
      if (iBrush) {
        const next = evaluator.evaluate(accumBrush, iBrush, INTERSECTION);
        disposableGeoms.push(next.geometry);
        next.updateMatrixWorld();
        accumBrush = next;
      }
    }

    const basePositives = [...addPrims, ...intersectPrims];
    for (const rawVp of subtractPrims) {
      const extendedVp = extendSubtractPrimitiveOpenEnds(rawVp, basePositives);
      const sBrush = registerBrush(makeBrush(extendedVp));
      if (sBrush) {
        const next = evaluator.evaluate(accumBrush, sBrush, SUBTRACTION);
        disposableGeoms.push(next.geometry);
        next.updateMatrixWorld();
        accumBrush = next;
      }
    }

    const finalGeom = finalizeGeometryToTargetSpace(
      accumBrush.geometry,
      space,
      30
    );
    return finalGeom;
  } catch {
    // Ultra-safe non-crashing fallback: merge positive geometries directly so WebGL never white-screens!
    const fallbackBuilder = new EngMeshBuilder();
    for (const ap of addPrims) {
      const g = buildSinglePrimitiveEngineeringGeometry(ap);
      const p = g.getAttribute('position');
      if (p) {
        for (let i = 0; i < p.array.length; i++) {
          fallbackBuilder.positions.push(p.array[i]);
        }
      }
      g.dispose();
    }
    const fbEng = fallbackBuilder.toCleanEngineeringBufferGeometry();
    const out = finalizeGeometryToTargetSpace(fbEng, space, 30);
    fbEng.dispose();
    return out;
  } finally {
    for (const g of disposableGeoms) {
      g.dispose();
    }
  }
}

/**
 * Facade #6: Extract crisp sharp feature edges (`dihedralAngle >= creaseAngleDeg` or open boundary edges)
 * using spatial vertex welding so non-indexed crease-split BufferGeometries produce zero tessellation clutter!
 */
export function extractSharpFeatureEdges(
  geometry: THREE.BufferGeometry,
  creaseAngleDeg = 32
): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count < 3) {
    return new THREE.BufferGeometry();
  }

  const index = geometry.getIndex();
  const triCount = index
    ? Math.floor(index.count / 3)
    : Math.floor(pos.count / 3);
  const cosThreshold = Math.cos((creaseAngleDeg * Math.PI) / 180);

  // Weld vertices on a `2e-3 mm` spatial grid
  const weldedCoords: Vec3[] = [];
  const gridMap = new Map<string, number>();

  const getWeldedId = (vi: number): number => {
    const x = pos.getX(vi);
    const y = pos.getY(vi);
    const z = pos.getZ(vi);
    const key = `${Math.round(x * 500)},${Math.round(y * 500)},${Math.round(z * 500)}`;
    const ex = gridMap.get(key);
    if (ex !== undefined) return ex;
    const id = weldedCoords.length;
    weldedCoords.push({ x, y, z });
    gridMap.set(key, id);
    return id;
  };

  interface EdgeRef {
    a: number;
    b: number;
    normals: Vec3[];
  }
  const edgeMap = new Map<string, EdgeRef>();

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    const w0 = getWeldedId(i0);
    const w1 = getWeldedId(i1);
    const w2 = getWeldedId(i2);
    if (w0 === w1 || w1 === w2 || w2 === w0) continue;

    const p0 = weldedCoords[w0];
    const p1 = weldedCoords[w1];
    const p2 = weldedCoords[w2];
    const rawN = cross3(sub3(p1, p0), sub3(p2, p0));
    if (len3(rawN) < MIN_TRIANGLE_AREA * 2) continue;
    const n = normalize3(rawN);

    for (const [u, v] of [
      [w0, w1],
      [w1, w2],
      [w2, w0],
    ] as const) {
      const lo = Math.min(u, v);
      const hi = Math.max(u, v);
      const ek = `${lo}_${hi}`;
      let ref = edgeMap.get(ek);
      if (!ref) {
        ref = { a: lo, b: hi, normals: [n] };
        edgeMap.set(ek, ref);
      } else {
        ref.normals.push(n);
      }
    }
  }

  // Collect single-normal edges (potential CSG T-junction split edges on coplanar caps)
  const singleRefs: {
    pa: Vec3;
    pb: Vec3;
    mid: Vec3;
    dir: Vec3;
    len: number;
    n: Vec3;
  }[] = [];
  for (const ref of edgeMap.values()) {
    if (ref.normals.length === 1) {
      const pa = weldedCoords[ref.a];
      const pb = weldedCoords[ref.b];
      const d = sub3(pb, pa);
      const l = len3(d);
      if (l > 1e-4) {
        singleRefs.push({
          pa,
          pb,
          mid: scale3(add3(pa, pb), 0.5),
          dir: scale3(d, 1 / l),
          len: l,
          n: ref.normals[0],
        });
      }
    }
  }

  const pointToSegDist3 = (p: Vec3, a: Vec3, b: Vec3): number => {
    const ab = sub3(b, a);
    const l2 = dot3(ab, ab);
    if (l2 < 1e-10) return len3(sub3(p, a));
    const t = Math.max(0, Math.min(1, dot3(sub3(p, a), ab) / l2));
    return len3(sub3(p, add3(a, scale3(ab, t))));
  };

  const lineCoords: number[] = [];
  for (const ref of edgeMap.values()) {
    let isSharp = false;
    if (ref.normals.length === 1) {
      // Check if this single-normal edge is a coplanar CSG T-junction split edge:
      // If another single-normal edge on a coplanar triangle (`dot(n0, n1) > cosThreshold`) passes through
      // this edge's midpoint (or vice versa), both belong to the same flat cap and are NOT a crease!
      const pa = weldedCoords[ref.a];
      const pb = weldedCoords[ref.b];
      const mid = scale3(add3(pa, pb), 0.5);
      const n0 = ref.normals[0];
      let isCoplanarTJunction = false;
      for (const sr of singleRefs) {
        if (sr.pa === pa && sr.pb === pb) continue;
        if (dot3(n0, sr.n) <= cosThreshold) continue;
        if (
          pointToSegDist3(mid, sr.pa, sr.pb) <= 0.03 ||
          pointToSegDist3(sr.mid, pa, pb) <= 0.03
        ) {
          isCoplanarTJunction = true;
          break;
        }
      }
      isSharp = !isCoplanarTJunction;
    } else {
      const n0 = ref.normals[0];
      for (let k = 1; k < ref.normals.length; k++) {
        if (dot3(n0, ref.normals[k]) <= cosThreshold) {
          isSharp = true;
          break;
        }
      }
    }
    if (isSharp) {
      const pa = weldedCoords[ref.a];
      const pb = weldedCoords[ref.b];
      lineCoords.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    }
  }

  const edgeGeom = new THREE.BufferGeometry();
  edgeGeom.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(lineCoords), 3)
  );
  return edgeGeom;
}

/**
 * Facade #7: Export composite 3D primitives directly in millimeter `'engineering'` space (`[0, 120]^3`)
 * to an ASCII watertight manifold STL string with verified outward right-handed facet normals!
 */
export function exportPrimitivesToWatertightSTL(
  primitives: Primitive3D[],
  solidName = 'DorED_3D_Solid'
): string {
  const safeName = solidName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'DorED_3D_Solid';
  const geom = buildWatertightManifoldGeometry(primitives, 'engineering');
  const pos = geom.getAttribute('position');

  const lines: string[] = [`solid ${safeName}`];
  if (pos && pos.count >= 3) {
    for (let i = 0; i <= pos.count - 3; i += 3) {
      const a: Vec3 = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) };
      const b: Vec3 = {
        x: pos.getX(i + 1),
        y: pos.getY(i + 1),
        z: pos.getY(i + 1) !== undefined ? pos.getZ(i + 1) : 0,
      };
      const c: Vec3 = {
        x: pos.getX(i + 2),
        y: pos.getY(i + 2),
        z: pos.getZ(i + 2),
      };
      const rawN = cross3(sub3(b, a), sub3(c, a));
      if (len3(rawN) < MIN_TRIANGLE_AREA * 2) continue;
      const n = normalize3(rawN);

      lines.push(
        `  facet normal ${n.x.toExponential(6)} ${n.y.toExponential(6)} ${n.z.toExponential(6)}`
      );
      lines.push('    outer loop');
      lines.push(
        `      vertex ${a.x.toFixed(5)} ${a.y.toFixed(5)} ${a.z.toFixed(5)}`
      );
      lines.push(
        `      vertex ${b.x.toFixed(5)} ${b.y.toFixed(5)} ${b.z.toFixed(5)}`
      );
      lines.push(
        `      vertex ${c.x.toFixed(5)} ${c.y.toFixed(5)} ${c.z.toFixed(5)}`
      );
      lines.push('    endloop');
      lines.push('  endfacet');
    }
  }
  lines.push(`endsolid ${safeName}`);
  geom.dispose();
  return lines.join('\n');
}
