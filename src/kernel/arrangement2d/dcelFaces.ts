import { LineType, LoopCurveSegment2D, Point2D, ViewType } from '../../types/cad';
import {
  arcSweepCCW,
  computeBounds2D,
  dist2,
  normAngle,
  pointToArcSegDist,
  pointToLineSegDist,
  polygonSignedArea,
  sampleLoopSegmentsToDensePolygon,
  TWO_PI,
} from '../core/coordSystem';
import {
  BoundingBox2D,
  CompositeRegion2D,
  CurveSegment2D,
  DCELAtomicFace,
  DCELHalfEdge,
  DCELVertex,
  PlanarityDCELResult,
  RegionProfileKind,
  RegionProfileMeta,
} from '../core/types';

const VERTEX_SNAP_TOL = 0.06;

/**
 * Exact 2D Signed Distance Function for a curved/polygonal closed region.
 * Negative strictly inside, 0 on boundary, positive outside.
 */
export function evalCurvedRegion2DSDF(
  pt: Point2D,
  segments: LoopCurveSegment2D[],
  fallbackPoly: Point2D[] = []
): number {
  const poly =
    fallbackPoly.length >= 3
      ? fallbackPoly
      : sampleLoopSegmentsToDensePolygon(segments, 64);
  if (poly.length < 3) return 1e6;

  // Min unsigned distance to exact curved/line boundary
  let minD = Infinity;
  if (segments.length > 0) {
    for (const seg of segments) {
      if (
        seg.kind === 'arc' &&
        seg.center &&
        seg.radius !== undefined &&
        seg.startAngle !== undefined &&
        seg.endAngle !== undefined
      ) {
        const d = pointToArcSegDist(
          pt,
          seg.center,
          seg.radius,
          seg.startAngle,
          seg.endAngle
        ).dist;
        if (d < minD) minD = d;
      } else {
        const d = pointToLineSegDist(pt, seg.p1, seg.p2).dist;
        if (d < minD) minD = d;
      }
    }
  } else {
    for (let i = 0; i < poly.length; i++) {
      const d = pointToLineSegDist(pt, poly[i], poly[(i + 1) % poly.length]).dist;
      if (d < minD) minD = d;
    }
  }

  // Exact point-in-curved-loop test via dense polygon winding
  const inside = pointInPolygonExact(pt, poly);
  return inside ? -minD : minD;
}

