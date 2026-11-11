import {
  CadEntity,
  ProjectionStep,
  ReconstructedSolution,
  ViewType,
} from '../types/cad';
import { buildPlanarArrangement2D } from './arrangement2d/carrierReconstruction';
import { getThirdTargetView, projectPoint3DToView } from './lifting3d/surfacePrimitives';
import { liftProjectiveCandidates3D } from './lifting3d/candidateLifter';
import { buildCurvedCellComplex3D } from './solver/cellDecomposition';
import { solveCellularOccupancyCSP } from './solver/cspOccupancySolver';
import { extractCandidateEdges3DForView } from './hlr/silhouetteAndCrease';
import { runQuantitativeHLR } from './hlr/quantitativeHLR';
import { reconstructClean2DEntitiesFromHLR } from './hlr/curveReconstruction2D';
import { SolvedSolidModel3D } from './types';

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Generates educational GB/T 4458.1 Three-Equal projection steps (`长对正`, `高平齐`, `宽相等`)
 * tracing key structural landmarks of a `SolvedSolidModel3D` from `(v1, v2)` to `targetView`.
 */
function buildEducationalProjectionSteps(
  model: SolvedSolidModel3D,
  derivedEntities: CadEntity[],
  v1: ViewType,
  v2: ViewType,
  targetView: ViewType
): ProjectionStep[] {
  const steps: ProjectionStep[] = [];
  const b = model.bounds;

  const keyPoints3D = [
    { label: '左前底基准角点', pt: { x: b.xMin, y: b.yMax, z: b.zMin } },
    { label: '右后顶包络角点', pt: { x: b.xMax, y: b.yMin, z: b.zMax } },
    {
      label: '中心形体特征核',
      pt: {
        x: 0.5 * (b.xMin + b.xMax),
        y: 0.5 * (b.yMin + b.yMax),
        z: 0.5 * (b.zMin + b.zMax),
      },
    },
  ];

  const primaryRule: ProjectionStep['rule'] =
    targetView === 'left'
      ? '宽相等 (Y轴45°折转)'
      : targetView === 'top'
        ? '长对正 (X轴对齐)'
        : '高平齐 (Z轴对齐)';

  keyPoints3D.forEach((kp, idx) => {
    const q1 = projectPoint3DToView(kp.pt, v1);
    const q2 = projectPoint3DToView(kp.pt, v2);
    const qt = projectPoint3DToView(kp.pt, targetView);
    const matchedEnt = derivedEntities[idx % Math.max(1, derivedEntities.length)];

    steps.push({
      id: `${model.id}_step_${idx + 1}`,
      stepNumber: idx + 1,
      title: `步骤 ${idx + 1}：${kp.label}三等求交`,
      rule: idx === 1 && targetView === 'left' ? '高平齐 (Z轴对齐)' : primaryRule,
      description: `由已知两视图坐标 (${round2(q1.u)}, ${round2(q1.v)}) 与 (${round2(q2.u)}, ${round2(q2.v)}) 经三维体元逆向与 45° 折转锁定目标点 (${round2(qt.u)}, ${round2(qt.v)})。`,
      sourceView1: v1,
      sourcePt1: { u: round2(q1.u), v: round2(q1.v) },
      sourceView2: v2,
      sourcePt2: { u: round2(q2.u), v: round2(q2.v) },
      targetView,
      targetPt: { u: round2(qt.u), v: round2(qt.v) },
      entityId: matchedEnt?.id,
      lineType: matchedEnt?.lineType ?? 'thick_solid',
    });
  });

  return steps;
}

/**
 * Complete end-to-end 6-layer industrial 2D-to-3D Reverse Engineering & Quantitative HLR pipeline:
 *   Layer 1 (DCEL Planar Arrangement & Carrier Stitching)
 *   -> Layer 2 (Cross-View Half-Space & GeneralizedLoft Lifting)
 *   -> Layer 3 (3D Curved-Boundary Cell Complex & CSP Branch-and-Bound Occupancy Solver)
 *   -> Layer 4 (Newton-Raphson SSI Space Curve Marching)
 *   -> Layer 5 (Quantitative Ray-Depth HLR & GB/T 4458.4 Curve/Centerline Reconstruction)
 */
export function reconstructAndDeriveThirdView(
  entities: CadEntity[],
  v1: ViewType,
  v2: ViewType,
  options?: { maxSolutions?: number }
): ReconstructedSolution[] {
  const t0 = performance.now();
  if (v1 === v2) return [];

  const ents1 = entities.filter((e) => e.view === v1 && e.lineType !== 'construction');
  const ents2 = entities.filter((e) => e.view === v2 && e.lineType !== 'construction');
  if (ents1.length === 0 || ents2.length === 0) return [];

  const arr1 = buildPlanarArrangement2D(ents1, v1);
  const arr2 = buildPlanarArrangement2D(ents2, v2);
  if (arr1.splitSegments.length === 0 || arr2.splitSegments.length === 0) return [];

  const targetView = getThirdTargetView(v1, v2);
  const pool = liftProjectiveCandidates3D(arr1, arr2);
  const complex = buildCurvedCellComplex3D(pool);
  const maxSols = options?.maxSolutions ?? 4;
  const solvedModels = solveCellularOccupancyCSP(pool, complex, maxSols);

  const solveElapsed = Math.round((performance.now() - t0) * 100) / 100;

  return solvedModels.map((model, idx) => {
    const candidates3D = extractCandidateEdges3DForView(model, targetView);
    const hlrSpans = runQuantitativeHLR(candidates3D, model, targetView);
    const derivedEntities = reconstructClean2DEntitiesFromHLR(
      hlrSpans,
      model,
      targetView,
      `sol${idx + 1}_der`
    );
    const projectionSteps = buildEducationalProjectionSteps(
      model,
      derivedEntities,
      v1,
      v2,
      targetView
    );

    const occupiedCells = model.occupancy.reduce((acc, v) => acc + v, 0);

    return {
      id: model.id,
      title: model.title,
      subtitle: model.subtitle,
      description: model.description,
      confidence: model.confidence,
      primitives3D: model.coalescedPrimitives,
      derivedEntities,
      projectionSteps,
      solverMetrics: {
        totalCells: complex.cells.length,
        occupiedCells,
        unexplainedError: round2(model.score.unexplainedLength),
        phantomError: round2(model.score.phantomLength),
        surfaceComplexity: round2(model.score.surfaceComplexity),
        solveTimeMs: solveElapsed,
      },
    };
  });
}
