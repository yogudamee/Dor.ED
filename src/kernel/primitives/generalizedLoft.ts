import { LoopCurveSegment2D, Point2D, Primitive3D, ViewType } from '../../types/cad';
import {
  Axis3D,
  CircleOrArc3D,
  GeneralizedLoftSolid,
  Seg3D,
  Vec3,
} from '../../types/kernel';
import { curvedLoopSignedDist2D } from '../arrangement/containmentTree';
import { isAngleOnArc, polygonSignedArea2D, sampleArcPoints } from '../arrangement/curveIntersector';

/**
 * Converts a standard Primitive3D (prism, pyramid, cylinder_x/y/z, cone_x/y/z)
 * into a unified GeneralizedLoftSolid operator:
 *   S(s, t) = (1 - t) * Γ_0(s) + t * Γ_1(s),   t = (w - w0) / (w1 - w0) ∈ [0, 1]
 */
export function primitiveToGeneralizedLoft(prim: Primitive3D): GeneralizedLoftSolid | null {
  if (prim.shape === 'cone_z' || prim.shape === 'cone_y' || prim.shape === 'cone_x') {
    const axis: Axis3D = prim.shape === 'cone_z' ? 'Z' : prim.shape === 'cone_y' ? 'Y' : 'X';
    const w0 = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const w1 = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
    const defU =
      axis === 'Z' || axis === 'Y'
        ? (prim.centerX ?? 0.5 * (prim.xMin + prim.xMax))
        : (prim.centerY ?? 0.5 * (prim.yMin + prim.yMax));
    const defV =
      axis === 'Z'
        ? (prim.centerY ?? 0.5 * (prim.yMin + prim.yMax))
        : (prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax));
    const c0: Point2D = { u: prim.uCenterMin ?? defU, v: prim.vCenterMin ?? defV };
    const c1: Point2D = { u: prim.uCenterMax ?? defU, v: prim.vCenterMax ?? defV };
    const r0 = Math.max(0.05, prim.rMin ?? prim.radius ?? 10);
    const r1 = Math.max(0, prim.rMax ?? 0);
    const scale = r0 > 1e-3 ? r1 / r0 : 0;
    const circlePts = sampleArcPoints(
      { center: c0, radius: r0, startAngle: 0, endAngle: Math.PI * 2, ccw: true },
      48,
      false
    );
    return {
      id: prim.id,
      featureId: prim.featureId,
      label: prim.label,
      operation: prim.operation,
      axis,
      w0,
      w1,
      baseSegments: [
        {
          kind: 'arc',
          p1: { u: c0.u + r0, v: c0.v },
          p2: { u: c0.u + r0, v: c0.v },
          center: c0,
          radius: r0,
          startAngle: 0,
          endAngle: Math.PI * 2,
          ccw: true,
        },
      ],
      basePolygon: circlePts,
      c0,
      c1,
      scaleU: scale,
      scaleV: scale,
      isCircular: true,
      r0,
      r1,
      isInternalFeature: prim.isInternalFeature,
      isInsideLoopContour: prim.isInsideLoopContour,
    };
  }

  if (
    (prim.shape === 'pyramid' || prim.shape === 'prism') &&
    prim.prismPolygon &&
    prim.prismPolygon.length >= 3
  ) {
    const axis: Axis3D = (prim.prismAxis || prim.extrudeAxis?.toUpperCase() || 'Z') as Axis3D;
    const minW = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
    const maxW = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMin === prim.xMax ? prim.xMin + 1 : prim.xMax;
    if (prim.shape === 'prism' || !prim.apex3D) {
      const uMid =
        0.5 *
        (Math.min(...prim.prismPolygon.map((p) => p.u)) +
          Math.max(...prim.prismPolygon.map((p) => p.u)));
      const vMid =
        0.5 *
        (Math.min(...prim.prismPolygon.map((p) => p.v)) +
          Math.max(...prim.prismPolygon.map((p) => p.v)));
      return {
        id: prim.id,
        featureId: prim.featureId,
        label: prim.label,
        operation: prim.operation,
        axis,
        w0: minW,
        w1: maxW,
        baseSegments: prim.prismSegments || [],
        basePolygon: prim.prismPolygon,
        c0: { u: uMid, v: vMid },
        c1: { u: uMid, v: vMid },
        scaleU: 1,
        scaleV: 1,
        isInternalFeature: prim.isInternalFeature,
        isInsideLoopContour: prim.isInsideLoopContour,
      };
    }

    const [ax, ay, az] = prim.apex3D;
    const uApex = axis === 'Z' ? ax : axis === 'Y' ? ax : ay;
    const vApex = axis === 'Z' ? ay : axis === 'Y' ? az : az;
    const wApex = axis === 'Z' ? az : axis === 'Y' ? ay : ax;
    const w0 = Math.abs(wApex - minW) > Math.abs(wApex - maxW) ? minW : maxW;
    const w1 = w0 === minW ? maxW : minW;
    const topScale =
      typeof prim.pyramidTopScale === 'number' && prim.pyramidTopScale > 1e-3
        ? prim.pyramidTopScale
        : 0;
    return {
      id: prim.id,
      featureId: prim.featureId,
      label: prim.label,
      operation: prim.operation,
      axis,
      w0,
      w1,
      baseSegments: prim.prismSegments || [],
      basePolygon: prim.prismPolygon,
      c0: { u: uApex, v: vApex },
      c1: { u: uApex, v: vApex },
      scaleU: topScale,
      scaleV: topScale,
      isInternalFeature: prim.isInternalFeature,
      isInsideLoopContour: prim.isInsideLoopContour,
    };
  }

  return null;
}

