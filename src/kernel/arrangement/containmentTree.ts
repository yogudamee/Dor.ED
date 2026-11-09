import { CadEntity, LoopCurveSegment2D, Point2D, ViewType } from '../../types/cad';
import {
  BoundingBox2D,
  CompositeRegion2D,
  ContainmentHierarchyGraph,
  RegionProfileKind,
  VirtualCircleFeature,
} from '../../types/kernel';
import {
  dist2D,
  isAngleOnArc,
  normalizeAngle,
  pointToSegmentDist,
} from './curveIntersector';
import { extractCompositeRegionsInView } from './planarGraphDCEL';
import { stitchVirtualCirclesInView } from './virtualCircleStitcher';

/**
 * Exact 2D signed distance to a closed loop with straight and circular arc segments.
 * Negative inside, positive outside.
 */
export function curvedLoopSignedDist2D(
  p: Point2D,
  polygon: Point2D[],
  segments?: LoopCurveSegment2D[]
): number {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (
      pi.v > p.v !== pj.v > p.v &&
      p.u < ((pj.u - pi.u) * (p.v - pi.v)) / (pj.v - pi.v + 1e-12) + pi.u
    ) {
      inside = !inside;
    }
  }

  let minDist = Infinity;
  if (segments && segments.length > 0) {
    for (const s of segments) {
      if (
        s.kind === 'arc' &&
        s.center &&
        s.radius !== undefined &&
        s.startAngle !== undefined &&
        s.endAngle !== undefined
      ) {
        const dx = p.u - s.center.u;
        const dy = p.v - s.center.v;
        const rPt = Math.hypot(dx, dy);
        const ang = normalizeAngle(Math.atan2(dy, dx));
        if (isAngleOnArc(ang, s.startAngle, s.endAngle)) {
          minDist = Math.min(minDist, Math.abs(rPt - s.radius));
          const onCcwSweep = isAngleOnArc(ang, s.startAngle, s.endAngle, -1e-2);
          if (onCcwSweep) {
            const pS = s.p1;
            const pE = s.p2;
            const chordLen = Math.hypot(pE.u - pS.u, pE.v - pS.v);
            if (chordLen > 0.5) {
              const midAng = normalizeAngle(
                s.startAngle +
                  0.5 *
                    (((s.endAngle - s.startAngle) % (Math.PI * 2) + Math.PI * 2) %
                      (Math.PI * 2))
              );
              const arcMid = {
                u: s.center.u + s.radius * Math.cos(midAng),
                v: s.center.v + s.radius * Math.sin(midAng),
              };
              const crossMid =
                (pE.u - pS.u) * (arcMid.v - pS.v) - (pE.v - pS.v) * (arcMid.u - pS.u);
              const crossPt = (pE.u - pS.u) * (p.v - pS.v) - (pE.v - pS.v) * (p.u - pS.u);
              if (crossMid * crossPt > 0) {
                inside = rPt <= s.radius;
              }
            }
          }
        } else {
          minDist = Math.min(minDist, dist2D(p, s.p1), dist2D(p, s.p2));
        }
      } else {
        minDist = Math.min(minDist, pointToSegmentDist(p, s.p1, s.p2).dist);
      }
    }
  } else {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      minDist = Math.min(minDist, pointToSegmentDist(p, a, b).dist);
    }
  }

  return inside ? -minDist : minDist;
}

/**
 * Classifies a 2D composite region into its exact geometric profile kind and metadata.
 */
