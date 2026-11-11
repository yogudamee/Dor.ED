import { LoopCurveSegment2D, ViewType } from '../../types/cad';
import {
  BBox2D,
  DCELFace,
  DCELHalfEdge,
  DCELVertex,
  RegionProfile2D,
  SplitCurveSegment2D,
  Vec2,
} from '../types';
import { arcSweepCCW, dist2, normAngle, pointToLineSegDist } from './snapAndSplit';

const TWO_PI = Math.PI * 2;
const MAX_FACE_WALK_STEPS = 512;

export function sampleLoopSegmentsToDensePolygon(
  segments: LoopCurveSegment2D[],
  arcSubdivsPerCircle = 48
): Vec2[] {
  const poly: Vec2[] = [];
  const pushPt = (pt: Vec2) => {
    if (poly.length === 0 || dist2(poly[poly.length - 1], pt) > 0.05) {
      poly.push({ u: pt.u, v: pt.v });
    }
  };
  for (const seg of segments) {
    if (seg.kind === 'line' || !seg.center || !seg.radius) {
      pushPt(seg.p1);
      pushPt(seg.p2);
    } else {
      const sA = seg.startAngle ?? 0;
      const eA = seg.endAngle ?? 0;
      const sweep = arcSweepCCW(sA, eA);
      const steps = Math.max(6, Math.ceil((sweep / TWO_PI) * arcSubdivsPerCircle));
      if (seg.ccw !== false) {
        for (let k = 0; k <= steps; k++) {
          const ang = sA + (k / steps) * sweep;
          pushPt({
            u: seg.center.u + seg.radius * Math.cos(ang),
            v: seg.center.v + seg.radius * Math.sin(ang),
          });
        }
      } else {
        for (let k = 0; k <= steps; k++) {
          const ang = sA + ((steps - k) / steps) * sweep;
          pushPt({
            u: seg.center.u + seg.radius * Math.cos(ang),
            v: seg.center.v + seg.radius * Math.sin(ang),
          });
        }
      }
    }
  }
  if (poly.length >= 2 && dist2(poly[0], poly[poly.length - 1]) <= 0.08) {
    poly.pop();
  }
  return poly;
}

export function polygonSignedArea(poly: Vec2[]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.u * b.v - b.u * a.v;
  }
  return 0.5 * s;
}

export function isPointStrictlyInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  if (poly.length < 3) return false;
  // Reject points within 0.08mm of boundary
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (pointToLineSegDist(pt, a, b).dist <= 0.08) return false;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].u;
    const yi = poly[i].v;
    const xj = poly[j].u;
    const yj = poly[j].v;
    const intersect =
      yi > pt.v !== yj > pt.v && pt.u < ((xj - xi) * (pt.v - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function findGuaranteedInteriorPoint(poly: Vec2[], bbox: BBox2D): Vec2 {
  if (poly.length < 3) {
    return { u: 0.5 * (bbox.uMin + bbox.uMax), v: 0.5 * (bbox.vMin + bbox.vMax) };
  }
  let cu = 0;
  let cv = 0;
  for (const p of poly) {
    cu += p.u;
    cv += p.v;
  }
  const centroid = { u: cu / poly.length, v: cv / poly.length };
  if (isPointStrictlyInPolygon(centroid, poly)) return centroid;

  // Scan horizontal mid-chords across v levels to find widest interior interval
  let bestPt = centroid;
  let bestSpan = -1;
  const steps = 11;
  for (let k = 1; k < steps; k++) {
    const vScan = bbox.vMin + (k / steps) * (bbox.vMax - bbox.vMin);
    const uHits: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a.v <= vScan && b.v > vScan) || (b.v <= vScan && a.v > vScan)) {
        const t = (vScan - a.v) / (b.v - a.v);
        uHits.push(a.u + t * (b.u - a.u));
      }
    }
    uHits.sort((a, b) => a - b);
    for (let m = 0; m + 1 < uHits.length; m += 2) {
      const span = uHits[m + 1] - uHits[m];
      if (span > bestSpan) {
        const cand = { u: 0.5 * (uHits[m] + uHits[m + 1]), v: vScan };
        if (isPointStrictlyInPolygon(cand, poly)) {
          bestSpan = span;
          bestPt = cand;
        }
      }
    }
  }
  return bestPt;
}