export function pointInPolygonExact(pt: Point2D, poly: Point2D[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].u;
    const yi = poly[i].v;
    const xj = poly[j].u;
    const yj = poly[j].v;
    const intersect =
      yi > pt.v !== yj > pt.v &&
      pt.u < ((xj - xi) * (pt.v - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findRobustInteriorPoint(poly: Point2D[]): Point2D {
  if (poly.length === 0) return { u: 0, v: 0 };
  // Try centroid first
  let cu = 0;
  let cv = 0;
  for (const p of poly) {
    cu += p.u;
    cv += p.v;
  }
  const centroid = { u: cu / poly.length, v: cv / poly.length };
  if (pointInPolygonExact(centroid, poly)) return centroid;

  // Otherwise scan horizontal scanlines near median v-coordinates for widest interior chord midpoint
  const bounds = computeBounds2D(poly);
  let bestPt = centroid;
  let bestSpan = -1;
  const steps = 11;
  for (let k = 1; k < steps; k++) {
    const vTest = bounds.vMin + ((bounds.vMax - bounds.vMin) * k) / steps;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      if ((a.v <= vTest && b.v > vTest) || (b.v <= vTest && a.v > vTest)) {
        const t = (vTest - a.v) / (b.v - a.v);
        xs.push(a.u + t * (b.u - a.u));
      }
    }
    xs.sort((a, b) => a - b);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const span = xs[m + 1] - xs[m];
      if (span > bestSpan) {
        bestSpan = span;
        bestPt = { u: 0.5 * (xs[m] + xs[m + 1]), v: vTest };
      }
    }
  }
  return bestPt;
}

/**
 * Construct planar Doubly Connected Edge List (DCEL) with curved-edge tangent & signed curvature ordering,
 * iteratively pruning degree-1 dangling spurs so every bounded atomic face is cleanly extracted!
 */
export function buildPlanarDCEL(segments: CurveSegment2D[]): PlanarityDCELResult {
  const vertices: DCELVertex[] = [];
  const findOrCreateVertex = (pt: Point2D): number => {
    for (let i = 0; i < vertices.length; i++) {
      if (dist2(vertices[i].pt, pt) <= VERTEX_SNAP_TOL) return i;
    }
    const id = vertices.length;
    vertices.push({ id, pt: { u: pt.u, v: pt.v }, outgoingHalfEdges: [] });
    return id;
  };

  interface EdgePair {
    v1: number;
    v2: number;
    seg: CurveSegment2D;
    alive: boolean;
  }

  const pairs: EdgePair[] = [];
  for (const seg of segments) {
    const v1 = findOrCreateVertex(seg.p1);
    const v2 = findOrCreateVertex(seg.p2);
    if (v1 === v2) continue;
    pairs.push({ v1, v2, seg, alive: true });
  }

  // Iteratively prune degree-1 dangling spurs so open spurs never corrupt inner face cycles
  let changed = true;
  while (changed) {
    changed = false;
    const deg = new Int32Array(vertices.length);
    for (const ep of pairs) {
      if (!ep.alive) continue;
      deg[ep.v1]++;
      deg[ep.v2]++;
    }
    for (const ep of pairs) {
      if (!ep.alive) continue;
      if (deg[ep.v1] <= 1 || deg[ep.v2] <= 1) {
        ep.alive = false;
        changed = true;
      }
    }
  }

  const halfEdges: DCELHalfEdge[] = [];
  for (const ep of pairs) {
    if (!ep.alive) continue;
    const idFwd = halfEdges.length;
    const idRev = idFwd + 1;
    const pA = vertices[ep.v1].pt;
    const pB = vertices[ep.v2].pt;

    let fwdStartTan: number;
    let fwdEndTan: number;
    let revStartTan: number;
    let revEndTan: number;
    let fwdCurv = 0;
    let revCurv = 0;

    if (
      ep.seg.kind === 'arc' &&
      ep.seg.center &&
      ep.seg.radius !== undefined &&
      ep.seg.startAngle !== undefined &&
      ep.seg.endAngle !== undefined
    ) {
      // Forward traverses p1 -> p2 along +dθ (ccw = true)
      const sAng = ep.seg.startAngle;
      const eAng = ep.seg.endAngle;
      fwdStartTan = normAngle(sAng + Math.PI / 2);
      fwdEndTan = normAngle(eAng + Math.PI / 2);
      revStartTan = normAngle(eAng - Math.PI / 2);
      revEndTan = normAngle(sAng - Math.PI / 2);
      fwdCurv = 1 / Math.max(0.1, ep.seg.radius);
      revCurv = -1 / Math.max(0.1, ep.seg.radius);
    } else {
      const angAB = normAngle(Math.atan2(pB.v - pA.v, pB.u - pA.u));
      const angBA = normAngle(Math.atan2(pA.v - pB.v, pA.u - pB.u));
      fwdStartTan = angAB;
      fwdEndTan = angAB;
      revStartTan = angBA;
      revEndTan = angBA;
    }

    const fwdSeg: CurveSegment2D = { ...ep.seg, p1: pA, p2: pB, ccw: true };
    const revSeg: CurveSegment2D = { ...ep.seg, p1: pB, p2: pA, ccw: false };

    halfEdges.push(
      {
        id: idFwd,
        origin: ep.v1,
        twin: idRev,
        next: -1,
        prev: -1,
        face: null,
        segment: fwdSeg,
        startTangentAngle: fwdStartTan,
        endTangentAngle: fwdEndTan,
        signedCurvature: fwdCurv,
      },
      {
        id: idRev,
        origin: ep.v2,
        twin: idFwd,
        next: -1,
        prev: -1,
        face: null,
        segment: revSeg,
        startTangentAngle: revStartTan,
        endTangentAngle: revEndTan,
        signedCurvature: revCurv,
      }
    );
    vertices[ep.v1].outgoingHalfEdges.push(idFwd);
    vertices[ep.v2].outgoingHalfEdges.push(idRev);
  }

  // Sort outgoing half-edges CCW around each vertex; break tangent ties using signed curvature!
  // For two tangent curves sharing the same outgoing tangent direction, larger signed curvature (+1/R) bends more to the left (larger CCW angle).
  for (const v of vertices) {
    v.outgoingHalfEdges.sort((aId, bId) => {
      const ha = halfEdges[aId];
      const hb = halfEdges[bId];
      let da = ha.startTangentAngle - hb.startTangentAngle;
      if (Math.abs(da) > TWO_PI - 1e-4) {
        da = da > 0 ? da - TWO_PI : da + TWO_PI;
      }
      if (Math.abs(da) > 1e-3) return da;
      return ha.signedCurvature - hb.signedCurvature;
    });
  }

  // Link next/prev pointers: arriving along `he` at `vTarget` (`twin = he.twin`),
  // the sharpest left turn (interior CCW face) is the predecessor of `twin` in `vTarget.outgoingHalfEdges`!
  for (const he of halfEdges) {
    const twinHe = halfEdges[he.twin];
    const vTarget = vertices[twinHe.origin];
    const outList = vTarget.outgoingHalfEdges;
    const idx = outList.indexOf(he.twin);
    if (idx < 0 || outList.length === 0) continue;
    const nextIdx = (idx - 1 + outList.length) % outList.length;
    const nextHeId = outList[nextIdx];
    he.next = nextHeId;
    halfEdges[nextHeId].prev = he.id;
  }

  // Extract all minimal cycles; positive signedArea = bounded interior cycle, negative = outer hole/unbounded wrapper
  const visited = new Uint8Array(halfEdges.length);
  interface CycleInfo {
    halfEdgeIds: number[];
    segments: CurveSegment2D[];
    poly: Point2D[];
    signedArea: number;
    bounds: BoundingBox2D;
    interiorPoint: Point2D;
  }
  const positiveCycles: CycleInfo[] = [];
  const negativeCycles: CycleInfo[] = [];

  for (let i = 0; i < halfEdges.length; i++) {
    if (visited[i] || halfEdges[i].next < 0) continue;
    const cycleIds: number[] = [];
    let curr = i;
    let guard = 0;
    while (!visited[curr] && curr >= 0 && guard < halfEdges.length + 5) {
      visited[curr] = 1;
      cycleIds.push(curr);
      curr = halfEdges[curr].next;
      guard++;
    }
    if (curr !== i || cycleIds.length < 2) continue;

    const segs = cycleIds.map((hid) => halfEdges[hid].segment);
    const poly = sampleLoopSegmentsToDensePolygon(segs, 64);
    if (poly.length < 3) continue;
    const sArea = polygonSignedArea(poly);
    if (Math.abs(sArea) < 0.25) continue;

    const bounds = computeBounds2D(poly);
    const interiorPoint = findRobustInteriorPoint(poly);
    const info: CycleInfo = {
      halfEdgeIds: cycleIds,
      segments: segs,
      poly,
      signedArea: sArea,
      bounds,
      interiorPoint,
    };
    if (sArea > 0) positiveCycles.push(info);
    else negativeCycles.push(info);
  }

  // Sort positive cycles from smallest area to largest so inner hole negative cycles attach to smallest enclosing positive cycle
  positiveCycles.sort((a, b) => a.signedArea - b.signedArea);

  const atomicFaces: DCELAtomicFace[] = positiveCycles.map((c, idx) => {
    for (const hid of c.halfEdgeIds) {
      halfEdges[hid].face = idx;
    }
    return {
      id: idx,
      outerHalfEdges: c.halfEdgeIds,
      holeHalfEdgeLoops: [],
      segments: c.segments,
      polygon: c.poly,
      signedArea: c.signedArea,
      area: Math.abs(c.signedArea),
      bounds: c.bounds,
      interiorPoint: c.interiorPoint,
      isUnboundedOuter: false,
    };
  });

  // Attach floating inner hole island wrappers (negative cycles strictly inside a positive face)
  for (const neg of negativeCycles) {
    const samplePt = neg.poly[0];
    let hostFace: DCELAtomicFace | null = null;
    for (const af of atomicFaces) {
      if (Math.abs(neg.signedArea) >= af.area - 0.5) continue;
      if (pointInPolygonExact(samplePt, af.polygon)) {
        hostFace = af;
        break; // smallest enclosing positive cycle
      }
    }
    if (hostFace) {
      hostFace.holeHalfEdgeLoops.push(neg.halfEdgeIds);
      hostFace.area = Math.max(0.1, hostFace.area - Math.abs(neg.signedArea));
    }
  }

  return { vertices, halfEdges, atomicFaces };
}

// ============================================================================
// Profile Classification & Shared-Chord Union Operator (f_a U f_b)
// ============================================================================

function mergeCollinearBoundarySegments(
  segs: CurveSegment2D[]
): CurveSegment2D[] {
  if (segs.length <= 1) return segs;
  const merged: CurveSegment2D[] = [];
  for (const s of segs) {
    if (merged.length === 0) {
      merged.push({ ...s });
      continue;
    }
    const prev = merged[merged.length - 1];
    if (
      prev.kind === 'line' &&
      s.kind === 'line' &&
      dist2(prev.p2, s.p1) < 0.08
    ) {
      const d1u = prev.p2.u - prev.p1.u;
      const d1v = prev.p2.v - prev.p1.v;
      const d2u = s.p2.u - s.p1.u;
      const d2v = s.p2.v - s.p1.v;
      const l1 = Math.hypot(d1u, d1v);
      const l2 = Math.hypot(d2u, d2v);
      if (l1 > 1e-4 && l2 > 1e-4) {
        const cross = Math.abs(d1u * d2v - d1v * d2u) / (l1 * l2);
        const dot = (d1u * d2u + d1v * d2v) / (l1 * l2);
        if (cross < 0.015 && dot > 0.99) {
          prev.p2 = { ...s.p2 };
          continue;
        }
      }
    } else if (
      prev.kind === 'arc' &&
      s.kind === 'arc' &&
      prev.center &&
      s.center &&
      prev.radius !== undefined &&
      s.radius !== undefined &&
      dist2(prev.center, s.center) < 0.12 &&
      Math.abs(prev.radius - s.radius) < 0.12 &&
      prev.ccw === s.ccw &&
      dist2(prev.p2, s.p1) < 0.08
    ) {
      if (prev.ccw !== false) {
        prev.endAngle = s.endAngle;
        prev.p2 = { ...s.p2 };
      } else {
        prev.startAngle = s.startAngle;
        prev.p2 = { ...s.p2 };
      }
      continue;
    }
    merged.push({ ...s });
  }

  // Check wrap-around merge between last and first
  if (merged.length >= 2) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    if (
      last.kind === 'line' &&
      first.kind === 'line' &&
      dist2(last.p2, first.p1) < 0.08
    ) {
      const d1u = last.p2.u - last.p1.u;
      const d1v = last.p2.v - last.p1.v;
      const d2u = first.p2.u - first.p1.u;
      const d2v = first.p2.v - first.p1.v;
      const l1 = Math.hypot(d1u, d1v);
      const l2 = Math.hypot(d2u, d2v);
      if (l1 > 1e-4 && l2 > 1e-4) {
        const cross = Math.abs(d1u * d2v - d1v * d2u) / (l1 * l2);
        const dot = (d1u * d2u + d1v * d2v) / (l1 * l2);
        if (cross < 0.015 && dot > 0.99) {
          first.p1 = { ...last.p1 };
          merged.pop();
        }
      }
    }
  }
  return merged;
}

