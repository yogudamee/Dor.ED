import { LineType, ViewType } from '../../types/cad';
import {
  CandidateEdge3D,
  SolvedSolidModel3D,
  SpaceCircleArc3D,
  SpaceLine3D,
  SpacePolyline3D,
  Vec2,
  Vec3,
} from '../types';
import { normAngle } from '../arrangement2d/snapAndSplit';
import { getViewProjectionFrame, projectPoint3DToView } from '../lifting3d/surfacePrimitives';

const TWO_PI = Math.PI * 2;
const OCCLUSION_T_MIN = 0.38;
const OCCLUSION_SDF_TOL = -0.085;

export interface ClassifiedLineSpan2D {
  kind: 'line';
  p1: Vec2;
  p2: Vec2;
  lineType: 'thick_solid' | 'thin_dashed';
  featureId?: string;
  featureLabel?: string;
}

export interface ClassifiedArcSpan2D {
  kind: 'arc';
  center: Vec2;
  radius: number;
  startAngle: number; // +dθ in 2D view (u, v)
  sweep: number;      // in (0, 2π]
  lineType: 'thick_solid' | 'thin_dashed';
  featureId?: string;
  featureLabel?: string;
}

export interface ClassifiedPolylineSpan2D {
  kind: 'polyline';
  points: Vec2[];
  closed: boolean;
  lineType: 'thick_solid' | 'thin_dashed';
  featureId?: string;
  featureLabel?: string;
}

export type ClassifiedCurveSpan2D =
  | ClassifiedLineSpan2D
  | ClassifiedArcSpan2D
  | ClassifiedPolylineSpan2D;

/**
 * Tests whether a 3D boundary point `pt` is unoccluded (`true` -> `thick_solid`)
 * or occluded by solid material (`false` -> `thin_dashed`) along `eyeDir`.
 */
export function isPointVisibleInModel3D(
  pt: Vec3,
  eyeDir: Vec3,
  model: SolvedSolidModel3D,
  maxRayDist: number,
  isCavityBoundary = false
): boolean {
  const tMin = isCavityBoundary ? 0.12 : OCCLUSION_T_MIN;
  const sdfTol = isCavityBoundary ? -2.5e-4 : OCCLUSION_SDF_TOL;
  const baseStep = isCavityBoundary ? 0.16 : 0.32;

  if (maxRayDist <= tMin) return true;

  // Adaptive fine + coarse step march along P + t * eyeDir:
  // Extra-sensitive near internal cavity tangent silhouettes where `SDF_solid = -t^2 / (2R)` grows quadratically!
  let t = tMin;
  let step = baseStep;
  let iter = 0;

  while (t <= maxRayDist && iter++ < 260) {
    const q = {
      x: pt.x + eyeDir.x * t,
      y: pt.y + eyeDir.y * t,
      z: pt.z + eyeDir.z * t,
    };
    const sdf = model.evalSDF(q);
    if (sdf < sdfTol) {
      return false;
    }
    // Sphere-tracing acceleration when safely outside solid (`sdf > 0.6`)
    step = sdf > 0.6 ? Math.min(3.0, Math.max(baseStep, sdf * 0.75)) : baseStep;
    t += step;
  }

  return true;
}

function computeMaxRayDist(pt: Vec3, view: ViewType, model: SolvedSolidModel3D): number {
  const b = model.bounds;
  if (view === 'front') return Math.max(0, b.yMax + 1.0 - pt.y);
  if (view === 'top') return Math.max(0, b.zMax + 1.0 - pt.z);
  return Math.max(0, pt.x - (b.xMin - 1.0));
}

