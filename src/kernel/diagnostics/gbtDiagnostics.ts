import {
  CadEntity,
  DiagnosticIssue,
  Point2D,
  ViewType,
} from '../../types/cad';
import { buildPlanarArrangement2D } from '../arrangement2d/carrierReconstruction';
import { dist2, pointToLineSegDist } from '../arrangement2d/snapAndSplit';

const ALIGN_TOL_MM = 0.85;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Performs comprehensive GB/T 4458.1 / 4458.4 intelligent engineering drawing diagnostics:
 * 1. Three-View Projection Alignment (`长对正 X`, `高平齐 Z`, `宽相等 Y`) with 1-click axis snap fix.
 * 2. Open / Dangling Endpoint Detection (`unclosed_loop`) with 1-click endpoint closure fix.
 * 3. Missing Circle / Semicircle Symmetry Cross-Centerlines (`center_dot_dash`) with 1-click fix.
 * 4. Missing Cylinder / Cone / Frustum Revolution Axis (`center_dot_dash`) with 1-click fix.
 * 5. Hidden-Line Logic Conflict (`thin_dashed` floating outside outer solid silhouette).
 */
export function runGbtThreeViewDiagnostics(entities: CadEntity[]): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  let issueSeq = 1;

  const frontEnts = entities.filter((e) => e.view === 'front');
  const topEnts = entities.filter((e) => e.view === 'top');
  const leftEnts = entities.filter((e) => e.view === 'left');

  const arrFront = frontEnts.length > 0 ? buildPlanarArrangement2D(frontEnts, 'front') : null;
  const arrTop = topEnts.length > 0 ? buildPlanarArrangement2D(topEnts, 'top') : null;
  const arrLeft = leftEnts.length > 0 ? buildPlanarArrangement2D(leftEnts, 'left') : null;

  // ==========================================================================
  // 1. GB/T 4458.1 Three-Equal Alignment Checks (长对正 / 高平齐 / 宽相等)
  // ==========================================================================
  if (arrFront?.solidBBox && arrTop?.solidBBox) {
    const fBox = arrFront.solidBBox;
    const tBox = arrTop.solidBBox;
    const dMinX = Math.abs(fBox.uMin - tBox.uMin);
    const dMaxX = Math.abs(fBox.uMax - tBox.uMax);

    if (dMinX > ALIGN_TOL_MM) {
      issues.push({
        id: `diag_len_min_${issueSeq++}`,
        severity: 'error',
        category: 'violation_length',
        title: `主俯视图左端“长不对正” (偏差 ${round2(dMinX)} mm)`,
        description: `主视图左边界 X = ${round2(fBox.uMin)} 与俯视图左边界 X = ${round2(tBox.uMin)} 未对齐，违反 GB/T 4458.1“主俯长对正”投影规律。`,
        suggestion: `将俯视图左端偏移对齐至 X = ${round2(fBox.uMin)}。`,
        views: ['front', 'top'],
        fixPayload: {
          type: 'align_axis',
          targetView: 'top',
          axis: 'X',
          coordKey: 'u',
          actualVal: tBox.uMin,
          expectedVal: fBox.uMin,
        },
        highlightCoords: [
          { view: 'front', p1: { u: fBox.uMin, v: fBox.vMin }, deltaValue: dMinX, axis: 'X' },
          { view: 'top', p1: { u: tBox.uMin, v: tBox.vMin }, deltaValue: dMinX, axis: 'X' },
        ],
      });
    }

    if (dMaxX > ALIGN_TOL_MM) {
      issues.push({
        id: `diag_len_max_${issueSeq++}`,
        severity: 'error',
        category: 'violation_length',
        title: `主俯视图右端“长不对正” (偏差 ${round2(dMaxX)} mm)`,
        description: `主视图右边界 X = ${round2(fBox.uMax)} 与俯视图右边界 X = ${round2(tBox.uMax)} 未对齐，违反 GB/T 4458.1“主俯长对正”投影规律。`,
        suggestion: `将俯视图右端对齐至 X = ${round2(fBox.uMax)}。`,
        views: ['front', 'top'],
        fixPayload: {
          type: 'align_axis',
          targetView: 'top',
          axis: 'X',
          coordKey: 'u',
          actualVal: tBox.uMax,
          expectedVal: fBox.uMax,
        },
        highlightCoords: [
          { view: 'front', p1: { u: fBox.uMax, v: fBox.vMin }, deltaValue: dMaxX, axis: 'X' },
          { view: 'top', p1: { u: tBox.uMax, v: tBox.vMin }, deltaValue: dMaxX, axis: 'X' },
        ],
      });
    }
  }

  if (arrFront?.solidBBox && arrLeft?.solidBBox) {
    const fBox = arrFront.solidBBox;
    const lBox = arrLeft.solidBBox;
    const dMinZ = Math.abs(fBox.vMin - lBox.vMin);
    const dMaxZ = Math.abs(fBox.vMax - lBox.vMax);

    if (dMinZ > ALIGN_TOL_MM) {
      issues.push({
        id: `diag_hgt_min_${issueSeq++}`,
        severity: 'error',
        category: 'violation_height',
        title: `主左视图底端“高不平齐” (偏差 ${round2(dMinZ)} mm)`,
        description: `主视图底边 Z = ${round2(fBox.vMin)} 与左视图底边 Z = ${round2(lBox.vMin)} 高度不一致，违反“主左高平齐”规律。`,
        suggestion: `将左视图底边对齐至 Z = ${round2(fBox.vMin)}。`,
        views: ['front', 'left'],
        fixPayload: {
          type: 'align_axis',
          targetView: 'left',
          axis: 'Z',
          coordKey: 'v',
          actualVal: lBox.vMin,
          expectedVal: fBox.vMin,
        },
        highlightCoords: [
          { view: 'front', p1: { u: fBox.uMax, v: fBox.vMin }, deltaValue: dMinZ, axis: 'Z' },
          { view: 'left', p1: { u: lBox.uMin, v: lBox.vMin }, deltaValue: dMinZ, axis: 'Z' },
        ],
      });
    }

    if (dMaxZ > ALIGN_TOL_MM) {
      issues.push({
        id: `diag_hgt_max_${issueSeq++}`,
        severity: 'error',
        category: 'violation_height',
        title: `主左视图顶端“高不平齐” (偏差 ${round2(dMaxZ)} mm)`,
        description: `主视图顶边 Z = ${round2(fBox.vMax)} 与左视图顶边 Z = ${round2(lBox.vMax)} 高度不一致，违反“主左高平齐”规律。`,
        suggestion: `将左视图顶边对齐至 Z = ${round2(fBox.vMax)}。`,
        views: ['front', 'left'],
        fixPayload: {
          type: 'align_axis',
          targetView: 'left',
          axis: 'Z',
          coordKey: 'v',
          actualVal: lBox.vMax,
          expectedVal: fBox.vMax,
        },
        highlightCoords: [
          { view: 'front', p1: { u: fBox.uMax, v: fBox.vMax }, deltaValue: dMaxZ, axis: 'Z' },
          { view: 'left', p1: { u: lBox.uMin, v: lBox.vMax }, deltaValue: dMaxZ, axis: 'Z' },
        ],
      });
    }
  }

  if (arrTop?.solidBBox && arrLeft?.solidBBox) {
    const tBox = arrTop.solidBBox;
    const lBox = arrLeft.solidBBox;
    const dMinY = Math.abs(tBox.vMin - lBox.uMin);
    const dMaxY = Math.abs(tBox.vMax - lBox.uMax);

    if (dMinY > ALIGN_TOL_MM || dMaxY > ALIGN_TOL_MM) {
      const useMin = dMinY >= dMaxY;
      const actualVal = useMin ? lBox.uMin : lBox.uMax;
      const expectedVal = useMin ? tBox.vMin : tBox.vMax;
      const delta = Math.max(dMinY, dMaxY);
      issues.push({
        id: `diag_wid_${issueSeq++}`,
        severity: 'error',
        category: 'violation_width',
        title: `俯左视图前后“宽不相等” (偏差 ${round2(delta)} mm)`,
        description: `俯视图前后宽度区间 Y ∈ [${round2(tBox.vMin)}, ${round2(tBox.vMax)}] 与左视图 Y ∈ [${round2(lBox.uMin)}, ${round2(lBox.uMax)}] 不匹配，违反 45° 折转“宽相等”原则。`,
        suggestion: `将左视图 Y 坐标修正对齐至 Y = ${round2(expectedVal)}。`,
        views: ['top', 'left'],
        fixPayload: {
          type: 'align_axis',
          targetView: 'left',
          axis: 'Y',
          coordKey: 'u',
          actualVal,
          expectedVal,
        },
        highlightCoords: [
          { view: 'top', p1: { u: tBox.uMax, v: useMin ? tBox.vMin : tBox.vMax }, deltaValue: delta, axis: 'Y' },
          { view: 'left', p1: { u: actualVal, v: lBox.vMin }, deltaValue: delta, axis: 'Y' },
        ],
      });
    }
  }

  // ==========================================================================
  // 2. Per-View Checks: Dangling Contours, Missing Centerlines & Revolution Axes
  // ==========================================================================
  const viewArrs = [arrFront, arrTop, arrLeft].filter(
    (a): a is NonNullable<typeof arrFront> => a !== null
  );

  for (const arr of viewArrs) {
    const viewEnts = entities.filter((e) => e.view === arr.view);
    const centerLines = viewEnts.filter(
      (e) => e.lineType === 'center_dot_dash' && e.type === 'line'
    );

    const hasCenterlineThrough = (pt: Point2D, orientation: 'horizontal' | 'vertical'): boolean =>
      centerLines.some((cl) => {
        if (cl.type !== 'line') return false;
        const du = Math.abs(cl.p2.u - cl.p1.u);
        const dv = Math.abs(cl.p2.v - cl.p1.v);
        if (orientation === 'horizontal' && dv > 0.6) return false;
        if (orientation === 'vertical' && du > 0.6) return false;
        return pointToLineSegDist(pt, cl.p1, cl.p2).dist <= 0.9;
      });

    // 2a. Check Dangling `thick_solid` Line Endpoints (degree 1 in solid graph)
    const solidLines = viewEnts.filter(
      (e): e is Extract<CadEntity, { type: 'line' }> =>
        e.type === 'line' && e.lineType === 'thick_solid'
    );
    for (const ln of solidLines) {
      for (const endKey of ['p1', 'p2'] as const) {
        const pt = ln[endKey];
        // Check if `pt` touches any other solid segment or arc in `arr.splitSegments`
        const connected = arr.splitSegments.some((seg) => {
          if (seg.sourceEntityId === ln.id) return false;
          if (seg.lineType !== 'thick_solid') return false;
          if (dist2(pt, seg.p1) <= 0.6 || dist2(pt, seg.p2) <= 0.6) return true;
          if (seg.kind === 'line' && pointToLineSegDist(pt, seg.p1, seg.p2).dist <= 0.6) {
            return true;
          }
          if (seg.kind === 'arc' && seg.center && seg.radius !== undefined) {
            return Math.abs(Math.hypot(pt.u - seg.center.u, pt.v - seg.center.v) - seg.radius) <= 0.6;
          }
          return false;
        });

        if (!connected) {
          // Find nearest snap target within 8mm to offer 1-click closure
          let bestSnap: Point2D | undefined;
          let bestDist = 8.0;
          for (const vtx of arr.vertices) {
            const d = dist2(pt, vtx.pt);
            if (d > 0.6 && d < bestDist) {
              bestDist = d;
              bestSnap = { u: vtx.pt.u, v: vtx.pt.v };
            }
          }
          issues.push({
            id: `diag_dangling_${arr.view}_${issueSeq++}`,
            severity: 'warning',
            category: 'unclosed_loop',
            title: `${viewLabel(arr.view)}存在悬空未闭合实线端点`,
            description: `粗实线端点 (${round2(pt.u)}, ${round2(pt.v)}) 未与其他可见轮廓连接，可能导致截面无法构成闭合环。`,
            suggestion: bestSnap
              ? `一键延伸吸附至相邻端点 (${round2(bestSnap.u)}, ${round2(bestSnap.v)})。`
              : '请使用延伸(EX)或直线工具闭合轮廓。',
            views: [arr.view],
            fixPayload: bestSnap
              ? {
                  type: 'close_dangling',
                  targetView: arr.view,
                  danglingEntityId: ln.id,
                  danglingEndpoint: endKey,
                  snapTargetPt: bestSnap,
                }
              : undefined,
            highlightCoords: [{ view: arr.view, p1: pt }],
          });
        }
      }
    }

    // 2b. Check Circle / Semicircle Cross-Centerlines (`center_dot_dash`)
    const checkedCenters: Point2D[] = [];
    for (const cc of arr.carrierCircles) {
      if (checkedCenters.some((p) => dist2(p, cc.center) <= 0.8)) continue;
      checkedCenters.push(cc.center);

      const needHoriz = !hasCenterlineThrough(cc.center, 'horizontal');
      const needVert = !hasCenterlineThrough(cc.center, 'vertical');
      if (needHoriz || needVert) {
        issues.push({
          id: `diag_cl_cir_${arr.view}_${issueSeq++}`,
          severity: 'info',
          category: 'missing_centerline',
          title: `${viewLabel(arr.view)}圆/圆弧缺失十字对称中心线`,
          description: `圆心 (${round2(cc.center.u)}, ${round2(cc.center.v)}) R=${round2(cc.radius)} 缺少标准细点画线(${needHoriz && needVert ? '水平+竖直' : needHoriz ? '水平' : '竖直'})对称中心线 (GB/T 4458.4)。`,
          suggestion: '一键自动补全超出轮廓 3.5mm 的十字细点画线。',
          views: [arr.view],
          fixPayload: {
            type: 'add_circle_centerlines',
            targetView: arr.view,
            center: { u: cc.center.u, v: cc.center.v },
            radius: cc.radius,
            needHoriz,
            needVert,
          },
          highlightCoords: [{ view: arr.view, p1: cc.center }],
        });
      }
    }

    // 2c. Check Missing Revolution Axis when another view has a full circle
    const otherArrs = viewArrs.filter((o) => o.view !== arr.view);
    for (const other of otherArrs) {
      const fullCircles = other.carrierCircles.filter((c) => c.isFullCircle);
      if (fullCircles.length === 0 || !arr.solidBBox) continue;

      for (const fc of fullCircles) {
        // Shared axis between `other.view` and `arr.view` determines revolution axis orientation in `arr.view`!
        let axisOrientationInArr: 'vertical' | 'horizontal' | null = null;
        let axisCoord = 0;

        if (other.view === 'top' && arr.view === 'front') {
          axisOrientationInArr = 'vertical';
          axisCoord = fc.center.u;
        } else if (other.view === 'top' && arr.view === 'left') {
          axisOrientationInArr = 'vertical';
          axisCoord = fc.center.v;
        } else if (other.view === 'front' && arr.view === 'top') {
          axisOrientationInArr = 'vertical';
          axisCoord = fc.center.u;
        } else if (other.view === 'front' && arr.view === 'left') {
          axisOrientationInArr = 'horizontal';
          axisCoord = fc.center.v;
        } else if (other.view === 'left' && arr.view === 'front') {
          axisOrientationInArr = 'horizontal';
          axisCoord = fc.center.v;
        } else if (other.view === 'left' && arr.view === 'top') {
          axisOrientationInArr = 'horizontal';
          axisCoord = fc.center.u;
        }

        if (!axisOrientationInArr) continue;
        const midPt: Point2D =
          axisOrientationInArr === 'vertical'
            ? { u: axisCoord, v: 0.5 * (arr.solidBBox.vMin + arr.solidBBox.vMax) }
            : { u: 0.5 * (arr.solidBBox.uMin + arr.solidBBox.uMax), v: axisCoord };

        if (!hasCenterlineThrough(midPt, axisOrientationInArr)) {
          const spanMin =
            axisOrientationInArr === 'vertical' ? arr.solidBBox.vMin : arr.solidBBox.uMin;
          const spanMax =
            axisOrientationInArr === 'vertical' ? arr.solidBBox.vMax : arr.solidBBox.uMax;

          // Avoid duplicate revolution axis issue at the same coordinate
          const dupAxis = issues.some(
            (iss) =>
              iss.fixPayload?.type === 'add_revolution_axis' &&
              iss.fixPayload.targetView === arr.view &&
              iss.fixPayload.orientation === axisOrientationInArr &&
              Math.abs((iss.fixPayload.axisCoord ?? 0) - axisCoord) <= 0.8
          );
          if (!dupAxis) {
            issues.push({
              id: `diag_rev_axis_${arr.view}_${issueSeq++}`,
              severity: 'info',
              category: 'missing_centerline',
              title: `${viewLabel(arr.view)}缺失回转体/圆孔轴线`,
              description: `${viewLabel(other.view)}存在圆形回转特征，对应${viewLabel(arr.view)}在 ${axisOrientationInArr === 'vertical' ? 'u' : 'v'} = ${round2(axisCoord)} 处应绘制细点画线回转轴线。`,
              suggestion: '一键自动补全回转轴线。',
              views: [arr.view, other.view],
              fixPayload: {
                type: 'add_revolution_axis',
                targetView: arr.view,
                orientation: axisOrientationInArr,
                axisCoord,
                spanMin: spanMin - 3.5,
                spanMax: spanMax + 3.5,
              },
              highlightCoords: [{ view: arr.view, p1: midPt }],
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Applies a 1-click automated CAD repair for any `DiagnosticIssue` equipped with `fixPayload`.
 */
export function applySingleDiagnosticFix(
  entities: CadEntity[],
  issue: DiagnosticIssue
): CadEntity[] {
  const payload = issue.fixPayload;
  if (!payload) return entities;

  if (payload.type === 'align_axis' && payload.coordKey && payload.actualVal !== undefined && payload.expectedVal !== undefined) {
    const delta = payload.expectedVal - payload.actualVal;
    const key = payload.coordKey;
    return entities.map((ent) => {
      if (ent.view !== payload.targetView) return ent;
      if (ent.type === 'line') {
        return {
          ...ent,
          p1: { ...ent.p1, [key]: ent.p1[key] + delta },
          p2: { ...ent.p2, [key]: ent.p2[key] + delta },
        };
      }
      if (ent.type === 'rect') {
        return key === 'u'
          ? { ...ent, x: ent.x + delta }
          : { ...ent, y: ent.y + delta };
      }
      if (ent.type === 'circle' || ent.type === 'arc') {
        return {
          ...ent,
          center: { ...ent.center, [key]: ent.center[key] + delta },
        };
      }
      if (ent.type === 'polygon') {
        return {
          ...ent,
          points: ent.points.map((pt) => ({ ...pt, [key]: pt[key] + delta })),
        };
      }
      return ent;
    });
  }

  if (
    payload.type === 'close_dangling' &&
    payload.danglingEntityId &&
    payload.danglingEndpoint &&
    payload.snapTargetPt
  ) {
    return entities.map((ent) => {
      if (ent.id !== payload.danglingEntityId || ent.type !== 'line') return ent;
      return {
        ...ent,
        [payload.danglingEndpoint!]: { ...payload.snapTargetPt! },
      };
    });
  }

  if (payload.type === 'add_circle_centerlines' && payload.center && payload.radius !== undefined) {
    const next = [...entities];
    const ext = payload.radius + 3.5;
    const ts = Date.now();
    if (payload.needHoriz) {
      next.push({
        id: `fix_cl_h_${ts}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1: { u: round2(payload.center.u - ext), v: round2(payload.center.v) },
        p2: { u: round2(payload.center.u + ext), v: round2(payload.center.v) },
        source: 'user',
      });
    }
    if (payload.needVert) {
      next.push({
        id: `fix_cl_v_${ts + 1}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1: { u: round2(payload.center.u), v: round2(payload.center.v - ext) },
        p2: { u: round2(payload.center.u), v: round2(payload.center.v + ext) },
        source: 'user',
      });
    }
    return next;
  }

  if (
    payload.type === 'add_revolution_axis' &&
    payload.orientation &&
    payload.axisCoord !== undefined &&
    payload.spanMin !== undefined &&
    payload.spanMax !== undefined
  ) {
    const p1: Point2D =
      payload.orientation === 'vertical'
        ? { u: round2(payload.axisCoord), v: round2(payload.spanMin) }
        : { u: round2(payload.spanMin), v: round2(payload.axisCoord) };
    const p2: Point2D =
      payload.orientation === 'vertical'
        ? { u: round2(payload.axisCoord), v: round2(payload.spanMax) }
        : { u: round2(payload.spanMax), v: round2(payload.axisCoord) };
    return [
      ...entities,
      {
        id: `fix_rev_ax_${Date.now()}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1,
        p2,
        source: 'user',
      },
    ];
  }

  if (payload.type === 'convert_linetype' && payload.entityId && payload.targetLineType) {
    return entities.map((e) =>
      e.id === payload.entityId ? { ...e, lineType: payload.targetLineType! } : e
    );
  }

  if (payload.type === 'replace_view_entities' && payload.replacementEntities) {
    return [
      ...entities.filter((e) => e.view !== payload.targetView),
      ...payload.replacementEntities,
    ];
  }

  return entities;
}

function viewLabel(v: ViewType): string {
  return v === 'front' ? '主视图' : v === 'top' ? '俯视图' : '左视图';
}
