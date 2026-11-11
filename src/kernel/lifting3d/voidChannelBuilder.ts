import { GeneralizedLoftPayload, Point2D, Primitive3D } from '../../types/cad';
import {
  composeFromAxis,
  getSharedAxisBetweenViews,
  getViewAxisSpec,
} from '../core/coordSystem';
import {
  Axis3D,
  BoundingBox2D,
  BoundingBox3D,
  CandidateSolidVolume,
  CandidateVoidChannel,
  CompositeRegion2D,
  ParallelDashedBand2D,
  TaperedDashedBand2D,
  ViewArrangementResult,
} from '../core/types';

function getSpanOnCoord(b: BoundingBox2D, coord: 'u' | 'v'): [number, number] {
  return coord === 'u' ? [b.uMin, b.uMax] : [b.vMin, b.vMax];
}

function makeBoundsFromAxis(
  axis: Axis3D,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  wMin: number,
  wMax: number
): BoundingBox3D {
  if (axis === 'Z') {
    return { xMin: uMin, xMax: uMax, yMin: vMin, yMax: vMax, zMin: wMin, zMax: wMax };
  }
  if (axis === 'Y') {
    return { xMin: uMin, xMax: uMax, yMin: wMin, yMax: wMax, zMin: vMin, zMax: vMax };
  }
  return { xMin: wMin, xMax: wMax, yMin: uMin, yMax: uMax, zMin: vMin, zMax: vMax };
}

function getSolidGlobalSpanAlongAxis(
  solids: CandidateSolidVolume[],
  axis: Axis3D
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of solids) {
    const a = axis === 'X' ? s.bounds.xMin : axis === 'Y' ? s.bounds.yMin : s.bounds.zMin;
    const b = axis === 'X' ? s.bounds.xMax : axis === 'Y' ? s.bounds.yMax : s.bounds.zMax;
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [20, 90];
  return [lo, hi];
}

/**
 * Lift all void channels (through-holes, blind/T-branch holes, slanted semi-frustum holes,
 * open U-slots, and orthogonal crossed bores) strictly obeying the **Visible Opening Law**:
 * 1. NEVER interlock two orthogonal inner `thick_solid` loops into an isolated bubble trapped inside the core!
 * 2. Each inner loop pairs independently with matching `thin_dashed` bands (or through-span when piercing a tapered/slotted flank) to form an unobstructed opening channel!
 * 3. T-junction branch bores terminating against an orthogonal main bore automatically extend to the main bore's axis to guarantee 100% clean manifold intersection!
 */