function classifyLine3D(
  line: SpaceLine3D,
  view: ViewType,
  eyeDir: Vec3,
  model: SolvedSolidModel3D
): ClassifiedLineSpan2D[] {
  const q1 = projectPoint3DToView(line.p1, view);
  const q2 = projectPoint3DToView(line.p2, view);
  const len2D = Math.hypot(q2.u - q1.u, q2.v - q1.v);
  if (len2D < 0.2) return [];

  const evalAtT = (t: number): { pt3D: Vec3; vis: boolean } => {
    const pt3D = {
      x: line.p1.x + t * (line.p2.x - line.p1.x),
      y: line.p1.y + t * (line.p2.y - line.p1.y),
      z: line.p1.z + t * (line.p2.z - line.p1.z),
    };
    const maxD = computeMaxRayDist(pt3D, view, model);
    const vis = isPointVisibleInModel3D(
      pt3D,
      eyeDir,
      model,
      maxD,
      Boolean(line.isCavityBoundary)
    );
    return { pt3D, vis };
  };

  const N = Math.max(12, Math.min(80, Math.ceil(len2D / 1.0)));
  // Sample strictly inside (0, 1) near endpoints (`0.015` and `0.985`) to avoid vertex corner ambiguity
  const ts: number[] = [];
  for (let i = 0; i <= N; i++) {
    const raw = i / N;
    ts.push(i === 0 ? 0.012 : i === N ? 0.988 : raw);
  }
  const visArr = ts.map((t) => evalAtT(t).vis);

  const out: ClassifiedLineSpan2D[] = [];
  let spanStartT = 0;
  let curVis = visArr[0];

  for (let i = 1; i <= N; i++) {
    if (visArr[i] !== curVis) {
      // Binary-bisect exact visibility transition in [ts[i-1], ts[i]]
      let lo = ts[i - 1];
      let hi = ts[i];
      for (let b = 0; b < 6; b++) {
        const mid = 0.5 * (lo + hi);
        if (evalAtT(mid).vis === curVis) lo = mid;
        else hi = mid;
      }
      const splitT = 0.5 * (lo + hi);
      if ((splitT - spanStartT) * len2D >= 0.25) {
        out.push({
          kind: 'line',
          p1: {
            u: q1.u + spanStartT * (q2.u - q1.u),
            v: q1.v + spanStartT * (q2.v - q1.v),
          },
          p2: {
            u: q1.u + splitT * (q2.u - q1.u),
            v: q1.v + splitT * (q2.v - q1.v),
          },
          lineType: curVis ? 'thick_solid' : 'thin_dashed',
          featureId: line.featureId,
          featureLabel: line.featureLabel,
        });
      }
      spanStartT = splitT;
      curVis = visArr[i];
    }
  }

  if ((1.0 - spanStartT) * len2D >= 0.25) {
    out.push({
      kind: 'line',
      p1: {
        u: q1.u + spanStartT * (q2.u - q1.u),
        v: q1.v + spanStartT * (q2.v - q1.v),
      },
      p2: { u: q2.u, v: q2.v },
      lineType: curVis ? 'thick_solid' : 'thin_dashed',
      featureId: line.featureId,
      featureLabel: line.featureLabel,
    });
  }

  return out;
}

function evalCirclePoint3D(circ: SpaceCircleArc3D, theta: number): Vec3 {
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  return {
    x: circ.center.x + circ.radius * (ct * circ.uAxis.x + st * circ.vAxis.x),
    y: circ.center.y + circ.radius * (ct * circ.uAxis.y + st * circ.vAxis.y),
    z: circ.center.z + circ.radius * (ct * circ.uAxis.z + st * circ.vAxis.z),
  };
}