function mergeConsecutiveCollinearSegments(segs: LoopCurveSegment2D[]): LoopCurveSegment2D[] {
  if (segs.length <= 2) return segs;
  const out: LoopCurveSegment2D[] = [];
  for (const s of segs) {
    if (out.length > 0 && out[out.length - 1].kind === 'line' && s.kind === 'line') {
      const prev = out[out.length - 1];
      const du1 = prev.p2.u - prev.p1.u;
      const dv1 = prev.p2.v - prev.p1.v;
      const l1 = Math.hypot(du1, dv1);
      const du2 = s.p2.u - s.p1.u;
      const dv2 = s.p2.v - s.p1.v;
      const l2 = Math.hypot(du2, dv2);
      if (l1 > 1e-3 && l2 > 1e-3) {
        const cross = Math.abs(du1 * dv2 - dv1 * du2) / (l1 * l2);
        const dot = (du1 * du2 + dv1 * dv2) / (l1 * l2);
        if (cross <= 0.025 && dot > 0.95) {
          prev.p2 = { ...s.p2 };
          continue;
        }
      }
    } else if (
      out.length > 0 &&
      out[out.length - 1].kind === 'arc' &&
      s.kind === 'arc' &&
      out[out.length - 1].center &&
      s.center &&
      out[out.length - 1].radius &&
      s.radius &&
      out[out.length - 1].ccw === s.ccw &&
      dist2(out[out.length - 1].center!, s.center) <= 0.6 &&
      Math.abs(out[out.length - 1].radius! - s.radius) <= 0.6
    ) {
      const prev = out[out.length - 1];
      if (prev.ccw !== false) {
        prev.endAngle = s.endAngle;
        prev.p2 = { ...s.p2 };
      } else {
        prev.startAngle = s.startAngle;
        prev.p2 = { ...s.p2 };
      }
      continue;
    }
    out.push({ ...s, p1: { ...s.p1 }, p2: { ...s.p2 } });
  }
  // Wrap-around merge between last and first
  if (out.length >= 3 && out[0].kind === 'line' && out[out.length - 1].kind === 'line') {
    const last = out[out.length - 1];
    const first = out[0];
    const du1 = last.p2.u - last.p1.u;
    const dv1 = last.p2.v - last.p1.v;
    const l1 = Math.hypot(du1, dv1);
    const du2 = first.p2.u - first.p1.u;
    const dv2 = first.p2.v - first.p1.v;
    const l2 = Math.hypot(du2, dv2);
    if (l1 > 1e-3 && l2 > 1e-3) {
      const cross = Math.abs(du1 * dv2 - dv1 * du2) / (l1 * l2);
      const dot = (du1 * du2 + dv1 * dv2) / (l1 * l2);
      if (cross <= 0.025 && dot > 0.95) {
        first.p1 = { ...last.p1 };
        out.pop();
      }
    }
  }
  return out;
}

/**
 * Classifies a closed 2D region into exact analytical shapes:
 * circle, semicircle (with shared flat chord), rect, trapezoid, triangle, arch_or_curved, or polygon.
 */
