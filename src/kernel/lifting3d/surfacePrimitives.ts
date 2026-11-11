import {
  HemisphereCapSpec,
  LoopCurveSegment2D,
  Primitive3D,
  ViewType,
} from '../../types/cad';
import {
  AnalyticalSurface3D,
  Axis3D,
  BBox3D,
  CandidateVolume3D,
  Vec2,
  Vec3,
  ViewProjectionFrame,
} from '../types';
import { arcSweepCCW, normAngle, pointToLineSegDist } from '../arrangement2d/snapAndSplit';
import { sampleLoopSegmentsToDensePolygon } from '../arrangement2d/dcelBuilder';
import {
  computeGeneralizedLoftBBox,
  ensureCCWPolygon2D,
  evalGeneralizedLoftGrad,
  evalGeneralizedLoftSDF,
  loftUVWToXYZ,
  primitiveToGeneralizedLoft,
  xyzToLoftUVW,
} from './generalizedLoft';

const TWO_PI = Math.PI * 2;

/**
 * Canonical GB/T 4458.1 First-Angle Projection coordinate frames:
 * - front (V): u = X, v = Z, w = Y, observer at +Y (yMax = front, yMin = back)
 * - top   (H): u = X, v = Y, w = Z, observer at +Z (zMax = top,   zMin = bottom)
 * - left  (W): u = Y, v = Z, w = X, observer at -X (xMin = left,  xMax = right)
 */
export function getViewProjectionFrame(view: ViewType): ViewProjectionFrame {
  if (view === 'front') {
    return {
      view: 'front',
      uAxis: 'X',
      vAxis: 'Z',
      wAxis: 'Y',
      eyeDir: { x: 0, y: 1, z: 0 },
    };
  }
  if (view === 'top') {
    return {
      view: 'top',
      uAxis: 'X',
      vAxis: 'Y',
      wAxis: 'Z',
      eyeDir: { x: 0, y: 0, z: 1 },
    };
  }
  return {
    view: 'left',
    uAxis: 'Y',
    vAxis: 'Z',
    wAxis: 'X',
    eyeDir: { x: -1, y: 0, z: 0 },
  };
}

export function projectPoint3DToView(p: Vec3, view: ViewType): { u: number; v: number; depthTowardsEye: number } {
  if (view === 'front') {
    return { u: p.x, v: p.z, depthTowardsEye: p.y };
  }
  if (view === 'top') {
    return { u: p.x, v: p.y, depthTowardsEye: p.z };
  }
  // left view: observer looks from -X toward +X, so smaller X is closer to observer (-p.x is larger)
  return { u: p.y, v: p.z, depthTowardsEye: -p.x };
}

export function unprojectViewPointTo3D(view: ViewType, u: number, v: number, wCoord: number): Vec3 {
  if (view === 'front') return { x: u, y: wCoord, z: v };
  if (view === 'top') return { x: u, y: v, z: wCoord };
  return { x: wCoord, y: u, z: v };
}

export function getThirdTargetView(v1: ViewType, v2: ViewType): ViewType {
  const present = new Set<ViewType>([v1, v2]);
  if (!present.has('left')) return 'left';
  if (!present.has('top')) return 'top';
  return 'front';
}

function pointToArcDist2D(
  pt: Vec2,
  center: Vec2,
  radius: number,
  startAngle: number,
  endAngle: number
): number {
  const dx = pt.u - center.u;
  const dy = pt.v - center.v;
  const r = Math.hypot(dx, dy);
  const sweep = arcSweepCCW(startAngle, endAngle);
  if (sweep >= TWO_PI - 1e-4) {
    return Math.abs(r - radius);
  }
  const ang = normAngle(Math.atan2(dy, dx));
  const rel = normAngle(ang - startAngle);
  if (rel <= sweep + 1e-5 || TWO_PI - rel <= 1e-5) {
    return Math.abs(r - radius);
  }
  const pStart = {
    u: center.u + radius * Math.cos(startAngle),
    v: center.v + radius * Math.sin(startAngle),
  };
  const pEnd = {
    u: center.u + radius * Math.cos(endAngle),
    v: center.v + radius * Math.sin(endAngle),
  };
  return Math.min(
    Math.hypot(pt.u - pStart.u, pt.v - pStart.v),
    Math.hypot(pt.u - pEnd.u, pt.v - pEnd.v)
  );
}

