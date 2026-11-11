import { HemisphereCapSpec, Primitive3D, ViewType } from '../../types/cad';
import {
  Axis3D,
  CandidateEdge3D,
  SolvedSolidModel3D,
  SpaceCircleArc3D,
  SpaceLine3D,
  Vec3,
} from '../types';
import { arcSweepCCW, normAngle } from '../arrangement2d/snapAndSplit';
import {
  ensureCCWPolygon2D,
  extractGeneralizedLoftFeatureEdges,
  loftUVWToXYZ,
  primitiveToGeneralizedLoft,
} from '../lifting3d/generalizedLoft';
import { evalPrimitive3DSDF, getViewProjectionFrame } from '../lifting3d/surfacePrimitives';
import { traceModelSSICurves3D } from '../ssi/ssiMarchingTracer';

const TWO_PI = Math.PI * 2;

function evalPositiveBodyOnlySDF(p: Vec3, prims: Primitive3D[]): number {
  let dSolid = Infinity;
  let hasAdd = false;
  for (const pr of prims) {
    if (pr.operation === 'add') {
      const d = evalPrimitive3DSDF(p, pr);
      if (d < dSolid) dSolid = d;
      hasAdd = true;
    }
  }
  if (!hasAdd) return Infinity;
  for (const pr of prims) {
    if (pr.operation === 'intersect') {
      dSolid = Math.max(dSolid, evalPrimitive3DSDF(p, pr));
    }
  }
  return dSolid;
}

/**
 * Clips a 3D line segment `[p1, p2]` to sub-intervals that truly lie on the active boundary
 * of `model` (or strictly inside the positive body when `isCavityBoundary === true`),
 * using 8-step binary bisection at transitions for exact generator endpoints on crossed holes.
 */
function clipLineSegmentToActiveModel(
  line: SpaceLine3D,
  model: SolvedSolidModel3D,
  prims: Primitive3D[]
): SpaceLine3D[] {
  const dx = line.p2.x - line.p1.x;
  const dy = line.p2.y - line.p1.y;
  const dz = line.p2.z - line.p1.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.25) return [];

  const otherSubtracts = line.isCavityBoundary
    ? prims.filter((pr) => pr.operation === 'subtract' && !line.surfaceIds.includes(pr.id))
    : [];

  const isValidAt = (t: number): boolean => {
    const pt = {
      x: line.p1.x + t * dx,
      y: line.p1.y + t * dy,
      z: line.p1.z + t * dz,
    };

    if (line.isCavityBoundary) {
      // Cavity inner generator/edge: must lie inside the positive solid body (`posSDF < -0.015`)
      // AND not be swallowed inside another intersecting subtract cavity!
      const posSDF = evalPositiveBodyOnlySDF(pt, prims);
      if (posSDF >= -0.015) return false;
      for (const sub of otherSubtracts) {
        if (evalPrimitive3DSDF(pt, sub) < -0.015) return false;
      }
      const finalSDF = model.evalSDF(pt);
      return Math.abs(finalSDF) <= 0.36;
    } else {
      const finalSDF = model.evalSDF(pt);
      return Math.abs(finalSDF) <= 0.36;
    }
  };

  const bisectBoundary = (tValid: number, tInvalid: number): number => {
    let tv = tValid;
    let ti = tInvalid;
    for (let k = 0; k < 8; k++) {
      const tm = 0.5 * (tv + ti);
      if (isValidAt(tm)) tv = tm;
      else ti = tm;
    }
    return 0.5 * (tv + ti);
  };

  const SAMPLES = Math.max(24, Math.min(128, Math.ceil(len * 2.0)));
  const validFlags = new Uint8Array(SAMPLES + 1);

  for (let i = 0; i <= SAMPLES; i++) {
    validFlags[i] = isValidAt(i / SAMPLES) ? 1 : 0;
  }

  const out: SpaceLine3D[] = [];
  let inRun = false;
  let runStart = 0;
  let subIdx = 0;

  for (let i = 0; i <= SAMPLES; i++) {
    if (validFlags[i] === 1 && !inRun) {
      inRun = true;
      runStart = i;
    } else if ((validFlags[i] === 0 || i === SAMPLES) && inRun) {
      const runEnd = validFlags[i] === 1 ? i : i - 1;
      inRun = false;
      const t0 =
        runStart > 0
          ? bisectBoundary(runStart / SAMPLES, (runStart - 1) / SAMPLES)
          : 0;
      const t1 =
        runEnd < SAMPLES
          ? bisectBoundary(runEnd / SAMPLES, (runEnd + 1) / SAMPLES)
          : 1;
      if ((t1 - t0) * len >= 0.35) {
        out.push({
          ...line,
          id: `${line.id}_s${subIdx++}`,
          p1: {
            x: line.p1.x + t0 * dx,
            y: line.p1.y + t0 * dy,
            z: line.p1.z + t0 * dz,
          },
          p2: {
            x: line.p1.x + t1 * dx,
            y: line.p1.y + t1 * dy,
            z: line.p1.z + t1 * dz,
          },
        });
      }
    }
  }

  return out;
}