export function classifyRegionProfile2D(
  id: string,
  view: ViewType,
  faceIds: number[],
  rawSegments: LoopCurveSegment2D[],
  isAtomic: boolean,
  isOuterEnvelope: boolean,
  isSolidOnly: boolean,
  hasDashedBoundary: boolean
): RegionProfile2D {
  const segments = mergeConsecutiveCollinearSegments(rawSegments);
  const densePolygon = sampleLoopSegmentsToDensePolygon(segments, 56);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of densePolygon) {
    if (p.u < uMin) uMin = p.u;
    if (p.u > uMax) uMax = p.u;
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  if (!Number.isFinite(uMin)) {
    uMin = 0;
    uMax = 0;
    vMin = 0;
    vMax = 0;
  }
  const bbox: BBox2D = { uMin, uMax, vMin, vMax };
  const area = Math.abs(polygonSignedArea(densePolygon));
  const interiorSample = findGuaranteedInteriorPoint(densePolygon, bbox);

  const lineSegs = segments.filter((s) => s.kind === 'line');
  const arcSegs = segments.filter((s) => s.kind === 'arc');

  // 1. Check Full Circle (1 or more concentric equal-radius arcs with 0 lines)
  if (lineSegs.length === 0 && arcSegs.length >= 1) {
    const c0 = arcSegs[0].center!;
    const r0 = arcSegs[0].radius!;
    const allConcentric = arcSegs.every(
      (a) => a.center && a.radius && dist2(a.center, c0) <= 0.9 && Math.abs(a.radius - r0) <= 0.9
    );
    if (allConcentric && Math.abs(area - Math.PI * r0 * r0) <= Math.max(6, 0.08 * Math.PI * r0 * r0)) {
      return {
        id,
        view,
        faceIds,
        isAtomic,
        isOuterEnvelope,
        isSolidOnly,
        hasDashedBoundary,
        area,
        bbox: { uMin: c0.u - r0, uMax: c0.u + r0, vMin: c0.v - r0, vMax: c0.v + r0 },
        segments,
        densePolygon,
        interiorSample: { ...c0 },
        shapeKind: 'circle',
        circleSpec: { center: { ...c0 }, radius: r0 },
      };
    }
  }

  // 2. Check Semicircle (1 line chord + 1 or more concentric arcs spanning ~π)
  if (lineSegs.length === 1 && arcSegs.length >= 1) {
    const chord = lineSegs[0];
    const c0 = arcSegs[0].center!;
    const r0 = arcSegs[0].radius!;
    const allConcentric = arcSegs.every(
      (a) => a.center && a.radius && dist2(a.center, c0) <= 1.0 && Math.abs(a.radius - r0) <= 1.0
    );
    const chordLen = dist2(chord.p1, chord.p2);
    const isHorizChord = Math.abs(chord.p1.v - chord.p2.v) <= 1.2;
    const isVertChord = Math.abs(chord.p1.u - chord.p2.u) <= 1.2;
    if (
      allConcentric &&
      Math.abs(chordLen - 2 * r0) <= 2.2 &&
      (isHorizChord || isVertChord) &&
      Math.abs(area - 0.5 * Math.PI * r0 * r0) <= Math.max(8, 0.14 * 0.5 * Math.PI * r0 * r0)
    ) {
      const chordAxis: 'u' | 'v' = isHorizChord ? 'v' : 'u';
      const chordCoord = isHorizChord ? 0.5 * (chord.p1.v + chord.p2.v) : 0.5 * (chord.p1.u + chord.p2.u);
      const midSampleCoord = isHorizChord ? interiorSample.v : interiorSample.u;
      const keepGreater = midSampleCoord > chordCoord;
      const arcStart = isHorizChord
        ? keepGreater
          ? 0
          : Math.PI
        : keepGreater
        ? 1.5 * Math.PI
        : 0.5 * Math.PI;
      const arcEnd = normAngle(arcStart + Math.PI);
      return {
        id,
        view,
        faceIds,
        isAtomic,
        isOuterEnvelope,
        isSolidOnly,
        hasDashedBoundary,
        area,
        bbox,
        segments,
        densePolygon,
        interiorSample,
        shapeKind: 'semicircle',
        semicircleSpec: {
          center: { ...c0 },
          radius: r0,
          chordAxis,
          chordCoord,
          keepGreater,
          arcStart,
          arcEnd,
        },
      };
    }
  }

  // 3. Pure polygonal shapes (0 arcs)
  if (arcSegs.length === 0 && lineSegs.length >= 3) {
    const w = uMax - uMin;
    const h = vMax - vMin;
    // Axis-aligned rectangle
    if (
      lineSegs.length === 4 &&
      w > 0.5 &&
      h > 0.5 &&
      Math.abs(area - w * h) <= Math.max(2.0, 0.025 * w * h)
    ) {
      return {
        id,
        view,
        faceIds,
        isAtomic,
        isOuterEnvelope,
        isSolidOnly,
        hasDashedBoundary,
        area,
        bbox,
        segments,
        densePolygon,
        interiorSample,
        shapeKind: 'rect',
      };
    }

    // Triangle with 1 axis-aligned base (cone / half-cone / pyramid envelope!)
    if (lineSegs.length === 3) {
      const pts = lineSegs.map((s) => s.p1);
      // Check horizontal base (taper along 'v')
      for (let i = 0; i < 3; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % 3];
        const apex = pts[(i + 2) % 3];
        if (Math.abs(a.v - b.v) <= 1.2 && Math.abs(a.u - b.u) >= 2.0 && Math.abs(apex.v - a.v) >= 2.0) {
          const w0 = 0.5 * (a.v + b.v);
          return {
            id,
            view,
            faceIds,
            isAtomic,
            isOuterEnvelope,
            isSolidOnly,
            hasDashedBoundary,
            area,
            bbox,
            segments,
            densePolygon,
            interiorSample,
            shapeKind: 'triangle',
            trapezoidSpec: {
              taperAxis: 'v',
              w0,
              w1: apex.v,
              span0Min: Math.min(a.u, b.u),
              span0Max: Math.max(a.u, b.u),
              span1Min: apex.u,
              span1Max: apex.u,
              isTriangle: true,
              apexCoord: { ...apex },
            },
          };
        }
        if (Math.abs(a.u - b.u) <= 1.2 && Math.abs(a.v - b.v) >= 2.0 && Math.abs(apex.u - a.u) >= 2.0) {
          const w0 = 0.5 * (a.u + b.u);
          return {
            id,
            view,
            faceIds,
            isAtomic,
            isOuterEnvelope,
            isSolidOnly,
            hasDashedBoundary,
            area,
            bbox,
            segments,
            densePolygon,
            interiorSample,
            shapeKind: 'triangle',
            trapezoidSpec: {
              taperAxis: 'u',
              w0,
              w1: apex.u,
              span0Min: Math.min(a.v, b.v),
              span0Max: Math.max(a.v, b.v),
              span1Min: apex.v,
              span1Max: apex.v,
              isTriangle: true,
              apexCoord: { ...apex },
            },
          };
        }
      }
    }

    // Trapezoid with 2 parallel horizontal bases (taper along 'v') or vertical bases (taper along 'u')
    if (lineSegs.length === 4) {
      const horiz = lineSegs.filter((s) => Math.abs(s.p1.v - s.p2.v) <= 1.2 && Math.abs(s.p1.u - s.p2.u) >= 1.5);
      if (horiz.length === 2) {
        const b0 = horiz[0];
        const b1 = horiz[1];
        const v0 = 0.5 * (b0.p1.v + b0.p2.v);
        const v1 = 0.5 * (b1.p1.v + b1.p2.v);
        const len0 = Math.abs(b0.p2.u - b0.p1.u);
        const len1 = Math.abs(b1.p2.u - b1.p1.u);
        if (Math.abs(v1 - v0) >= 2.0 && (Math.abs(len0 - len1) >= 1.2 || Math.abs(Math.min(b0.p1.u, b0.p2.u) - Math.min(b1.p1.u, b1.p2.u)) >= 1.2)) {
          return {
            id,
            view,
            faceIds,
            isAtomic,
            isOuterEnvelope,
            isSolidOnly,
            hasDashedBoundary,
            area,
            bbox,
            segments,
            densePolygon,
            interiorSample,
            shapeKind: 'trapezoid',
            trapezoidSpec: {
              taperAxis: 'v',
              w0: v0,
              w1: v1,
              span0Min: Math.min(b0.p1.u, b0.p2.u),
              span0Max: Math.max(b0.p1.u, b0.p2.u),
              span1Min: Math.min(b1.p1.u, b1.p2.u),
              span1Max: Math.max(b1.p1.u, b1.p2.u),
              isTriangle: false,
            },
          };
        }
      }
      const vert = lineSegs.filter((s) => Math.abs(s.p1.u - s.p2.u) <= 1.2 && Math.abs(s.p1.v - s.p2.v) >= 1.5);
      if (vert.length === 2) {
        const b0 = vert[0];
        const b1 = vert[1];
        const u0 = 0.5 * (b0.p1.u + b0.p2.u);
        const u1 = 0.5 * (b1.p1.u + b1.p2.u);
        const len0 = Math.abs(b0.p2.v - b0.p1.v);
        const len1 = Math.abs(b1.p2.v - b1.p1.v);
        if (Math.abs(u1 - u0) >= 2.0 && (Math.abs(len0 - len1) >= 1.2 || Math.abs(Math.min(b0.p1.v, b0.p2.v) - Math.min(b1.p1.v, b1.p2.v)) >= 1.2)) {
          return {
            id,
            view,
            faceIds,
            isAtomic,
            isOuterEnvelope,
            isSolidOnly,
            hasDashedBoundary,
            area,
            bbox,
            segments,
            densePolygon,
            interiorSample,
            shapeKind: 'trapezoid',
            trapezoidSpec: {
              taperAxis: 'u',
              w0: u0,
              w1: u1,
              span0Min: Math.min(b0.p1.v, b0.p2.v),
              span0Max: Math.max(b0.p1.v, b0.p2.v),
              span1Min: Math.min(b1.p1.v, b1.p2.v),
              span1Max: Math.max(b1.p1.v, b1.p2.v),
              isTriangle: false,
            },
          };
        }
      }
    }

    return {
      id,
      view,
      faceIds,
      isAtomic,
      isOuterEnvelope,
      isSolidOnly,
      hasDashedBoundary,
      area,
      bbox,
      segments,
      densePolygon,
      interiorSample,
      shapeKind: 'polygon',
    };
  }

  return {
    id,
    view,
    faceIds,
    isAtomic,
    isOuterEnvelope,
    isSolidOnly,
    hasDashedBoundary,
    area,
    bbox,
    segments,
    densePolygon,
    interiorSample,
    shapeKind: 'arch_or_curved',
  };
}

