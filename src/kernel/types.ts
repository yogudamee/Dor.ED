import {
  CadEntity,
  GeneralizedLoftPayload,
  HemisphereCapSpec,
  LineType,
  LoopCurveSegment2D,
  Point2D,
  Primitive3D,
  ViewType,
} from '../types/cad';

// ============================================================================
// Fundamental 2D / 3D Mathematical Primitives & Coordinate Frames
// ============================================================================

export interface Vec2 {
  u: number;
  v: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BBox2D {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface BBox3D {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

export type Axis3D = 'X' | 'Y' | 'Z';

/**
 * First-Angle Projection (GB/T 4458.1) coordinate mapping for a 2D view:
 * - front (V): u = X, v = Z, depth w = Y, sightline toward observer = (0, +1, 0) (yMax = front, yMin = back)
 * - top   (H): u = X, v = Y, depth w = Z, sightline toward observer = (0, 0, +1) (zMax = top,   zMin = bottom)
 * - left  (W): u = Y, v = Z, depth w = X, sightline toward observer = (-1, 0, 0) (xMin = left,  xMax = right)
 */
export interface ViewProjectionFrame {
  view: ViewType;
  uAxis: Axis3D;
  vAxis: Axis3D;
  wAxis: Axis3D;
  eyeDir: Vec3; // unit vector pointing from object toward observer
}

// ============================================================================
// Layer 1: 2D Planar Arrangement, DCEL & Analytical Carrier Reconstruction
// ============================================================================

export interface SplitCurveSegment2D {
  id: string;
  sourceEntityId: string;
  view: ViewType;
  lineType: LineType;
  kind: 'line' | 'arc';
  p1: Vec2;
  p2: Vec2;
  // Populated when kind === 'arc'
  center?: Vec2;
  radius?: number;
  startAngle?: number; // in [0, 2π), advancing +dθ from startAngle to endAngle
  endAngle?: number;   // in [0, 2π)
  bbox: BBox2D;
}

export interface EvidenceSpan1D {
  tMin: number;
  tMax: number;
  p1: Vec2;
  p2: Vec2;
  lineType: LineType;
  sourceEntityId: string;
}

export interface CarrierLine2D {
  id: string;
  kind: 'line';
  view: ViewType;
  origin: Vec2;
  dir: Vec2;        // unit direction vector
  normal: Vec2;     // unit normal (-dir.v, dir.u)
  offsetC: number;  // normal.u * u + normal.v * v = offsetC
  tMin: number;     // min projection along dir
  tMax: number;     // max projection along dir
  pMin: Vec2;
  pMax: Vec2;
  isHorizontal: boolean;
  isVertical: boolean;
  hasSolid: boolean;
  hasDashed: boolean;
  spans: EvidenceSpan1D[];
}

export interface AngularEvidenceSpan {
  startAngle: number; // [0, 2π)
  sweep: number;      // (0, 2π]
  lineType: LineType;
  sourceEntityId: string;
}

export interface CarrierCircle2D {
  id: string;
  kind: 'circle';
  view: ViewType;
  center: Vec2;
  radius: number;
  totalSolidSweep: number;
  totalDashedSweep: number;
  totalSweep: number; // in (0, 2π]
  isFullCircle: boolean;       // true if stitched solid+dashed >= 1.92π or native circle or major trimmed arc >= 1.05π
  isMajorTrimmedArc: boolean;  // single arc with sweep > π + 0.15
  isSemicircle: boolean;
  sharedChord?: {
    axis: 'u' | 'v';
    coord: number;
    keepGreater: boolean;
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
  };
  angularSpans: AngularEvidenceSpan[];
  bbox: BBox2D;
}

export type CarrierCurve2D = CarrierLine2D | CarrierCircle2D;

export interface DCELVertex {
  id: number;
  pt: Vec2;
  outgoingHalfEdges: number[];
}

export interface DCELHalfEdge {
  id: number;
  twinId: number;
  originVertexId: number;
  targetVertexId: number;
  nextHalfEdgeId: number;
  faceId: number; // -1 before face assignment
  segment: SplitCurveSegment2D;
  forward: boolean; // true: p1 -> p2; false: p2 -> p1
  exitTangentAngle: number;
  signedCurvature: number; // +1/R if curving left (CCW), -1/R if curving right (CW), 0 for line
}

export interface DCELFace {
  id: number;
  isOuterInfinite: boolean;
  signedArea: number;
  area: number;
  bbox: BBox2D;
  boundaryHalfEdgeIds: number[];
  boundarySegments: LoopCurveSegment2D[];
  densePolygon: Vec2[];
  interiorSample: Vec2;
  hasDashedBoundary: boolean;
  allSolidBoundary: boolean;
  nestingDepth: number;
  parentFaceId: number | null;
}

export interface RegionProfile2D {
  id: string;
  view: ViewType;
  faceIds: number[];
  isAtomic: boolean;
  isOuterEnvelope: boolean;
  isSolidOnly: boolean;
  hasDashedBoundary: boolean;
  area: number;
  bbox: BBox2D;
  segments: LoopCurveSegment2D[];
  densePolygon: Vec2[];
  interiorSample: Vec2;
  // Analytical classification of this 2D region
  shapeKind: 'rect' | 'circle' | 'semicircle' | 'trapezoid' | 'triangle' | 'arch_or_curved' | 'polygon';
  circleSpec?: {
    center: Vec2;
    radius: number;
  };
  semicircleSpec?: {
    center: Vec2;
    radius: number;
    chordAxis: 'u' | 'v';
    chordCoord: number;
    keepGreater: boolean;
    arcStart: number;
    arcEnd: number;
  };
  trapezoidSpec?: {
    taperAxis: 'u' | 'v'; // axis along which cross-span varies linearly (e.g. 'v' if top/bottom are horizontal bases)
    w0: number;
    w1: number;
    span0Min: number;
    span0Max: number;
    span1Min: number;
    span1Max: number;
    isTriangle: boolean;
    apexCoord?: Vec2;
  };
}

export interface ParallelDashedBand2D {
  id: string;
  view: ViewType;
  orientation: 'vertical' | 'horizontal'; // vertical: two lines u = uMin, u = uMax spanning v in [spanMin, spanMax]
  coordMin: number;
  coordMax: number;
  spanMin: number;
  spanMax: number;
  touchesMinBoundary: boolean;
  touchesMaxBoundary: boolean;
  wasInterruptedByHole: boolean;
}

export interface TaperedDashedBand2D {
  id: string;
  view: ViewType;
  taperAxis: 'u' | 'v'; // 'v': varies along v from v0 to v1 with u-spans [u0Min,u0Max] -> [u1Min,u1Max]
  w0: number;
  w1: number;
  span0Min: number;
  span0Max: number;
  span1Min: number;
  span1Max: number;
}

export interface PlanarArrangement2D {
  view: ViewType;
  overallBBox: BBox2D | null;
  solidBBox: BBox2D | null;
  splitSegments: SplitCurveSegment2D[];
  vertices: DCELVertex[];
  halfEdges: DCELHalfEdge[];
  atomicFaces: DCELFace[]; // excludes infinite face
  solidAtomicFaces: DCELFace[]; // faces formed purely from thick_solid DCEL
  outerSilhouetteLoops: RegionProfile2D[];
  regions: RegionProfile2D[]; // atomic + multi-scale union profiles (e.g., shared-chord semicircles)
  carrierLines: CarrierLine2D[];
  carrierCircles: CarrierCircle2D[];
  parallelDashedBands: ParallelDashedBand2D[];
  taperedDashedBands: TaperedDashedBand2D[];
}

// ============================================================================
// Layer 2: 3D Analytical Half-Spaces & Projective Surface Lifting
// ============================================================================

export type SurfaceKind3D =
  | 'plane'
  | 'cylinder'
  | 'prism_extrusion'
  | 'sphere'
  | 'hemisphere'
  | 'cone_frustum'
  | 'generalized_loft';

export interface AnalyticalSurface3D {
  id: string;
  kind: SurfaceKind3D;
  label: string;
  sourceViews: ViewType[];
  isCavityHint?: boolean; // true if lifted from thin_dashed band/circle
  domainBox: BBox3D;
  axis?: Axis3D;
  // Exact signed distance / implicit function: phi(p) < 0 inside bounded/negative side, 0 on surface, > 0 outside
  evalPhi: (p: Vec3) => number;
  // Exact analytical outward unit normal / gradient at p
  evalGrad: (p: Vec3) => Vec3;
  // Underlying geometric parameters for algebraic coalescing, SSI, HLR, and sharp meshing
  planeParams?: { normal: Vec3; d: number }; // normal · p + d = 0
  cylinderParams?: { axis: Axis3D; centerU: number; centerV: number; radius: number; wMin: number; wMax: number };
  sphereParams?: { center: Vec3; radius: number; hemisphereCap?: HemisphereCapSpec };
  loftParams?: GeneralizedLoftPayload;
  prismParams?: {
    axis: Axis3D;
    wMin: number;
    wMax: number;
    segments: LoopCurveSegment2D[];
    densePolygon: Vec2[];
  };
  associatedPrimitive?: Primitive3D;
}

export interface CandidateVolume3D {
  id: string;
  label: string;
  roleHint: 'solid_body' | 'step_boss' | 'cavity_Candidate' | 'ambiguous';
  isGuaranteedVoid?: boolean;
  isGuaranteedSolid?: boolean;
  priority: number;
  bbox: BBox3D;
  primitive: Primitive3D;
  evalSDF: (p: Vec3) => number;
  evalGrad: (p: Vec3) => Vec3;
  surfaces: AnalyticalSurface3D[];
}

export interface LiftedCandidatePool3D {
  knownViews: [ViewType, ViewType];
  targetView: ViewType;
  visualHullBBox: BBox3D;
  arr1: PlanarArrangement2D;
  arr2: PlanarArrangement2D;
  surfaces: AnalyticalSurface3D[];
  volumes: CandidateVolume3D[];
}

// ============================================================================
// Layer 3: Curved-Boundary 3D Cell Complex & Boolean CSP Occupancy Solver
// ============================================================================

export interface AtomicCell3D {
  id: number;
  signKey: string;
  signVector: Int8Array; // sigma_k in {-1, +1}^M across splitting surfaces/volumes
  witnessPoints: Vec3[];
  centroid: Vec3;
  approxVolume: number;
  bbox: BBox3D;
  inVisualHull: boolean;
  // Pre-classified status during deterministic unit propagation: -1 = free, 0 = empty, 1 = solid
  fixedState: -1 | 0 | 1;
  coveringVolumeIds: string[];
  voidHintVolumeIds: string[];
}

export interface CellBoundaryPatch3D {
  id: string;
  cellA: number; // index into cells, or -1 for exterior unbounded air C_0
  cellB: number; // index into cells, or -1 for exterior unbounded air C_0
  surfaceId: string;
  surface: AnalyticalSurface3D;
  samplePoints: Vec3[]; // refined onto surface phi(p) = 0
  approxArea: number;
}

export interface SightlineRay2D {
  view: ViewType;
  pt2D: Vec2;
  mustBeSolid: boolean;  // true if inside solid region not covered by through-hole
  mustBeEmpty: boolean;  // true if outside outer solid silhouette or inside clear through-hole
  orderedCellIds: number[]; // cells intersected along eye ray from front-most to back-most
}

export interface CellComplex3D {
  visualHullBBox: BBox3D;
  surfaces: AnalyticalSurface3D[];
  volumes: CandidateVolume3D[];
  cells: AtomicCell3D[];
  patches: CellBoundaryPatch3D[];
  sightlinesV1: SightlineRay2D[];
  sightlinesV2: SightlineRay2D[];
  evalPointCellId: (p: Vec3) => number; // returns cell id in [0..N-1] or -1 for exterior air
}

export interface ReprojectionScore {
  totalEnergy: number;
  unexplainedLength: number;
  phantomLength: number;
  lineTypeMismatchLength: number;
  surfaceComplexity: number;
  recallV1: number;
  precisionV1: number;
  recallV2: number;
  precisionV2: number;
  isValidSilhouette: boolean;
}

export interface SolvedSolidModel3D {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  confidence: string;
  occupancy: Uint8Array; // length = complex.cells.length, x_k in {0, 1}
  score: ReprojectionScore;
  coalescedPrimitives: Primitive3D[];
  activeSurfaces: AnalyticalSurface3D[];
  evalSDF: (p: Vec3) => number;
  isPointOccupied: (p: Vec3) => boolean;
  bounds: BBox3D;
}

// ============================================================================
// Layer 4 & 5: 3D SSI Curves, Crease/Silhouette Extraction & Quantitative HLR
// ============================================================================

export interface SpaceLine3D {
  id: string;
  kind: 'line3d';
  p1: Vec3;
  p2: Vec3;
  isCavityBoundary: boolean;
  surfaceIds: string[];
  featureId?: string;
  featureLabel?: string;
}

export interface SpaceCircleArc3D {
  id: string;
  kind: 'circle3d';
  center: Vec3;
  radius: number;
  uAxis: Vec3; // unit vector in circle plane
  vAxis: Vec3; // unit vector orthogonal to uAxis in circle plane
  normal: Vec3;
  startAngle: number;
  sweep: number; // (0, 2π]
  isAnnularShoulderOuter?: boolean;
  isKnifeEdgeRim?: boolean;
  isCavityBoundary: boolean;
  surfaceIds: string[];
  featureId?: string;
  featureLabel?: string;
}

export interface SpacePolyline3D {
  id: string;
  kind: 'polyline3d';
  points: Vec3[]; // high-density Newton-refined 3D SSI curve points
  closed: boolean;
  isCavityBoundary: boolean;
  surfaceIds: string[];
  featureId?: string;
  featureLabel?: string;
}

export type CandidateEdge3D = SpaceLine3D | SpaceCircleArc3D | SpacePolyline3D;

// ============================================================================
// Layer 6: Benchmark Self-Test Report Types
// ============================================================================

export interface BenchmarkCaseResult {
  caseId: string;
  caseName: string;
  passed: boolean;
  knownViews: [ViewType, ViewType];
  targetView: ViewType;
  cellCount: number;
  occupiedCellCount: number;
  solutionCount: number;
  derivedEntityCount: number;
  derivedSolidCount: number;
  derivedDashedCount: number;
  derivedCenterlineCount: number;
  recallKnownViews: number;
  precisionKnownViews: number;
  watertightTriangles: number;
  isWatertightManifold: boolean;
  solveTimeMs: number;
  notes: string;
}

export interface BenchmarkSuiteReport {
  totalCases: number;
  passedCases: number;
  totalTimeMs: number;
  results: BenchmarkCaseResult[];
}
