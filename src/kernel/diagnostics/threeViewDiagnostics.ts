import {
  CadEntity,
  DiagnosticIssue,
  Point2D,
  ViewType,
} from '../../types/cad';
import { buildViewArrangementAndCarriers } from '../arrangement2d/carrierGraph';
import { arcSweepCCW, dist2 } from '../core/coordSystem';
import { ViewArrangementResult } from '../core/types';
import { solve2DTo3DVolumeCSP } from '../solver/volumeCSPSolver';

type LangCode = 'zh-CN' | 'zh-TW' | 'en';

function tr(
  lang: LangCode,
  zhCN: string,
  zhTW: string,
  en: string
): string {
  if (lang === 'zh-TW') return zhTW;
  if (lang === 'en') return en;
  return zhCN;
}

/**
 * Facade #2: GB/T 4458.1 & GB/T 4458.4 Comprehensive Three-View Intelligent Diagnostics:
 * 1. Three-Equal Projection Laws (`violation_length` Front-Top ΔX, `violation_height` Front-Left ΔZ, `violation_width` Top-Left ΔY)
 * 2. Dangling / Unclosed Loop Endpoints (`unclosed_loop`)
 * 3. Hidden / Visible Line Logic Conflicts (`hidden_conflict` — e.g. missing hidden bore dashed lines or outer contour drawn as dashed)
 * 4. Missing Circle Crosshair Centerlines & Revolution Axes (`missing_centerline`)
 * 5. Under-Constrained Multi-Solution Ambiguity (`under_constrained`)
 */