export function buildCandidateVoidChannels(
  arr1: ViewArrangementResult,
  arr2: ViewArrangementResult,
  solidCandidates: CandidateSolidVolume[]
): CandidateVoidChannel[] {
  const voids: CandidateVoidChannel[] = [];
  const mapping = getSharedAxisBetweenViews(arr1.view, arr2.view);
  let seq = 0;

  const pushVoid = (
    prim: Primitive3D,
    axis: Axis3D,
    isThrough: boolean,
    hasDashedEvidence: boolean,
    hasInnerLoopEvidence: boolean,
    confidence: number,
    description: string
  ) => {
    const bounds: BoundingBox3D = {
      xMin: prim.xMin,
      xMax: prim.xMax,
      yMin: prim.yMin,
      yMax: prim.yMax,
      zMin: prim.zMin,
      zMax: prim.zMax,
    };
    if (
      bounds.xMax - bounds.xMin < 0.5 ||
      bounds.yMax - bounds.yMin < 0.5 ||
      bounds.zMax - bounds.zMin < 0.5
    ) {
      return;
    }

    // Deduplicate overlapping identical void channels
    const dup = voids.find(
      (v) =>
        v.axis === axis &&
        v.primitive.shape === prim.shape &&
        Math.abs(v.bounds.xMin - bounds.xMin) <= 0.8 &&
        Math.abs(v.bounds.xMax - bounds.xMax) <= 0.8 &&
        Math.abs(v.bounds.yMin - bounds.yMin) <= 0.8 &&
        Math.abs(v.bounds.yMax - bounds.yMax) <= 0.8 &&
        Math.abs(v.bounds.zMin - bounds.zMin) <= 0.8 &&
        Math.abs(v.bounds.zMax - bounds.zMax) <= 0.8
    );
    if (dup) {
      if (hasDashedEvidence) dup.hasDashedEvidence = true;
      if (hasInnerLoopEvidence) dup.hasInnerLoopEvidence = true;
      dup.confidence = Math.max(dup.confidence, confidence);
      return;
    }

    voids.push({
      id: `void_${seq++}`,
      primitive: prim,
      bounds,
      axis,
      isThrough,
      hasDashedEvidence,
      hasInnerLoopEvidence,
      confidence,
      description,
    });
  };

  // ==========================================================================
  // 1. Directional Inner Loops (Inner Circles, Inner Rects/Polygons, Co-Chord Semicircles)
  //    in `endArr` paired with `parallelDashedBands` / `taperedDashedBands` in `sideArr`!
  // ==========================================================================
  const liftDirectionalVoids = (
    endArr: ViewArrangementResult,
    sideArr: ViewArrangementResult,
    endSharedCoord: 'u' | 'v',
    sideSharedCoord: 'u' | 'v',
    sideSweepCoord: 'u' | 'v',
    holeAxis: Axis3D
  ) => {
    const [globalWMin, globalWMax] = getSolidGlobalSpanAlongAxis(
      solidCandidates,
      holeAxis
    );

    // 1A. Inner Circles (`nestingDepth >= 1` OR dashed circles!) in `endArr`
    for (const vc of endArr.circleCarriers) {
      if (vc.nestingDepth === 0 && vc.dominantLineType === 'thick_solid') {
        continue;
      }
      const cShared = endSharedCoord === 'u' ? vc.center.u : vc.center.v;
      const r = vc.radius;
      const span0 = cShared - r;
      const span1 = cShared + r;

      // Check if this inner circle is actually a positive coaxial step boss!
      // A positive boss has a matching solid tier in `sideArr` OUTSIDE the base AND no internal dashed hole lines.
      const matchingSolidBoss = sideArr.regions.some((sr) => {
        const [s0, s1] = getSpanOnCoord(sr.bounds, sideSharedCoord);
        return (
          !sr.isFullEnvelope &&
          Math.abs(s0 - span0) <= 1.2 &&
          Math.abs(s1 - span1) <= 1.2
        );
      });

      // Find all matching parallel dashed bands in `sideArr`
      const matchingBands: ParallelDashedBand2D[] = sideArr.parallelDashedBands.filter(
        (b) =>
          b.axis === sideSharedCoord &&
          Math.abs(b.c1 - span0) <= 1.4 &&
          Math.abs(b.c2 - span1) <= 1.4
      );

      if (matchingBands.length > 0) {
        const cylShape: Primitive3D['shape'] =
          holeAxis === 'Z'
            ? 'cylinder_z'
            : holeAxis === 'Y'
            ? 'cylinder_y'
            : 'cylinder_x';

        for (const band of matchingBands) {
          const w0 = band.spanMin;
          const w1 = band.spanMax;
          const b = makeBoundsFromAxis(
            holeAxis,
            vc.center.u - r,
            vc.center.u + r,
            vc.center.v - r,
            vc.center.v + r,
            w0,
            w1
          );
          const c3 = composeFromAxis(
            holeAxis,
            vc.center.u,
            vc.center.v,
            0.5 * (w0 + w1)
          );
          const isThru =
            w0 <= globalWMin + 1.5 && w1 >= globalWMax - 1.5;
          const prim: Primitive3D = {
            id: `prim_void_cyl_${seq}`,
            featureId: `feat_hole_${seq}`,
            label: isThru
              ? `Ø${(2 * r).toFixed(0)} 圆柱通孔`
              : `Ø${(2 * r).toFixed(0)} 圆柱半通孔/阶梯孔`,
            operation: 'subtract',
            shape: cylShape,
            ...b,
            centerX: c3.x,
            centerY: c3.y,
            centerZ: c3.z,
            radius: r,
            isInternalFeature: true,
            isInsideLoopContour: vc.dominantLineType === 'thick_solid',
          };
          pushVoid(
            prim,
            holeAxis,
            isThru,
            true,
            vc.dominantLineType === 'thick_solid',
            1.0,
            prim.label
          );
        }
        continue;
      }

      // Check matching tapered dashed bands (conical / frustum hole!)
      const matchingTapered: TaperedDashedBand2D[] = sideArr.taperedDashedBands.filter(
        (tb) =>
          tb.sweepAxis === sideSweepCoord &&
          (Math.abs(tb.r0 - r) <= 1.4 || Math.abs(tb.r1 - r) <= 1.4) &&
          Math.abs(0.5 * (tb.center0 + tb.center1) - cShared) <= 2.0
      );
      if (matchingTapered.length > 0) {
        for (const tb of matchingTapered) {
          const rMax = Math.max(tb.r0, tb.r1);
          const loftSpec: GeneralizedLoftPayload = {
            axis: holeAxis,
            w0: tb.w0,
            w1: tb.w1,
            section0: {
              kind: tb.r0 <= 0.2 ? 'point' : 'circle',
              centerU: vc.center.u,
              centerV: vc.center.v,
              radiusU: tb.r0,
            },
            section1: {
              kind: tb.r1 <= 0.2 ? 'point' : 'circle',
              centerU: vc.center.u,
              centerV: vc.center.v,
              radiusU: tb.r1,
            },
          };
          const b = makeBoundsFromAxis(
            holeAxis,
            vc.center.u - rMax,
            vc.center.u + rMax,
            vc.center.v - rMax,
            vc.center.v + rMax,
            tb.w0,
            tb.w1
          );
          const prim: Primitive3D = {
            id: `prim_void_taper_${seq}`,
            featureId: `feat_taper_hole_${seq}`,
            label: `圆台斜通孔 (R${tb.r0.toFixed(0)}→R${tb.r1.toFixed(0)})`,
            operation: 'subtract',
            shape: 'generalized_loft',
            ...b,
            rMin: tb.r0,
            rMax: tb.r1,
            loftSpec,
            isInternalFeature: true,
          };
          pushVoid(prim, holeAxis, true, true, true, 1.0, prim.label);
        }
        continue;
      }

      if (matchingSolidBoss) {
        // Hard Constraint: "无虚线不打假孔"! It's a boss step, NOT a hole.
        continue;
      }
    }

    // 1B. Co-Chord Semicircles & Inner Semicircles paired with Tapered Dashed Bands (Case 5: 共顶弦双半圆内部八字斜通孔!)
    const semiRegions = endArr.regions.filter(
      (r) =>
        r.profileKind === 'semicircle' &&
        !r.isFullEnvelope &&
        r.profileMeta?.center &&
        r.profileMeta?.radius !== undefined
    );
    const emittedSemiLoftKeys = new Set<string>();
    for (const sReg of semiRegions) {
      // Must be strictly smaller than outer bounds (i.e. an inner or co-chord smaller semicircle!)
      if (
        endArr.bounds &&
        sReg.bounds.uMax - sReg.bounds.uMin >=
          endArr.bounds.uMax - endArr.bounds.uMin - 1.0 &&
        sReg.bounds.vMax - sReg.bounds.vMin >=
          endArr.bounds.vMax - endArr.bounds.vMin - 1.0
      ) {
        continue;
      }
      const c0 = sReg.profileMeta!.center!;
      const rSemi = sReg.profileMeta!.radius!;
      const cShared = endSharedCoord === 'u' ? c0.u : c0.v;

      for (const tb of sideArr.taperedDashedBands) {
        if (tb.sweepAxis !== sideSweepCoord) continue;
        if (
          (Math.abs(tb.r0 - rSemi) <= 1.5 || Math.abs(tb.r1 - rSemi) <= 1.5) &&
          Math.abs(0.5 * (tb.center0 + tb.center1) - cShared) <= 1.8
        ) {
          const dedupKey = `${holeAxis}_${tb.w0.toFixed(1)}_${tb.w1.toFixed(1)}_${tb.r0.toFixed(1)}_${tb.r1.toFixed(1)}_${c0.u.toFixed(1)}_${c0.v.toFixed(1)}`;
          if (emittedSemiLoftKeys.has(dedupKey)) continue;
          emittedSemiLoftKeys.add(dedupKey);

          const rMax = Math.max(tb.r0, tb.r1);
          const arcStart = sReg.profileMeta!.arcStart ?? 0;
          const arcEnd = sReg.profileMeta!.arcEnd ?? Math.PI;
          const chordAxis = sReg.profileMeta!.chordAxis;
          const chordCoord = sReg.profileMeta!.chordCoord;
          const keepGreater = sReg.profileMeta!.keepGreater;

          const loftSpec: GeneralizedLoftPayload = {
            axis: holeAxis,
            w0: tb.w0,
            w1: tb.w1,
            section0: {
              kind: tb.r0 <= 0.2 ? 'point' : 'semicircle',
              centerU: c0.u,
              centerV: c0.v,
              radiusU: tb.r0,
              arcStart,
              arcEnd,
              flatChordAxis: chordAxis,
              flatChordVal: chordCoord,
              keepGreater,
            },
            section1: {
              kind: tb.r1 <= 0.2 ? 'point' : 'semicircle',
              centerU: c0.u,
              centerV: c0.v,
              radiusU: tb.r1,
              arcStart,
              arcEnd,
              flatChordAxis: chordAxis,
              flatChordVal: chordCoord,
              keepGreater,
            },
          };

          const uMinB =
            chordAxis === 'u' && chordCoord !== undefined
              ? keepGreater
                ? chordCoord
                : c0.u - rMax
              : c0.u - rMax;
          const uMaxB =
            chordAxis === 'u' && chordCoord !== undefined
              ? keepGreater
                ? c0.u + rMax
                : chordCoord
              : c0.u + rMax;
          const vMinB =
            chordAxis === 'v' && chordCoord !== undefined
              ? keepGreater
                ? chordCoord
                : c0.v - rMax
              : c0.v - rMax;
          const vMaxB =
            chordAxis === 'v' && chordCoord !== undefined
              ? keepGreater
                ? c0.v + rMax
                : chordCoord
              : c0.v + rMax;

          const b = makeBoundsFromAxis(
            holeAxis,
            uMinB,
            uMaxB,
            vMinB,
            vMaxB,
            tb.w0,
            tb.w1
          );
          const prim: Primitive3D = {
            id: `prim_void_semifrustum_${seq}`,
            featureId: `feat_semifrustum_hole_${seq}`,
            label: `共顶弦半圆台斜通孔 (R${tb.r0.toFixed(0)}→R${tb.r1.toFixed(0)})`,
            operation: 'subtract',
            shape: 'generalized_loft',
            ...b,
            rMin: tb.r0,
            rMax: tb.r1,
            loftSpec,
            isInternalFeature: true,
            isInsideLoopContour: true,
          };
          pushVoid(prim, holeAxis, true, true, true, 1.0, prim.label);
        }
      }
    }

    // 1C. Inner Polygonal / Rectangular Loops (`nestingDepth >= 1`, e.g., Square/Hex Hole in Arch or Cone Lateral Rectangular Hole!)
    for (const iReg of endArr.innerRegions) {
      if (iReg.profileKind === 'circle' || iReg.isSharedChordUnion) continue;
      const [iShared0, iShared1] = getSpanOnCoord(iReg.bounds, endSharedCoord);

      // Skip if this inner loop is a positive boss tier (matches a protruding solid region in sideArr!)
      const isPositiveBoss = sideArr.regions.some((sr) => {
        const [s0, s1] = getSpanOnCoord(sr.bounds, sideSharedCoord);
        return (
          !sr.isFullEnvelope &&
          Math.abs(s0 - iShared0) <= 1.2 &&
          Math.abs(s1 - iShared1) <= 1.2
        );
      });

      const matchingBands = sideArr.parallelDashedBands.filter(
        (b) =>
          b.axis === sideSharedCoord &&
          Math.abs(b.c1 - iShared0) <= 1.5 &&
          Math.abs(b.c2 - iShared1) <= 1.5
      );

      if (matchingBands.length > 0) {
        for (const band of matchingBands) {
          const w0 = band.spanMin;
          const w1 = band.spanMax;
          const b = makeBoundsFromAxis(
            holeAxis,
            iReg.bounds.uMin,
            iReg.bounds.uMax,
            iReg.bounds.vMin,
            iReg.bounds.vMax,
            w0,
            w1
          );
          const prim = createPrismaticOrBoxVoid(
            iReg,
            holeAxis,
            b,
            seq,
            true
          );
          pushVoid(
            prim,
            holeAxis,
            w0 <= globalWMin + 1.5 && w1 >= globalWMax - 1.5,
            true,
            true,
            1.0,
            prim.label
          );
        }
        continue;
      }

      if (isPositiveBoss) continue;

      // What if an inner rectangular hole pierces laterally through a Cone / Cylinder / Sphere (Case 7: 圆锥横向开方孔!)
      // where in `sideArr` (e.g. `top` view of a cone pierced by a lateral rectangular hole), its intersection
      // with the curved cone surface produces curved arcs or solid/dashed chords inside `[iShared0, iShared1]`!
      const hasCurvedOrDashedEvidenceInSide =
        sideArr.splitSegments.some((seg) => {
          const segMin =
            sideSharedCoord === 'u'
              ? Math.min(seg.p1.u, seg.p2.u)
              : Math.min(seg.p1.v, seg.p2.v);
          const segMax =
            sideSharedCoord === 'u'
              ? Math.max(seg.p1.u, seg.p2.u)
              : Math.max(seg.p1.v, seg.p2.v);
          if (seg.lineType === 'thin_dashed') {
            return (
              segMin >= iShared0 - 1.5 &&
              segMax <= iShared1 + 1.5
            );
          }
          return false;
        }) ||
        solidCandidates.some(
          (sc) =>
            sc.primitives[0]?.shape.startsWith('cone') ||
            sc.primitives[0]?.shape === 'generalized_loft' ||
            sc.primitives[0]?.shape === 'sphere'
        );

      if (hasCurvedOrDashedEvidenceInSide) {
        const b = makeBoundsFromAxis(
          holeAxis,
          iReg.bounds.uMin,
          iReg.bounds.uMax,
          iReg.bounds.vMin,
          iReg.bounds.vMax,
          globalWMin,
          globalWMax
        );
        const prim = createPrismaticOrBoxVoid(iReg, holeAxis, b, seq, true);
        pushVoid(prim, holeAxis, true, true, true, 0.92, prim.label);
      }
    }
  };

  liftDirectionalVoids(
    arr1,
    arr2,
    mapping.v1Coord,
    mapping.v2Coord,
    mapping.v2FreeCoord,
    mapping.v2FreeAxis
  );
  liftDirectionalVoids(
    arr2,
    arr1,
    mapping.v2Coord,
    mapping.v1Coord,
    mapping.v1FreeCoord,
    mapping.v1FreeAxis
  );

  // ==========================================================================
  // 2. Bores Parallel to the Shared Axis (seen as Parallel Dashed Bands in BOTH Known Views!
  //    Example: Known views = Front (X,Z) & Top (X,Y), lateral X-axis bore in Left wall `l_block_hole`
  //    or Hexagonal Prism X-axis cross-bore!)
  // ==========================================================================
  const bands1AlongShared = arr1.parallelDashedBands.filter(
    (b) => b.axis === mapping.v1FreeCoord
  );
  const bands2AlongShared = arr2.parallelDashedBands.filter(
    (b) => b.axis === mapping.v2FreeCoord
  );

  for (const b1 of bands1AlongShared) {
    for (const b2 of bands2AlongShared) {
      // Overlap along the shared axis!
      const ovMin = Math.max(b1.spanMin, b2.spanMin);
      const ovMax = Math.min(b1.spanMax, b2.spanMax);
      if (ovMax - ovMin < 2.0) continue;
      if (
        Math.abs(b1.spanMin - b2.spanMin) > 3.0 ||
        Math.abs(b1.spanMax - b2.spanMax) > 3.0
      ) {
        continue;
      }

      // Check if circular bore (width1 ≈ width2 AND at least one view has a centerline, or widths equal within 0.5mm!)
      const isCircular =
        Math.abs(b1.width - b2.width) <= 0.8 &&
        (b1.hasCenterline || b2.hasCenterline);

      const holeAxis = mapping.sharedAxis;
      const box3 = assembleBoxAlongShared(
        mapping,
        ovMin,
        ovMax,
        b1.c1,
        b1.c2,
        b2.c1,
        b2.c2
      );

      if (isCircular) {
        const r = 0.25 * (b1.width + b2.width);
        const cx = 0.5 * (box3.xMin + box3.xMax);
        const cy = 0.5 * (box3.yMin + box3.yMax);
        const cz = 0.5 * (box3.zMin + box3.zMax);
        const cylShape: Primitive3D['shape'] =
          holeAxis === 'X'
            ? 'cylinder_x'
            : holeAxis === 'Y'
            ? 'cylinder_y'
            : 'cylinder_z';
        const prim: Primitive3D = {
          id: `prim_shared_cyl_${seq}`,
          featureId: `feat_hole_${seq}`,
          label: `${holeAxis}向 Ø${(2 * r).toFixed(0)} 通孔`,
          operation: 'subtract',
          shape: cylShape,
          ...box3,
          centerX: cx,
          centerY: cy,
          centerZ: cz,
          radius: r,
          isInternalFeature: true,
        };
        pushVoid(prim, holeAxis, true, true, false, 0.98, prim.label);
      } else {
        const prim: Primitive3D = {
          id: `prim_shared_boxhole_${seq}`,
          featureId: `feat_hole_${seq}`,
          label: `${holeAxis}向 矩形通孔`,
          operation: 'subtract',
          shape: 'box',
          ...box3,
          isInternalFeature: true,
        };
        pushVoid(prim, holeAxis, true, true, false, 0.94, prim.label);
      }
    }
  }

  // ==========================================================================
  // 3. Open Boundary Notches / U-Slots (e.g. Slotted Cylinder, Slotted Cone, Slotted Sphere!)
  //    First pair orthogonal notches across `(arr1, arr2)` sharing the same slot width so a bounded
  //    depth slot (like `z = [52, 82]` on a slotted sphere) is NEVER also extruded across full depth (`z = [22, 82]`)!
  // ==========================================================================
  const pairedNotchIds = new Set<string>();
  for (const n1 of arr1.openNotches) {
    const s1Min = mapping.v1Coord === 'u' ? n1.uMin : n1.vMin;
    const s1Max = mapping.v1Coord === 'u' ? n1.uMax : n1.vMax;
    const f1Min = mapping.v1FreeCoord === 'u' ? n1.uMin : n1.vMin;
    const f1Max = mapping.v1FreeCoord === 'u' ? n1.uMax : n1.vMax;

    for (const n2 of arr2.openNotches) {
      const s2Min = mapping.v2Coord === 'u' ? n2.uMin : n2.vMin;
      const s2Max = mapping.v2Coord === 'u' ? n2.uMax : n2.vMax;
      const f2Min = mapping.v2FreeCoord === 'u' ? n2.uMin : n2.vMin;
      const f2Max = mapping.v2FreeCoord === 'u' ? n2.uMax : n2.vMax;

      if (
        Math.abs(s1Min - s2Min) <= 1.8 &&
        Math.abs(s1Max - s2Max) <= 1.8
      ) {
        pairedNotchIds.add(n1.id);
        pairedNotchIds.add(n2.id);
        const box3 = assembleBoxAlongShared(
          mapping,
          0.5 * (s1Min + s2Min),
          0.5 * (s1Max + s2Max),
          f1Min,
          f1Max,
          f2Min,
          f2Max
        );
        // Determine primary through-axis of the open slot (the view with `_chordslot_` or full span!)
        const slotAxis: Axis3D = n1.id.includes('_chordslot_')
          ? getViewAxisSpec(arr2.view).wAxis
          : getViewAxisSpec(arr1.view).wAxis;
        const [gMin, gMax] = getSolidGlobalSpanAlongAxis(solidCandidates, slotAxis);
        if (slotAxis === 'X') {
          box3.xMin = Math.min(box3.xMin, gMin);
          box3.xMax = Math.max(box3.xMax, gMax);
        } else if (slotAxis === 'Y') {
          box3.yMin = Math.min(box3.yMin, gMin);
          box3.yMax = Math.max(box3.yMax, gMax);
        } else {
          box3.zMin = Math.min(box3.zMin, gMin);
          box3.zMax = Math.max(box3.zMax, gMax);
        }

        const prim: Primitive3D = {
          id: `prim_paired_notch_${seq}`,
          featureId: `feat_slot_${seq}`,
          label: '双向配对贯穿方槽 (Bounded Through-Slot)',
          operation: 'subtract',
          shape: 'box',
          ...box3,
          isInternalFeature: true,
        };
        pushVoid(prim, slotAxis, true, true, true, 0.99, prim.label);
      }
    }
  }

  const liftNotchesFromView = (arr: ViewArrangementResult) => {
    const spec = getViewAxisSpec(arr.view);
    const slotAxis = spec.wAxis;
    const [wMin, wMax] = getSolidGlobalSpanAlongAxis(solidCandidates, slotAxis);

    for (const notch of arr.openNotches) {
      if (pairedNotchIds.has(notch.id)) continue;
      // Parallel chords across a circle without a 3-wall U-pocket in the other view must not cut full-height unconfirmed!
      if (notch.id.includes('_chordslot_')) continue;
      const b = makeBoundsFromAxis(
        slotAxis,
        notch.uMin,
        notch.uMax,
        notch.vMin,
        notch.vMax,
        wMin,
        wMax
      );
      const prim: Primitive3D = {
        id: `prim_notch_${seq}`,
        featureId: `feat_slot_${seq}`,
        label: '贯穿方槽 (Open Through-Slot)',
        operation: 'subtract',
        shape: 'box',
        ...b,
        isInternalFeature: true,
      };
      pushVoid(prim, slotAxis, true, true, true, 0.96, prim.label);
    }
  };
  liftNotchesFromView(arr1);
  liftNotchesFromView(arr2);

  // ==========================================================================
  // 4. T-Junction Branch Bore Extension Rule:
  //    When a half-through branch bore (`vBranch`) meets an orthogonal main bore (`vMain`),
  //    its 2D dashed lines in engineering drawings stop at the outer silhouette of `vMain`
  //    (distance `R_main` short of `vMain`'s axis!). If we didn't extend `vBranch` into `vMain`'s
  //    axis, a curved crescent sliver between `R_main` and `sqrt(R_main^2 - r_branch^2)` would
  //    block the T-junction! Extending `vBranch` to `vMain`'s central axis guarantees 100%
  //    manifold breakthrough without piercing the opposite wall!
  // ==========================================================================
  for (let i = 0; i < voids.length; i++) {
    const vBranch = voids[i];
    for (let j = 0; j < voids.length; j++) {
      if (i === j) continue;
      const vMain = voids[j];
      if (vBranch.axis === vMain.axis) continue;

      extendTBranchToMainAxisIfAbutting(vBranch, vMain);
    }
  }

  return voids;
}

