export type ViewType = 'front' | 'top' | 'left';

export type LineType =
  | 'thick_solid'     // 粗实线：可见轮廓线 (GB/T 4458.4)
  | 'thin_dashed'     // 细虚线：不可见轮廓线/内部孔槽
  | 'center_dot_dash' // 细点画线：对称中心线/回转体轴线
  | 'construction';   // 辅助投影线

export type ToolType =
  | 'select'
  | 'pan'
  | 'line'
  | 'rect'
  | 'polygon'
  | 'circle'
  | 'arc'
  | 'tangent'
  | 'trim'
  | 'extend'
  | 'offset'
  | 'erase';

export type SnapType =
  | 'grid'
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'quadrant'
  | 'intersection';

export interface Point2D {
  u: number; // Horizontal axis in the 2D view (Front: X, Top: X, Left: Y)
  v: number; // Vertical axis in the 2D view (Front: Z, Top: Y, Left: Z)
}

export interface SnapResult {
  point: Point2D;
  type: SnapType;
  label: string;
  entityId?: string;
}

export interface CadLineEntity {
  id: string;
  view: ViewType;
  type: 'line';
  lineType: LineType;
  p1: Point2D;
  p2: Point2D;
  source?: 'user' | 'derived' | 'template';
  featureId?: string;
  featureLabel?: string;
}

export interface CadRectEntity {
  id: string;
  view: ViewType;
  type: 'rect';
  lineType: LineType;
  x: number; // min u
  y: number; // min v
  width: number;
  height: number;
  source?: 'user' | 'derived' | 'template';
  featureId?: string;
  featureLabel?: string;
}

export interface CadCircleEntity {
  id: string;
  view: ViewType;
  type: 'circle';
  lineType: LineType;
  center: Point2D;
  radius: number;
  source?: 'user' | 'derived' | 'template';
  featureId?: string;
  featureLabel?: string;
}

export interface CadArcEntity {
  id: string;
  view: ViewType;
  type: 'arc';
  lineType: LineType;
  center: Point2D;
  radius: number;
  startAngle: number; // radians
  endAngle: number;   // radians
  source?: 'user' | 'derived' | 'template';
  featureId?: string;
  featureLabel?: string;
}

export interface CadPolygonEntity {
  id: string;
  view: ViewType;
  type: 'polygon';
  lineType: LineType;
  points: Point2D[];
  closed: boolean;
  source?: 'user' | 'derived' | 'template';
  featureId?: string;
  featureLabel?: string;
}

export type CadEntity =
  | CadLineEntity
  | CadRectEntity
  | CadCircleEntity
  | CadArcEntity
  | CadPolygonEntity;

export interface LoopCurveSegment2D {
  kind: 'line' | 'arc';
  p1: Point2D;
  p2: Point2D;
  center?: Point2D;
  radius?: number;
  startAngle?: number; // original CCW startAngle of the CadArcEntity
  endAngle?: number;   // original CCW endAngle of the CadArcEntity
  ccw?: boolean;       // true if p1 -> p2 traverses from startAngle to endAngle CCW, false if CW
}

export interface Primitive3D {
  id: string;
  featureId: string;
  label: string;
  operation: 'add' | 'subtract' | 'intersect';
  shape:
    | 'box'
    | 'cylinder_x'
    | 'cylinder_y'
    | 'cylinder_z'
    | 'sphere'
    | 'hemisphere'
    | 'cone_x'
    | 'cone_y'
    | 'cone_z'
    | 'pyramid'
    | 'wedge_x'
    | 'wedge_y'
    | 'rib_xz'
    | 'prism'
    | 'plane_sheet'
    | 'generalized_loft';
  // Bounding box or center parameters in engineering space X:[0,120], Y:[0,120], Z:[0,120]
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  radius?: number;
  rMin?: number;
  rMax?: number;
  centerX?: number;
  centerY?: number;
  centerZ?: number;
  uCenterMin?: number;
  vCenterMin?: number;
  uCenterMax?: number;
  vCenterMax?: number;
  apex3D?: [number, number, number];
  pyramidTopScale?: number;
  vertices3D?: [number, number, number][];
  prismAxis?: 'X' | 'Y' | 'Z';
  extrudeAxis?: 'x' | 'y' | 'z';
  prismPolygon?: Point2D[];
  polygon2D?: Point2D[];
  prismSegments?: LoopCurveSegment2D[];
  isInternalFeature?: boolean; // True for holes, slots, blind holes (used in X-Ray mode)
  isInsideLoopContour?: boolean;
}

