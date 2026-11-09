import { CadEntity, ViewType, DiagnosticIssue, Primitive3D } from '../../types/cad';

/**
 * Checks whether circular features (circles/semicircles) or rotational primitives
 * in a view have corresponding GB/T 4458.1 `center_dot_dash` axes.
 */
export function checkMissingCenterlinesInView(
  entities: CadEntity[],
  view: ViewType
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const viewCircles = entities.filter(
    (e) =>
      e.view === view &&
      (e.lineType === 'thick_solid' || e.lineType === 'thin_dashed') &&
      (e.type === 'circle' || e.type === 'arc') &&
      e.radius >= 3.0
  );
  if (viewCircles.length === 0) return issues;

  const centerlines = entities.filter(
    (e) => e.view === view && e.lineType === 'center_dot_dash' && e.type === 'line'
  );

  let missingCount = 0;
  for (const c of viewCircles) {
    if (c.type !== 'circle' && c.type !== 'arc') continue;
    const { u: uc, v: vc } = c.center;
    const hasHoriz = centerlines.some(
      (cl) =>
        cl.type === 'line' &&
        Math.abs(cl.p1.v - vc) <= 2.0 &&
        Math.abs(cl.p2.v - vc) <= 2.0 &&
        Math.min(cl.p1.u, cl.p2.u) <= uc + 2.0 &&
        Math.max(cl.p1.u, cl.p2.u) >= uc - 2.0
    );
    const hasVert = centerlines.some(
      (cl) =>
        cl.type === 'line' &&
        Math.abs(cl.p1.u - uc) <= 2.0 &&
        Math.abs(cl.p2.u - uc) <= 2.0 &&
        Math.min(cl.p1.v, cl.p2.v) <= vc + 2.0 &&
        Math.max(cl.p1.v, cl.p2.v) >= vc - 2.0
    );
    if (!hasHoriz || !hasVert) {
      missingCount++;
    }
  }

  if (missingCount > 0) {
    const viewLabel =
      view === 'front' ? '主视图' : view === 'top' ? '俯视图' : '左视图';
    issues.push({
      id: `missing-centerline-${view}`,
      severity: 'info',
      category: 'missing_centerline',
      title: `${viewLabel}回转特征缺少十字对称中心线（细点画线）`,
      description: `根据 GB/T 4458.1 机械制图标准，${viewLabel}中的 ${missingCount} 个圆或圆弧特征应绘制超出轮廓 3~5mm 的细点画线（center_dot_dash）十字中心线。`,
      views: [view],
      suggestion: '可使用中心线图层补齐圆心十字对称线或使用自动补齐功能。',
    });
  }

  return issues;
}

/**
 * Automatically synthesizes GB/T 4458.1 compliant `center_dot_dash` entities
 * (extending 4mm beyond feature bounds) for rotational primitives and circular features
 * in the target view.
 */
export function synthesizeCenterlinesForView(
  primitives: Primitive3D[],
  existingEntities: CadEntity[],
  targetView: ViewType,
  overhang: number = 4.0
): CadEntity[] {
  const result: CadEntity[] = [];
  const existingCenterlines = existingEntities.filter(
    (e) => e.view === targetView && e.lineType === 'center_dot_dash' && e.type === 'line'
  );

  const addCenterlineIfUnique = (
    u1: number,
    v1: number,
    u2: number,
    v2: number,
    idSuffix: string
  ) => {
    const len = Math.hypot(u2 - u1, v2 - v1);
    if (len < 3.0) return;

    const allLines = [...existingCenterlines, ...result];
    const isDup = allLines.some((cl) => {
      if (cl.type !== 'line') return false;
      const d1 =
        Math.hypot(cl.p1.u - u1, cl.p1.v - v1) +
        Math.hypot(cl.p2.u - u2, cl.p2.v - v2);
      const d2 =
        Math.hypot(cl.p1.u - u2, cl.p1.v - v2) +
        Math.hypot(cl.p2.u - u1, cl.p2.v - v1);
      return Math.min(d1, d2) < 3.0;
    });

    if (!isDup) {
      result.push({
        id: `auto-cl-${targetView}-${idSuffix}-${result.length}`,
        view: targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1: { u: Number(u1.toFixed(2)), v: Number(v1.toFixed(2)) },
        p2: { u: Number(u2.toFixed(2)), v: Number(v2.toFixed(2)) },
        source: 'derived',
      });
    }
  };

  for (let i = 0; i < primitives.length; i++) {
    const p = primitives[i];
    const isZ = p.shape === 'cylinder_z' || p.shape === 'cone_z';
    const isY = p.shape === 'cylinder_y' || p.shape === 'cone_y';
    const isX = p.shape === 'cylinder_x' || p.shape === 'cone_x';

    if (!isZ && !isY && !isX) continue;

    const xc = 0.5 * (p.xMin + p.xMax);
    const yc = 0.5 * (p.yMin + p.yMax);
    const zc = 0.5 * (p.zMin + p.zMax);
    const rx = 0.5 * (p.xMax - p.xMin);
    const ry = 0.5 * (p.yMax - p.yMin);
    const rz = 0.5 * (p.zMax - p.zMin);

    if (isZ) {
      if (targetView === 'top') {
        addCenterlineIfUnique(xc - rx - overhang, yc, xc + rx + overhang, yc, `z-top-h-${i}`);
        addCenterlineIfUnique(xc, yc - ry - overhang, xc, yc + ry + overhang, `z-top-v-${i}`);
      } else if (targetView === 'front') {
        addCenterlineIfUnique(xc, p.zMin - overhang, xc, p.zMax + overhang, `z-front-ax-${i}`);
      } else if (targetView === 'left') {
        addCenterlineIfUnique(yc, p.zMin - overhang, yc, p.zMax + overhang, `z-left-ax-${i}`);
      }
    } else if (isY) {
      if (targetView === 'front') {
        addCenterlineIfUnique(xc - rx - overhang, zc, xc + rx + overhang, zc, `y-front-h-${i}`);
        addCenterlineIfUnique(xc, zc - rz - overhang, xc, zc + rz + overhang, `y-front-v-${i}`);
      } else if (targetView === 'top') {
        addCenterlineIfUnique(xc, p.yMin - overhang, xc, p.yMax + overhang, `y-top-ax-${i}`);
      } else if (targetView === 'left') {
        addCenterlineIfUnique(p.yMin - overhang, zc, p.yMax + overhang, zc, `y-left-ax-${i}`);
      }
    } else if (isX) {
      if (targetView === 'left') {
        addCenterlineIfUnique(yc - ry - overhang, zc, yc + ry + overhang, zc, `x-left-h-${i}`);
        addCenterlineIfUnique(yc, zc - rz - overhang, yc, zc + rz + overhang, `x-left-v-${i}`);
      } else if (targetView === 'front') {
        addCenterlineIfUnique(p.xMin - overhang, zc, p.xMax + overhang, zc, `x-front-ax-${i}`);
      } else if (targetView === 'top') {
        addCenterlineIfUnique(p.xMin - overhang, yc, p.xMax + overhang, yc, `x-top-ax-${i}`);
      }
    }
  }

  return result;
}