export function classifyRegionProfile(
  rawSegs: CurveSegment2D[],
  poly: Point2D[],
  bounds: BoundingBox2D
): { kind: RegionProfileKind; meta: RegionProfileMeta } {
  const segs = mergeCollinearBoundarySegments(rawSegs);
  const arcs = segs.filter((s) => s.kind === 'arc');
  const lines = segs.filter((s) => s.kind === 'line');

  // 1. Pure circle: all arc segments share same center & radius and span ~2π
  if (segs.length > 0 && lines.length === 0 && arcs.length >= 1) {
    const c0 = arcs[0].center!;
    const r0 = arcs[0].radius!;
    if (
      arcs.every(
        (a) =>
          a.center &&
          a.radius !== undefined &&
          dist2(a.center, c0) < 0.25 &&
          Math.abs(a.radius - r0) < 0.25
      )
    ) {
      return {
        kind: 'circle',
        meta: { center: { ...c0 }, radius: r0 },
      };
    }
  }

  // 2. Semicircle: 1 line chord + >=1 concentric arcs of radius R where chord passes through center!
  if (lines.length === 1 && arcs.length >= 1) {
    const c0 = arcs[0].center!;
    const r0 = arcs[0].radius!;
    const sameCircle = arcs.every(
      (a) =>
        a.center &&
        a.radius !== undefined &&
        dist2(a.center, c0) < 0.35 &&
        Math.abs(a.radius - r0) < 0.35
    );
    if (sameCircle) {
      const ln = lines[0];
      const dCenterToChord = pointToLineSegDist(c0, ln.p1, ln.p2).dist;
      const chordLen = dist2(ln.p1, ln.p2);
      if (dCenterToChord <= 0.8 && Math.abs(chordLen - 2 * r0) <= 1.2) {
        // Determine arc span [arcStart, arcEnd] along +dθ
        let sAng = arcs[0].startAngle!;
        let eAng = arcs[arcs.length - 1].endAngle!;
        if (arcs.length === 1) {
          sAng = arcs[0].startAngle!;
          eAng = arcs[0].endAngle!;
        } else {
          // Determine from endpoints of chord!
          const a1 = normAngle(Math.atan2(ln.p1.v - c0.v, ln.p1.u - c0.u));
          const a2 = normAngle(Math.atan2(ln.p2.v - c0.v, ln.p2.u - c0.u));
          const midPoly = findRobustInteriorPoint(poly);
          const midAng = normAngle(Math.atan2(midPoly.v - c0.v, midPoly.u - c0.u));
          const rel12 = normAngle(midAng - a1);
          if (rel12 <= arcSweepCCW(a1, a2) + 0.05) {
            sAng = a1;
            eAng = a2;
          } else {
            sAng = a2;
            eAng = a1;
          }
        }
        const isHorizChord = Math.abs(ln.p1.v - ln.p2.v) < 0.4;
        const isVertChord = Math.abs(ln.p1.u - ln.p2.u) < 0.4;
        const midPt = findRobustInteriorPoint(poly);
        return {
          kind: 'semicircle',
          meta: {
            center: { ...c0 },
            radius: r0,
            arcStart: sAng,
            arcEnd: eAng,
            chordAxis: isHorizChord ? 'v' : isVertChord ? 'u' : undefined,
            chordCoord: isHorizChord
              ? 0.5 * (ln.p1.v + ln.p2.v)
              : isVertChord
              ? 0.5 * (ln.p1.u + ln.p2.u)
              : undefined,
            keepGreater: isHorizChord
              ? midPt.v >= c0.v
              : isVertChord
              ? midPt.u >= c0.u
              : undefined,
          },
        };
      }
    }
  }

  // 3. Arch: 3 orthogonal lines + 1 semicircular arc
  if (arcs.length >= 1 && lines.length >= 2) {
    const c0 = arcs[0].center!;
    const r0 = arcs[0].radius!;
    if (
      arcs.every(
        (a) =>
          a.center &&
          dist2(a.center, c0) < 0.35 &&
          Math.abs((a.radius ?? 0) - r0) < 0.35
      ) &&
      lines.length === 3
    ) {
      return {
        kind: 'arch',
        meta: { center: { ...c0 }, radius: r0 },
      };
    }
    return { kind: 'curved_loop', meta: {} };
  }

  if (arcs.length > 0) {
    return { kind: 'curved_loop', meta: {} };
  }

  // Pure polygonal loop: extract clean simplified vertices
  const verts = segs.map((s) => s.p1);
  const m = verts.length;

  if (m === 3) {
    // Check horizontal base (triangle_v: tapers along v) or vertical base (triangle_h: tapers along u)
    for (let i = 0; i < 3; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % 3];
      const apex = verts[(i + 2) % 3];
      if (Math.abs(a.v - b.v) < 0.4) {
        const baseAtMin = a.v < apex.v;
        const baseR = 0.5 * Math.abs(b.u - a.u);
        const baseC = 0.5 * (a.u + b.u);
        return {
          kind: 'triangle_v',
          meta: {
            apex,
            rAtMin: baseAtMin ? baseR : 0,
            rAtMax: baseAtMin ? 0 : baseR,
            cAtMin: baseAtMin ? baseC : apex.u,
            cAtMax: baseAtMin ? apex.u : baseC,
          },
        };
      }
      if (Math.abs(a.u - b.u) < 0.4) {
        const baseAtMin = a.u < apex.u;
        const baseR = 0.5 * Math.abs(b.v - a.v);
        const baseC = 0.5 * (a.v + b.v);
        return {
          kind: 'triangle_h',
          meta: {
            apex,
            rAtMin: baseAtMin ? baseR : 0,
            rAtMax: baseAtMin ? 0 : baseR,
            cAtMin: baseAtMin ? baseC : apex.v,
            cAtMax: baseAtMin ? apex.v : baseC,
          },
        };
      }
    }
    return { kind: 'general_polygon', meta: { sides: 3 } };
  }

  if (m === 4) {
    const horizEdges = segs.filter((s) => Math.abs(s.p1.v - s.p2.v) < 0.35);
    const vertEdges = segs.filter((s) => Math.abs(s.p1.u - s.p2.u) < 0.35);
    if (horizEdges.length === 2 && vertEdges.length === 2) {
      return {
        kind: 'rectangle',
        meta: {
          center: {
            u: 0.5 * (bounds.uMin + bounds.uMax),
            v: 0.5 * (bounds.vMin + bounds.vMax),
          },
        },
      };
    }
    if (horizEdges.length === 2) {
      // Trapezoid tapering along v (bottom & top horizontal bases!)
      const sortedH = [...horizEdges].sort(
        (a, b) => 0.5 * (a.p1.v + a.p2.v) - 0.5 * (b.p1.v + b.p2.v)
      );
      const bot = sortedH[0];
      const top = sortedH[1];
      return {
        kind: 'trapezoid_v',
        meta: {
          rAtMin: 0.5 * Math.abs(bot.p2.u - bot.p1.u),
          rAtMax: 0.5 * Math.abs(top.p2.u - top.p1.u),
          cAtMin: 0.5 * (bot.p1.u + bot.p2.u),
          cAtMax: 0.5 * (top.p1.u + top.p2.u),
        },
      };
    }
    if (vertEdges.length === 2) {
      // Trapezoid tapering along u (left & right vertical bases!)
      const sortedV = [...vertEdges].sort(
        (a, b) => 0.5 * (a.p1.u + a.p2.u) - 0.5 * (b.p1.u + b.p2.u)
      );
      const left = sortedV[0];
      const right = sortedV[1];
      return {
        kind: 'trapezoid_h',
        meta: {
          rAtMin: 0.5 * Math.abs(left.p2.v - left.p1.v),
          rAtMax: 0.5 * Math.abs(right.p2.v - right.p1.v),
          cAtMin: 0.5 * (left.p1.v + left.p2.v),
          cAtMax: 0.5 * (right.p1.v + right.p2.v),
        },
      };
    }
  }

  if (m >= 5) {
    // Check if regular polygon (equal edge lengths & equal radii from centroid)
    const cu = verts.reduce((acc, p) => acc + p.u, 0) / m;
    const cv = verts.reduce((acc, p) => acc + p.v, 0) / m;
    const radii = verts.map((p) => Math.hypot(p.u - cu, p.v - cv));
    const avgR = radii.reduce((a, b) => a + b, 0) / m;
    const isRegular = radii.every((r) => Math.abs(r - avgR) <= Math.max(0.8, avgR * 0.04));
    if (isRegular) {
      return {
        kind: 'regular_polygon',
        meta: { center: { u: cu, v: cv }, radius: avgR, sides: m },
      };
    }
  }

  return { kind: 'general_polygon', meta: { sides: m } };
}

