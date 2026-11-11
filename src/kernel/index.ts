export * from './types';

// Layer 1: 2D Planar Arrangement, DCEL & Analytical Carrier Reconstruction
export {
  arcSweepCCW,
  computeArcBBox,
  dist2,
  normAngle,
  pointToLineSegDist,
  snapAndSplitViewEntities,
} from './arrangement2d/snapAndSplit';
export {
  buildDCELFromSplitSegments,
  buildUnionFaceProfiles,
  classifyRegionProfile2D,
  findGuaranteedInteriorPoint,
  isPointStrictlyInPolygon,
  polygonSignedArea,
  sampleLoopSegmentsToDensePolygon,
} from './arrangement2d/dcelBuilder';
export {
  buildPlanarArrangement2D,
  extractDashedBandsFromCarriers,
  extractDashedBandsFromCarriers as extractDashedBands,
  reconstructCarrierCircles,
  reconstructCarrierLines,
} from './arrangement2d/carrierReconstruction';

// Layer 2: 3D Analytical Half-Spaces, GeneralizedLoft & Projective Lifting
export {
  buildGeneralizedLoftTrianglePositions,
  buildGeneralizedLoftTrianglePositions as buildGeneralizedLoftManifoldPositions,
  computeGeneralizedLoftBBox,
  evalGeneralizedLoftGrad,
  evalGeneralizedLoftSDF,
  extractGeneralizedLoftFeatureEdges,
  loftUVWToXYZ,
  primitiveToGeneralizedLoft,
  xyzToLoftUVW,
} from './lifting3d/generalizedLoft';
export {
  buildCandidateVolumeFromPrimitive,
  createCylinderSurface3D,
  createPlaneSurface3D,
  evalCurvedRegion2DSDF,
  evalPrimitive3DGrad,
  evalPrimitive3DSDF,
  getThirdTargetView,
  getViewProjectionFrame,
  projectPoint3DToView,
  unprojectViewPointTo3D,
} from './lifting3d/surfacePrimitives';
export {
  getSharedAxisMapping,
  liftProjectiveCandidates3D,
} from './lifting3d/candidateLifter';

// Layer 3: Curved-Boundary 3D Cell Complex & Boolean CSP Occupancy Solver
export {
  buildCurvedCellComplex3D,
  isPointInArrangementOuterSilhouette,
  isPointInVisualHull3D,
} from './solver/cellDecomposition';
export { compileReprojectionEvaluator } from './solver/reprojectionVerifier';
export {
  coalesceOccupiedCellsToPrimitives,
  solveCellularOccupancyCSP,
} from './solver/cspOccupancySolver';

// Layer 4: 3D Surface-Surface Intersection (SSI) Numerical Marching Tracer
export { traceModelSSICurves3D } from './ssi/ssiMarchingTracer';

// Layer 5: Quantitative HLR & GB/T 4458.4 Clean 2D Curve Reconstruction
export { extractCandidateEdges3DForView } from './hlr/silhouetteAndCrease';
export { isPointVisibleInModel3D, runQuantitativeHLR } from './hlr/quantitativeHLR';
export { reconstructClean2DEntitiesFromHLR } from './hlr/curveReconstruction2D';

// Layer 6: Sharp-Edge Watertight Manifold Mesher, GB/T Diagnostics & Benchmark Suite
export {
  buildSinglePrimitiveGeometry,
  buildWatertightManifoldGeometry,
  exportPrimitivesToWatertightSTL,
  extractSharpFeatureEdges,
  sanitizeAndOrientBufferGeometry,
  verifyManifoldWatertightness,
} from './mesh/manifoldMesher';
export {
  applySingleDiagnosticFix,
  runGbtThreeViewDiagnostics,
} from './diagnostics/gbtDiagnostics';
export {
  getBenchmarkPresetCases,
  getNormalizedBenchmarkPresets,
  runKernelBenchmarkSelfTest,
} from './benchmark/selfTestSuite';

// End-to-End 6-Layer Reconstruction & Derivation Pipeline
export { reconstructAndDeriveThirdView } from './pipeline';
