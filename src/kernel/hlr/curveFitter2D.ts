import {
  CadArcEntity,
  CadCircleEntity,
  CadEntity,
  CadLineEntity,
  LineType,
  Point2D,
  Primitive3D,
  ViewType,
} from '../../types/cad';
import {
  arcSweepCCW,
  dist2,
  getViewAxisSpec,
  normAngle,
  projectPoint3DToView,
  TWO_PI,
} from '../core/coordSystem';
import { ClassifiedSegment2D } from '../core/types';
import { getPrimitiveLoftEquivalent } from '../lifting3d/analyticSurfaces';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Deduplicate and stitch classified 2D visible/hidden segments under strict GB/T 4458.4 priority
 * (`thick_solid > thin_dashed > center_dot_dash`), restoring native `line`, `circle`, and `arc`
 * entities (`source: 'derived'`) plus strictly horizontal/vertical orthogonal revolution centerlines!
 */
export function fitClassifiedSegmentsToCadEntities(
  classified: ClassifiedSegment2D[],
  primitives: Primitive3D[],
  view: ViewType
): CadEntity[] {
  const entities: CadEntity[] = [];
  let seq = 0;

  // ==========================================================================
  // 1. Stitch Concentric Co-Radius Arcs (Priority: thick_solid > thin_dashed)
  // ==========================================================================
  const arcSegs = classified.filter(
    (s) =>
      s.kind === 'arc' &&
      s.center &&
      s.radius !== undefined &&
      s.startAngle !== undefined &&
      s.endAngle !== undefined
  );

  interface CircleBucket {
    center: Point2D;
    radius: number;
    segs: ClassifiedSegment2D[];
  }
  const circleBuckets: CircleBucket[] = [];
  for (const s of arcSegs) {
    let b = circleBuckets.find(
      (bk) =>
        dist2(bk.center, s.center!) <= 0.2 &&
        Math.abs(bk.radius - s.radius!) <= 0.2
    );
    if (!b) {
      b = { center: { ...s.center! }, radius: s.radius!, segs: [] };
      circleBuckets.push(b);
    }
    b.segs.push(s);
  }

  for (const bk of circleBuckets) {
    // 720-bin high-res angular coverage map (`2 = thick_solid`, `1 = thin_dashed`, `0 = empty`)
    const NB = 720;
    const bins = new Uint8Array(NB);
    let featId: string | undefined;
    let featLabel: string | undefined;

    for (const s of bk.segs) {
      if (!featId && s.featureId) {
        featId = s.featureId;
        featLabel = s.featureLabel;
      }
      const prio = s.lineType === 'thick_solid' ? 2 : 1;
      const sw = arcSweepCCW(s.startAngle!, s.endAngle!);
      for (let k = 0; k < NB; k++) {
        const ang = ((k + 0.5) / NB) * TWO_PI;
        const rel = normAngle(ang - s.startAngle!);
        if (rel <= sw + 1e-4) {
          if (prio > bins[k]) bins[k] = prio;
        }
      }
    }

    // Bridge 1-bin micro-glitches
    for (let k = 0; k < NB; k++) {
      const prev = bins[(k - 1 + NB) % NB];
      const next = bins[(k + 1) % NB];
      if (prev === next && prev > bins[k]) bins[k] = prev;
    }

    const solidCount = bins.reduce((acc, v) => acc + (v === 2 ? 1 : 0), 0);
    const dashedCount = bins.reduce((acc, v) => acc + (v === 1 ? 1 : 0), 0);

    if (solidCount >= NB - 3) {
      const circEnt: CadCircleEntity = {
        id: `der_${view}_cir_${seq++}`,
        view,
        type: 'circle',
        lineType: 'thick_solid',
        center: { u: round2(bk.center.u), v: round2(bk.center.v) },
        radius: round2(bk.radius),
        source: 'derived',
        featureId: featId,
        featureLabel: featLabel,
      };
      entities.push(circEnt);
      continue;
    }
    if (dashedCount >= NB - 3 && solidCount === 0) {
      const circEnt: CadCircleEntity = {
        id: `der_${view}_dcir_${seq++}`,
        view,
        type: 'circle',
        lineType: 'thin_dashed',
        center: { u: round2(bk.center.u), v: round2(bk.center.v) },
        radius: round2(bk.radius),
        source: 'derived',
        featureId: featId,
        featureLabel: featLabel,
      };
      entities.push(circEnt);
      continue;
    }

    // Extract contiguous non-zero runs around the 720-bin ring!
    let startIdx = 0;
    for (let k = 0; k < NB; k++) {
      if (bins[k] !== bins[(k - 1 + NB) % NB]) {
        startIdx = k;
        break;
      }
    }

    let offset = 0;
    while (offset < NB) {
      const idx = (startIdx + offset) % NB;
      const val = bins[idx];
      if (val === 0) {
        offset++;
        continue;
      }
      let runLen = 1;
      while (
        offset + runLen < NB &&
        bins[(startIdx + offset + runLen) % NB] === val
      ) {
        runLen++;
      }
      const sAng = normAngle((idx / NB) * TWO_PI);
      const eAng = normAngle(((idx + runLen) / NB) * TWO_PI);
      const arcLen = (runLen / NB) * TWO_PI * bk.radius;
      if (arcLen >= 0.45) {
        const arcEnt: CadArcEntity = {
          id: `der_${view}_arc_${seq++}`,
          view,
          type: 'arc',
          lineType: val === 2 ? 'thick_solid' : 'thin_dashed',
          center: { u: round2(bk.center.u), v: round2(bk.center.v) },
          radius: round2(bk.radius),
          startAngle: Number(sAng.toFixed(4)),
          endAngle: Number(eAng.toFixed(4)),
          source: 'derived',
          featureId: featId,
          featureLabel: featLabel,
        };
        entities.push(arcEnt);
      }
      offset += runLen;
    }
  }

  // ==========================================================================
  // 2. Stitch Collinear Line Segments (Priority: thick_solid > thin_dashed)
  //    Also suppress line segments that overlap an already-emitted circle/arc chord!
  // ==========================================================================
  const lineSegs = classified.filter((s) => s.kind === 'line');

  interface LineGroup {
    origin: Point2D;
    dir: Point2D;
    normal: Point2D;
    segs: {
      s0: number;
      s1: number;
      prio: 1 | 2;
      featureId?: string;
      featureLabel?: string;
    }[];
  }
  const lineGroups: LineGroup[] = [];

  for (const ls of lineSegs) {
    const du = ls.p2.u - ls.p1.u;
    const dv = ls.p2.v - ls.p1.v;
    const len = Math.hypot(du, dv);
    if (len < 0.06) continue;

    let dirU = du / len;
    let dirV = dv / len;
    if (dirU < -1e-6 || (Math.abs(dirU) <= 1e-6 && dirV < 0)) {
      dirU = -dirU;
      dirV = -dirV;
    }
    if (Math.abs(dirV) < 0.008) {
      dirU = 1;
      dirV = 0;
    } else if (Math.abs(dirU) < 0.008) {
      dirU = 0;
      dirV = 1;
    }

    let grp = lineGroups.find((g) => {
      const dot = Math.abs(g.dir.u * dirU + g.dir.v * dirV);
      if (dot < 0.9997) return false;
      const perp = Math.abs(
        (ls.p1.u - g.origin.u) * g.normal.u +
          (ls.p1.v - g.origin.v) * g.normal.v
      );
      return perp <= 0.22;
    });

    if (!grp) {
      grp = {
        origin: { ...ls.p1 },
        dir: { u: dirU, v: dirV },
        normal: { u: -dirV, v: dirU },
        segs: [],
      };
      lineGroups.push(grp);
    }

    const sA =
      (ls.p1.u - grp.origin.u) * grp.dir.u +
      (ls.p1.v - grp.origin.v) * grp.dir.v;
    const sB =
      (ls.p2.u - grp.origin.u) * grp.dir.u +
      (ls.p2.v - grp.origin.v) * grp.dir.v;
    grp.segs.push({
      s0: Math.min(sA, sB),
      s1: Math.max(sA, sB),
      prio: ls.lineType === 'thick_solid' ? 2 : 1,
      featureId: ls.featureId,
      featureLabel: ls.featureLabel,
    });
  }

  for (const grp of lineGroups) {
    // Sweep-line exact interval union where prio 2 (`thick_solid`) overrides prio 1 (`thin_dashed`)!
    const events: number[] = [];
    for (const sg of grp.segs) {
      events.push(sg.s0, sg.s1);
    }
    events.sort((a, b) => a - b);
    const uniq: number[] = [];
    for (const ev of events) {
      if (uniq.length === 0 || ev - uniq[uniq.length - 1] > 0.04) {
        uniq.push(ev);
      }
    }

    interface SpanOut {
      s0: number;
      s1: number;
      prio: 1 | 2;
      featureId?: string;
      featureLabel?: string;
    }
    const atomicSpans: SpanOut[] = [];
    for (let k = 0; k < uniq.length - 1; k++) {
      const a = uniq[k];
      const b = uniq[k + 1];
      const mid = 0.5 * (a + b);
      let bestPrio: 0 | 1 | 2 = 0;
      let fId: string | undefined;
      let fLbl: string | undefined;
      for (const sg of grp.segs) {
        if (mid >= sg.s0 - 0.02 && mid <= sg.s1 + 0.02) {
          if (sg.prio > bestPrio) {
            bestPrio = sg.prio;
            fId = sg.featureId;
            fLbl = sg.featureLabel;
          }
        }
      }
      if (bestPrio > 0) {
        atomicSpans.push({
          s0: a,
          s1: b,
          prio: bestPrio as 1 | 2,
          featureId: fId,
          featureLabel: fLbl,
        });
      }
    }

    // Merge adjacent spans of identical priority across tiny numerical gaps (<= 0.35mm)
    const mergedSpans: SpanOut[] = [];
    for (const sp of atomicSpans) {
      if (mergedSpans.length === 0) {
        mergedSpans.push({ ...sp });
        continue;
      }
      const prev = mergedSpans[mergedSpans.length - 1];
      if (prev.prio === sp.prio && sp.s0 <= prev.s1 + 0.35) {
        prev.s1 = Math.max(prev.s1, sp.s1);
      } else {
        mergedSpans.push({ ...sp });
      }
    }

    for (const sp of mergedSpans) {
      if (sp.s1 - sp.s0 < 0.45) continue;
      const p1 = {
        u: round2(grp.origin.u + grp.dir.u * sp.s0),
        v: round2(grp.origin.v + grp.dir.v * sp.s0),
      };
      const p2 = {
        u: round2(grp.origin.u + grp.dir.u * sp.s1),
        v: round2(grp.origin.v + grp.dir.v * sp.s1),
      };
      if (dist2(p1, p2) < 0.45) continue;

      const lnEnt: CadLineEntity = {
        id: `der_${view}_ln_${seq++}`,
        view,
        type: 'line',
        lineType: sp.prio === 2 ? 'thick_solid' : 'thin_dashed',
        p1,
        p2,
        source: 'derived',
        featureId: sp.featureId,
        featureLabel: sp.featureLabel,
      };
      entities.push(lnEnt);
    }
  }

  // ==========================================================================
  // 3. Synthesize Orthogonal Revolution Axes & Circle Crosshair Centerlines
  //    Strictly locked to HORIZONTAL (`dv === 0`) or VERTICAL (`du === 0`)!
  // ==========================================================================
  const centerlines = synthesizeOrthogonalCenterlines(
    entities,
    primitives,
    view,
    seq
  );
  entities.push(...centerlines);

  return entities;
}