/**
 * Compute exact topological union boundary of a subset of DCEL atomic faces `{f_i}`:
 * Internal twin half-edges `(he, twin)` where BOTH `he.face` and `twin.face` belong to `faceSet`
 * cancel out algebraically (`f_a U f_b`)! Remaining outer boundary half-edges are chained into
 * clean closed loops.
 */
function unionAtomicFaceSubset(
  dcel: PlanarityDCELResult,
  faceIdSubset: number[],
  view: ViewType,
  idPrefix: string,
  isFullEnvelope = false
): CompositeRegion2D | null {
  const set = new Set<number>(faceIdSubset);
  const boundaryHeIds: number[] = [];
  for (const fid of faceIdSubset) {
    const af = dcel.atomicFaces[fid];
    if (!af) continue;
    for (const hid of af.outerHalfEdges) {
      const he = dcel.halfEdges[hid];
      const twinFace = dcel.halfEdges[he.twin].face;
      if (twinFace === null || !set.has(twinFace)) {
        boundaryHeIds.push(hid);
      }
    }
  }
  if (boundaryHeIds.length < 2) return null;

  // Chain boundary half-edges into closed cycles around vertices
  const outByOrigin = new Map<number, number[]>();
  for (const hid of boundaryHeIds) {
    const orig = dcel.halfEdges[hid].origin;
    const arr = outByOrigin.get(orig) ?? [];
    arr.push(hid);
    outByOrigin.set(orig, arr);
  }

  const used = new Set<number>();
  let bestCycleSegs: CurveSegment2D[] | null = null;
  let bestPoly: Point2D[] = [];
  let bestArea = -1;

  for (const startHid of boundaryHeIds) {
    if (used.has(startHid)) continue;
    const cycle: number[] = [];
    let curr = startHid;
    let guard = 0;
    while (!used.has(curr) && guard < boundaryHeIds.length + 5) {
      used.add(curr);
      cycle.push(curr);
      const twinOrigin = dcel.halfEdges[dcel.halfEdges[curr].twin].origin;
      const candidates = (outByOrigin.get(twinOrigin) ?? []).filter(
        (c) => !used.has(c) || c === startHid
      );
      if (candidates.length === 0) break;
      if (candidates.includes(startHid) && cycle.length >= 2 && candidates.length === 1) {
        curr = startHid;
        break;
      }
      // Pick outgoing boundary half-edge with smallest CCW turn
      const inAngle = normAngle(dcel.halfEdges[curr].endTangentAngle + Math.PI);
      candidates.sort((a, b) => {
        const turnA = normAngle(inAngle - dcel.halfEdges[a].startTangentAngle);
        const turnB = normAngle(inAngle - dcel.halfEdges[b].startTangentAngle);
        return turnA - turnB;
      });
      curr = candidates[0];
      if (curr === startHid) break;
      guard++;
    }

    if (curr === startHid && cycle.length >= 2) {
      const segs = cycle.map((hid) => dcel.halfEdges[hid].segment);
      const poly = sampleLoopSegmentsToDensePolygon(segs, 64);
      const sArea = polygonSignedArea(poly);
      if (sArea > bestArea) {
        bestArea = sArea;
        bestCycleSegs = segs;
        bestPoly = poly;
      }
    }
  }

  if (!bestCycleSegs || bestPoly.length < 3 || bestArea < 0.5) return null;
  const mergedSegs = mergeCollinearBoundarySegments(bestCycleSegs);
  const bounds = computeBounds2D(bestPoly);
  const { kind, meta } = classifyRegionProfile(mergedSegs, bestPoly, bounds);
  return {
    id: `${idPrefix}_${faceIdSubset.join('_')}`,
    view,
    lineType: 'thick_solid',
    atomicFaceIds: [...faceIdSubset],
    boundarySegments: mergedSegs,
    polygon: bestPoly,
    area: bestArea,
    bounds,
    interiorPoint: findRobustInteriorPoint(bestPoly),
    nestingDepth: 0,
    parentRegionId: null,
    childRegionIds: [],
    isSharedChordUnion: true,
    isFullEnvelope,
    profileKind: kind,
    profileMeta: meta,
  };
}