/**
 * Exact 2D signed distance to a curved/polygonal region bounded by `LoopCurveSegment2D[]`.
 * Negative inside, 0 on boundary, positive outside.
 */
export function evalCurvedRegion2DSDF(
  pt: Vec2,
  segments: LoopCurveSegment2D[],
  densePolygon: Vec2[]
): number {
  let minDist = Infinity;
  if (segments.length > 0) {
    for (const seg of segments) {
      let d: number;
      if (seg.kind === 'arc' && seg.center && seg.radius !== undefined) {
        d = pointToArcDist2D(
          pt,
          seg.center,
          seg.radius,
          seg.startAngle ?? 0,
          seg.endAngle ?? 0
        );
      } else {
        d = pointToLineSegDist(pt, seg.p1, seg.p2).dist;
      }
      if (d < minDist) minDist = d;
    }
  } else {
    for (let i = 0; i < densePolygon.length; i++) {
      const a = densePolygon[i];
      const b = densePolygon[(i + 1) % densePolygon.length];
      const d = pointToLineSegDist(pt, a, b).dist;
      if (d < minDist) minDist = d;
    }
  }

  let inside = false;
  for (let i = 0, j = densePolygon.length - 1; i < densePolygon.length; j = i++) {
    const a = densePolygon[j];
    const b = densePolygon[i];
    const intersect =
      b.v > pt.v !== a.v > pt.v &&
      pt.u < ((a.u - b.u) * (pt.v - b.v)) / (a.v - b.v + 1e-12) + b.u;
    if (intersect) inside = !inside;
  }

  return inside ? -minDist : minDist;
}

/**
 * Creates an axis-aligned or arbitrary oriented planar half-space surface:
 *   phi(p) = n · p + d  (phi < 0 on negative side)
 */
export function createPlaneSurface3D(
  id: string,
  label: string,
  normal: Vec3,
  pointOnPlane: Vec3,
  domainBox: BBox3D,
  sourceViews: ViewType[],
  isCavityHint = false
): AnalyticalSurface3D {
  const len = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const n = { x: normal.x / len, y: normal.y / len, z: normal.z / len };
  const d = -(n.x * pointOnPlane.x + n.y * pointOnPlane.y + n.z * pointOnPlane.z);
  return {
    id,
    kind: 'plane',
    label,
    sourceViews,
    isCavityHint,
    domainBox,
    planeParams: { normal: n, d },
    evalPhi: (p: Vec3) => n.x * p.x + n.y * p.y + n.z * p.z + d,
    evalGrad: () => n,
  };
}

export function createCylinderSurface3D(
  id: string,
  label: string,
  axis: Axis3D,
  centerU: number,
  centerV: number,
  radius: number,
  wMin: number,
  wMax: number,
  sourceViews: ViewType[],
  isCavityHint = false,
  associatedPrimitive?: Primitive3D
): AnalyticalSurface3D {
  const pMin = loftUVWToXYZ(axis, centerU - radius, centerV - radius, wMin);
  const pMax = loftUVWToXYZ(axis, centerU + radius, centerV + radius, wMax);
  const domainBox: BBox3D = {
    xMin: Math.min(pMin.x, pMax.x),
    xMax: Math.max(pMin.x, pMax.x),
    yMin: Math.min(pMin.y, pMax.y),
    yMax: Math.max(pMin.y, pMax.y),
    zMin: Math.min(pMin.z, pMax.z),
    zMax: Math.max(pMin.z, pMax.z),
  };

  return {
    id,
    kind: 'cylinder',
    label,
    axis,
    sourceViews,
    isCavityHint,
    domainBox,
    cylinderParams: { axis, centerU, centerV, radius, wMin, wMax },
    associatedPrimitive,
    evalPhi: (p: Vec3) => {
      const { u, v } = xyzToLoftUVW(axis, p);
      return Math.hypot(u - centerU, v - centerV) - radius;
    },
    evalGrad: (p: Vec3) => {
      const { u, v } = xyzToLoftUVW(axis, p);
      const du = u - centerU;
      const dv = v - centerV;
      const r = Math.hypot(du, dv);
      const nu = r > 1e-8 ? du / r : 1;
      const nv = r > 1e-8 ? dv / r : 0;
      const g = loftUVWToXYZ(axis, nu, nv, 0);
      const orig = loftUVWToXYZ(axis, 0, 0, 0);
      return { x: g.x - orig.x, y: g.y - orig.y, z: g.z - orig.z };
    },
  };
}