export function classifyRegionProfile(region: CompositeRegion2D): {
  kind: RegionProfileKind;
  meta: CompositeRegion2D['profileMeta'];
} {
  const segs = region.boundarySegments;
  const arcSegs = segs.filter((s) => s.kind === 'arc');
  const lineSegs = segs.filter((s) => s.kind === 'line');

  if (arcSegs.length === 1 && lineSegs.length === 1 && arcSegs[0].center && arcSegs[0].radius) {
    const arc = arcSegs[0];
    const ln = lineSegs[0];
    const du = Math.abs(ln.p1.u - ln.p2.u);
    const dv = Math.abs(ln.p1.v - ln.p2.v);
    if (dv <= 3.0 && du > 3.0) {
      const vFlat = Math.abs(0.5 * (ln.p1.v + ln.p2.v) - arc.center.v) <= 3.5 ? arc.center.v : 0.5 * (ln.p1.v + ln.p2.v);
      return {
        kind: 'semicircle',
        meta: {
          center: { u: arc.center.u, v: vFlat },
          radius: arc.radius,
          chordCoord: vFlat,
          chordAxis: 'v',
        },
      };
    }
    if (du <= 3.0 && dv > 3.0) {
      const uFlat = Math.abs(0.5 * (ln.p1.u + ln.p2.u) - arc.center.u) <= 3.5 ? arc.center.u : 0.5 * (ln.p1.u + ln.p2.u);
      return {
        kind: 'semicircle',
        meta: {
          center: { u: uFlat, v: arc.center.v },
          radius: arc.radius,
          chordCoord: uFlat,
          chordAxis: 'u',
        },
      };
    }
    return {
      kind: 'curved_loop',
      meta: { center: arc.center, radius: arc.radius },
    };
  }

  if (arcSegs.length > 0) {
    return {
      kind: 'arch',
      meta: { center: arcSegs[0].center, radius: arcSegs[0].radius },
    };
  }

  if (lineSegs.length === 3) {
    const verts = lineSegs.map((s) => s.p1);
    for (let i = 0; i < 3; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % 3];
      const apex = verts[(i + 2) % 3];
      if (Math.abs(a.v - b.v) <= 2.5) {
        return { kind: 'triangle_h', meta: { apex } };
      }
      if (Math.abs(a.u - b.u) <= 2.5) {
        return { kind: 'triangle_v', meta: { apex } };
      }
    }
  }

  if (lineSegs.length === 4) {
    const horiz = lineSegs.filter((s) => Math.abs(s.p1.v - s.p2.v) <= 1.5);
    const vert = lineSegs.filter((s) => Math.abs(s.p1.u - s.p2.u) <= 1.5);
    if (horiz.length === 2 && vert.length === 2) {
      return { kind: 'rectangle', meta: {} };
    }
    const nonHoriz = lineSegs.filter((s) => Math.abs(s.p1.v - s.p2.v) > 1.5);
    if (horiz.length === 2 && nonHoriz.length === 2) {
      const w1 = Math.abs(horiz[0].p2.u - horiz[0].p1.u);
      const w2 = Math.abs(horiz[1].p2.u - horiz[1].p1.u);
      const bothSlanted = nonHoriz.every(
        (s) => Math.abs(s.p2.u - s.p1.u) / Math.max(1.0, Math.abs(s.p2.v - s.p1.v)) > 0.08
      );
      if (Math.abs(w1 - w2) > 4.0 && bothSlanted) {
        const vA = 0.5 * (horiz[0].p1.v + horiz[0].p2.v);
        const vB = 0.5 * (horiz[1].p1.v + horiz[1].p2.v);
        const hMin = vA < vB ? horiz[0] : horiz[1];
        const hMax = vA < vB ? horiz[1] : horiz[0];
        const uMin0 = Math.min(hMin.p1.u, hMin.p2.u);
        const uMax0 = Math.max(hMin.p1.u, hMin.p2.u);
        const uMin1 = Math.min(hMax.p1.u, hMax.p2.u);
        const uMax1 = Math.max(hMax.p1.u, hMax.p2.u);
        return {
          kind: 'trapezoid_h',
          meta: {
            rAtMin: 0.5 * (uMax0 - uMin0),
            rAtMax: 0.5 * (uMax1 - uMin1),
            cAtMin: 0.5 * (uMin0 + uMax0),
            cAtMax: 0.5 * (uMin1 + uMax1),
            wSlopeMin: Math.min(vA, vB),
            wSlopeMax: Math.max(vA, vB),
          },
        };
      }
    }
    const nonVert = lineSegs.filter((s) => Math.abs(s.p1.u - s.p2.u) > 1.5);
    if (vert.length === 2 && nonVert.length === 2) {
      const h1 = Math.abs(vert[0].p2.v - vert[0].p1.v);
      const h2 = Math.abs(vert[1].p2.v - vert[1].p1.v);
      const bothSlanted = nonVert.every(
        (s) => Math.abs(s.p2.v - s.p1.v) / Math.max(1.0, Math.abs(s.p2.u - s.p1.u)) > 0.08
      );
      if (Math.abs(h1 - h2) > 4.0 && bothSlanted) {
        const uA = 0.5 * (vert[0].p1.u + vert[0].p2.u);
        const uB = 0.5 * (vert[1].p1.u + vert[1].p2.u);
        const vMinSeg = uA < uB ? vert[0] : vert[1];
        const vMaxSeg = uA < uB ? vert[1] : vert[0];
        const vMin0 = Math.min(vMinSeg.p1.v, vMinSeg.p2.v);
        const vMax0 = Math.max(vMinSeg.p1.v, vMinSeg.p2.v);
        const vMin1 = Math.min(vMaxSeg.p1.v, vMaxSeg.p2.v);
        const vMax1 = Math.max(vMaxSeg.p1.v, vMaxSeg.p2.v);
        return {
          kind: 'trapezoid_v',
          meta: {
            rAtMin: 0.5 * (vMax0 - vMin0),
            rAtMax: 0.5 * (vMax1 - vMin1),
            cAtMin: 0.5 * (vMin0 + vMax0),
            cAtMax: 0.5 * (vMin1 + vMax1),
            wSlopeMin: Math.min(uA, uB),
            wSlopeMax: Math.max(uA, uB),
          },
        };
      }
    }
  }

  return { kind: 'general_polygon', meta: {} };
}

/**
 * Builds the 2D Containment Hierarchy Tree (Depth 0..N) for all regions and virtual circles in a view.
 */