/**
 * Evaluates the exact 3D Signed Distance Function (SDF) of a GeneralizedLoftSolid at point p.
 */
export function evalGeneralizedLoftSDF(p: Vec3, loft: GeneralizedLoftSolid): number {
  const uVal = loft.axis === 'Z' ? p.x : loft.axis === 'Y' ? p.x : p.y;
  const vVal = loft.axis === 'Z' ? p.y : loft.axis === 'Y' ? p.z : p.z;
  const wVal = loft.axis === 'Z' ? p.z : loft.axis === 'Y' ? p.y : p.x;
  const wMin = Math.min(loft.w0, loft.w1);
  const wMax = Math.max(loft.w0, loft.w1);
  const spanW = loft.w1 - loft.w0;
  const t = Math.max(0, Math.min(0.996, (wVal - loft.w0) / (Math.abs(spanW) > 1e-3 ? spanW : 1)));

  const padCap = loft.operation === 'subtract' ? 1.2 : 0;
  const dW = Math.abs(wVal - 0.5 * (wMin + wMax)) - (0.5 * (wMax - wMin) + padCap);

  if (loft.isCircular && loft.r0 !== undefined && loft.r1 !== undefined) {
    const uCAtT = (1 - t) * loft.c0.u + t * loft.c1.u;
    const vCAtT = (1 - t) * loft.c0.v + t * loft.c1.v;
    const rAtT = (1 - t) * loft.r0 + t * loft.r1;
    const cosAlpha =
      Math.abs(wMax - wMin) /
      Math.max(1e-3, Math.hypot(wMax - wMin, loft.r0 - loft.r1, loft.c1.u - loft.c0.u, loft.c1.v - loft.c0.v));
    const dLat = (Math.hypot(uVal - uCAtT, vVal - vCAtT) - rAtT) * cosAlpha;
    return Math.max(dLat, dW);
  }

  const sU = Math.max(0.005, 1 - t * (1 - loft.scaleU));
  const sV = Math.max(0.005, 1 - t * (1 - loft.scaleV));
  const cUt = (1 - t) * loft.c0.u + t * loft.c1.u;
  const cVt = (1 - t) * loft.c0.v + t * loft.c1.v;
  const qBase: Point2D = {
    u: loft.c0.u + (uVal - cUt) / sU,
    v: loft.c0.v + (vVal - cVt) / sV,
  };
  const avgScale = 0.5 * (sU + sV);
  const d2d = curvedLoopSignedDist2D(qBase, loft.basePolygon, loft.baseSegments) * avgScale;
  return Math.max(d2d, dW);
}

/**
 * Extracts exact 3D edges and silhouette generators for a GeneralizedLoftSolid
 * using the analytical normal-view orthogonality condition N(θ) · v_view = 0.
 */