const prismDensePolyCache = new WeakMap<Primitive3D, Vec2[]>();

function getCachedPrismDensePolygon(prim: Primitive3D): Vec2[] {
  const cached = prismDensePolyCache.get(prim);
  if (cached) return cached;
  const segs = prim.prismSegments ?? [];
  const rawPoly = prim.prismPolygon ?? prim.polygon2D ?? [];
  const built =
    segs.length > 0
      ? sampleLoopSegmentsToDensePolygon(segs, 48)
      : rawPoly.map((pt) => ({ u: pt.u, v: pt.v }));
  prismDensePolyCache.set(prim, built);
  return built;
}

/**
 * Evaluates exact analytical SDF for any Primitive3D (< 0 strictly inside, 0 on surface, > 0 outside).
 */
export function evalPrimitive3DSDF(p: Vec3, prim: Primitive3D): number {
  if (prim.shape === 'box') {
    const dx = Math.max(prim.xMin - p.x, p.x - prim.xMax);
    const dy = Math.max(prim.yMin - p.y, p.y - prim.yMax);
    const dz = Math.max(prim.zMin - p.z, p.z - prim.zMax);
    const outX = Math.max(dx, 0);
    const outY = Math.max(dy, 0);
    const outZ = Math.max(dz, 0);
    return Math.hypot(outX, outY, outZ) + Math.min(Math.max(dx, dy, dz), 0);
  }

  if (prim.shape === 'cylinder_x' || prim.shape === 'cylinder_y' || prim.shape === 'cylinder_z') {
    const axis: Axis3D =
      prim.shape === 'cylinder_z' ? 'Z' : prim.shape === 'cylinder_y' ? 'Y' : 'X';
    const r =
      prim.radius ??
      0.5 * (axis === 'X' ? prim.yMax - prim.yMin : prim.xMax - prim.xMin);
    const cU =
      axis === 'X'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cV =
      axis === 'Z'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const wMin = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const wMax = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
    const { u, v, w } = xyzToLoftUVW(axis, p);
    const dRad = Math.hypot(u - cU, v - cV) - r;
    const dAx = Math.max(wMin - w, w - wMax);
    if (dRad <= 0 && dAx <= 0) return Math.max(dRad, dAx);
    if (dRad > 0 && dAx > 0) return Math.hypot(dRad, dAx);
    return Math.max(dRad, dAx);
  }

  if (prim.shape === 'sphere' || prim.shape === 'hemisphere') {
    const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
    const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const r = prim.radius ?? 0.5 * Math.max(prim.xMax - prim.xMin, prim.yMax - prim.yMin, prim.zMax - prim.zMin);
    const dSphere = Math.hypot(p.x - cx, p.y - cy, p.z - cz) - r;

    if (prim.shape === 'sphere') return dSphere;

    const cap: HemisphereCapSpec = prim.hemisphereSpec ?? {
      flatAxis: 'Z',
      flatCoord: prim.zMin,
      keepPositiveSide: true,
    };
    const coord = cap.flatAxis === 'X' ? p.x : cap.flatAxis === 'Y' ? p.y : p.z;
    const dPlane = cap.keepPositiveSide ? cap.flatCoord - coord : coord - cap.flatCoord;
    if (dSphere <= 0 && dPlane <= 0) return Math.max(dSphere, dPlane);
    if (dSphere > 0 && dPlane > 0) {
      // Exact distance to equatorial base circle rim
      const du = cap.flatAxis === 'X' ? p.y - cy : p.x - cx;
      const dv = cap.flatAxis === 'Z' ? p.y - cy : p.z - cz;
      const dRadRim = Math.max(0, Math.hypot(du, dv) - r);
      return Math.hypot(dPlane, dRadRim);
    }
    return Math.max(dSphere, dPlane);
  }

  if (
    prim.shape === 'generalized_loft' ||
    prim.shape === 'pyramid' ||
    prim.shape === 'cone_x' ||
    prim.shape === 'cone_y' ||
    prim.shape === 'cone_z'
  ) {
    const loft = primitiveToGeneralizedLoft(prim);
    if (loft) return evalGeneralizedLoftSDF(p, loft);
  }

  if (prim.shape === 'prism') {
    // Fast exact AABB lower-bound skip when far outside prism (> 2.0mm)
    const bdx = Math.max(prim.xMin - p.x, p.x - prim.xMax, 0);
    const bdy = Math.max(prim.yMin - p.y, p.y - prim.yMax, 0);
    const bdz = Math.max(prim.zMin - p.z, p.z - prim.zMax, 0);
    if (bdx > 2.0 || bdy > 2.0 || bdz > 2.0) {
      return Math.hypot(bdx, bdy, bdz);
    }

    const axis: Axis3D =
      prim.prismAxis ??
      (prim.extrudeAxis ? (prim.extrudeAxis.toUpperCase() as Axis3D) : 'Z');
    const wMin = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const wMax = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
    const { u, v, w } = xyzToLoftUVW(axis, p);
    const dAx = Math.max(wMin - w, w - wMax);
    const segs = prim.prismSegments ?? [];
    const densePoly = getCachedPrismDensePolygon(prim);
    if (densePoly.length >= 3) {
      const d2D = evalCurvedRegion2DSDF({ u, v }, segs, densePoly);
      if (d2D <= 0 && dAx <= 0) return Math.max(d2D, dAx);
      if (d2D > 0 && dAx > 0) return Math.hypot(d2D, dAx);
      return Math.max(d2D, dAx);
    }
  }

  // Fallback to bounding box SDF
  const dx = Math.max(prim.xMin - p.x, p.x - prim.xMax);
  const dy = Math.max(prim.yMin - p.y, p.y - prim.yMax);
  const dz = Math.max(prim.zMin - p.z, p.z - prim.zMax);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0);
}

