import {
  CadEntity,
  LineType,
  LoopCurveSegment2D,
  Point2D,
  Primitive3D,
  ReconstructedSolution,
  ViewType,
} from '../../types/cad';

export type Axis3D = 'X' | 'Y' | 'Z';
export type BooleanOp = 'add' | 'subtract' | 'intersect';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox2D {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface BoundingBox3D {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

export interface CurveSegment2D extends LoopCurveSegment2D {
  id: string;
  lineType: LineType;
  sourceEntityId: string;
  featureId?: string;
  featureLabel?: string;
}

export interface DCELVertex {
  id: number;
  pt: Point2D;
  outgoingHalfEdges: number[];
}

export interface DCELHalfEdge {
  id: number;
  origin: number;
  twin: number;
  next: number;
  prev: number;
  face: number | null;
  segment: CurveSegment2D;
  startTangentAngle: number;
  endTangentAngle: number;
  signedCurvature: number;
}

export interface DCELAtomicFace {
  id: number;
  outerHalfEdges: number[];
  holeHalfEdgeLoops: number[][];
  segments: CurveSegment2D[];
  polygon: Point2D[];
  signedArea: number;
  area: number;
  bounds: BoundingBox2D;
  interiorPoint: Point2D;
  isUnboundedOuter: boolean;
}

export interface PlanarityDCELResult {
  vertices: DCELVertex[];
  halfEdges: DCELHalfEdge[];
  atomicFaces: DCELAtomicFace[];
}

export type RegionProfileKind =
  | 'circle'
  | 'semicircle'
  | 'arch'
  | 'rectangle'
  | 'trapezoid_h'
  | 'trapezoid_v'
  | 'triangle_h'
  | 'triangle_v'
  | 'regular_polygon'
  | 'general_polygon'
  | 'curved_loop';

export interface RegionProfileMeta {
  center?: Point2D;
  radius?: number;
  arcStart?: number;
  arcEnd?: number;
  chordCoord?: number;
  chordAxis?: 'u' | 'v';
  keepGreater?: boolean;
  rAtMin?: number;
  rAtMax?: number;
  cAtMin?: number;
  cAtMax?: number;
  apex?: Point2D;
  sides?: number;
}

export interface CompositeRegion2D {
  id: string;
  view: ViewType;
  lineType: LineType;
  atomicFaceIds: number[];
  boundarySegments: CurveSegment2D[];
  polygon: Point2D[];
  area: number;
  bounds: BoundingBox2D;
  interiorPoint: Point2D;
  nestingDepth: number;
  parentRegionId: string | null;
  childRegionIds: string[];
  isSharedChordUnion: boolean;
  isFullEnvelope?: boolean;
  isSubDecomposed?: boolean;
  profileKind: RegionProfileKind;
  profileMeta?: RegionProfileMeta;
}

export interface LineCarrierInterval {
  s0: number;
  s1: number;
  p1: Point2D;
  p2: Point2D;
  lineType: LineType;
  entityId: string;
}

export interface LineCarrier2D {
  id: string;
  view: ViewType;
  origin: Point2D;
  dir: Point2D; // unit direction
  normal: Point2D;
  sMin: number;
  sMax: number;
  pStart: Point2D;
  pEnd: Point2D;
  isHorizontal: boolean;
  isVertical: boolean;
  coordConst?: number; // v for horizontal, u for vertical
  intervals: LineCarrierInterval[];
  solidIntervals: LineCarrierInterval[];
  dashedIntervals: LineCarrierInterval[];
  hasSolid: boolean;
  hasDashed: boolean;
  isCoaxialSolidDashed: boolean;
}

export interface CircleArcInterval {
  startAngle: number;
  endAngle: number;
  sweep: number;
  lineType: LineType;
  entityId: string;
}

export interface VirtualCircleCarrier2D {
  id: string;
  view: ViewType;
  center: Point2D;
  radius: number;
  dominantLineType: LineType;
  isStitchedFromArcs: boolean;
  isFullCircleEntity: boolean;
  totalSolidDegrees: number;
  totalDashedDegrees: number;
  coverageDegrees: number;
  intervals: CircleArcInterval[];
  sourceEntityIds: string[];
  nestingDepth: number;
  parentRegionId: string | null;
}

export interface ParallelDashedBand2D {
  id: string;
  axis: 'u' | 'v'; // 'u' means two vertical lines u=c1, u=c2 spanning [vMin,vMax]; 'v' means two horizontal lines v=c1, v=c2 spanning [uMin,uMax]
  c1: number;
  c2: number;
  center: number;
  width: number;
  spanMin: number;
  spanMax: number;
  hasCenterline: boolean;
  sourceIds: string[];
}

export interface TaperedDashedBand2D {
  id: string;
  sweepAxis: 'u' | 'v'; // 'v' means sweeping along v from v0 to v1 with u-widths [u0Min..u0Max] -> [u1Min..u1Max]
  w0: number;
  w1: number;
  p0Min: number;
  p0Max: number;
  p1Min: number;
  p1Max: number;
  center0: number;
  center1: number;
  r0: number;
  r1: number;
  sourceIds: string[];
}

export interface OpenNotchFeature2D {
  id: string;
  view: ViewType;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  openSide: 'uMin' | 'uMax' | 'vMin' | 'vMax';
  lineType: LineType;
}

export interface ViewArrangementResult {
  view: ViewType;
  rawEntities: CadEntity[];
  centerlineEntities: CadEntity[];
  splitSegments: CurveSegment2D[];
  solidDCEL: PlanarityDCELResult;
  fullDCEL: PlanarityDCELResult;
  regions: CompositeRegion2D[];
  subFaces: CompositeRegion2D[];
  outerRegions: CompositeRegion2D[];
  innerRegions: CompositeRegion2D[];
  bounds: BoundingBox2D | null;
  lineCarriers: LineCarrier2D[];
  circleCarriers: VirtualCircleCarrier2D[];
  parallelDashedBands: ParallelDashedBand2D[];
  taperedDashedBands: TaperedDashedBand2D[];
  openNotches: OpenNotchFeature2D[];
}

export interface CandidateSolidVolume {
  id: string;
  primitives: Primitive3D[]; // Usually 1 primitive, or 2+ primitives with 'intersect' for clipped polyhedra
  bounds: BoundingBox3D;
  witnessPoints: Vec3[];
  surfaceAreaEstimate: number;
  priorityBoost: number;
  isEssentialOuter: boolean;
  sourceRegions: { view: ViewType; regionId: string }[];
  description: string;
}

export interface CandidateVoidChannel {
  id: string;
  primitive: Primitive3D; // operation: 'subtract'
  bounds: BoundingBox3D;
  axis: Axis3D;
  isThrough: boolean;
  isTBranch?: boolean;
  parentMainVoidId?: string;
  hasDashedEvidence: boolean;
  hasInnerLoopEvidence: boolean;
  confidence: number;
  description: string;
}

export interface Seg3D {
  p1: Vec3;
  p2: Vec3;
  ownerOp: BooleanOp;
  ownerId: string;
  featureId?: string;
  featureLabel?: string;
  forceHidden?: boolean;
  isKnifeEdgeProtected?: boolean;
  isSilhouette?: boolean;
}

export interface AnalyticArc3D {
  center: Vec3;
  radius: number;
  uAxis: Vec3; // unit vector in circle plane corresponding to cos(theta)
  vAxis: Vec3; // unit vector in circle plane corresponding to sin(theta)
  normal: Vec3;
  startAngle: number;
  endAngle: number;
  isFullCircle: boolean;
  ownerOp: BooleanOp;
  ownerId: string;
  featureId?: string;
  featureLabel?: string;
  forceHidden?: boolean;
  isKnifeEdgeProtected?: boolean;
  isAnnularShoulder?: boolean;
}

export interface SSICurveChain3D {
  id: string;
  points: Vec3[];
  closed: boolean;
  interactionKind: 'solid_solid' | 'solid_void' | 'void_void';
  primAId: string;
  primBId: string;
  featureId: string;
  featureLabel: string;
  forceHidden: boolean;
}

export interface ExtractedEdges3D {
  segments: Seg3D[];
  arcs: AnalyticArc3D[];
  ssiChains: SSICurveChain3D[];
}

export interface ClassifiedSegment2D {
  kind: 'line' | 'arc';
  p1: Point2D;
  p2: Point2D;
  center?: Point2D;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  visibility: 'visible' | 'hidden' | 'culled';
  lineType: LineType;
  featureId?: string;
  featureLabel?: string;
}

export interface ViewReprojectionMetrics {
  view: ViewType;
  solidRecall: number;
  dashedRecall: number;
  unexplainedError: number;
  phantomSolidError: number;
  phantomDashedError: number;
  missingStepJumpPenalty: number;
  wallSplitPenalty: number;
  falseHoleIds: string[];
  totalScore: number;
}

export interface ReprojectionVerificationReport {
  totalError: number;
  unexplainedError: number;
  phantomError: number;
  recallKnownViews: number;
  viewReports: [ViewReprojectionMetrics, ViewReprojectionMetrics];
  falseHoleIds: string[];
}

export interface CSPSolvedConfiguration {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  confidenceLabel: string;
  primitives: Primitive3D[];
  verification: ReprojectionVerificationReport;
  surfaceComplexity: number;
  totalCandidateCells: number;
  occupiedCellCount: number;
}

export interface BenchmarkCaseResult {
  caseId: string;
  caseName: string;
  passed: boolean;
  notes: string;
  knownViews: [ViewType, ViewType];
  targetView: ViewType;
  cellCount: number;
  occupiedCellCount: number;
  solutionCount: number;
  derivedSolidCount: number;
  derivedDashedCount: number;
  derivedCenterlineCount: number;
  watertightTriangles: number;
  recallKnownViews: number;
  solveTimeMs: number;
}

export interface BenchmarkSuiteReport {
  totalCases: number;
  passedCases: number;
  totalTimeMs: number;
  results: BenchmarkCaseResult[];
}