function classifyCircleArc3D(
  circ: SpaceCircleArc3D,
  view: ViewType,
  eyeDir: Vec3,
  model: SolvedSolidModel3D
): ClassifiedCurveSpan2D[] {
  const cosAlign = Math.abs(
    circ.normal.x * eyeDir.x + circ.normal.y * eyeDir.y + circ.normal.z * eyeDir.z
  );

  const STEPS = Math.max(36, Math.ceil((circ.sweep / TWO_PI) * 96));
  const thetas: number[] = [];
  const visArr: boolean[] = [];

  for (let i = 0; i <= STEPS; i++) {
    const frac = i === 0 ? 0.004 : i === STEPS ? 0.996 : i / STEPS;
    const th = circ.startAngle + frac * circ.sweep;
    thetas.push(th);
    const p3 = evalCirclePoint3D(circ, th);
    const maxD = computeMaxRayDist(p3, view, model);
    visArr.push(isPointVisibleInModel3D(p3, eyeDir, model, maxD));
  }

  // Extract contiguous visibility intervals in parameter theta
  const intervals: { th0: number; th1: number; vis: boolean }[] = [];
  let curTh0 = circ.startAngle;
  let curVis = visArr[0];

  for (let i = 1; i <= STEPS; i++) {
    if (visArr[i] !== curVis) {
      let lo = thetas[i - 1];
      let hi = thetas[i];
      for (let b = 0; b < 6; b++) {
        const mid = 0.5 * (lo + hi);
        const pMid = evalCirclePoint3D(circ, mid);
        const vMid = isPointVisibleInModel3D(
          pMid,
          eyeDir,
          model,
          computeMaxRayDist(pMid, view, model)
        );
        if (vMid === curVis) lo = mid;
        else hi = mid;
      }
      const splitTh = 0.5 * (lo + hi);
      if (splitTh - curTh0 > 1e-3) {
        intervals.push({ th0: curTh0, th1: splitTh, vis: curVis });
      }
      curTh0 = splitTh;
      curVis = visArr[i];
    }
  }
  const endTh = circ.startAngle + circ.sweep;
  if (endTh - curTh0 > 1e-3) {
    intervals.push({ th0: curTh0, th1: endTh, vis: curVis });
  }

  // Case A: Circle plane is parallel to the 2D projection plane -> exact 2D Circular Arc(s)!
  if (cosAlign > 0.998) {
    const c2D = projectPoint3DToView(circ.center, view);
    const uProj = projectPoint3DToView(
      {
        x: circ.center.x + circ.uAxis.x,
        y: circ.center.y + circ.uAxis.y,
        z: circ.center.z + circ.uAxis.z,
      },
      view
    );
    const vProj = projectPoint3DToView(
      {
        x: circ.center.x + circ.vAxis.x,
        y: circ.center.y + circ.vAxis.y,
        z: circ.center.z + circ.vAxis.z,
      },
      view
    );
    const du1 = uProj.u - c2D.u;
    const dv1 = uProj.v - c2D.v;
    const du2 = vProj.u - c2D.u;
    const dv2 = vProj.v - c2D.v;
    // Signed 2D Jacobian det determines whether +theta maps to +dθ (CCW) or -dθ (CW) in (u, v)
    const det2D = du1 * dv2 - dv1 * du2;

    const outArcs: ClassifiedArcSpan2D[] = [];
    for (const iv of intervals) {
      const sw = iv.th1 - iv.th0;
      if (sw * circ.radius < 0.25) continue;
      if (sw >= TWO_PI - 1e-2) {
        outArcs.push({
          kind: 'arc',
          center: { u: c2D.u, v: c2D.v },
          radius: circ.radius,
          startAngle: 0,
          sweep: TWO_PI,
          lineType: iv.vis ? 'thick_solid' : 'thin_dashed',
          featureId: circ.featureId,
          featureLabel: circ.featureLabel,
        });
      } else {
        const pStart2D = projectPoint3DToView(evalCirclePoint3D(circ, iv.th0), view);
        const pEnd2D = projectPoint3DToView(evalCirclePoint3D(circ, iv.th1), view);
        const a0 = normAngle(Math.atan2(pStart2D.v - c2D.v, pStart2D.u - c2D.u));
        const a1 = normAngle(Math.atan2(pEnd2D.v - c2D.v, pEnd2D.u - c2D.u));
        const startAng = det2D >= 0 ? a0 : a1;
        outArcs.push({
          kind: 'arc',
          center: { u: c2D.u, v: c2D.v },
          radius: circ.radius,
          startAngle: startAng,
          sweep: Math.min(TWO_PI, sw),
          lineType: iv.vis ? 'thick_solid' : 'thin_dashed',
          featureId: circ.featureId,
          featureLabel: circ.featureLabel,
        });
      }
    }
    return outArcs;
  }

  // Case B: Circle plane is perpendicular (edge-on) to the 2D projection plane -> exact straight 2D line spans!
  // Note: Because a 3D circle folds back on itself when projected edge-on, split each interval at its
  // 2D turning extrema so every monotonic branch becomes a crisp `ClassifiedLineSpan2D`!
  if (cosAlign < 1e-2) {
    const outLines: ClassifiedLineSpan2D[] = [];
    for (const iv of intervals) {
      const subN = Math.max(8, Math.ceil(((iv.th1 - iv.th0) / Math.PI) * 32));
      const pts2D: Vec2[] = [];
      for (let k = 0; k <= subN; k++) {
        const th = iv.th0 + (k / subN) * (iv.th1 - iv.th0);
        const q = projectPoint3DToView(evalCirclePoint3D(circ, th), view);
        pts2D.push({ u: q.u, v: q.v });
      }
      // Project onto principal line direction of this edge-on circle
      const c2 = projectPoint3DToView(circ.center, view);
      // Tangent vector of projected circle lies perpendicular to projected normal
      const n2 = projectPoint3DToView(
        {
          x: circ.center.x + circ.normal.x,
          y: circ.center.y + circ.normal.y,
          z: circ.center.z + circ.normal.z,
        },
        view
      );
      const nx = n2.u - c2.u;
      const ny = n2.v - c2.v;
      const nLen = Math.hypot(nx, ny) || 1;
      const dirU = -ny / nLen;
      const dirV = nx / nLen;

      let sMin = Infinity;
      let sMax = -Infinity;
      for (const pt of pts2D) {
        const s = (pt.u - c2.u) * dirU + (pt.v - c2.v) * dirV;
        if (s < sMin) sMin = s;
        if (s > sMax) sMax = s;
      }
      if (sMax - sMin >= 0.25) {
        outLines.push({
          kind: 'line',
          p1: { u: c2.u + sMin * dirU, v: c2.v + sMin * dirV },
          p2: { u: c2.u + sMax * dirU, v: c2.v + sMax * dirV },
          lineType: iv.vis ? 'thick_solid' : 'thin_dashed',
          featureId: circ.featureId,
          featureLabel: circ.featureLabel,
        });
      }
    }
    return outLines;
  }

  // Case C: Tilted Circle -> Elliptical Polyline Spans
  const outPolys: ClassifiedPolylineSpan2D[] = [];
  for (const iv of intervals) {
    const subN = Math.max(12, Math.ceil(((iv.th1 - iv.th0) / TWO_PI) * 64));
    const pts: Vec2[] = [];
    for (let k = 0; k <= subN; k++) {
      const th = iv.th0 + (k / subN) * (iv.th1 - iv.th0);
      const q = projectPoint3DToView(evalCirclePoint3D(circ, th), view);
      pts.push({ u: q.u, v: q.v });
    }
    outPolys.push({
      kind: 'polyline',
      points: pts,
      closed: iv.th1 - iv.th0 >= TWO_PI - 1e-2,
      lineType: iv.vis ? 'thick_solid' : 'thin_dashed',
      featureId: circ.featureId,
      featureLabel: circ.featureLabel,
    });
  }
  return outPolys;
}