/**
 * Builds a complete Planar DCEL on `splitSegments`, iteratively pruning degree-1 dangling spurs
 * so closed faces are never corrupted by centerlines or open annotations.
 */
export function buildDCELFromSplitSegments(
  splitSegments: SplitCurveSegment2D[]
): {
  vertices: DCELVertex[];
  halfEdges: DCELHalfEdge[];
  boundedFaces: DCELFace[];
  infiniteFaces: DCELFace[];
} {
  if (splitSegments.length === 0) {
    return { vertices: [], halfEdges: [], boundedFaces: [], infiniteFaces: [] };
  }

  // Cluster endpoints into unique DCEL vertices (tol <= 0.45mm)
  const vertices: DCELVertex[] = [];
  const getOrAddVertex = (pt: Vec2): number => {
    for (let i = 0; i < vertices.length; i++) {
      if (dist2(vertices[i].pt, pt) <= 0.45) return i;
    }
    const id = vertices.length;
    vertices.push({ id, pt: { ...pt }, outgoingHalfEdges: [] });
    return id;
  };

  interface EdgeEntry {
    seg: SplitCurveSegment2D;
    v1: number;
    v2: number;
    alive: boolean;
  }

  const edgeEntries: EdgeEntry[] = [];
  for (const seg of splitSegments) {
    const v1 = getOrAddVertex(seg.p1);
    const v2 = getOrAddVertex(seg.p2);
    if (v1 === v2) continue;
    edgeEntries.push({ seg, v1, v2, alive: true });
  }

  // Iteratively prune degree-1 dangling spurs so face cycles never walk down dead-end spikes
  let changed = true;
  let iter = 0;
  while (changed && iter < 64) {
    changed = false;
    iter++;
    const deg = new Int32Array(vertices.length);
    for (const e of edgeEntries) {
      if (!e.alive) continue;
      deg[e.v1]++;
      deg[e.v2]++;
    }
    for (const e of edgeEntries) {
      if (!e.alive) continue;
      if (deg[e.v1] <= 1 || deg[e.v2] <= 1) {
        e.alive = false;
        changed = true;
      }
    }
  }

  const activeEdges = edgeEntries.filter((e) => e.alive);
  if (activeEdges.length === 0) {
    return { vertices, halfEdges: [], boundedFaces: [], infiniteFaces: [] };
  }

  for (const v of vertices) v.outgoingHalfEdges = [];
  const halfEdges: DCELHalfEdge[] = [];

  const computeExitTangentAndCurvature = (
    seg: SplitCurveSegment2D,
    forward: boolean
  ): { angle: number; curvature: number } => {
    if (seg.kind === 'line' || !seg.center || !seg.radius) {
      const a = forward ? seg.p1 : seg.p2;
      const b = forward ? seg.p2 : seg.p1;
      return { angle: normAngle(Math.atan2(b.v - a.v, b.u - a.u)), curvature: 0 };
    }
    // Arc: p(θ) = c + R(cos θ, sin θ).
    // Forward (+dθ from startAngle): tangent at startAngle is (-sin sA, cos sA) = sA + π/2, curving LEFT (+1/R).
    // Backward (-dθ from endAngle): tangent at endAngle is (sin eA, -cos eA) = eA - π/2, curving RIGHT (-1/R).
    if (forward) {
      const sA = seg.startAngle ?? 0;
      return { angle: normAngle(sA + Math.PI * 0.5), curvature: 1 / seg.radius };
    } else {
      const eA = seg.endAngle ?? 0;
      return { angle: normAngle(eA - Math.PI * 0.5), curvature: -1 / seg.radius };
    }
  };

  for (const e of activeEdges) {
    const idFwd = halfEdges.length;
    const idRev = idFwd + 1;
    const tFwd = computeExitTangentAndCurvature(e.seg, true);
    const tRev = computeExitTangentAndCurvature(e.seg, false);
    halfEdges.push({
      id: idFwd,
      twinId: idRev,
      originVertexId: e.v1,
      targetVertexId: e.v2,
      nextHalfEdgeId: -1,
      faceId: -1,
      segment: e.seg,
      forward: true,
      exitTangentAngle: tFwd.angle,
      signedCurvature: tFwd.curvature,
    });
    halfEdges.push({
      id: idRev,
      twinId: idFwd,
      originVertexId: e.v2,
      targetVertexId: e.v1,
      nextHalfEdgeId: -1,
      faceId: -1,
      segment: e.seg,
      forward: false,
      exitTangentAngle: tRev.angle,
      signedCurvature: tRev.curvature,
    });
    vertices[e.v1].outgoingHalfEdges.push(idFwd);
    vertices[e.v2].outgoingHalfEdges.push(idRev);
  }

  // Sort outgoing half-edges CCW by exitTangentAngle, breaking ties by signedCurvature
  for (const v of vertices) {
    if (v.outgoingHalfEdges.length === 0) continue;
    v.outgoingHalfEdges.sort((aId, bId) => {
      const ha = halfEdges[aId];
      const hb = halfEdges[bId];
      const dAng = ha.exitTangentAngle - hb.exitTangentAngle;
      if (Math.abs(dAng) > 1e-4) return dAng;
      return ha.signedCurvature - hb.signedCurvature;
    });
  }

  // Link nextHalfEdgeId: to trace minimal CCW interior face on the LEFT of half-edge h,
  // at target vertex v = target(h), look up twin(h) in v.outgoingHalfEdges (sorted CCW)
  // and pick the PREVIOUS outgoing half-edge in cyclic CCW order (maximal left turn)!
  for (const h of halfEdges) {
    const vTarget = vertices[h.targetVertexId];
    const outs = vTarget.outgoingHalfEdges;
    const idx = outs.indexOf(h.twinId);
    if (idx !== -1 && outs.length > 0) {
      const nextIdx = (idx - 1 + outs.length) % outs.length;
      h.nextHalfEdgeId = outs[nextIdx];
    }
  }

  const boundedFaces: DCELFace[] = [];
  const infiniteFaces: DCELFace[] = [];
  let faceCounter = 0;

  for (const hStart of halfEdges) {
    if (hStart.faceId !== -1 || hStart.nextHalfEdgeId === -1) continue;
    const cycle: number[] = [];
    let curr = hStart.id;
    let steps = 0;
    let closedCleanly = false;
    while (curr !== -1 && steps < MAX_FACE_WALK_STEPS) {
      steps++;
      if (halfEdges[curr].faceId !== -1) break;
      cycle.push(curr);
      const nxt = halfEdges[curr].nextHalfEdgeId;
      if (nxt === hStart.id) {
        closedCleanly = true;
        break;
      }
      if (cycle.includes(nxt)) break;
      curr = nxt;
    }

    const fId = faceCounter++;
    for (const hid of cycle) halfEdges[hid].faceId = fId;
    if (!closedCleanly || cycle.length < 2) continue;

    const boundarySegments: LoopCurveSegment2D[] = cycle.map((hid) => {
      const he = halfEdges[hid];
      const s = he.segment;
      const p1 = vertices[he.originVertexId].pt;
      const p2 = vertices[he.targetVertexId].pt;
      if (s.kind === 'line' || !s.center || !s.radius) {
        return { kind: 'line', p1: { ...p1 }, p2: { ...p2 } };
      }
      return {
        kind: 'arc',
        p1: { ...p1 },
        p2: { ...p2 },
        center: { ...s.center },
        radius: s.radius,
        startAngle: s.startAngle,
        endAngle: s.endAngle,
        ccw: he.forward,
      };
    });

    const densePolygon = sampleLoopSegmentsToDensePolygon(boundarySegments, 56);
    const signedArea = polygonSignedArea(densePolygon);
    const absArea = Math.abs(signedArea);
    if (absArea < 0.8) continue;

    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const pt of densePolygon) {
      if (pt.u < uMin) uMin = pt.u;
      if (pt.u > uMax) uMax = pt.u;
      if (pt.v < vMin) vMin = pt.v;
      if (pt.v > vMax) vMax = pt.v;
    }
    const bbox: BBox2D = { uMin, uMax, vMin, vMax };
    const hasDashed = cycle.some((hid) => halfEdges[hid].segment.lineType === 'thin_dashed');
    const allSolid = cycle.every((hid) => halfEdges[hid].segment.lineType === 'thick_solid');

    const faceObj: DCELFace = {
      id: fId,
      isOuterInfinite: signedArea < 0,
      signedArea,
      area: absArea,
      bbox,
      boundaryHalfEdgeIds: cycle,
      boundarySegments,
      densePolygon,
      interiorSample: signedArea > 0 ? findGuaranteedInteriorPoint(densePolygon, bbox) : { u: uMin - 5, v: vMin - 5 },
      hasDashedBoundary: hasDashed,
      allSolidBoundary: allSolid,
      nestingDepth: 0,
      parentFaceId: null,
    };

    if (signedArea > 0) {
      boundedFaces.push(faceObj);
    } else {
      infiniteFaces.push(faceObj);
    }
  }

  // Compute nesting hierarchy among bounded faces
  boundedFaces.sort((a, b) => b.area - a.area);
  for (let i = 0; i < boundedFaces.length; i++) {
    const child = boundedFaces[i];
    let depth = 0;
    let bestParent: DCELFace | null = null;
    for (let j = 0; j < i; j++) {
      const parent = boundedFaces[j];
      if (
        child.bbox.uMin >= parent.bbox.uMin - 0.5 &&
        child.bbox.uMax <= parent.bbox.uMax + 0.5 &&
        child.bbox.vMin >= parent.bbox.vMin - 0.5 &&
        child.bbox.vMax <= parent.bbox.vMax + 0.5 &&
        isPointStrictlyInPolygon(child.interiorSample, parent.densePolygon)
      ) {
        depth++;
        if (!bestParent || parent.area < bestParent.area) {
          bestParent = parent;
        }
      }
    }
    child.nestingDepth = depth;
    child.parentFaceId = bestParent ? bestParent.id : null;
  }

  // Ensure any face containing nested child holes samples its interior witness point in the solid annulus
  // strictly OUTSIDE all nested child faces (so sightline rays never force a through-hole center to be solid!)
  for (let i = 0; i < boundedFaces.length; i++) {
    const face = boundedFaces[i];
    const nested = boundedFaces.filter(
      (other, idx) =>
        idx !== i &&
        other.area < face.area &&
        other.nestingDepth > face.nestingDepth &&
        other.bbox.uMin >= face.bbox.uMin - 0.5 &&
        other.bbox.uMax <= face.bbox.uMax + 0.5 &&
        other.bbox.vMin >= face.bbox.vMin - 0.5 &&
        other.bbox.vMax <= face.bbox.vMax + 0.5
    );
    if (nested.length === 0) continue;
    const insideHole = (pt: Vec2) =>
      nested.some((ch) => isPointStrictlyInPolygon(pt, ch.densePolygon));
    if (!insideHole(face.interiorSample)) continue;

    let found: Vec2 | null = null;
    const G = 13;
    const du = (face.bbox.uMax - face.bbox.uMin) / G;
    const dv = (face.bbox.vMax - face.bbox.vMin) / G;
    for (let r = 1; r < G && !found; r++) {
      for (let c = 1; c < G && !found; c++) {
        const cand = { u: face.bbox.uMin + c * du, v: face.bbox.vMin + r * dv };
        if (isPointStrictlyInPolygon(cand, face.densePolygon) && !insideHole(cand)) {
          found = cand;
        }
      }
    }
    if (found) {
      face.interiorSample = found;
    }
  }

  return { vertices, halfEdges, boundedFaces, infiniteFaces };
}