export function diagnoseThreeViews(
  entities: CadEntity[],
  knownViews?: [ViewType, ViewType],
  lang: LangCode = 'zh-CN'
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  let seq = 1;

  const arrFront = buildViewArrangementAndCarriers(entities, 'front');
  const arrTop = buildViewArrangementAndCarriers(entities, 'top');
  const arrLeft = buildViewArrangementAndCarriers(entities, 'left');

  const ALIGN_TOL = 0.65;

  // ==========================================================================
  // 1. GB/T 4458.1 Three-Equal Alignment Checks ("长对正、高平齐、宽相等")
  // ==========================================================================
  if (arrFront.bounds && arrTop.bounds) {
    const dxMin = Math.abs(arrFront.bounds.uMin - arrTop.bounds.uMin);
    const dxMax = Math.abs(arrFront.bounds.uMax - arrTop.bounds.uMax);
    if (dxMin > ALIGN_TOL || dxMax > ALIGN_TOL) {
      const useMax = dxMax >= dxMin;
      const actualVal = useMax ? arrTop.bounds.uMax : arrTop.bounds.uMin;
      const expectedVal = useMax ? arrFront.bounds.uMax : arrFront.bounds.uMin;
      const delta = Number(Math.abs(actualVal - expectedVal).toFixed(2));
      issues.push({
        id: `diag_len_${seq++}`,
        severity: 'error',
        category: 'violation_length',
        title: tr(
          lang,
          `违反“长对正”原则（X 向偏差 ${delta}mm）`,
          `違反「長對正」原則（X 向偏差 ${delta}mm）`,
          `Length Alignment Violation (ΔX = ${delta}mm)`
        ),
        description: tr(
          lang,
          `主视图 X 跨度 [${arrFront.bounds.uMin.toFixed(1)}, ${arrFront.bounds.uMax.toFixed(1)}] 与俯视图 X 跨度 [${arrTop.bounds.uMin.toFixed(1)}, ${arrTop.bounds.uMax.toFixed(1)}] 未对齐。`,
          `主視圖 X 跨度 [${arrFront.bounds.uMin.toFixed(1)}, ${arrFront.bounds.uMax.toFixed(1)}] 與俯視圖 X 跨度 [${arrTop.bounds.uMin.toFixed(1)}, ${arrTop.bounds.uMax.toFixed(1)}] 未對齊。`,
          `Front view X span [${arrFront.bounds.uMin.toFixed(1)}, ${arrFront.bounds.uMax.toFixed(1)}] does not match Top view X span [${arrTop.bounds.uMin.toFixed(1)}, ${arrTop.bounds.uMax.toFixed(1)}].`
        ),
        suggestion: tr(
          lang,
          `将俯视图边界 u = ${actualVal.toFixed(1)} 平移/对齐至 X = ${expectedVal.toFixed(1)}。`,
          `將俯視圖邊界 u = ${actualVal.toFixed(1)} 平移/對齊至 X = ${expectedVal.toFixed(1)}。`,
          `Align Top view boundary u = ${actualVal.toFixed(1)} to X = ${expectedVal.toFixed(1)}.`
        ),
        views: ['front', 'top'],
        fixPayload: {
          type: 'align_axis',
          targetView: 'top',
          axis: 'X',
          coordKey: 'u',
          actualVal,
          expectedVal,
        },
        highlightCoords: [
          {
            view: 'front',
            p1: { u: expectedVal, v: arrFront.bounds.vMin },
            p2: { u: expectedVal, v: arrFront.bounds.vMax },
            deltaValue: delta,
            axis: 'X',
          },
          {
            view: 'top',
            p1: { u: actualVal, v: arrTop.bounds.vMin },
            p2: { u: actualVal, v: arrTop.bounds.vMax },
            deltaValue: delta,
            axis: 'X',
          },
        ],
      });
    }
  }

  if (arrFront.bounds && arrLeft.bounds) {
    const dzMin = Math.abs(arrFront.bounds.vMin - arrLeft.bounds.vMin);
    const dzMax = Math.abs(arrFront.bounds.vMax - arrLeft.bounds.vMax);
    if (dzMin > ALIGN_TOL || dzMax > ALIGN_TOL) {
      const useMax = dzMax >= dzMin;
      const actualVal = useMax ? arrLeft.bounds.vMax : arrLeft.bounds.vMin;
      const expectedVal = useMax ? arrFront.bounds.vMax : arrFront.bounds.vMin;
      const delta = Number(Math.abs(actualVal - expectedVal).toFixed(2));
      issues.push({
        id: `diag_hgt_${seq++}`,
        severity: 'error',
        category: 'violation_height',
        title: tr(
          lang,
          `违反“高平齐”原则（Z 向偏差 ${delta}mm）`,
          `違反「高平齊」原則（Z 向偏差 ${delta}mm）`,
          `Height Alignment Violation (ΔZ = ${delta}mm)`
        ),
        description: tr(
          lang,
          `主视图高度跨度 [${arrFront.bounds.vMin.toFixed(1)}, ${arrFront.bounds.vMax.toFixed(1)}] 与左视图高度跨度 [${arrLeft.bounds.vMin.toFixed(1)}, ${arrLeft.bounds.vMax.toFixed(1)}] 不一致。`,
          `主視圖高度跨度 [${arrFront.bounds.vMin.toFixed(1)}, ${arrFront.bounds.vMax.toFixed(1)}] 與左視圖高度跨度 [${arrLeft.bounds.vMin.toFixed(1)}, ${arrLeft.bounds.vMax.toFixed(1)}] 不一致。`,
          `Front view Z span [${arrFront.bounds.vMin.toFixed(1)}, ${arrFront.bounds.vMax.toFixed(1)}] mismatches Left view Z span [${arrLeft.bounds.vMin.toFixed(1)}, ${arrLeft.bounds.vMax.toFixed(1)}].`
        ),
        suggestion: tr(
          lang,
          `将左视图高度 v = ${actualVal.toFixed(1)} 对齐至主视图 Z = ${expectedVal.toFixed(1)}。`,
          `將左視圖高度 v = ${actualVal.toFixed(1)} 對齊至主視圖 Z = ${expectedVal.toFixed(1)}。`,
          `Align Left view height v = ${actualVal.toFixed(1)} to Z = ${expectedVal.toFixed(1)}.`
        ),
        views: ['front', 'left'],
        fixPayload: {
          type: 'align_axis',
          targetView: 'left',
          axis: 'Z',
          coordKey: 'v',
          actualVal,
          expectedVal,
        },
        highlightCoords: [
          {
            view: 'front',
            p1: { u: arrFront.bounds.uMin, v: expectedVal },
            p2: { u: arrFront.bounds.uMax, v: expectedVal },
            deltaValue: delta,
            axis: 'Z',
          },
          {
            view: 'left',
            p1: { u: arrLeft.bounds.uMin, v: actualVal },
            p2: { u: arrLeft.bounds.uMax, v: actualVal },
            deltaValue: delta,
            axis: 'Z',
          },
        ],
      });
    }
  }

  if (arrTop.bounds && arrLeft.bounds) {
    const dyMin = Math.abs(arrTop.bounds.vMin - arrLeft.bounds.uMin);
    const dyMax = Math.abs(arrTop.bounds.vMax - arrLeft.bounds.uMax);
    if (dyMin > ALIGN_TOL || dyMax > ALIGN_TOL) {
      const useMax = dyMax >= dyMin;
      const actualVal = useMax ? arrLeft.bounds.uMax : arrLeft.bounds.uMin;
      const expectedVal = useMax ? arrTop.bounds.vMax : arrTop.bounds.vMin;
      const delta = Number(Math.abs(actualVal - expectedVal).toFixed(2));
      issues.push({
        id: `diag_wid_${seq++}`,
        severity: 'error',
        category: 'violation_width',
        title: tr(
          lang,
          `违反“宽相等”原则（Y 向 45° 折转偏差 ${delta}mm）`,
          `違反「寬相等」原則（Y 向 45° 折轉偏差 ${delta}mm）`,
          `Width Miter Violation (ΔY = ${delta}mm)`
        ),
        description: tr(
          lang,
          `俯视图前后宽度 [${arrTop.bounds.vMin.toFixed(1)}, ${arrTop.bounds.vMax.toFixed(1)}] 与左视图前后宽度 [${arrLeft.bounds.uMin.toFixed(1)}, ${arrLeft.bounds.uMax.toFixed(1)}] 不相等。`,
          `俯視圖前後寬度 [${arrTop.bounds.vMin.toFixed(1)}, ${arrTop.bounds.vMax.toFixed(1)}] 與左視圖前後寬度 [${arrLeft.bounds.uMin.toFixed(1)}, ${arrLeft.bounds.uMax.toFixed(1)}] 不相等。`,
          `Top view Y depth [${arrTop.bounds.vMin.toFixed(1)}, ${arrTop.bounds.vMax.toFixed(1)}] mismatches Left view Y depth [${arrLeft.bounds.uMin.toFixed(1)}, ${arrLeft.bounds.uMax.toFixed(1)}].`
        ),
        suggestion: tr(
          lang,
          `经 45° 辅助折线将左视图 u = ${actualVal.toFixed(1)} 修正至 Y = ${expectedVal.toFixed(1)}。`,
          `經 45° 輔助折線將左視圖 u = ${actualVal.toFixed(1)} 修正至 Y = ${expectedVal.toFixed(1)}。`,
          `Align Left view u = ${actualVal.toFixed(1)} to Y = ${expectedVal.toFixed(1)} via 45° miter.`
        ),
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
          {
            view: 'top',
            p1: { u: arrTop.bounds.uMin, v: expectedVal },
            p2: { u: arrTop.bounds.uMax, v: expectedVal },
            deltaValue: delta,
            axis: 'Y',
          },
          {
            view: 'left',
            p1: { u: actualVal, v: arrLeft.bounds.vMin },
            p2: { u: actualVal, v: arrLeft.bounds.vMax },
            deltaValue: delta,
            axis: 'Y',
          },
        ],
      });
    }
  }

  // ==========================================================================
  // 2. Unclosed Loop / Dangling Endpoint Detection (`unclosed_loop`)
  // ==========================================================================
  for (const arr of [arrFront, arrTop, arrLeft]) {
    const lineEnts = arr.rawEntities.filter(
      (e) =>
        e.type === 'line' &&
        (e.lineType === 'thick_solid' || e.lineType === 'thin_dashed')
    );
    if (lineEnts.length === 0) continue;

    // Collect all topological vertices in this view (splitSegments endpoints + circle/arc rims)
    const allEndpoints: { pt: Point2D; entId: string; which: 'p1' | 'p2' }[] = [];
    for (const le of lineEnts) {
      if (le.type === 'line') {
        allEndpoints.push({ pt: le.p1, entId: le.id, which: 'p1' });
        allEndpoints.push({ pt: le.p2, entId: le.id, which: 'p2' });
      }
    }

    for (const ep of allEndpoints) {
      // Check if `ep.pt` touches at least one OTHER segment or circle/arc within 0.45mm
      const connected = arr.splitSegments.some((seg) => {
        if (seg.sourceEntityId === ep.entId) return false;
        if (dist2(ep.pt, seg.p1) <= 0.45 || dist2(ep.pt, seg.p2) <= 0.45) {
          return true;
        }
        if (seg.kind === 'arc' && seg.center && seg.radius !== undefined) {
          return Math.abs(dist2(ep.pt, seg.center) - seg.radius) <= 0.5;
        }
        return false;
      });
      if (connected) continue;

      // Find nearest snap target within [0.5mm, 8.0mm]
      let bestTarget: Point2D | null = null;
      let bestD = 8.0;
      for (const other of allEndpoints) {
        if (other.entId === ep.entId) continue;
        const d = dist2(ep.pt, other.pt);
        if (d > 0.45 && d < bestD) {
          bestD = d;
          bestTarget = other.pt;
        }
      }

      if (bestTarget) {
        issues.push({
          id: `diag_unclosed_${seq++}`,
          severity: 'error',
          category: 'unclosed_loop',
          title: tr(
            lang,
            `视图轮廓未闭合（悬空端点间隙 ${bestD.toFixed(2)}mm）`,
            `視圖輪廓未閉合（懸空端點間隙 ${bestD.toFixed(2)}mm）`,
            `Unclosed Loop / Dangling Endpoint (Gap ${bestD.toFixed(2)}mm)`
          ),
          description: tr(
            lang,
            `图元 ${ep.entId} 的端点 (${ep.pt.u.toFixed(1)}, ${ep.pt.v.toFixed(1)}) 处于悬空状态，导致二维区域拓扑无法闭合。`,
            `圖元 ${ep.entId} 的端點 (${ep.pt.u.toFixed(1)}, ${ep.pt.v.toFixed(1)}) 處於懸空狀態，導致二維區域拓撲無法閉合。`,
            `Endpoint (${ep.pt.u.toFixed(1)}, ${ep.pt.v.toFixed(1)}) of ${ep.entId} is dangling.`
          ),
          suggestion: tr(
            lang,
            `将悬空端点自动吸附闭合至邻近顶点 (${bestTarget.u.toFixed(1)}, ${bestTarget.v.toFixed(1)})。`,
            `將懸空端點自動吸附閉合至鄰近頂點 (${bestTarget.u.toFixed(1)}, ${bestTarget.v.toFixed(1)})。`,
            `Snap dangling endpoint to (${bestTarget.u.toFixed(1)}, ${bestTarget.v.toFixed(1)}).`
          ),
          views: [arr.view],
          fixPayload: {
            type: 'close_dangling',
            targetView: arr.view,
            danglingEntityId: ep.entId,
            danglingEndpoint: ep.which,
            snapTargetPt: bestTarget,
          },
          highlightCoords: [
            {
              view: arr.view,
              p1: ep.pt,
              p2: bestTarget,
            },
          ],
        });
        break; // Report primary unclosed gap per view cleanly
      }
    }
  }

  // ==========================================================================
  // 3. Hidden / Solid Line Logic Conflict (`hidden_conflict`)
  //    a) Inner circle hole in Top/Front/Left missing matching hidden dashed lines in an adjacent drawn view
  //    b) Extreme outer boundary line erroneously drawn as `thin_dashed`
  // ==========================================================================
  checkMissingHiddenHoleInAdjacentViews(
    arrTop,
    arrFront,
    arrLeft,
    lang,
    issues,
    () => seq++
  );

  for (const arr of [arrFront, arrTop, arrLeft]) {
    if (!arr.bounds) continue;
    for (const ent of arr.rawEntities) {
      if (ent.type === 'line' && ent.lineType === 'thin_dashed') {
        const onExtremeBorder =
          (Math.abs(ent.p1.u - arr.bounds.uMin) < 0.3 &&
            Math.abs(ent.p2.u - arr.bounds.uMin) < 0.3) ||
          (Math.abs(ent.p1.u - arr.bounds.uMax) < 0.3 &&
            Math.abs(ent.p2.u - arr.bounds.uMax) < 0.3) ||
          (Math.abs(ent.p1.v - arr.bounds.vMin) < 0.3 &&
            Math.abs(ent.p2.v - arr.bounds.vMin) < 0.3) ||
          (Math.abs(ent.p1.v - arr.bounds.vMax) < 0.3 &&
            Math.abs(ent.p2.v - arr.bounds.vMax) < 0.3);
        // Only flag if there is NO solid segment along that same extreme border!
        if (onExtremeBorder) {
          const hasSolidCollinear = arr.splitSegments.some(
            (s) =>
              s.lineType === 'thick_solid' &&
              dist2(s.p1, ent.p1) < 1.0 &&
              dist2(s.p2, ent.p2) < 1.0
          );
          if (!hasSolidCollinear) {
            issues.push({
              id: `diag_hid_outer_${seq++}`,
              severity: 'error',
              category: 'hidden_conflict',
              title: tr(
                lang,
                '外轮廓极值边界误画为细虚线',
                '外輪廓極值邊界誤畫為細虛線',
                'Extreme Outer Contour Drawn as Dashed Line'
              ),
              description: tr(
                lang,
                `视图最外侧边界 (${ent.id}) 无任何前景遮挡物，按 GB/T 4458.4 必须采用粗实线绘制。`,
                `視圖最外側邊界 (${ent.id}) 無任何前景遮擋物，按 GB/T 4458.4 必須採用粗實線繪製。`,
                `Extreme outer boundary (${ent.id}) has no foreground occluder and must be a thick solid line.`
              ),
              suggestion: tr(
                lang,
                '将该外边界细虚线转换为粗实线（thick_solid）。',
                '將該外邊界細虛線轉換為粗實線（thick_solid）。',
                'Convert outer boundary dashed line to thick_solid.'
              ),
              views: [arr.view],
              fixPayload: {
                type: 'convert_linetype',
                targetView: arr.view,
                entityId: ent.id,
                targetLineType: 'thick_solid',
              },
              highlightCoords: [{ view: arr.view, p1: ent.p1, p2: ent.p2 }],
            });
          }
        }
      }
    }
  }

  // ==========================================================================
  // 4. Missing Circle Crosshair Centerlines (`missing_centerline`)
  // ==========================================================================
  for (const arr of [arrFront, arrTop, arrLeft]) {
    for (const ent of arr.rawEntities) {
      if (ent.type === 'circle' || ent.type === 'arc') {
        if (
          ent.type === 'arc' &&
          arcSweepCCW(ent.startAngle, ent.endAngle) < Math.PI - 0.08
        ) {
          continue;
        }
        const hasHorizCL = arr.centerlineEntities.some(
          (cl) =>
            cl.type === 'line' &&
            Math.abs(cl.p1.v - cl.p2.v) < 0.5 &&
            Math.abs(cl.p1.v - ent.center.v) <= 1.0 &&
            Math.min(cl.p1.u, cl.p2.u) <= ent.center.u &&
            Math.max(cl.p1.u, cl.p2.u) >= ent.center.u
        );
        const hasVertCL = arr.centerlineEntities.some(
          (cl) =>
            cl.type === 'line' &&
            Math.abs(cl.p1.u - cl.p2.u) < 0.5 &&
            Math.abs(cl.p1.u - ent.center.u) <= 1.0 &&
            Math.min(cl.p1.v, cl.p2.v) <= ent.center.v &&
            Math.max(cl.p1.v, cl.p2.v) >= ent.center.v
        );
        if (!hasHorizCL || !hasVertCL) {
          issues.push({
            id: `diag_cl_${seq++}`,
            severity: 'warning',
            category: 'missing_centerline',
            title: tr(
              lang,
              '圆/圆弧特征缺失十字细点画线中心线',
              '圓/圓弧特徵缺失十字細點畫線中心線',
              'Missing Crosshair Centerlines on Circular Feature'
            ),
            description: tr(
              lang,
              `依据 GB/T 4458.4 制图规范，圆孔或圆柱端面圆心 (${ent.center.u.toFixed(1)}, ${ent.center.v.toFixed(1)}) 应绘制超出轮廓约 3~5mm 的水平与铅垂细点画线。`,
              `依據 GB/T 4458.4 製圖規範，圓孔或圓柱端面圓心 (${ent.center.u.toFixed(1)}, ${ent.center.v.toFixed(1)}) 應繪製超出輪廓約 3~5mm 的水平與鉛垂細點畫線。`,
              `Circular feature at (${ent.center.u.toFixed(1)}, ${ent.center.v.toFixed(1)}) requires orthogonal crosshair centerlines per GB/T 4458.4.`
            ),
            suggestion: tr(
              lang,
              '一键补全该圆特征的标准十字对称中心线。',
              '一鍵補全該圓特徵的標準十字對稱中心線。',
              'Add orthogonal crosshair centerlines.'
            ),
            views: [arr.view],
            fixPayload: {
              type: 'add_circle_centerlines',
              targetView: arr.view,
              center: ent.center,
              radius: ent.radius,
              needHoriz: !hasHorizCL,
              needVert: !hasVertCL,
            },
            highlightCoords: [{ view: arr.view, p1: ent.center }],
          });
        }
      }
    }
  }

  // ==========================================================================
  // 5. Under-Constrained Multi-Solution Warning (`under_constrained`)
  // ==========================================================================
  const nonEmptyViews = (['front', 'top', 'left'] as ViewType[]).filter(
    (v) =>
      entities.some(
        (e) =>
          e.view === v &&
          (e.lineType === 'thick_solid' || e.lineType === 'thin_dashed')
      )
  );
  if (nonEmptyViews.length === 2 || knownViews) {
    const kv: [ViewType, ViewType] =
      knownViews ?? [nonEmptyViews[0] ?? 'front', nonEmptyViews[1] ?? 'top'];
    const sols = solve2DTo3DVolumeCSP(entities, kv);
    if (sols.length > 1) {
      issues.push({
        id: `diag_ambig_${seq++}`,
        severity: 'info',
        category: 'under_constrained',
        title: tr(
          lang,
          `检测到欠约束真多解（共 ${sols.length} 种合法三维构型）`,
          `檢測到欠約束真多解（共 ${sols.length} 種合法三維構型）`,
          `Under-Constrained Views (${sols.length} Valid 3D Solutions)`
        ),
        description: tr(
          lang,
          `当前已知两视图缺少第三视图或回转中心线唯一锁定约束，存在 ${sols.length} 种在已知视图上重投影完全一致的合法三维实体构型。`,
          `當前已知兩視圖缺少第三視圖或迴轉中心線唯一鎖定約束，存在 ${sols.length} 種在已知視圖上重投影完全一致的合法三維實體構型。`,
          `Current two views admit ${sols.length} distinct 3D solids with identical reprojections.`
        ),
        suggestion: tr(
          lang,
          '可在顶部多解切换栏对比各候选构型，或补充第三视图/细点画线消除二义性。',
          '可在頂部多解切換欄對比各候選構型，或補充第三視圖/細點畫線消除二義性。',
          'Compare candidate solutions in the toolbar or add centerlines / third-view constraints.'
        ),
        views: kv,
      });
    }
  }

  return issues;
}