function classifyPolyline3D(
  poly: SpacePolyline3D,
  view: ViewType,
  eyeDir: Vec3,
  model: SolvedSolidModel3D
): ClassifiedPolylineSpan2D[] {
  if (poly.points.length < 2) return [];

  const visFlags = poly.points.map((pt) => {
    if (poly.isCavityBoundary) return false;
    return isPointVisibleInModel3D(pt, eyeDir, model, computeMaxRayDist(pt, view, model));
  });

  const out: ClassifiedPolylineSpan2D[] = [];
  let curPts: Vec2[] = [];
  let curVis = visFlags[0];

  const pushPt = (p3: Vec3) => {
    const q = projectPoint3DToView(p3, view);
    if (
      curPts.length === 0 ||
      Math.hypot(q.u - curPts[curPts.length - 1].u, q.v - curPts[curPts.length - 1].v) > 0.08
    ) {
      curPts.push({ u: q.u, v: q.v });
    }
  };

  pushPt(poly.points[0]);

  for (let i = 1; i < poly.points.length; i++) {
    if (visFlags[i] === curVis) {
      pushPt(poly.points[i]);
    } else {
      // Bisect transition along segment [points[i-1], points[i]]
      const A = poly.points[i - 1];
      const B = poly.points[i];
      let lo = 0;
      let hi = 1;
      for (let b = 0; b < 5; b++) {
        const mid = 0.5 * (lo + hi);
        const pMid = {
          x: A.x + mid * (B.x - A.x),
          y: A.y + mid * (B.y - A.y),
          z: A.z + mid * (B.z - A.z),
        };
        const vMid = poly.isCavityBoundary
          ? false
          : isPointVisibleInModel3D(pMid, eyeDir, model, computeMaxRayDist(pMid, view, model));
        if (vMid === curVis) lo = mid;
        else hi = mid;
      }
      const splitT = 0.5 * (lo + hi);
      const pSplit = {
        x: A.x + splitT * (B.x - A.x),
        y: A.y + splitT * (B.y - A.y),
        z: A.z + splitT * (B.z - A.z),
      };
      pushPt(pSplit);
      if (curPts.length >= 2) {
        out.push({
          kind: 'polyline',
          points: curPts,
          closed: false,
          lineType: curVis ? 'thick_solid' : 'thin_dashed',
          featureId: poly.featureId,
          featureLabel: poly.featureLabel,
        });
      }
      curPts = [];
      curVis = visFlags[i];
      pushPt(pSplit);
      pushPt(B);
    }
  }

  if (curPts.length >= 2) {
    out.push({
      kind: 'polyline',
      points: curPts,
      closed: poly.closed && out.length === 0,
      lineType: curVis ? 'thick_solid' : 'thin_dashed',
      featureId: poly.featureId,
      featureLabel: poly.featureLabel,
    });
  }

  return out;
}