function synthesizeOrthogonalCenterlines(
  existingEntities: CadEntity[],
  primitives: Primitive3D[],
  view: ViewType,
  startSeq: number
): CadLineEntity[] {
  const { uAxis, vAxis, wAxis } = getViewAxisSpec(view);
  let seq = startSeq;

  interface AxisCand {
    orientation: 'H' | 'V';
    coord: number; // v for 'H', u for 'V'
    spanMin: number;
    spanMax: number;
    featureId?: string;
  }
  const cands: AxisCand[] = [];

  // 1. Crosshairs for full circles and major arcs (>= 180 deg) in `existingEntities`
  for (const ent of existingEntities) {
    if (ent.type === 'circle' || ent.type === 'arc') {
      if (
        ent.type === 'arc' &&
        arcSweepCCW(ent.startAngle, ent.endAngle) < Math.PI - 0.05
      ) {
        continue;
      }
      const ext = Math.min(4.5, Math.max(2.5, ent.radius * 0.18));
      cands.push(
        {
          orientation: 'H',
          coord: ent.center.v,
          spanMin: ent.center.u - ent.radius - ext,
          spanMax: ent.center.u + ent.radius + ext,
          featureId: ent.featureId,
        },
        {
          orientation: 'V',
          coord: ent.center.u,
          spanMin: ent.center.v - ent.radius - ext,
          spanMax: ent.center.v + ent.radius + ext,
          featureId: ent.featureId,
        }
      );
    }
  }

  // 2. Side-view revolution axes for Cylinders, Right Cones/Frustums, Spheres, and Hemispheres
  //    CRITICAL: Skip oblique/eccentric frustums whose centerline is tilted (`dc != 0`) so NO diagonal centerlines ever fly across the drawing!
  for (const prim of primitives) {
    if (prim.shape === 'sphere' || prim.shape === 'hemisphere') {
      const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
      const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
      const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
      const c2 = projectPoint3DToView({ x: cx, y: cy, z: cz }, view);
      const bMin = projectPoint3DToView(
        { x: prim.xMin, y: prim.yMin, z: prim.zMin },
        view
      );
      const bMax = projectPoint3DToView(
        { x: prim.xMax, y: prim.yMax, z: prim.zMax },
        view
      );
      cands.push(
        {
          orientation: 'H',
          coord: c2.v,
          spanMin: Math.min(bMin.u, bMax.u) - 3.5,
          spanMax: Math.max(bMin.u, bMax.u) + 3.5,
          featureId: prim.featureId,
        },
        {
          orientation: 'V',
          coord: c2.u,
          spanMin: Math.min(bMin.v, bMax.v) - 3.5,
          spanMax: Math.max(bMin.v, bMax.v) + 3.5,
          featureId: prim.featureId,
        }
      );
      continue;
    }

    const loft = getPrimitiveLoftEquivalent(prim);
    if (!loft) continue;
    if (loft.section0.polygon || loft.section1.polygon) continue;
    // Must be coaxial (`|dc_u| < 0.2` and `|dc_v| < 0.2`) — strictly orthogonal axis!
    if (
      Math.abs(loft.section1.centerU - loft.section0.centerU) > 0.2 ||
      Math.abs(loft.section1.centerV - loft.section0.centerV) > 0.2
    ) {
      continue;
    }
    if (loft.axis === wAxis) continue; // End-on already handled by circle crosshair above

    const pStart3 =
      loft.axis === 'Z'
        ? { x: loft.section0.centerU, y: loft.section0.centerV, z: loft.w0 }
        : loft.axis === 'Y'
        ? { x: loft.section0.centerU, y: loft.w0, z: loft.section0.centerV }
        : { x: loft.w0, y: loft.section0.centerU, z: loft.section0.centerV };
    const pEnd3 =
      loft.axis === 'Z'
        ? { x: loft.section1.centerU, y: loft.section1.centerV, z: loft.w1 }
        : loft.axis === 'Y'
        ? { x: loft.section1.centerU, y: loft.w1, z: loft.section1.centerV }
        : { x: loft.w1, y: loft.section1.centerU, z: loft.section1.centerV };

    const qA = projectPoint3DToView(pStart3, view);
    const qB = projectPoint3DToView(pEnd3, view);

    if (loft.axis === uAxis) {
      // Horizontal axis!
      cands.push({
        orientation: 'H',
        coord: qA.v,
        spanMin: Math.min(qA.u, qB.u) - 4.0,
        spanMax: Math.max(qA.u, qB.u) + 4.0,
        featureId: prim.featureId,
      });
    } else if (loft.axis === vAxis) {
      // Vertical axis!
      cands.push({
        orientation: 'V',
        coord: qA.u,
        spanMin: Math.min(qA.v, qB.v) - 4.0,
        spanMax: Math.max(qA.v, qB.v) + 4.0,
        featureId: prim.featureId,
      });
    }
  }

  // Merge collinear centerlines and suppress any interval completely covered by an existing `thick_solid` or `thin_dashed` line!
  const merged: AxisCand[] = [];
  for (const c of cands) {
    const ex = merged.find(
      (m) =>
        m.orientation === c.orientation &&
        Math.abs(m.coord - c.coord) <= 0.35 &&
        Math.max(m.spanMin, c.spanMin) <= Math.min(m.spanMax, c.spanMax) + 8.0
    );
    if (ex) {
      ex.spanMin = Math.min(ex.spanMin, c.spanMin);
      ex.spanMax = Math.max(ex.spanMax, c.spanMax);
    } else {
      merged.push({ ...c });
    }
  }

  const out: CadLineEntity[] = [];
  for (const m of merged) {
    // Check if an existing thick_solid line completely covers `[m.spanMin + 4, m.spanMax - 4]` along `m.coord` (e.g. semi-cone flat back wall on centerline!)
    const coveredBySolid = existingEntities.some((ent) => {
      if (ent.type !== 'line' || ent.lineType !== 'thick_solid') return false;
      if (m.orientation === 'H' && Math.abs(ent.p1.v - ent.p2.v) < 0.3) {
        if (Math.abs(ent.p1.v - m.coord) <= 0.35) {
          const lo = Math.min(ent.p1.u, ent.p2.u);
          const hi = Math.max(ent.p1.u, ent.p2.u);
          return lo <= m.spanMin + 5 && hi >= m.spanMax - 5;
        }
      }
      if (m.orientation === 'V' && Math.abs(ent.p1.u - ent.p2.u) < 0.3) {
        if (Math.abs(ent.p1.u - m.coord) <= 0.35) {
          const lo = Math.min(ent.p1.v, ent.p2.v);
          const hi = Math.max(ent.p1.v, ent.p2.v);
          return lo <= m.spanMin + 5 && hi >= m.spanMax - 5;
        }
      }
      return false;
    });
    if (coveredBySolid) continue;

    const p1: Point2D =
      m.orientation === 'H'
        ? { u: round2(m.spanMin), v: round2(m.coord) }
        : { u: round2(m.coord), v: round2(m.spanMin) };
    const p2: Point2D =
      m.orientation === 'H'
        ? { u: round2(m.spanMax), v: round2(m.coord) }
        : { u: round2(m.coord), v: round2(m.spanMax) };

    const lineType: LineType = 'center_dot_dash';
    out.push({
      id: `der_${view}_cl_${seq++}`,
      view,
      type: 'line',
      lineType,
      p1,
      p2,
      source: 'derived',
      featureId: m.featureId,
      featureLabel: '回转轴线 / 对称中心线',
    });
  }

  return out;
}