/**
 * Computes union boundary cycle(s) of a subset of DCEL faces (e.g., to extract outer silhouette
 * or merge shared-chord inner semicircle + crescent into full outer semicircle).
 */
export function buildUnionFaceProfiles(
  faceSubset: DCELFace[],
  halfEdges: DCELHalfEdge[],
  vertices: DCELVertex[],
  view: ViewType,
  idPrefix: string,
  isOuterEnvelope: boolean
): RegionProfile2D[] {
  if (faceSubset.length === 0) return [];
  const inSubset = new Set(faceSubset.map((f) => f.id));

  // Boundary half-edges are those whose faceId is in inSubset while twin.faceId is NOT in inSubset!
  const boundaryHEs = halfEdges.filter(
    (he) => inSubset.has(he.faceId) && !inSubset.has(halfEdges[he.twinId].faceId)
  );
  if (boundaryHEs.length === 0) return [];

  const outgoingByVert = new Map<number, DCELHalfEdge[]>();
  for (const he of boundaryHEs) {
    const list = outgoingByVert.get(he.originVertexId) || [];
    list.push(he);
    outgoingByVert.set(he.originVertexId, list);
  }

  const visited = new Set<number>();
  const profiles: RegionProfile2D[] = [];
  let idx = 0;

  for (const startHE of boundaryHEs) {
    if (visited.has(startHE.id)) continue;
    const cycle: DCELHalfEdge[] = [];
    let curr: DCELHalfEdge | undefined = startHE;
    let guard = 0;
    while (curr && !visited.has(curr.id) && guard < MAX_FACE_WALK_STEPS) {
      guard++;
      visited.add(curr.id);
      cycle.push(curr);
      if (curr.targetVertexId === startHE.originVertexId) break;
      const cands = (outgoingByVert.get(curr.targetVertexId) || []).filter((h) => !visited.has(h.id));
      if (cands.length === 0) break;
      if (cands.length === 1) {
        curr = cands[0];
      } else {
        // Choose minimal CCW turn relative to twin
        const twinAng = halfEdges[curr.twinId].exitTangentAngle;
        cands.sort((a, b) => normAngle(twinAng - a.exitTangentAngle) - normAngle(twinAng - b.exitTangentAngle));
        curr = cands[0];
      }
    }
    if (cycle.length < 2) continue;

    const segs: LoopCurveSegment2D[] = cycle.map((he) => {
      const s = he.segment;
      const p1 = vertices[he.originVertexId].pt;
      const p2 = vertices[he.targetVertexId].pt;
      if (s.kind === 'line' || !s.center || !s.radius) {
        return { kind: 'line', p1: { ...p1 }, p2: { ...p2 } };
      }
      return {
        kind: 'arc',
        p1: { ...p1 },
        p2: { ...p2 },
        center: { ...s.center },
        radius: s.radius,
        startAngle: s.startAngle,
        endAngle: s.endAngle,
        ccw: he.forward,
      };
    });

    const dense = sampleLoopSegmentsToDensePolygon(segs, 56);
    const sArea = polygonSignedArea(dense);
    // Only keep positive CCW outer boundary loops (negative cycles are internal holes of the union)
    if (sArea <= 1.0) continue;

    const isSolidOnly = cycle.every((he) => he.segment.lineType === 'thick_solid');
    const hasDashed = cycle.some((he) => he.segment.lineType === 'thin_dashed');

    profiles.push(
      classifyRegionProfile2D(
        `${idPrefix}-${idx++}`,
        view,
        faceSubset.map((f) => f.id),
        segs,
        false,
        isOuterEnvelope,
        isSolidOnly,
        hasDashed
      )
    );
  }

  return profiles;
}