/**
 * Runs Quantitative Hidden-Line Removal (HLR) on all 3D candidate edges for `targetView`,
 * returning finely classified visible (`thick_solid`) and hidden (`thin_dashed`) 2D curve spans.
 */
export function runQuantitativeHLR(
  candidates: CandidateEdge3D[],
  model: SolvedSolidModel3D,
  targetView: ViewType
): ClassifiedCurveSpan2D[] {
  const frame = getViewProjectionFrame(targetView);
  const eyeDir = frame.eyeDir;
  const spans: ClassifiedCurveSpan2D[] = [];

  for (const edge of candidates) {
    if (edge.kind === 'line3d') {
      spans.push(...classifyLine3D(edge, targetView, eyeDir, model));
    } else if (edge.kind === 'circle3d') {
      spans.push(...classifyCircleArc3D(edge, targetView, eyeDir, model));
    } else {
      spans.push(...classifyPolyline3D(edge, targetView, eyeDir, model));
    }
  }

  // Filter out degenerate tiny spans (< 0.3mm)
  return spans.filter((sp) => {
    if (sp.kind === 'line') {
      return Math.hypot(sp.p2.u - sp.p1.u, sp.p2.v - sp.p1.v) >= 0.3;
    }
    if (sp.kind === 'arc') {
      return sp.sweep * sp.radius >= 0.3;
    }
    let len = 0;
    for (let i = 1; i < sp.points.length; i++) {
      len += Math.hypot(
        sp.points[i].u - sp.points[i - 1].u,
        sp.points[i].v - sp.points[i - 1].v
      );
    }
    return len >= 0.4;
  });
}

export type { LineType };
