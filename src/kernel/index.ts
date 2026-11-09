// Layer 1: 2D Planar Arrangement, DCEL, Virtual Circle Stitcher, Containment Tree & Dashed Parser
export * from './arrangement/curveIntersector';
export * from './arrangement/planarGraphDCEL';
export * from './arrangement/virtualCircleStitcher';
export * from './arrangement/containmentTree';
export * from './arrangement/dashedFeatureParser';

// Layer 2: 3D Solid Primitives, Generalized Loft, Quadrics & CSG Tree
export * from './primitives/generalizedLoft';
export * from './primitives/quadrics';
export * from './primitives/csgTree';

// Layer 3: 2D-to-3D Feature Pairing Matrix, Candidate Generator & Back-Projection Self-Healing Verifier
export * from './reconstruction/featurePairingMatrix';
export * from './reconstruction/candidateGenerator';
export * from './reconstruction/backProjectionVerifier';

// Layer 4: 3D Plane-Surface Cut & Surface-Surface Intersection (SSI) Marching Engine
export * from './intersection/planeSurfaceCut';
export * from './intersection/surfaceSurfaceSSI';

// Layer 5: 3D-to-2D Silhouette Extraction, Quantitative HLR Visibility & 2D Curve Fitter
export * from './hlr/silhouetteExtractor';
export * from './hlr/quantitativeVisibility';
export * from './hlr/curveFitter2D';

// Layer 6: GB/T 4458.1 Alignment, Closure & Centerline Diagnostics
export * from './diagnostics/alignmentChecker';
export * from './diagnostics/centerlineComplete';