export function buildContainmentHierarchyInView(
  entities: CadEntity[],
  view: ViewType
): ContainmentHierarchyGraph {
  const solidRegions = extractCompositeRegionsInView(entities, view, 'thick_solid');
  const dashedRegions = extractCompositeRegionsInView(entities, view, 'thin_dashed');
  const allRegions = [...solidRegions, ...dashedRegions];
  const { virtualCircles, consumedDashedArcIds } = stitchVirtualCirclesInView(entities, view);

  // Classify each region's profile
  for (const reg of allRegions) {
    const { kind, meta } = classifyRegionProfile(reg);
    reg.profileKind = kind;
    reg.profileMeta = meta;
  }

  // Sort regions descending by area so parents precede children
  allRegions.sort((a, b) => b.area - a.area);

  const isRegionAInsideB = (a: CompositeRegion2D, b: CompositeRegion2D): boolean => {
    if (b.area <= a.area + 2.0) return false;
    if (
      a.bounds.uMin < b.bounds.uMin - 1.5 ||
      a.bounds.uMax > b.bounds.uMax + 1.5 ||
      a.bounds.vMin < b.bounds.vMin - 1.5 ||
      a.bounds.vMax > b.bounds.vMax + 1.5
    ) {
      return false;
    }
    const sampleCentroid = {
      u: 0.5 * (a.bounds.uMin + a.bounds.uMax),
      v: 0.5 * (a.bounds.vMin + a.bounds.vMax),
    };
    return curvedLoopSignedDist2D(sampleCentroid, b.polygon, b.boundarySegments) <= 1.2;
  };

  for (let i = 0; i < allRegions.length; i++) {
    const child = allRegions[i];
    let depth = 0;
    let directParent: CompositeRegion2D | null = null;
    for (let j = 0; j < i; j++) {
      const candidateParent = allRegions[j];
      if (candidateParent.lineType !== 'thick_solid') continue;
      if (isRegionAInsideB(child, candidateParent)) {
        depth++;
        if (!directParent || candidateParent.area < directParent.area) {
          directParent = candidateParent;
        }
      }
    }
    child.nestingDepth = depth;
    if (directParent) {
      child.parentRegionId = directParent.id;
      directParent.childRegionIds.push(child.id);
    }
  }

  // Compute nesting depth for VirtualCircles
  for (const vc of virtualCircles) {
    let depth = 0;
    let smallestParentReg: CompositeRegion2D | null = null;
    for (const reg of solidRegions) {
      if (reg.area <= Math.PI * vc.radius * vc.radius + 2.0) continue;
      if (
        vc.center.u - vc.radius >= reg.bounds.uMin - 1.8 &&
        vc.center.u + vc.radius <= reg.bounds.uMax + 1.8 &&
        vc.center.v - vc.radius >= reg.bounds.vMin - 1.8 &&
        vc.center.v + vc.radius <= reg.bounds.vMax + 1.8 &&
        curvedLoopSignedDist2D(vc.center, reg.polygon, reg.boundarySegments) < -0.5
      ) {
        depth++;
        if (!smallestParentReg || reg.area < smallestParentReg.area) {
          smallestParentReg = reg;
        }
      }
    }
    let smallestParentCir: VirtualCircleFeature | null = null;
    for (const other of virtualCircles) {
      if (other.id === vc.id || other.lineType !== 'thick_solid') continue;
      if (
        other.radius > vc.radius + 1.5 &&
        dist2D(vc.center, other.center) + vc.radius <= other.radius + 1.8
      ) {
        depth++;
        if (!smallestParentCir || other.radius < smallestParentCir.radius) {
          smallestParentCir = other;
        }
      }
    }
    vc.nestingDepth = depth;
    vc.parentRegionId = smallestParentReg ? smallestParentReg.id : null;
    vc.parentCircleId = smallestParentCir ? smallestParentCir.id : null;
  }

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const r of allRegions) {
    uMin = Math.min(uMin, r.bounds.uMin);
    uMax = Math.max(uMax, r.bounds.uMax);
    vMin = Math.min(vMin, r.bounds.vMin);
    vMax = Math.max(vMax, r.bounds.vMax);
  }
  for (const c of virtualCircles) {
    uMin = Math.min(uMin, c.center.u - c.radius);
    uMax = Math.max(uMax, c.center.u + c.radius);
    vMin = Math.min(vMin, c.center.v - c.radius);
    vMax = Math.max(vMax, c.center.v + c.radius);
  }
  const bounds: BoundingBox2D | null =
    uMin <= uMax && vMin <= vMax ? { uMin, uMax, vMin, vMax } : null;

  return {
    view,
    bounds,
    regions: allRegions,
    outerRegions: allRegions.filter((r) => r.lineType === 'thick_solid' && r.nestingDepth === 0),
    innerRegions: allRegions.filter((r) => r.nestingDepth >= 1 || r.lineType === 'thin_dashed'),
    circles: virtualCircles,
    outerCircles: virtualCircles.filter((c) => c.lineType === 'thick_solid' && c.nestingDepth === 0),
    innerCircles: virtualCircles.filter((c) => c.nestingDepth >= 1 || c.lineType === 'thin_dashed'),
    consumedDashedArcIds,
  };
}