/**
 * Clips a 3D circular/arc curve to active angular intervals on `model`'s boundary.
 * Crucially preserves full 3D outer circular rims of annular step shoulders (`r_outer > r_inner`)
 * and knife-edge coaxial hole rims (`r_hole ≈ R_min`), while suppressing T-junction inner cap arcs
 * swallowed inside an orthogonal intersecting hole!
 */
function clipCircleArcToActiveModel(
  circ: SpaceCircleArc3D,
  model: SolvedSolidModel3D,
  prims: Primitive3D[]
): SpaceCircleArc3D[] {
  if (circ.radius < 0.2) return [];
  if (circ.isKnifeEdgeRim) return [circ];

  const SAMPLES = 72;
  const validFlags = new Uint8Array(SAMPLES + 1);
  const isFull = circ.sweep >= TWO_PI - 1e-3;
  const otherSubtracts = circ.isCavityBoundary
    ? prims.filter((pr) => pr.operation === 'subtract' && !circ.surfaceIds.includes(pr.id))
    : [];

  for (let i = 0; i <= SAMPLES; i++) {
    const theta = circ.startAngle + (i / SAMPLES) * circ.sweep;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const pt = {
      x: circ.center.x + circ.radius * (ct * circ.uAxis.x + st * circ.vAxis.x),
      y: circ.center.y + circ.radius * (ct * circ.uAxis.y + st * circ.vAxis.y),
      z: circ.center.z + circ.radius * (ct * circ.uAxis.z + st * circ.vAxis.z),
    };

    const finalSDF = model.evalSDF(pt);
    if (circ.isCavityBoundary) {
      // Cavity end-cap circle: active ONLY if on/inside the solid body AND not swallowed inside an intersecting void!
      const posSDF = evalPositiveBodyOnlySDF(pt, prims);
      const swallowedByOtherVoid = otherSubtracts.some(
        (sub) => evalPrimitive3DSDF(pt, sub) <= 0.08
      );
      validFlags[i] =
        !swallowedByOtherVoid && posSDF <= 0.25 && Math.abs(finalSDF) <= 0.3 ? 1 : 0;
    } else {
      validFlags[i] = Math.abs(finalSDF) <= 0.3 ? 1 : 0;
    }
  }

  // If every sample is valid, return original full circle/arc intact!
  let allValid = true;
  for (let i = 0; i <= SAMPLES; i++) {
    if (validFlags[i] === 0) {
      allValid = false;
      break;
    }
  }
  if (allValid) return [circ];

  const spans: { i0: number; i1: number }[] = [];
  let inRun = false;
  let runStart = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    if (validFlags[i] === 1 && !inRun) {
      inRun = true;
      runStart = i;
    } else if ((validFlags[i] === 0 || i === SAMPLES) && inRun) {
      const runEnd = validFlags[i] === 1 ? i : i - 1;
      inRun = false;
      if (runEnd > runStart) {
        spans.push({ i0: runStart, i1: runEnd });
      }
    }
  }

  // Merge wrap-around span across theta = startAngle + 2π for full circles
  if (isFull && spans.length >= 2 && spans[0].i0 === 0 && spans[spans.length - 1].i1 === SAMPLES) {
    const first = spans.shift()!;
    const last = spans.pop()!;
    spans.push({ i0: last.i0, i1: SAMPLES + first.i1 });
  }

  return spans
    .map((sp, idx) => {
      const a0 = normAngle(circ.startAngle + (sp.i0 / SAMPLES) * circ.sweep);
      const sw = ((sp.i1 - sp.i0) / SAMPLES) * circ.sweep;
      if (sw * circ.radius < 0.35) return null;
      return {
        ...circ,
        id: `${circ.id}_a${idx}`,
        startAngle: a0,
        sweep: Math.min(TWO_PI, sw),
      };
    })
    .filter((x): x is SpaceCircleArc3D => x !== null);
}

