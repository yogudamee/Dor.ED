import * as THREE from 'three';
import {
  CadEntity,
  DiagnosticIssue,
  PresetCase,
  Primitive3D,
  ReconstructedSolution,
  ViewType,
} from '../types/cad';
import { evalCurvedRegion2DSDF } from './arrangement2d/dcelFaces';
import {
  getNormalizedBenchmarkPresets,
  runKernelBenchmarkSelfTest,
} from './benchmark/benchmarkSuite';
import {
  arcSweepCCW,
  dist2,
  getThirdView,
  normAngle,
  pointToArcSegDist,
  pointToLineSegDist,
  polygonSignedArea,
  projectPoint3DToView,
  sampleArcDTheta,
  sampleLoopSegmentsToDensePolygon,
} from './core/coordSystem';
import type {
  BenchmarkCaseResult,
  BenchmarkSuiteReport,
  CandidateSolidVolume,
  CandidateVoidChannel,
  ClassifiedSegment2D,
  CompositeRegion2D,
  CSPSolvedConfiguration,
  ExtractedEdges3D,
  ReprojectionVerificationReport,
  SSICurveChain3D,
  Vec3,
  ViewArrangementResult,
} from './core/types';
import {
  diagnoseThreeViews,
  fixSingleDiagnosticIssue,
} from './diagnostics/threeViewDiagnostics';
import {
   evalCSGSolidSDF,
  evalGeneralizedLoftSDF,
  evalPrimitive3DSDF,
} from './lifting3d/analyticSurfaces';
import {
  buildSinglePrimitiveGeometry,
  buildWatertightManifoldGeometry,
  exportPrimitivesToWatertightSTL,
  extractSharpFeatureEdges,
} from './mesh/watertightMesher';
import { coalesceSolidPrimitives } from './solver/volumeCoalescer';
import { solve2DTo3DVolumeCSP } from './solver/volumeCSPSolver';

// ============================================================================
// Required 9 Public Kernel Facade APIs (Section 1 / Chapter 5 Contract)
// ============================================================================

/**
 * 1. Reconstruct 3D solid configuration(s) from two known orthographic views and synthesize
 *    the third target view (`thick_solid`, `thin_dashed`, `center_dot_dash` + pedagogical steps).
 */
export function deriveFromCustomViews(
  entities: CadEntity[],
  knownViews?: [ViewType, ViewType],
  targetView?: ViewType
): ReconstructedSolution[] {
  return solve2DTo3DVolumeCSP(entities, knownViews, targetView);
}

/**
 * 2. Run GB/T 4458.1 & GB/T 4458.4 three-view intelligent diagnostics.
 * 3. Apply a non-destructive geometric fix for a single diagnostic issue.
 * 4. Build composite boolean CSG watertight manifold `THREE.BufferGeometry`.
 * 5. Build single primitive watertight `THREE.BufferGeometry`.
 * 6. Extract sharp mechanical feature edges (`THREE.BufferGeometry`).
 * 7. Export 3D primitives in millimeter engineering space to ASCII STL.
 * 8. Retrieve all 14 normalized high-difficulty benchmark presets.
 * 9. Run the automated 14-case kernel self-test suite.
 */
export {
  diagnoseThreeViews,
  fixSingleDiagnosticIssue,
  buildWatertightManifoldGeometry,
  buildSinglePrimitiveGeometry,
  extractSharpFeatureEdges,
  exportPrimitivesToWatertightSTL,
  getNormalizedBenchmarkPresets,
  runKernelBenchmarkSelfTest,
};

// ============================================================================
// Auxiliary Geometric Helpers & Types Re-Exported for Codebase Utilities
// ============================================================================

export {
  arcSweepCCW,
  coalesceSolidPrimitives,
  dist2,
  evalCSGSolidSDF,
  evalCurvedRegion2DSDF,
  evalGeneralizedLoftSDF,
  evalPrimitive3DSDF,
  getThirdView,
  normAngle,
  pointToArcSegDist,
  pointToLineSegDist,
  polygonSignedArea,
  projectPoint3DToView,
  sampleArcDTheta,
  sampleLoopSegmentsToDensePolygon,
  THREE,
};

export type {
  BenchmarkCaseResult,
  BenchmarkSuiteReport,
  CandidateSolidVolume,
  CandidateVoidChannel,
  ClassifiedSegment2D,
  CompositeRegion2D,
  CSPSolvedConfiguration,
  ExtractedEdges3D,
  ReprojectionVerificationReport,
  SSICurveChain3D,
  Vec3,
  ViewArrangementResult,
};
