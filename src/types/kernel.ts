import {
  CadEntity,
  LineType,
  LoopCurveSegment2D,
  Point2D,
  Primitive3D,
  ReconstructedSolution,
  ViewType,
} from './cad';

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
}

export interface DCELVertex {
  id: number;
  pt: Point2D;
  outgoingHalfEdges: number[]; // Sorted counter-clockwise by outgoing tangent angle
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
  | 'general_polygon'
  | 'curved_loop';

export interface CompositeRegion2D {
  id: string;
  view: ViewType;
  lineType: LineType;
  atomicFaceIds: number[];
  boundarySegments: CurveSegment2D[];
  polygon: Point2D[];
  area: number;
  bounds: BoundingBox2D;
  nestingDepth: number;
  parentRegionId: string | null;
  childRegionIds: string[];
  isSharedChordUnion: boolean;
  isDecomposedSubLoop?: boolean;
  profileKind: RegionProfileKind;
  profileMeta?: {
    center?: Point2D;
    radius?: number;
    chordCoord?: number;
    chordAxis?: 'u' | 'v';
    rAtMin?: number;
    rAtMax?: number;
    cAtMin?: number;
    cAtMax?: number;
    wSlopeMin?: number;
    wSlopeMax?: number;
    apex?: Point2D;
  };
}

export interface VirtualCircleFeature {
  id: string;
  view: ViewType;
  center: Point2D;
  radius: number;
  lineType: LineType;
  isStitchedFromArcs: boolean;
  coverageDegrees: number;
  sourceEntityIds: string[];
  nestingDepth: number;
  parentRegionId: string | null;
  parentCircleId: string | null;
}

export interface ContainmentHierarchyGraph {
  view: ViewType;
  bounds: BoundingBox2D | null;
  regions: CompositeRegion2D[];
  outerRegions: CompositeRegion2D[];
  innerRegions: CompositeRegion2D[];
  circles: VirtualCircleFeature[];
  outerCircles: VirtualCircleFeature[];
  innerCircles: VirtualCircleFeature[];
  consumedDashedArcIds: Set<string>;
}

export interface TaperedDashedBand {
  v1: number;
  v2: number;
  u1Min: number;
  u1Max: number;
  u2Min: number;
  u2Max: number;
  ids: string[];
}

export interface TaperedDashedVBand {
  u1: number;
  u2: number;
  v1Min: number;
  v1Max: number;
  v2Min: number;
  v2Max: number;
  ids: string[];
}

export interface ParallelDashedUBand {
  u1: number;
  u2: number;
  vMin: number;
  vMax: number;
  openMin?: boolean;
  openMax?: boolean;
  slantedPoly?: Point2D[];
}

export interface ParallelDashedVBand {
  v1: number;
  v2: number;
  uMin: number;
  uMax: number;
  openMin?: boolean;
  openMax?: boolean;
  slantedPoly?: Point2D[];
}

export interface OpenDashedSlot {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  openSide: 'uMin' | 'uMax' | 'vMin' | 'vMax';
  lineType: LineType;
}

export interface StepDashedLine {
  coord: number; // v for horizontal, u for vertical
  spanMin: number;
  spanMax: number;
  axis: 'u' | 'v';
  isStepPlane: boolean;
}

export interface DashedTopologyFeatures {
  view: ViewType;
  uSlots: OpenDashedSlot[];
  uBands: ParallelDashedUBand[];
  vBands: ParallelDashedVBand[];
  taperedUBands: TaperedDashedBand[];
  taperedVBands: TaperedDashedVBand[];
  singleHorizDashed: { v: number; uMin: number; uMax: number; isStepPlane: boolean }[];
  singleVertDashed: { u: number; vMin: number; vMax: number; isStepPlane: boolean }[];
  solidUBands: { u1: number; u2: number; vMin: number; vMax: number }[];
  solidVBands: { v1: number; v2: number; uMin: number; uMax: number }[];
}

/**
 * GeneralizedLoftSolid: Unified mathematical operator for all prisms, cylinders,
 * right/oblique/eccentric cones & frustums, semi-cones, semi-frustums, and pyramids.
 * Parametric equation:
 *   S(s, t) = (1 - t) * Γ_0(s) + t * Γ_1(s),   t = (w - w0) / (w1 - w0) ∈ [0, 1]
 *   where Γ_1(s) = c1 + diag(scaleU, scaleV) * (Γ_0(s) - c0)
 */
export interface GeneralizedLoftSolid {
  id: string;
  featureId: string;
  label: string;
  operation: BooleanOp;
  axis: Axis3D;
  w0: number;
  w1: number;
  baseSegments: LoopCurveSegment2D[];
  basePolygon: Point2D[];
  c0: Point2D;
  c1: Point2D;
  scaleU: number;
  scaleV: number;
  isCircular?: boolean;
  r0?: number;
  r1?: number;
  isInternalFeature?: boolean;
  isInsideLoopContour?: boolean;
}

export interface Seg3D {
  p1: Vec3;
  p2: Vec3;
  ownerType?: BooleanOp;
  ownerId?: string;
  featureId?: string;
  featureLabel?: string;
  forceHidden?: boolean;
}

export interface CircleOrArc3D {
  center: Vec3;
  radius: number;
  axis: Axis3D;
  isArc?: boolean;
  startAngle?: number;
  endAngle?: number;
  ccw?: boolean;
  ownerType?: BooleanOp;
  ownerId?: string;
  featureId?: string;
  featureLabel?: string;
}

export interface Polychain3D {
  id: string;
  points: Vec3[];
  closed: boolean;
  ownerAId: string;
  ownerBId: string;
  ownerType: BooleanOp;
  featureId: string;
  featureLabel: string;
}

export interface Plane3D {
  normal: Vec3; // Unit normal vector (nx, ny, nz)
  d: number;    // Plane equation: n · p + d = 0
  bounds: BoundingBox3D;
}

export interface BackProjectionErrorMetrics {
  view: ViewType;
  solidChamferDist: number;
  falseDashedRatio: number;
  missedDashedRatio: number;
  silhouetteHausdorffDist: number;
  falseHolePrimitiveIds: string[];
  unpairedTaperedBands: TaperedDashedBand[];
  unpairedTaperedVBands: TaperedDashedVBand[];
  hasInvertedArcSilhouette: boolean;
}

export interface VerifiedSolidResult {
  solution: ReconstructedSolution;
  totalErrorScore: number;
  viewMetrics: [BackProjectionErrorMetrics, BackProjectionErrorMetrics];
  healedActions: string[];
}