export function extractGeneralizedLoftEdgesAndSilhouettes(
  loft: GeneralizedLoftSolid,
  targetView: ViewType
): { lines3D: Seg3D[]; circles3D: CircleOrArc3D[] } {
  const lines3D: Seg3D[] = [];
  const circles3D: CircleOrArc3D[] = [];
  const to3D = (u: number, v: number, w: number): Vec3 =>
    loft.axis === 'Z'
      ? { x: u, y: v, z: w }
      : loft.axis === 'Y'
        ? { x: u, y: w, z: v }
        : { x: w, y: u, z: v };

  const evalAtT = (u0: number, v0: number, t: number): Vec3 => {
    const sU = 1 - t * (1 - loft.scaleU);
    const sV = 1 - t * (1 - loft.scaleV);
    const cUt = (1 - t) * loft.c0.u + t * loft.c1.u;
    const cVt = (1 - t) * loft.c0.v + t * loft.c1.v;
    const u = cUt + sU * (u0 - loft.c0.u);
    const v = cVt + sV * (v0 - loft.c0.v);
    const w = loft.w0 + t * (loft.w1 - loft.w0);
    return to3D(u, v, w);
  };

  const segs = loft.baseSegments;
  const hasArcs = segs.some((s) => s.kind === 'arc');
  const isBaseParallelView =
    (loft.axis === 'Y' && targetView === 'front') ||
    (loft.axis === 'Z' && targetView === 'top') ||
    (loft.axis === 'X' && targetView === 'left');

  if (hasArcs) {
    const generatorUVs: Point2D[] = [];
    const addGenUV = (pt: Point2D) => {
      if (!generatorUVs.some((g) => Math.hypot(g.u - pt.u, g.v - pt.v) <= 0.4)) {
        generatorUVs.push({ u: pt.u, v: pt.v });
      }
    };

    for (const s of segs) {
      if (s.p1) addGenUV(s.p1);
      if (s.p2) addGenUV(s.p2);
      if (
        s.kind === 'arc' &&
        s.center &&
        s.radius !== undefined &&
        s.startAngle !== undefined &&
        s.endAngle !== undefined
      ) {
        if (isBaseParallelView) {
          circles3D.push({
            center: evalAtT(s.center.u, s.center.v, 0),
            radius: s.radius,
            axis: loft.axis,
            isArc: Math.abs(s.endAngle - s.startAngle) < Math.PI * 1.99,
            startAngle: s.startAngle,
            endAngle: s.endAngle,
            ccw: s.ccw !== false,
            ownerType: loft.operation,
            ownerId: loft.id,
            featureId: loft.featureId,
            featureLabel: loft.label,
          });
          if (loft.scaleU > 1e-3) {
            circles3D.push({
              center: evalAtT(s.center.u, s.center.v, 1),
              radius: s.radius * loft.scaleU,
              axis: loft.axis,
              isArc: Math.abs(s.endAngle - s.startAngle) < Math.PI * 1.99,
              startAngle: s.startAngle,
              endAngle: s.endAngle,
              ccw: s.ccw !== false,
              ownerType: loft.operation,
              ownerId: loft.id,
              featureId: loft.featureId,
              featureLabel: loft.label,
            });
          }
        }
        // Analytical silhouette angles along cardinal directions
        for (const qAng of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
          if (isAngleOnArc(qAng, s.startAngle, s.endAngle, 1e-3)) {
            addGenUV({
              u: s.center.u + s.radius * Math.cos(qAng),
              v: s.center.v + s.radius * Math.sin(qAng),
            });
          }
        }
        // Eccentric oblique cone/frustum axial tangency silhouette angles when viewed along the loft axis
        if (isBaseParallelView) {
          const c0Arc = evalAtT(s.center.u, s.center.v, 0);
          const c1Arc = evalAtT(s.center.u, s.center.v, 1);
          const du =
            loft.axis === 'Z' || loft.axis === 'Y' ? c1Arc.x - c0Arc.x : c1Arc.y - c0Arc.y;
          const dv =
            loft.axis === 'Z' ? c1Arc.y - c0Arc.y : c1Arc.z - c0Arc.z;
          const dCenter = Math.hypot(du, dv);
          const dR = s.radius * (1 - loft.scaleU);
          if (dCenter > Math.abs(dR) + 0.5) {
            const basePhi = Math.atan2(dv, du);
            const alpha = Math.acos(Math.max(-1, Math.min(1, dR / dCenter)));
            for (const tangAng of [basePhi + alpha, basePhi - alpha]) {
              if (isAngleOnArc(tangAng, s.startAngle, s.endAngle, 1e-2)) {
                addGenUV({
                  u: s.center.u + s.radius * Math.cos(tangAng),
                  v: s.center.v + s.radius * Math.sin(tangAng),
                });
              }
            }
          }
        }
      } else if (s.p1 && s.p2) {
        addGenUV({ u: 0.5 * (s.p1.u + s.p2.u), v: 0.5 * (s.p1.v + s.p2.v) });
        lines3D.push({
          p1: evalAtT(s.p1.u, s.p1.v, 0),
          p2: evalAtT(s.p2.u, s.p2.v, 0),
          ownerType: loft.operation,
          ownerId: loft.id,
          featureId: loft.featureId,
          featureLabel: loft.label,
        });
        if (loft.scaleU > 1e-3) {
          lines3D.push({
            p1: evalAtT(s.p1.u, s.p1.v, 1),
            p2: evalAtT(s.p2.u, s.p2.v, 1),
            ownerType: loft.operation,
            ownerId: loft.id,
            featureId: loft.featureId,
            featureLabel: loft.label,
          });
        }
      }
    }

    for (const g of generatorUVs) {
      lines3D.push({
        p1: evalAtT(g.u, g.v, 0),
        p2: evalAtT(g.u, g.v, 1),
        ownerType: loft.operation,
        ownerId: loft.id,
        featureId: loft.featureId,
        featureLabel: loft.label,
      });
    }
    return { lines3D, circles3D };
  }

  // Polygonal loft
  const pts = loft.basePolygon;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    lines3D.push(
      {
        p1: evalAtT(p1.u, p1.v, 0),
        p2: evalAtT(p2.u, p2.v, 0),
        ownerType: loft.operation,
        ownerId: loft.id,
        featureId: loft.featureId,
        featureLabel: loft.label,
      },
      {
        p1: evalAtT(p1.u, p1.v, 0),
        p2: evalAtT(p1.u, p1.v, 1),
        ownerType: loft.operation,
        ownerId: loft.id,
        featureId: loft.featureId,
        featureLabel: loft.label,
      }
    );
    if (loft.scaleU > 1e-3) {
      lines3D.push({
        p1: evalAtT(p1.u, p1.v, 1),
        p2: evalAtT(p2.u, p2.v, 1),
        ownerType: loft.operation,
        ownerId: loft.id,
        featureId: loft.featureId,
        featureLabel: loft.label,
      });
    }
  }
  return { lines3D, circles3D };
}