/**
 * Extract all exact atomic faces (preserving all parallel/stepped sub-loops!),
 * plus shared-chord unions (`f_a U f_b` for co-chord dual semicircles, multi-panel hexagonal prisms,
 * and composite silhouettes), plus composite line-to-arc sub-decomposition (e.g. cone + rear hemisphere
 * ice-cream silhouette if internal chord was omitted), and compute nesting containment hierarchy!
 */
export function extractCompositeRegionsFromDCEL(
  dcel: PlanarityDCELResult,
  view: ViewType
): {
  regions: CompositeRegion2D[];
  outerRegions: CompositeRegion2D[];
  innerRegions: CompositeRegion2D[];
  bounds: BoundingBox2D | null;
} {
  const atomicRegions: CompositeRegion2D[] = dcel.atomicFaces.map((af) => {
    const mergedSegs = mergeCollinearBoundarySegments(af.segments);
    const { kind, meta } = classifyRegionProfile(
      mergedSegs,
      af.polygon,
      af.bounds
    );
    return {
      id: `reg_${view}_af${af.id}`,
      view,
      lineType: 'thick_solid',
      atomicFaceIds: [af.id],
      boundarySegments: mergedSegs,
      polygon: af.polygon,
      area: af.area,
      bounds: af.bounds,
      interiorPoint: af.interiorPoint,
      nestingDepth: 0,
      parentRegionId: null,
      childRegionIds: [],
      isSharedChordUnion: false,
      profileKind: kind,
      profileMeta: meta,
    };
  });

  // Compute nesting depth among atomic faces
  for (let i = 0; i < atomicRegions.length; i++) {
    const ri = atomicRegions[i];
    let depth = 0;
    let smallestParent: CompositeRegion2D | null = null;
    for (let j = 0; j < atomicRegions.length; j++) {
      if (i === j) continue;
      const rj = atomicRegions[j];
      if (rj.area <= ri.area + 0.5) continue;
      if (pointInPolygonExact(ri.interiorPoint, rj.polygon)) {
        depth++;
        if (!smallestParent || rj.area < smallestParent.area) {
          smallestParent = rj;
        }
      }
    }
    ri.nestingDepth = depth;
    ri.parentRegionId = smallestParent ? smallestParent.id : null;
  }
  for (const r of atomicRegions) {
    if (r.parentRegionId) {
      const p = atomicRegions.find((x) => x.id === r.parentRegionId);
      if (p) p.childRegionIds.push(r.id);
    }
  }

  // Build adjacency graph between atomic faces sharing interior DCEL half-edges
  const nFaces = dcel.atomicFaces.length;
  const adj: Set<number>[] = Array.from({ length: nFaces }, () => new Set<number>());
  for (const he of dcel.halfEdges) {
    const f1 = he.face;
    const f2 = dcel.halfEdges[he.twin].face;
    if (f1 !== null && f2 !== null && f1 !== f2) {
      adj[f1].add(f2);
      adj[f2].add(f1);
    }
  }

  const unionRegions: CompositeRegion2D[] = [];
  const seenKey = new Set<string>(
    atomicRegions.map((r) => r.atomicFaceIds.join(','))
  );

  const tryAddUnion = (subset: number[], prefix: string, isFull = false) => {
    const sorted = [...new Set(subset)].sort((a, b) => a - b);
    if (sorted.length < 2) return;
    const key = sorted.join(',');
    if (seenKey.has(key)) return;
    seenKey.add(key);
    const uReg = unionAtomicFaceSubset(dcel, sorted, view, prefix, isFull);
    if (uReg) unionRegions.push(uReg);
  };

  // 1. Connected components of all adjacent atomic faces (full outer envelope, e.g., 3-panel hexagonal prism rectangle or co-chord dual semicircles!)
  const compVisited = new Uint8Array(nFaces);
  for (let i = 0; i < nFaces; i++) {
    if (compVisited[i]) continue;
    const comp: number[] = [];
    const queue = [i];
    compVisited[i] = 1;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const nb of adj[cur]) {
        if (!compVisited[nb]) {
          compVisited[nb] = 1;
          queue.push(nb);
        }
      }
    }
    if (comp.length >= 2) {
      tryAddUnion(comp, `reg_${view}_env`, true);
      // Also union only outer-depth (depth === 0) faces in the component
      const depth0Comp = comp.filter((fid) => atomicRegions[fid].nestingDepth === 0);
      if (depth0Comp.length >= 2 && depth0Comp.length < comp.length) {
        tryAddUnion(depth0Comp, `reg_${view}_d0env`, true);
      }
    }
  }

  // 2. Pairwise shared-chord unions (f_a U f_b) for adjacent faces (e.g., inner semicircle + crescent -> outer semicircle; or adjacent prism/step strips)
  for (let i = 0; i < nFaces; i++) {
    for (const j of adj[i]) {
      if (j <= i) continue;
      // Only limit pairwise blowup on huge grids
      if (nFaces <= 16) {
        tryAddUnion([i, j], `reg_${view}_pair`, false);
      }
    }
  }

  // 3. Decompose single curved_loop (e.g. cone + rear hemisphere drawn without internal chord) at sharp line-to-semicircle joints
  const decomposedSubRegions: CompositeRegion2D[] = [];
  for (const reg of atomicRegions) {
    if (reg.profileKind === 'curved_loop') {
      const arcs = reg.boundarySegments.filter((s) => s.kind === 'arc');
      const lines = reg.boundarySegments.filter((s) => s.kind === 'line');
      if (arcs.length === 1 && lines.length === 2) {
        const arc = arcs[0];
        const pA = arc.p1;
        const pB = arc.p2;
        if (
          arc.center &&
          arc.radius !== undefined &&
          Math.abs(dist2(pA, pB) - 2 * arc.radius) <= 1.2
        ) {
          // Virtual chord pA -> pB splits loop into Semicircle + Triangle!
          const chordForward: CurveSegment2D = {
            id: `${reg.id}_vchord_f`,
            kind: 'line',
            p1: pB,
            p2: pA,
            lineType: 'thick_solid',
            sourceEntityId: arc.sourceEntityId,
          };
          const semiSegs = [arc, chordForward];
          const semiPoly = sampleLoopSegmentsToDensePolygon(semiSegs, 64);
          if (Math.abs(polygonSignedArea(semiPoly)) > 1.0) {
            const semiBounds = computeBounds2D(semiPoly);
            const semiClass = classifyRegionProfile(semiSegs, semiPoly, semiBounds);
            decomposedSubRegions.push({
              id: `${reg.id}_sub_semi`,
              view,
              lineType: 'thick_solid',
              atomicFaceIds: reg.atomicFaceIds,
              boundarySegments: semiSegs,
              polygon: semiPoly,
              area: Math.abs(polygonSignedArea(semiPoly)),
              bounds: semiBounds,
              interiorPoint: findRobustInteriorPoint(semiPoly),
              nestingDepth: reg.nestingDepth,
              parentRegionId: reg.parentRegionId,
              childRegionIds: [],
              isSharedChordUnion: false,
              isSubDecomposed: true,
              profileKind: semiClass.kind,
              profileMeta: semiClass.meta,
            });
          }
          const triSegs: CurveSegment2D[] = [
            ...lines,
            {
              id: `${reg.id}_vchord_t`,
              kind: 'line',
              p1: lines[lines.length - 1].p2,
              p2: lines[0].p1,
              lineType: 'thick_solid',
              sourceEntityId: lines[0].sourceEntityId,
            },
          ];
          const triPoly = sampleLoopSegmentsToDensePolygon(triSegs, 16);
          if (Math.abs(polygonSignedArea(triPoly)) > 1.0) {
            const triBounds = computeBounds2D(triPoly);
            const triClass = classifyRegionProfile(triSegs, triPoly, triBounds);
            decomposedSubRegions.push({
              id: `${reg.id}_sub_tri`,
              view,
              lineType: 'thick_solid',
              atomicFaceIds: reg.atomicFaceIds,
              boundarySegments: triSegs,
              polygon: triPoly,
              area: Math.abs(polygonSignedArea(triPoly)),
              bounds: triBounds,
              interiorPoint: findRobustInteriorPoint(triPoly),
              nestingDepth: reg.nestingDepth,
              parentRegionId: reg.parentRegionId,
              childRegionIds: [],
              isSharedChordUnion: false,
              isSubDecomposed: true,
              profileKind: triClass.kind,
              profileMeta: triClass.meta,
            });
          }
        }
      }
    }
  }

  const allRegions = [...atomicRegions, ...unionRegions, ...decomposedSubRegions];
  const outerRegions = allRegions.filter((r) => r.nestingDepth === 0);
  const innerRegions = allRegions.filter((r) => r.nestingDepth >= 1);

  let globalBounds: BoundingBox2D | null = null;
  if (allRegions.length > 0) {
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const r of allRegions) {
      if (r.bounds.uMin < uMin) uMin = r.bounds.uMin;
      if (r.bounds.uMax > uMax) uMax = r.bounds.uMax;
      if (r.bounds.vMin < vMin) vMin = r.bounds.vMin;
      if (r.bounds.vMax > vMax) vMax = r.bounds.vMax;
    }
    globalBounds = { uMin, uMax, vMin, vMax };
  }

  return {
    regions: allRegions,
    outerRegions,
    innerRegions,
    bounds: globalBounds,
  };
}