export interface ProjectionStep {
  id: string;
  stepNumber: number;
  title: string;
  rule: '长对正 (X轴对齐)' | '高平齐 (Z轴对齐)' | '宽相等 (Y轴45°折转)';
  description: string;
  sourceView1: ViewType;
  sourcePt1: Point2D;
  sourceView2: ViewType;
  sourcePt2: Point2D;
  targetView: ViewType;
  targetPt: Point2D;
  entityId?: string;
  lineType: LineType;
}

export interface ReconstructedSolution {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  confidence: string;
  primitives3D: Primitive3D[];
  derivedEntities: CadEntity[]; // Entities for the target view (or all views)
  projectionSteps: ProjectionStep[];
}

export interface DiagnosticFixPayload {
  type:
    | 'align_axis'
    | 'add_missing_hidden_hole'
    | 'add_circle_centerlines'
    | 'add_revolution_axis'
    | 'close_dangling'
    | 'convert_linetype'
    | 'replace_view_entities';
  targetView: ViewType;
  axis?: 'X' | 'Y' | 'Z';
  coordKey?: 'u' | 'v';
  actualVal?: number;
  expectedVal?: number;
  holeCenterU?: number;
  holeRadius?: number;
  spanMin?: number;
  spanMax?: number;
  center?: Point2D;
  radius?: number;
  needHoriz?: boolean;
  needVert?: boolean;
  orientation?: 'vertical' | 'horizontal';
  axisCoord?: number;
  danglingEntityId?: string;
  danglingEndpoint?: 'p1' | 'p2';
  snapTargetPt?: Point2D;
  entityId?: string;
  targetLineType?: LineType;
  replacementEntities?: CadEntity[];
}

export interface DiagnosticIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category:
    | 'violation_length' // 主俯长不对正
    | 'violation_height' // 主左高不平齐
    | 'violation_width'  // 俯左宽不相等
    | 'unclosed_loop'    // 拓扑未闭合/悬空线
    | 'hidden_conflict'  // 虚实线逻辑冲突
    | 'missing_centerline' // 缺失中心线/回转轴线
    | 'under_constrained'; // 欠约束多解
  title: string;
  description: string;
  suggestion: string;
  views: ViewType[];
  fixPayload?: DiagnosticFixPayload;
  highlightCoords?: {
    view: ViewType;
    p1: Point2D;
    p2?: Point2D;
    deltaValue?: number;
    axis?: 'X' | 'Y' | 'Z';
  }[];
}

export interface GradingItem {
  entityId: string;
  status: 'correct' | 'missing' | 'extra' | 'wrong_linetype';
  description: string;
  entity: CadEntity;
}

export interface GradingReport {
  targetView: ViewType;
  score: number;
  totalStandardLines: number;
  matchedCount: number;
  missingCount: number;
  extraCount: number;
  wrongLineTypeCount: number;
  summary: string;
  items: GradingItem[];
}

export interface PresetCase {
  id: string;
  name: string;
  category: 'classic' | 'ambiguous' | 'diagnostic';
  badge: string;
  description: string;
  knownViews: [ViewType, ViewType];
  targetView: ViewType;
  entities: CadEntity[];
  solutions: ReconstructedSolution[];
  precomputedDiagnostics?: DiagnosticIssue[];
}