/**
 * Generates outward-oriented manifold triangle positions in Three.js coordinates
 * (X -> X-60, Z -> Y-50, Y -> Z-60) for a GeneralizedLoftSolid.
 */
export function buildGeneralizedLoftManifoldPositions(loft: GeneralizedLoftSolid): number[] {
  const pts = [...loft.basePolygon];
  if (pts.length < 3) return [];
  if (polygonSignedArea2D(pts) < 0) pts.reverse();

  const padDir = loft.w1 >= loft.w0 ? 1 : -1;
  const padW = loft.operation === 'subtract' ? 1.0 : 0;
  const w0 = loft.w0 - padDir * padW;
  const w1 = loft.w1 + padDir * padW;

  const toThree = (u: number, v: number, w: number): [number, number, number] => {
    if (loft.axis === 'Z') return [u - 60, w - 50, v - 60];
    if (loft.axis === 'Y') return [u - 60, v - 50, w - 60];
    return [w - 60, v - 50, u - 60];
  };

  const baseRing = pts.map((p) => toThree(p.u, p.v, w0));
  const topRing = pts.map((p) => {
    const u1 = loft.c1.u + loft.scaleU * (p.u - loft.c0.u);
    const v1 = loft.c1.v + loft.scaleV * (p.v - loft.c0.v);
    return toThree(u1, v1, w1);
  });

  const centroid0: [number, number, number] = [0, 0, 0];
  const centroid1: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    centroid0[0] += baseRing[i][0] / pts.length;
    centroid0[1] += baseRing[i][1] / pts.length;
    centroid0[2] += baseRing[i][2] / pts.length;
    centroid1[0] += topRing[i][0] / pts.length;
    centroid1[1] += topRing[i][1] / pts.length;
    centroid1[2] += topRing[i][2] / pts.length;
  }
  const refIn: [number, number, number] = [
    0.5 * (centroid0[0] + centroid1[0]),
    0.5 * (centroid0[1] + centroid1[1]),
    0.5 * (centroid0[2] + centroid1[2]),
  ];

  const positions: number[] = [];
  const pushTriOutward = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number]
  ) => {
    const abx = b[0] - a[0],
      aby = b[1] - a[1],
      abz = b[2] - a[2];
    const acx = c[0] - a[0],
      acy = c[1] - a[1],
      acz = c[2] - a[2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const ox = a[0] - refIn[0],
      oy = a[1] - refIn[1],
      oz = a[2] - refIn[2];
    if (nx * ox + ny * oy + nz * oz < 0) {
      positions.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
    } else {
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
  };

  for (let i = 0; i < pts.length; i++) {
    const ni = (i + 1) % pts.length;
    const b1 = baseRing[i];
    const b2 = baseRing[ni];
    const t1 = topRing[i];
    const t2 = topRing[ni];
    pushTriOutward(centroid0, b1, b2);
    if (loft.scaleU > 1e-3) {
      pushTriOutward(centroid1, t2, t1);
      pushTriOutward(b1, b2, t2);
      pushTriOutward(b1, t2, t1);
    } else {
      pushTriOutward(b1, b2, t1);
    }
  }
  return positions;
}