/**
 * Extracts the complete set of 3D candidate sharp creases, circular/arc end-caps, annular shoulders,
 * view-dependent smooth quadric/loft silhouettes (`grad phi · eyeDir = 0`), and SSI space curves
 * for projecting `model` onto `targetView`.
 */
export function extractCandidateEdges3DForView(
  model: SolvedSolidModel3D,
  targetView: ViewType
): CandidateEdge3D[] {
  const frame = getViewProjectionFrame(targetView);
  const eyeDir = frame.eyeDir;
  const prims = model.coalescedPrimitives;

  const rawLines: SpaceLine3D[] = [];
  const rawCircles: SpaceCircleArc3D[] = [];

  const pushBoxEdges = (pr: Primitive3D, isCav: boolean) => {
    const xs = [pr.xMin, pr.xMax];
    const ys = [pr.yMin, pr.yMax];
    const zs = [pr.zMin, pr.zMax];
    let idx = 0;
    for (const y of ys) {
      for (const z of zs) {
        rawLines.push({
          id: `${pr.id}_bx_${idx++}`,
          kind: 'line3d',
          p1: { x: xs[0], y, z },
          p2: { x: xs[1], y, z },
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });
      }
    }
    for (const x of xs) {
      for (const z of zs) {
        rawLines.push({
          id: `${pr.id}_by_${idx++}`,
          kind: 'line3d',
          p1: { x, y: ys[0], z },
          p2: { x, y: ys[1], z },
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });
      }
    }
    for (const x of xs) {
      for (const y of ys) {
        rawLines.push({
          id: `${pr.id}_bz_${idx++}`,
          kind: 'line3d',
          p1: { x, y, z: zs[0] },
          p2: { x, y, z: zs[1] },
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });
      }
    }
  };

  for (const pr of prims) {
    const isCav = pr.operation === 'subtract';

    if (pr.shape === 'box') {
      pushBoxEdges(pr, isCav);
      continue;
    }

    if (pr.shape === 'cylinder_x' || pr.shape === 'cylinder_y' || pr.shape === 'cylinder_z') {
      const axis: Axis3D =
        pr.shape === 'cylinder_z' ? 'Z' : pr.shape === 'cylinder_y' ? 'Y' : 'X';
      const r =
        pr.radius ??
        0.5 * (axis === 'X' ? pr.yMax - pr.yMin : pr.xMax - pr.xMin);
      const cU =
        axis === 'X'
          ? pr.centerY ?? 0.5 * (pr.yMin + pr.yMax)
          : pr.centerX ?? 0.5 * (pr.xMin + pr.xMax);
      const cV =
        axis === 'Z'
          ? pr.centerY ?? 0.5 * (pr.yMin + pr.yMax)
          : pr.centerZ ?? 0.5 * (pr.zMin + pr.zMax);
      const wMin = axis === 'Z' ? pr.zMin : axis === 'Y' ? pr.yMin : pr.xMin;
      const wMax = axis === 'Z' ? pr.zMax : axis === 'Y' ? pr.yMax : pr.xMax;

      const loftEquiv = {
        axis,
        w0: wMin,
        w1: wMax,
        section0: { kind: 'circle' as const, centerU: cU, centerV: cV, radiusU: r },
        section1: { kind: 'circle' as const, centerU: cU, centerV: cV, radiusU: r },
      };
      const { lines, circles } = extractGeneralizedLoftFeatureEdges(loftEquiv, eyeDir, {
        idPrefix: pr.id,
        isCavityBoundary: isCav,
        surfaceIds: [pr.id],
        featureId: pr.featureId,
        featureLabel: pr.label,
      });

      // Check knife-edge rim protection (`r_hole ≈ R_min` on coaxial frustum/cylinder)
      for (const c of circles) {
        if (!isCav) {
          c.isAnnularShoulderOuter = true;
          const matchesKnifeHole = prims.some(
            (sub) =>
              sub.operation === 'subtract' &&
              Math.abs((sub.radius ?? -1) - r) <= 0.3
          );
          if (matchesKnifeHole) c.isKnifeEdgeRim = true;
        }
        rawCircles.push(c);
      }
      rawLines.push(...lines);
      continue;
    }

    if (pr.shape === 'sphere' || pr.shape === 'hemisphere') {
      const cx = pr.centerX ?? 0.5 * (pr.xMin + pr.xMax);
      const cy = pr.centerY ?? 0.5 * (pr.yMin + pr.yMax);
      const cz = pr.centerZ ?? 0.5 * (pr.zMin + pr.zMax);
      const r =
        pr.radius ??
        0.5 * Math.max(pr.xMax - pr.xMin, pr.yMax - pr.yMin, pr.zMax - pr.zMin);
      const center = { x: cx, y: cy, z: cz };

      // 1. View-orthogonal great circle silhouette in plane perpendicular to `eyeDir`!
      let silU: Vec3;
      let silV: Vec3;
      if (targetView === 'front') {
        silU = { x: 1, y: 0, z: 0 };
        silV = { x: 0, y: 0, z: 1 };
      } else if (targetView === 'top') {
        silU = { x: 1, y: 0, z: 0 };
        silV = { x: 0, y: 1, z: 0 };
      } else {
        silU = { x: 0, y: 1, z: 0 };
        silV = { x: 0, y: 0, z: 1 };
      }

      if (pr.shape === 'sphere') {
        rawCircles.push({
          id: `${pr.id}_sil`,
          kind: 'circle3d',
          center,
          radius: r,
          uAxis: silU,
          vAxis: silV,
          normal: eyeDir,
          startAngle: 0,
          sweep: TWO_PI,
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });
      } else {
        const cap: HemisphereCapSpec = pr.hemisphereSpec ?? {
          flatAxis: 'Z',
          flatCoord: pr.zMin,
          keepPositiveSide: true,
        };
        // Emit BOTH the view-plane great circle (clipped to the hemisphere dome half-space!)
        // AND the 3D equatorial flat base circle at `flatAxis = flatCoord`!
        rawCircles.push({
          id: `${pr.id}_hemisil`,
          kind: 'circle3d',
          center,
          radius: r,
          uAxis: silU,
          vAxis: silV,
          normal: eyeDir,
          startAngle: 0,
          sweep: TWO_PI,
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });

        let eqU: Vec3;
        let eqV: Vec3;
        let eqN: Vec3;
        let eqCenter: Vec3;
        if (cap.flatAxis === 'Z') {
          eqU = { x: 1, y: 0, z: 0 };
          eqV = { x: 0, y: 1, z: 0 };
          eqN = { x: 0, y: 0, z: 1 };
          eqCenter = { x: cx, y: cy, z: cap.flatCoord };
        } else if (cap.flatAxis === 'Y') {
          eqU = { x: 1, y: 0, z: 0 };
          eqV = { x: 0, y: 0, z: 1 };
          eqN = { x: 0, y: 1, z: 0 };
          eqCenter = { x: cx, y: cap.flatCoord, z: cz };
        } else {
          eqU = { x: 0, y: 1, z: 0 };
          eqV = { x: 0, y: 0, z: 1 };
          eqN = { x: 1, y: 0, z: 0 };
          eqCenter = { x: cap.flatCoord, y: cy, z: cz };
        }
        rawCircles.push({
          id: `${pr.id}_hemibase`,
          kind: 'circle3d',
          center: eqCenter,
          radius: r,
          uAxis: eqU,
          vAxis: eqV,
          normal: eqN,
          startAngle: 0,
          sweep: TWO_PI,
          isAnnularShoulderOuter: !isCav,
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });
      }
      continue;
    }

    if (
      pr.shape === 'generalized_loft' ||
      pr.shape === 'pyramid' ||
      pr.shape === 'cone_x' ||
      pr.shape === 'cone_y' ||
      pr.shape === 'cone_z'
    ) {
      const loft = primitiveToGeneralizedLoft(pr);
      if (loft) {
        const { lines, circles } = extractGeneralizedLoftFeatureEdges(loft, eyeDir, {
          idPrefix: pr.id,
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });
        for (const c of circles) {
          if (!isCav) {
            c.isAnnularShoulderOuter = true;
            const matchesKnifeHole = prims.some(
              (sub) =>
                sub.operation === 'subtract' &&
                Math.abs((sub.radius ?? -1) - c.radius) <= 0.3
            );
            if (matchesKnifeHole) c.isKnifeEdgeRim = true;
          }
          rawCircles.push(c);
        }
        rawLines.push(...lines);
      }
      continue;
    }

    if (pr.shape === 'wedge_y') {
      const v: Vec3[] = [
        { x: pr.xMin, y: pr.yMin, z: pr.zMin },
        { x: pr.xMin, y: pr.yMax, z: pr.zMin },
        { x: pr.xMin, y: pr.yMax, z: pr.zMax },
        { x: pr.xMax, y: pr.yMin, z: pr.zMin },
        { x: pr.xMax, y: pr.yMax, z: pr.zMin },
        { x: pr.xMax, y: pr.yMax, z: pr.zMax },
      ];
      const wedgePairs: [number, number][] = [
        [0, 1], [1, 2], [2, 0],
        [3, 4], [4, 5], [5, 3],
        [0, 3], [1, 4], [2, 5],
      ];
      wedgePairs.forEach(([ia, ib], wIdx) => {
        rawLines.push({
          id: `${pr.id}_wg_${wIdx}`,
          kind: 'line3d',
          p1: v[ia],
          p2: v[ib],
          isCavityBoundary: isCav,
          surfaceIds: [pr.id],
          featureId: pr.featureId,
          featureLabel: pr.label,
        });
      });
      continue;
    }

    if (pr.shape === 'prism') {
      const axis: Axis3D =
        pr.prismAxis ??
        (pr.extrudeAxis ? (pr.extrudeAxis.toUpperCase() as Axis3D) : 'Z');
      const w0 = axis === 'Z' ? pr.zMin : axis === 'Y' ? pr.yMin : pr.xMin;
      const w1 = axis === 'Z' ? pr.zMax : axis === 'Y' ? pr.yMax : pr.xMax;
      const segs = pr.prismSegments ?? [];
      const uAx3D = Vec3Diff(loftUVWToXYZ(axis, 1, 0, 0), loftUVWToXYZ(axis, 0, 0, 0));
      const vAx3D = Vec3Diff(loftUVWToXYZ(axis, 0, 1, 0), loftUVWToXYZ(axis, 0, 0, 0));
      const wAx3D = Vec3Diff(loftUVWToXYZ(axis, 0, 0, 1), loftUVWToXYZ(axis, 0, 0, 0));

      if (segs.length > 0) {
        segs.forEach((seg, sIdx) => {
          const prevSeg = segs[(sIdx - 1 + segs.length) % segs.length];
          let isSharpCorner = prevSeg.kind !== seg.kind;
          if (!isSharpCorner && seg.kind === 'line' && prevSeg.kind === 'line') {
            const dPrevU = prevSeg.p2.u - prevSeg.p1.u;
            const dPrevV = prevSeg.p2.v - prevSeg.p1.v;
            const lPrev = Math.hypot(dPrevU, dPrevV) || 1;
            const dCurrU = seg.p2.u - seg.p1.u;
            const dCurrV = seg.p2.v - seg.p1.v;
            const lCurr = Math.hypot(dCurrU, dCurrV) || 1;
            const dot = (dPrevU * dCurrU + dPrevV * dCurrV) / (lPrev * lCurr);
            isSharpCorner = dot < 0.9995;
          } else if (!isSharpCorner && seg.kind === 'arc') {
            isSharpCorner = true;
          }

          if (isSharpCorner) {
            // Extrusion lateral edge at genuine corner vertex
            rawLines.push({
              id: `${pr.id}_pv_${sIdx}`,
              kind: 'line3d',
              p1: loftUVWToXYZ(axis, seg.p1.u, seg.p1.v, w0),
              p2: loftUVWToXYZ(axis, seg.p1.u, seg.p1.v, w1),
              isCavityBoundary: isCav,
              surfaceIds: [pr.id],
              featureId: pr.featureId,
              featureLabel: pr.label,
            });
          }

          if (seg.kind === 'arc' && seg.center && seg.radius !== undefined) {
            const sA = seg.startAngle ?? 0;
            const eA = seg.endAngle ?? 0;
            const sweep = arcSweepCCW(sA, eA);
            for (const [wVal, tag] of [
              [w0, '0'],
              [w1, '1'],
            ] as const) {
              rawCircles.push({
                id: `${pr.id}_parc_${sIdx}_${tag}`,
                kind: 'circle3d',
                center: loftUVWToXYZ(axis, seg.center.u, seg.center.v, wVal),
                radius: seg.radius,
                uAxis: uAx3D,
                vAxis: vAx3D,
                normal: wAx3D,
                startAngle: sA,
                sweep,
                isCavityBoundary: isCav,
                surfaceIds: [pr.id],
                featureId: pr.featureId,
                featureLabel: pr.label,
              });
            }

            // Also check view-extremal tangent rulings on curved arc prism wall!
            const eyeU = eyeDir.x * uAx3D.x + eyeDir.y * uAx3D.y + eyeDir.z * uAx3D.z;
            const eyeV = eyeDir.x * vAx3D.x + eyeDir.y * vAx3D.y + eyeDir.z * vAx3D.z;
            if (Math.hypot(eyeU, eyeV) > 1e-4) {
              // Normal (cos theta, sin theta) · (eyeU, eyeV) = 0 => tan(theta) = -eyeU / eyeV
              const baseAng = Math.atan2(-eyeU, eyeV);
              for (const candAng of [normAngle(baseAng), normAngle(baseAng + Math.PI)]) {
                const rel = normAngle(candAng - sA);
                if (rel <= sweep + 1e-3 || TWO_PI - rel <= 1e-3) {
                  const uSil = seg.center.u + seg.radius * Math.cos(candAng);
                  const vSil = seg.center.v + seg.radius * Math.sin(candAng);
                  rawLines.push({
                    id: `${pr.id}_psil_${sIdx}_${Math.round(candAng * 100)}`,
                    kind: 'line3d',
                    p1: loftUVWToXYZ(axis, uSil, vSil, w0),
                    p2: loftUVWToXYZ(axis, uSil, vSil, w1),
                    isCavityBoundary: isCav,
                    surfaceIds: [pr.id],
                    featureId: pr.featureId,
                    featureLabel: pr.label,
                  });
                }
              }
            }
          } else {
            for (const [wVal, tag] of [
              [w0, '0'],
              [w1, '1'],
            ] as const) {
              rawLines.push({
                id: `${pr.id}_pl_${sIdx}_${tag}`,
                kind: 'line3d',
                p1: loftUVWToXYZ(axis, seg.p1.u, seg.p1.v, wVal),
                p2: loftUVWToXYZ(axis, seg.p2.u, seg.p2.v, wVal),
                isCavityBoundary: isCav,
                surfaceIds: [pr.id],
                featureId: pr.featureId,
                featureLabel: pr.label,
              });
            }
          }
        });
      } else {
        const poly = ensureCCWPolygon2D(pr.prismPolygon ?? pr.polygon2D ?? []);
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          rawLines.push(
            {
              id: `${pr.id}_plv_${i}`,
              kind: 'line3d',
              p1: loftUVWToXYZ(axis, a.u, a.v, w0),
              p2: loftUVWToXYZ(axis, a.u, a.v, w1),
              isCavityBoundary: isCav,
              surfaceIds: [pr.id],
              featureId: pr.featureId,
              featureLabel: pr.label,
            },
            {
              id: `${pr.id}_pl0_${i}`,
              kind: 'line3d',
              p1: loftUVWToXYZ(axis, a.u, a.v, w0),
              p2: loftUVWToXYZ(axis, b.u, b.v, w0),
              isCavityBoundary: isCav,
              surfaceIds: [pr.id],
              featureId: pr.featureId,
              featureLabel: pr.label,
            },
            {
              id: `${pr.id}_pl1_${i}`,
              kind: 'line3d',
              p1: loftUVWToXYZ(axis, a.u, a.v, w1),
              p2: loftUVWToXYZ(axis, b.u, b.v, w1),
              isCavityBoundary: isCav,
              surfaceIds: [pr.id],
              featureId: pr.featureId,
              featureLabel: pr.label,
            }
          );
        }
      }
    }
  }

  // Clip all raw 3D lines and circles against the solved solid model
  const candidates: CandidateEdge3D[] = [];
  for (const l of rawLines) {
    candidates.push(...clipLineSegmentToActiveModel(l, model, prims));
  }
  for (const c of rawCircles) {
    candidates.push(...clipCircleArcToActiveModel(c, model, prims));
  }

  // Append exact 3D Surface-Surface Intersection (SSI) marching curves
  const ssiCurves = traceModelSSICurves3D(model);
  candidates.push(...ssiCurves);

  return candidates;
}

function Vec3Diff(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