function extendTBranchToMainAxisIfAbutting(
  vBranch: CandidateVoidChannel,
  vMain: CandidateVoidChannel
): void {
  const bPrim = vBranch.primitive;
  const mPrim = vMain.primitive;

  const getMainCenterAndHalfWidthAlong = (
    axis: Axis3D
  ): { center: number; halfWidth: number } => {
    if (axis === 'X') {
      return {
        center: mPrim.centerX ?? 0.5 * (mPrim.xMin + mPrim.xMax),
        halfWidth: 0.5 * (mPrim.xMax - mPrim.xMin),
      };
    }
    if (axis === 'Y') {
      return {
        center: mPrim.centerY ?? 0.5 * (mPrim.yMin + mPrim.yMax),
        halfWidth: 0.5 * (mPrim.yMax - mPrim.yMin),
      };
    }
    return {
      center: mPrim.centerZ ?? 0.5 * (mPrim.zMin + mPrim.zMax),
      halfWidth: 0.5 * (mPrim.zMax - mPrim.zMin),
    };
  };

  // Check transverse overlap first (axes actually intersect / overlap!)
  const axes: Axis3D[] = ['X', 'Y', 'Z'];
  for (const ax of axes) {
    if (ax === vBranch.axis) continue;
    const bLo = ax === 'X' ? bPrim.xMin : ax === 'Y' ? bPrim.yMin : bPrim.zMin;
    const bHi = ax === 'X' ? bPrim.xMax : ax === 'Y' ? bPrim.yMax : bPrim.zMax;
    const mLo = ax === 'X' ? mPrim.xMin : ax === 'Y' ? mPrim.yMin : mPrim.zMin;
    const mHi = ax === 'X' ? mPrim.xMax : ax === 'Y' ? mPrim.yMax : mPrim.zMax;
    if (Math.min(bHi, mHi) - Math.max(bLo, mLo) <= 0.5) return;
  }

  const { center: mainC, halfWidth: mainHW } = getMainCenterAndHalfWidthAlong(
    vBranch.axis
  );
  const bMin =
    vBranch.axis === 'X'
      ? bPrim.xMin
      : vBranch.axis === 'Y'
      ? bPrim.yMin
      : bPrim.zMin;
  const bMax =
    vBranch.axis === 'X'
      ? bPrim.xMax
      : vBranch.axis === 'Y'
      ? bPrim.yMax
      : bPrim.zMax;

  // Case A: branch comes from -axis side (`bMin < mainC - mainHW`) and stops near `mainC - mainHW`..`mainC`
  if (
    bMin < mainC - mainHW - 0.5 &&
    bMax >= mainC - mainHW - 2.0 &&
    bMax < mainC + 0.1
  ) {
    setAxisBound(bPrim, vBranch.bounds, vBranch.axis, bMin, mainC);
    vBranch.isTBranch = true;
    vBranch.parentMainVoidId = vMain.id;
  }
  // Case B: branch comes from +axis side (`bMax > mainC + mainHW`) and stops near `mainC`..`mainC + mainHW`
  else if (
    bMax > mainC + mainHW + 0.5 &&
    bMin <= mainC + mainHW + 2.0 &&
    bMin > mainC - 0.1
  ) {
    setAxisBound(bPrim, vBranch.bounds, vBranch.axis, mainC, bMax);
    vBranch.isTBranch = true;
    vBranch.parentMainVoidId = vMain.id;
  }
}