export function evalPrimitive3DGrad(p: Vec3, prim: Primitive3D): Vec3 {
  if (prim.loftSpec) {
    return evalGeneralizedLoftGrad(p, prim.loftSpec);
  }
  const eps = 1e-4;
  const dx =
    evalPrimitive3DSDF({ x: p.x + eps, y: p.y, z: p.z }, prim) -
    evalPrimitive3DSDF({ x: p.x - eps, y: p.y, z: p.z }, prim);
  const dy =
    evalPrimitive3DSDF({ x: p.x, y: p.y + eps, z: p.z }, prim) -
    evalPrimitive3DSDF({ x: p.x, y: p.y - eps, z: p.z }, prim);
  const dz =
    evalPrimitive3DSDF({ x: p.x, y: p.y, z: p.z + eps }, prim) -
    evalPrimitive3DSDF({ x: p.x, y: p.y, z: p.z - eps }, prim);
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: dx / len, y: dy / len, z: dz / len };
}

/**
 * Wraps a Primitive3D into a complete `CandidateVolume3D` along with its analytical bounding surfaces
 * so the 3D Cellular Complex can partition space sharply along every planar, cylindrical, spherical,
 * conical, and GeneralizedLoft surface.
 */
export function buildCandidateVolumeFromPrimitive(
  prim: Primitive3D,
  roleHint: CandidateVolume3D['roleHint'],
  priority: number,
  sourceViews: ViewType[],
  options?: {
    isGuaranteedVoid?: boolean;
    isGuaranteedSolid?: boolean;
  }
): CandidateVolume3D {
  const bbox: BBox3D = {
    xMin: prim.xMin,
    xMax: prim.xMax,
    yMin: prim.yMin,
    yMax: prim.yMax,
    zMin: prim.zMin,
    zMax: prim.zMax,
  };
  const isCavity = roleHint === 'cavity_Candidate' || prim.operation === 'subtract';
  const surfaces: AnalyticalSurface3D[] = [];

  if (prim.shape === 'box') {
    surfaces.push(
      createPlaneSurface3D(`${prim.id}_xmin`, `${prim.label}左平面`, { x: -1, y: 0, z: 0 }, { x: prim.xMin, y: 0, z: 0 }, bbox, sourceViews, isCavity),
      createPlaneSurface3D(`${prim.id}_xmax`, `${prim.label}右平面`, { x: 1, y: 0, z: 0 }, { x: prim.xMax, y: 0, z: 0 }, bbox, sourceViews, isCavity),
      createPlaneSurface3D(`${prim.id}_ymin`, `${prim.label}后平面`, { x: 0, y: -1, z: 0 }, { x: 0, y: prim.yMin, z: 0 }, bbox, sourceViews, isCavity),
      createPlaneSurface3D(`${prim.id}_ymax`, `${prim.label}前平面`, { x: 0, y: 1, z: 0 }, { x: 0, y: prim.yMax, z: 0 }, bbox, sourceViews, isCavity),
      createPlaneSurface3D(`${prim.id}_zmin`, `${prim.label}底平面`, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: prim.zMin }, bbox, sourceViews, isCavity),
      createPlaneSurface3D(`${prim.id}_zmax`, `${prim.label}顶平面`, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: prim.zMax }, bbox, sourceViews, isCavity)
    );
  } else if (
    prim.shape === 'cylinder_x' ||
    prim.shape === 'cylinder_y' ||
    prim.shape === 'cylinder_z'
  ) {
    const axis: Axis3D =
      prim.shape === 'cylinder_z' ? 'Z' : prim.shape === 'cylinder_y' ? 'Y' : 'X';
    const r =
      prim.radius ??
      0.5 * (axis === 'X' ? prim.yMax - prim.yMin : prim.xMax - prim.xMin);
    const cU =
      axis === 'X'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cV =
      axis === 'Z'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const wMin = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const wMax = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
    surfaces.push(
      createCylinderSurface3D(`${prim.id}_cyl`, `${prim.label}柱面`, axis, cU, cV, r, wMin, wMax, sourceViews, isCavity, prim)
    );
    const nPos = axis === 'Z' ? { x: 0, y: 0, z: 1 } : axis === 'Y' ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const nNeg = { x: -nPos.x, y: -nPos.y, z: -nPos.z };
    surfaces.push(
      createPlaneSurface3D(`${prim.id}_cap0`, `${prim.label}端面0`, nNeg, loftUVWToXYZ(axis, cU, cV, wMin), bbox, sourceViews, isCavity),
      createPlaneSurface3D(`${prim.id}_cap1`, `${prim.label}端面1`, nPos, loftUVWToXYZ(axis, cU, cV, wMax), bbox, sourceViews, isCavity)
    );
  } else if (prim.shape === 'sphere' || prim.shape === 'hemisphere') {
    const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
    const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const r = prim.radius ?? 0.5 * Math.max(prim.xMax - prim.xMin, prim.yMax - prim.yMin, prim.zMax - prim.zMin);
    const center = { x: cx, y: cy, z: cz };
    surfaces.push({
      id: `${prim.id}_sph`,
      kind: prim.shape === 'hemisphere' ? 'hemisphere' : 'sphere',
      label: `${prim.label}球面`,
      sourceViews,
      isCavityHint: isCavity,
      domainBox: bbox,
      sphereParams: { center, radius: r, hemisphereCap: prim.hemisphereSpec },
      associatedPrimitive: prim,
      evalPhi: (p: Vec3) => Math.hypot(p.x - cx, p.y - cy, p.z - cz) - r,
      evalGrad: (p: Vec3) => {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dz = p.z - cz;
        const d = Math.hypot(dx, dy, dz) || 1;
        return { x: dx / d, y: dy / d, z: dz / d };
      },
    });
    if (prim.shape === 'hemisphere' && prim.hemisphereSpec) {
      const cap = prim.hemisphereSpec;
      const sign = cap.keepPositiveSide ? -1 : 1;
      const n =
        cap.flatAxis === 'X'
          ? { x: sign, y: 0, z: 0 }
          : cap.flatAxis === 'Y'
            ? { x: 0, y: sign, z: 0 }
            : { x: 0, y: 0, z: sign };
      const pt =
        cap.flatAxis === 'X'
          ? { x: cap.flatCoord, y: cy, z: cz }
          : cap.flatAxis === 'Y'
            ? { x: cx, y: cap.flatCoord, z: cz }
            : { x: cx, y: cy, z: cap.flatCoord };
      surfaces.push(
        createPlaneSurface3D(`${prim.id}_hemicap`, `${prim.label}赤道底面`, n, pt, bbox, sourceViews, isCavity)
      );
    }
  } else if (
    prim.shape === 'generalized_loft' ||
    prim.shape === 'pyramid' ||
    prim.shape === 'cone_x' ||
    prim.shape === 'cone_y' ||
    prim.shape === 'cone_z'
  ) {
    const loft = primitiveToGeneralizedLoft(prim);
    if (loft) {
      const loftBox = computeGeneralizedLoftBBox(loft);
      surfaces.push({
        id: `${prim.id}_loft`,
        kind: 'generalized_loft',
        label: `${prim.label}放样侧面`,
        axis: loft.axis,
        sourceViews,
        isCavityHint: isCavity,
        domainBox: loftBox,
        loftParams: loft,
        associatedPrimitive: prim,
        evalPhi: (p: Vec3) => evalGeneralizedLoftSDF(p, loft),
        evalGrad: (p: Vec3) => evalGeneralizedLoftGrad(p, loft),
      });
    }
  } else if (prim.shape === 'prism') {
    const axis: Axis3D =
      prim.prismAxis ??
      (prim.extrudeAxis ? (prim.extrudeAxis.toUpperCase() as Axis3D) : 'Z');
    const wMin = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const wMax = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
    const wMid = 0.5 * (wMin + wMax);
    const segs = prim.prismSegments ?? [];
    const rawPoly = prim.prismPolygon ?? prim.polygon2D ?? [];
    const ccwPoly = ensureCCWPolygon2D(rawPoly);
    const densePoly =
      segs.length > 0
        ? sampleLoopSegmentsToDensePolygon(segs, 48)
        : ccwPoly.map((pt) => ({ u: pt.u, v: pt.v }));
    surfaces.push({
      id: `${prim.id}_prism`,
      kind: 'prism_extrusion',
      label: `${prim.label}柱面`,
      axis,
      sourceViews,
      isCavityHint: isCavity,
      domainBox: bbox,
      prismParams: { axis, wMin, wMax, segments: segs, densePolygon: densePoly },
      associatedPrimitive: prim,
      evalPhi: (p: Vec3) => {
        const { u, v } = xyzToLoftUVW(axis, p);
        return evalCurvedRegion2DSDF({ u, v }, segs, densePoly);
      },
      evalGrad: (p: Vec3) => evalPrimitive3DGrad(p, prim),
    });

    // Lift every straight polygon edge (especially non-orthogonal oblique half-spaces nu*U + nv*V + d <= 0)
    // as an explicit AnalyticalSurface3D plane so CellComplex3D and SSI operate on exact planar half-spaces!
    const orig3 = loftUVWToXYZ(axis, 0, 0, 0);
    const lineEdges: { p1: Vec2; p2: Vec2 }[] = [];
    if (segs.length > 0) {
      const ccwDense = ensureCCWPolygon2D(densePoly);
      const areaSign =
        densePoly.length >= 3 &&
        ccwDense.length >= 3 &&
        Math.hypot(ccwDense[0].u - densePoly[0].u, ccwDense[0].v - densePoly[0].v) > 1e-3
          ? -1
          : 1;
      for (const s of segs) {
        if (s.kind === 'line') {
          lineEdges.push(areaSign >= 0 ? { p1: s.p1, p2: s.p2 } : { p1: s.p2, p2: s.p1 });
        }
      }
    } else if (ccwPoly.length >= 3) {
      for (let i = 0; i < ccwPoly.length; i++) {
        lineEdges.push({ p1: ccwPoly[i], p2: ccwPoly[(i + 1) % ccwPoly.length] });
      }
    }

    lineEdges.forEach((edge, eIdx) => {
      const du = edge.p2.u - edge.p1.u;
      const dv = edge.p2.v - edge.p1.v;
      const len = Math.hypot(du, dv);
      if (len < 0.25) return;
      // Outward 2D normal for CCW edge (p1 -> p2) is (dv / len, -du / len)
      const nu = dv / len;
      const nv = -du / len;
      const nOff = loftUVWToXYZ(axis, nu, nv, 0);
      const normal3D = { x: nOff.x - orig3.x, y: nOff.y - orig3.y, z: nOff.z - orig3.z };
      const pt3D = loftUVWToXYZ(axis, 0.5 * (edge.p1.u + edge.p2.u), 0.5 * (edge.p1.v + edge.p2.v), wMid);
      const surf = createPlaneSurface3D(
        `${prim.id}_pedge_${eIdx}`,
        `${prim.label}棱柱侧面`,
        normal3D,
        pt3D,
        bbox,
        sourceViews,
        isCavity
      );
      surf.associatedPrimitive = prim;
      surfaces.push(surf);
    });

    // Lift end-cap planes at wMin and wMax
    const cU = densePoly.length > 0 ? densePoly.reduce((s, p) => s + p.u, 0) / densePoly.length : 0;
    const cV = densePoly.length > 0 ? densePoly.reduce((s, p) => s + p.v, 0) / densePoly.length : 0;
    const nMinOff = loftUVWToXYZ(axis, 0, 0, -1);
    const nMaxOff = loftUVWToXYZ(axis, 0, 0, 1);
    const capMin = createPlaneSurface3D(
      `${prim.id}_pcap0`,
      `${prim.label}底端面`,
      { x: nMinOff.x - orig3.x, y: nMinOff.y - orig3.y, z: nMinOff.z - orig3.z },
      loftUVWToXYZ(axis, cU, cV, wMin),
      bbox,
      sourceViews,
      isCavity
    );
    capMin.associatedPrimitive = prim;
    const capMax = createPlaneSurface3D(
      `${prim.id}_pcap1`,
      `${prim.label}顶端面`,
      { x: nMaxOff.x - orig3.x, y: nMaxOff.y - orig3.y, z: nMaxOff.z - orig3.z },
      loftUVWToXYZ(axis, cU, cV, wMax),
      bbox,
      sourceViews,
      isCavity
    );
    capMax.associatedPrimitive = prim;
    surfaces.push(capMin, capMax);
  }

  return {
    id: prim.id,
    label: prim.label,
    roleHint,
    isGuaranteedVoid: options?.isGuaranteedVoid,
    isGuaranteedSolid: options?.isGuaranteedSolid,
    priority,
    bbox,
    primitive: prim,
    evalSDF: (p: Vec3) => evalPrimitive3DSDF(p, prim),
    evalGrad: (p: Vec3) => evalPrimitive3DGrad(p, prim),
    surfaces,
  };
}