function checkMissingHiddenHoleInAdjacentViews(
  arrTop: ViewArrangementResult,
  arrFront: ViewArrangementResult,
  arrLeft: ViewArrangementResult,
  lang: LangCode,
  issues: DiagnosticIssue[],
  nextSeq: () => number
): void {
  // If Top has an inner circle `nestingDepth >= 1` and Front/Left is drawn, check that matching dashed lines exist!
  for (const vc of arrTop.circleCarriers) {
    if (vc.nestingDepth < 1) continue;
    // Check Front (u = X = vc.center.u ± vc.radius)
    if (arrFront.bounds && arrFront.splitSegments.length > 0) {
      const u1 = vc.center.u - vc.radius;
      const u2 = vc.center.u + vc.radius;
      const hasFeatureInFront = arrFront.lineCarriers.some(
        (lc) =>
          lc.isVertical &&
          (Math.abs((lc.coordConst ?? -999) - u1) <= 1.2 ||
            Math.abs((lc.coordConst ?? -999) - u2) <= 1.2)
      );
      if (!hasFeatureInFront) {
        const id = nextSeq();
        issues.push({
          id: `diag_hid_hole_f_${id}`,
          severity: 'error',
          category: 'hidden_conflict',
          title: tr(
            lang,
            '主视图漏画内圆通孔不可见细虚线轮廓',
            '主視圖漏畫內圓通孔不可見細虛線輪廓',
            'Missing Hidden Bore Dashed Lines in Front View'
          ),
          description: tr(
            lang,
            `俯视图存在圆心 X = ${vc.center.u.toFixed(1)}、半径 R${vc.radius.toFixed(1)} 的内部圆孔，但主视图对应位置缺失转向母线细虚线。`,
            `俯視圖存在圓心 X = ${vc.center.u.toFixed(1)}、半徑 R${vc.radius.toFixed(1)} 的內部圓孔，但主視圖對應位置缺失轉向母線細虛線。`,
            `Top view contains an internal hole at X = ${vc.center.u.toFixed(1)} (R${vc.radius.toFixed(1)}), but Front view lacks matching hidden dashed lines.`
          ),
          suggestion: tr(
            lang,
            `在主视图 u = ${u1.toFixed(1)} 与 u = ${u2.toFixed(1)} 处补全铅垂细虚线及中心线。`,
            `在主視圖 u = ${u1.toFixed(1)} 與 u = ${u2.toFixed(1)} 處補全鉛垂細虛線及中心線。`,
            `Add vertical hidden dashed lines at u = ${u1.toFixed(1)} and u = ${u2.toFixed(1)} in Front view.`
          ),
          views: ['top', 'front'],
          fixPayload: {
            type: 'add_missing_hidden_hole',
            targetView: 'front',
            holeCenterU: vc.center.u,
            holeRadius: vc.radius,
            spanMin: arrFront.bounds.vMin,
            spanMax: arrFront.bounds.vMax,
          },
          highlightCoords: [
            { view: 'top', p1: vc.center },
            {
              view: 'front',
              p1: { u: vc.center.u, v: arrFront.bounds.vMin },
              p2: { u: vc.center.u, v: arrFront.bounds.vMax },
            },
          ],
        });
      }
    }

    // Check Left (u = Y = vc.center.v ± vc.radius)
    if (arrLeft.bounds && arrLeft.splitSegments.length > 0) {
      const u1 = vc.center.v - vc.radius;
      const u2 = vc.center.v + vc.radius;
      const hasFeatureInLeft = arrLeft.lineCarriers.some(
        (lc) =>
          lc.isVertical &&
          (Math.abs((lc.coordConst ?? -999) - u1) <= 1.2 ||
            Math.abs((lc.coordConst ?? -999) - u2) <= 1.2)
      );
      if (!hasFeatureInLeft) {
        const id = nextSeq();
        issues.push({
          id: `diag_hid_hole_l_${id}`,
          severity: 'error',
          category: 'hidden_conflict',
          title: tr(
            lang,
            '左视图漏画铅垂通孔不可见细虚线轮廓',
            '左視圖漏畫鉛垂通孔不可見細虛線輪廓',
            'Missing Hidden Bore Dashed Lines in Left View'
          ),
          description: tr(
            lang,
            `俯视图存在圆心 Y = ${vc.center.v.toFixed(1)}、半径 R${vc.radius.toFixed(1)} 的内部圆孔，但左视图对应位置缺失铅垂细虚线。`,
            `俯視圖存在圓心 Y = ${vc.center.v.toFixed(1)}、半徑 R${vc.radius.toFixed(1)} 的內部圓孔，但左視圖對應位置缺失鉛垂細虛線。`,
            `Top view contains an internal hole at Y = ${vc.center.v.toFixed(1)} (R${vc.radius.toFixed(1)}), but Left view lacks matching hidden dashed lines.`
          ),
          suggestion: tr(
            lang,
            `在左视图 u = ${u1.toFixed(1)} 与 u = ${u2.toFixed(1)} 处补全铅垂细虚线及中心线。`,
            `在左視圖 u = ${u1.toFixed(1)} 與 u = ${u2.toFixed(1)} 處補全鉛垂細虛線及中心線。`,
            `Add vertical hidden dashed lines at u = ${u1.toFixed(1)} and u = ${u2.toFixed(1)} in Left view.`
          ),
          views: ['top', 'left'],
          fixPayload: {
            type: 'add_missing_hidden_hole',
            targetView: 'left',
            holeCenterU: vc.center.v,
            holeRadius: vc.radius,
            spanMin: arrLeft.bounds.vMin,
            spanMax: arrLeft.bounds.vMax,
          },
          highlightCoords: [
            { view: 'top', p1: vc.center },
            {
              view: 'left',
              p1: { u: vc.center.v, v: arrLeft.bounds.vMin },
              p2: { u: vc.center.v, v: arrLeft.bounds.vMax },
            },
          ],
        });
      }
    }
  }
}