function setAxisBound(
  prim: Primitive3D,
  bounds: BoundingBox3D,
  axis: Axis3D,
  lo: number,
  hi: number
): void {
  if (axis === 'X') {
    prim.xMin = lo;
    prim.xMax = hi;
    bounds.xMin = lo;
    bounds.xMax = hi;
  } else if (axis === 'Y') {
    prim.yMin = lo;
    prim.yMax = hi;
    bounds.yMin = lo;
    bounds.yMax = hi;
  } else {
    prim.zMin = lo;
    prim.zMax = hi;
    bounds.zMin = lo;
    bounds.zMax = hi;
  }
}

function createPrismaticOrBoxVoid(
  reg: CompositeRegion2D,
  holeAxis: Axis3D,
  b: BoundingBox3D,
  seq: number,
  insideContour: boolean
): Primitive3D {
  if (reg.profileKind === 'rectangle') {
    return {
      id: `prim_void_box_${seq}`,
      featureId: `feat_sq_hole_${seq}`,
      label: '内方通孔 / 矩形槽孔',
      operation: 'subtract',
      shape: 'box',
      ...b,
      isInternalFeature: true,
      isInsideLoopContour: insideContour,
    };
  }
  const verts: Point2D[] = reg.boundarySegments.some((s) => s.kind === 'arc')
    ? reg.polygon
    : reg.boundarySegments.map((s) => ({ u: s.p1.u, v: s.p1.v }));
  return {
    id: `prim_void_prism_${seq}`,
    featureId: `feat_poly_hole_${seq}`,
    label: '多边形截面内通孔',
    operation: 'subtract',
    shape: 'prism',
    ...b,
    prismAxis: holeAxis,
    prismPolygon: verts.length >= 3 ? verts : reg.polygon,
    prismSegments: reg.boundarySegments,
    isInternalFeature: true,
    isInsideLoopContour: insideContour,
  };
}

function assembleBoxAlongShared(
  mapping: ReturnType<typeof getSharedAxisBetweenViews>,
  sMin: number,
  sMax: number,
  f1Min: number,
  f1Max: number,
  f2Min: number,
  f2Max: number
): BoundingBox3D {
  const out: BoundingBox3D = {
    xMin: 0,
    xMax: 0,
    yMin: 0,
    yMax: 0,
    zMin: 0,
    zMax: 0,
  };
  const assign = (ax: Axis3D, lo: number, hi: number) => {
    if (ax === 'X') {
      out.xMin = lo;
      out.xMax = hi;
    } else if (ax === 'Y') {
      out.yMin = lo;
      out.yMax = hi;
    } else {
      out.zMin = lo;
      out.zMax = hi;
    }
  };
  assign(mapping.sharedAxis, sMin, sMax);
  assign(mapping.v1FreeAxis, f1Min, f1Max);
  assign(mapping.v2FreeAxis, f2Min, f2Max);
  return out;
}