/**
 * Facade #3: Apply an exact non-destructive geometric fix for a single `DiagnosticIssue`.
 */
export function fixSingleDiagnosticIssue(
  issue: DiagnosticIssue,
  entities: CadEntity[]
): CadEntity[] {
  const payload = issue.fixPayload;
  if (!payload) return entities;

  const stamp = Date.now().toString(36);

  if (
    payload.type === 'align_axis' &&
    payload.coordKey !== undefined &&
    payload.actualVal !== undefined &&
    payload.expectedVal !== undefined
  ) {
    const key = payload.coordKey;
    const actual = payload.actualVal;
    const expected = payload.expectedVal;
    const tol = 1.0;

    return entities.map((ent) => {
      if (ent.view !== payload.targetView) return ent;
      if (ent.type === 'line') {
        const p1 = { ...ent.p1 };
        const p2 = { ...ent.p2 };
        if (Math.abs(p1[key] - actual) <= tol) p1[key] = expected;
        if (Math.abs(p2[key] - actual) <= tol) p2[key] = expected;
        return { ...ent, p1, p2 };
      }
      if (ent.type === 'rect') {
        if (key === 'u') {
          let x0 = ent.x;
          let x1 = ent.x + ent.width;
          if (Math.abs(x0 - actual) <= tol) x0 = expected;
          if (Math.abs(x1 - actual) <= tol) x1 = expected;
          return {
            ...ent,
            x: Math.min(x0, x1),
            width: Math.abs(x1 - x0),
          };
        } else {
          let y0 = ent.y;
          let y1 = ent.y + ent.height;
          if (Math.abs(y0 - actual) <= tol) y0 = expected;
          if (Math.abs(y1 - actual) <= tol) y1 = expected;
          return {
            ...ent,
            y: Math.min(y0, y1),
            height: Math.abs(y1 - y0),
          };
        }
      }
      if (ent.type === 'polygon') {
        return {
          ...ent,
          points: ent.points.map((pt) =>
            Math.abs(pt[key] - actual) <= tol
              ? { ...pt, [key]: expected }
              : pt
          ),
        };
      }
      if (ent.type === 'circle' || ent.type === 'arc') {
        const shift = expected - actual;
        const cVal = ent.center[key];
        if (
          Math.abs(cVal + ent.radius - actual) <= tol ||
          Math.abs(cVal - ent.radius - actual) <= tol
        ) {
          return {
            ...ent,
            center: { ...ent.center, [key]: cVal + shift },
          };
        }
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
      if (ent.id !== payload.danglingEntityId || ent.type !== 'line') {
        return ent;
      }
      return payload.danglingEndpoint === 'p1'
        ? { ...ent, p1: { ...payload.snapTargetPt! } }
        : { ...ent, p2: { ...payload.snapTargetPt! } };
    });
  }

  if (
    payload.type === 'convert_linetype' &&
    payload.entityId &&
    payload.targetLineType
  ) {
    return entities.map((ent) =>
      ent.id === payload.entityId
        ? { ...ent, lineType: payload.targetLineType! }
        : ent
    );
  }

  if (
    payload.type === 'add_missing_hidden_hole' &&
    payload.holeCenterU !== undefined &&
    payload.holeRadius !== undefined &&
    payload.spanMin !== undefined &&
    payload.spanMax !== undefined
  ) {
    const uL = payload.holeCenterU - payload.holeRadius;
    const uR = payload.holeCenterU + payload.holeRadius;
    const v0 = payload.spanMin;
    const v1 = payload.spanMax;
    const additions: CadEntity[] = [
      {
        id: `fix_hid_l_${stamp}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'thin_dashed',
        p1: { u: uL, v: v0 },
        p2: { u: uL, v: v1 },
        source: 'user',
        featureLabel: '补全通孔左转向细虚线',
      },
      {
        id: `fix_hid_r_${stamp}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'thin_dashed',
        p1: { u: uR, v: v0 },
        p2: { u: uR, v: v1 },
        source: 'user',
        featureLabel: '补全通孔右转向细虚线',
      },
      {
        id: `fix_hid_cl_${stamp}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1: { u: payload.holeCenterU, v: v0 - 3.5 },
        p2: { u: payload.holeCenterU, v: v1 + 3.5 },
        source: 'user',
        featureLabel: '补全通孔轴线',
      },
    ];
    return [...entities, ...additions];
  }

  if (
    payload.type === 'add_circle_centerlines' &&
    payload.center &&
    payload.radius !== undefined
  ) {
    const ext = Math.max(3.0, payload.radius * 0.2);
    const additions: CadEntity[] = [];
    if (payload.needHoriz) {
      additions.push({
        id: `fix_cl_h_${stamp}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1: { u: payload.center.u - payload.radius - ext, v: payload.center.v },
        p2: { u: payload.center.u + payload.radius + ext, v: payload.center.v },
        source: 'user',
      });
    }
    if (payload.needVert) {
      additions.push({
        id: `fix_cl_v_${stamp}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1: { u: payload.center.u, v: payload.center.v - payload.radius - ext },
        p2: { u: payload.center.u, v: payload.center.v + payload.radius + ext },
        source: 'user',
      });
    }
    return [...entities, ...additions];
  }

  if (
    payload.type === 'add_revolution_axis' &&
    payload.orientation &&
    payload.axisCoord !== undefined &&
    payload.spanMin !== undefined &&
    payload.spanMax !== undefined
  ) {
    const p1: Point2D =
      payload.orientation === 'horizontal'
        ? { u: payload.spanMin - 4, v: payload.axisCoord }
        : { u: payload.axisCoord, v: payload.spanMin - 4 };
    const p2: Point2D =
      payload.orientation === 'horizontal'
        ? { u: payload.spanMax + 4, v: payload.axisCoord }
        : { u: payload.axisCoord, v: payload.spanMax + 4 };
    return [
      ...entities,
      {
        id: `fix_rev_ax_${stamp}`,
        view: payload.targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1,
        p2,
        source: 'user',
      },
    ];
  }

  if (
    payload.type === 'replace_view_entities' &&
    payload.replacementEntities
  ) {
    return [
      ...entities.filter((e) => e.view !== payload.targetView),
      ...payload.replacementEntities,
    ];
  }

  return entities;
}
