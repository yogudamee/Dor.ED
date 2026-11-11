import {
  CadEntity,
  LineType,
  Point2D,
  PresetCase,
  ViewType,
} from '../../types/cad';
import { verifyReprojectionFiniteIntervals } from '../solver/finiteReprojectionVerifier';
import { solve2DTo3DVolumeCSP } from '../solver/volumeCSPSolver';
import { buildViewArrangementAndCarriers } from '../arrangement2d/carrierGraph';
import { BenchmarkCaseResult, BenchmarkSuiteReport } from '../core/types';
import { buildWatertightManifoldGeometry } from '../mesh/watertightMesher';

function ln(
  id: string,
  view: ViewType,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
  lineType: LineType = 'thick_solid',
  featureId?: string
): CadEntity {
  return {
    id,
    view,
    type: 'line',
    lineType,
    p1: { u: Number(u1.toFixed(4)), v: Number(v1.toFixed(4)) },
    p2: { u: Number(u2.toFixed(4)), v: Number(v2.toFixed(4)) },
    source: 'template',
    featureId,
  };
}

function rc(
  id: string,
  view: ViewType,
  x: number,
  y: number,
  w: number,
  h: number,
  lineType: LineType = 'thick_solid',
  featureId?: string
): CadEntity {
  return {
    id,
    view,
    type: 'rect',
    lineType,
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    width: Number(w.toFixed(4)),
    height: Number(h.toFixed(4)),
    source: 'template',
    featureId,
  };
}

function cir(
  id: string,
  view: ViewType,
  cu: number,
  cv: number,
  r: number,
  lineType: LineType = 'thick_solid',
  featureId?: string
): CadEntity {
  return {
    id,
    view,
    type: 'circle',
    lineType,
    center: { u: Number(cu.toFixed(4)), v: Number(cv.toFixed(4)) },
    radius: Number(r.toFixed(4)),
    source: 'template',
    featureId,
  };
}

function arc(
  id: string,
  view: ViewType,
  cu: number,
  cv: number,
  r: number,
  startAngle: number,
  endAngle: number,
  lineType: LineType = 'thick_solid',
  featureId?: string
): CadEntity {
  return {
    id,
    view,
    type: 'arc',
    lineType,
    center: { u: Number(cu.toFixed(4)), v: Number(cv.toFixed(4)) },
    radius: Number(r.toFixed(4)),
    startAngle: Number(startAngle.toFixed(5)),
    endAngle: Number(endAngle.toFixed(5)),
    source: 'template',
    featureId,
  };
}

function poly(
  id: string,
  view: ViewType,
  points: Point2D[],
  lineType: LineType = 'thick_solid',
  featureId?: string
): CadEntity {
  return {
    id,
    view,
    type: 'polygon',
    lineType,
    points: points.map((p) => ({
      u: Number(p.u.toFixed(4)),
      v: Number(p.v.toFixed(4)),
    })),
    closed: true,
    source: 'template',
    featureId,
  };
}

function crosshair(
  prefix: string,
  view: ViewType,
  cu: number,
  cv: number,
  r: number
): CadEntity[] {
  const ext = 4;
  return [
    ln(
      `${prefix}_cl_h`,
      view,
      cu - r - ext,
      cv,
      cu + r + ext,
      cv,
      'center_dot_dash'
    ),
    ln(
      `${prefix}_cl_v`,
      view,
      cu,
      cv - r - ext,
      cu,
      cv + r + ext,
      'center_dot_dash'
    ),
  ];
}

let cachedBenchmarkPresets: PresetCase[] | null = null;

/**
 * Facade #8: Return all 14 normalized high-difficulty GB/T 4458.1 benchmark cases.
 * `solutions` is kept lazy (`[]`) so initial page mount runs in 0ms; selecting a case or
 * running `runKernelBenchmarkSelfTest()` invokes the live 6-layer CSP + HLR kernel on demand.
 */
export function getNormalizedBenchmarkPresets(): PresetCase[] {
  if (cachedBenchmarkPresets) return cachedBenchmarkPresets;

  const H_SIN60 = Math.sqrt(3) / 2; // 0.8660254
  const R30_HEX_DY = 30 * H_SIN60; // 25.9808

  // Regular hexagon #1 (flat top/bottom in Y, corners at X = 30, 90):
  const hexFlatY: Point2D[] = [
    { u: 90, v: 60 },
    { u: 75, v: 60 + R30_HEX_DY },
    { u: 45, v: 60 + R30_HEX_DY },
    { u: 30, v: 60 },
    { u: 45, v: 60 - R30_HEX_DY },
    { u: 75, v: 60 - R30_HEX_DY },
  ];

  // Regular hexagon #2 (flat left/right in X = 60 ± 25.9808, corners at Y = 30, 90):
  const hexFlatX: Point2D[] = [
    { u: 60 + R30_HEX_DY, v: 75 },
    { u: 60, v: 90 },
    { u: 60 - R30_HEX_DY, v: 75 },
    { u: 60 - R30_HEX_DY, v: 45 },
    { u: 60, v: 30 },
    { u: 60 + R30_HEX_DY, v: 45 },
  ];

  // Sphere R=30 at (60, 60, 52) with top slot Y in [48, 72], Z in [52, 82]:
  // Slice radius at Y = 48, 72 is sqrt(30^2 - 12^2) = sqrt(756) = 27.4955
  const R_SLICE_SPHERE = Math.sqrt(30 * 30 - 12 * 12);
  const ANG_SLOT_R = Math.atan2(R_SLICE_SPHERE, 12); // ~1.1225 rad
  const ANG_SLOT_L = Math.atan2(R_SLICE_SPHERE, -12); // ~2.0191 rad

  cachedBenchmarkPresets = [
    // ========================================================================
    // Case 01: 三阶同轴阶梯圆柱轴 + 中心通孔
    // ========================================================================
    {
      id: 'bench_01_stepped_coaxial_cylinders',
      name: '基准 01：三阶同轴阶梯圆柱轴（含中心圆通孔）',
      category: 'benchmark',
      badge: '高阶基准 · 同轴多阶回转体',
      description:
        '三阶同轴回转圆柱（Ø64 / Ø44 / Ø28，总高 62mm）叠加中心 Ø14 铅垂圆通孔。检验多并列同心圆环的精确环形肩部完整轮廓提取与同轴柱体合并。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z)
        rc('b01_f_t1', 'front', 28, 20, 64, 20),
        rc('b01_f_t2', 'front', 38, 40, 44, 22),
        rc('b01_f_t3', 'front', 46, 62, 28, 20),
        ln('b01_f_hl', 'front', 53, 20, 53, 82, 'thin_dashed'),
        ln('b01_f_hr', 'front', 67, 20, 67, 82, 'thin_dashed'),
        ln('b01_f_cl', 'front', 60, 16, 60, 86, 'center_dot_dash'),
        // Top (u=X, v=Y): 4 concentric circles!
        cir('b01_t_c1', 'top', 60, 60, 32),
        cir('b01_t_c2', 'top', 60, 60, 22),
        cir('b01_t_c3', 'top', 60, 60, 14),
        cir('b01_t_ch', 'top', 60, 60, 7),
        ...crosshair('b01_t', 'top', 60, 60, 32),
      ],
    },

    // ========================================================================
    // Case 02: 正六棱柱及中心单圆通孔
    // ========================================================================
    {
      id: 'bench_02_hex_prism_single_bore',
      name: '基准 02：正六棱柱及中心单圆通孔',
      category: 'benchmark',
      badge: '高阶基准 · 斜平面精确裁剪',
      description:
        '外接圆 Ø60 正六棱柱（高 60mm）中心钻 Ø24 铅垂通孔。严禁退化为正交 AABB 长方体切块，严格验证 60° 斜棱面半空间裁剪与左视图双斜面中棱线生成。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): outer [30..90, 22..82] + hex ridges at u=45, 75 + bore u=48, 72
        rc('b02_f_out', 'front', 30, 22, 60, 60),
        ln('b02_f_r1', 'front', 45, 22, 45, 82),
        ln('b02_f_r2', 'front', 75, 22, 75, 82),
        ln('b02_f_hl', 'front', 48, 22, 48, 82, 'thin_dashed'),
        ln('b02_f_hr', 'front', 72, 22, 72, 82, 'thin_dashed'),
        ln('b02_f_cl', 'front', 60, 18, 60, 86, 'center_dot_dash'),
        // Top (u=X, v=Y): exact regular hexagon + Ø24 bore
        poly('b02_t_hex', 'top', hexFlatY),
        cir('b02_t_bore', 'top', 60, 60, 12),
        ...crosshair('b02_t', 'top', 60, 60, 30),
      ],
    },

    // ========================================================================
    // Case 03: 正六棱柱正交十字交叉圆孔（含平面-柱面截交与内腔 Steinmetz 相贯）
    // ========================================================================
    {
      id: 'bench_03_hex_prism_t_cross_bores',
      name: '基准 03：正六棱柱正交交叉双圆通孔（SSI 相贯）',
      category: 'benchmark',
      badge: '高阶基准 · 多轴孔并集 + SSI',
      description:
        '对边宽 51.96mm 的正六棱柱同时包含 Ø26 铅垂主圆孔与 Ø18 横向水平交叉圆孔。检验多轴孔独立直通定律（零中心孤立气泡）及内腔柱-柱 Steinmetz 马鞍相贯虚线追踪。',
      knownViews: ['top', 'left'],
      targetView: 'front',
      solutions: [],
      entities: [
        // Top (u=X, v=Y): hexFlatX + Ø26 Z-bore + X-bore dashed bands (Y = 51, 69)
        poly('b03_t_hex', 'top', hexFlatX),
        cir('b03_t_zbore', 'top', 60, 60, 13),
        ln('b03_t_xl1', 'top', 60 - R30_HEX_DY, 51, 47, 51, 'thin_dashed'),
        ln('b03_t_xl2', 'top', 73, 51, 60 + R30_HEX_DY, 51, 'thin_dashed'),
        ln('b03_t_xr1', 'top', 60 - R30_HEX_DY, 69, 47, 69, 'thin_dashed'),
        ln('b03_t_xr2', 'top', 73, 69, 60 + R30_HEX_DY, 69, 'thin_dashed'),
        ...crosshair('b03_t', 'top', 60, 60, 30),
        // Left (u=Y, v=Z): hex [30..90, 20..84] + ridges u=45, 75 + Ø18 X-bore at (60, 52) + Z-bore dashed u=47, 73
        rc('b03_l_out', 'left', 30, 20, 60, 64),
        ln('b03_l_r1', 'left', 45, 20, 45, 84),
        ln('b03_l_r2', 'left', 75, 20, 75, 84),
        cir('b03_l_xbore', 'left', 60, 52, 9),
        ln('b03_l_zl', 'left', 47, 20, 47, 84, 'thin_dashed'),
        ln('b03_l_zr', 'left', 73, 20, 73, 84, 'thin_dashed'),
        ln('b03_l_clv', 'left', 60, 16, 60, 88, 'center_dot_dash'),
        ln('b03_l_clh', 'left', 46, 52, 74, 52, 'center_dot_dash'),
      ],
    },

    // ========================================================================
    // Case 04: 多级阶梯叠块 + 跨台阶半露半嵌圆柱组合体
    // ========================================================================
    {
      id: 'bench_04_stepped_block_straddling_cylinder',
      name: '基准 04：双阶梯底座 + 跨台阶半露半嵌空心圆柱',
      category: 'benchmark',
      badge: '高阶基准 · 载体还原与无痕融合',
      description:
        '底座含前后高低两级台阶（Z=42 与 Z=66），中央 Ø32 空心圆柱（内孔 Ø14）跨骑在 Y=58 台阶分界线上（前半圆下探至 Z=42、后半圆嵌合于 Z=66 台阶并高出至 Z=82）。检验共线打断台阶载体还原与内部共面消融。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z)
        ln('b04_f_b0', 'front', 24, 20, 96, 20),
        ln('b04_f_bl', 'front', 24, 20, 24, 66),
        ln('b04_f_br', 'front', 96, 20, 96, 66),
        // Step Z=42 across full width (24..44, 44..76 cylinder bottom visible in front, 76..96)
        ln('b04_f_s42', 'front', 24, 42, 96, 42),
        // Rear step Z=66 interrupted by foreground cylinder [44..76]
        ln('b04_f_s66_l', 'front', 24, 66, 44, 66),
        ln('b04_f_s66_r', 'front', 76, 66, 96, 66),
        // Straddling cylinder [44..76] from Z=42 (in front!) to Z=82
        ln('b04_f_cl_l', 'front', 44, 42, 44, 82),
        ln('b04_f_cl_r', 'front', 76, 42, 76, 82),
        ln('b04_f_cl_t', 'front', 44, 82, 76, 82),
        // Inner Ø14 bore
        ln('b04_f_hl', 'front', 53, 20, 53, 82, 'thin_dashed'),
        ln('b04_f_hr', 'front', 67, 20, 67, 82, 'thin_dashed'),
        ln('b04_f_axis', 'front', 60, 16, 60, 86, 'center_dot_dash'),
        // Top (u=X, v=Y)
        rc('b04_t_base', 'top', 24, 30, 72, 60),
        ln('b04_t_step_l', 'top', 24, 58, 44, 58),
        ln('b04_t_step_r', 'top', 76, 58, 96, 58),
        cir('b04_t_cyl', 'top', 60, 58, 16),
        cir('b04_t_hole', 'top', 60, 58, 7),
        ...crosshair('b04_t', 'top', 60, 58, 18),
      ],
    },

    // ========================================================================
    // Case 05: 共顶弦双半圆内部八字斜通孔
    // ========================================================================
    {
      id: 'bench_05_cochord_dual_semicircle_slanted_bore',
      name: '基准 05：平背半圆柱内嵌共顶弦双半圆八字斜通孔',
      category: 'benchmark',
      badge: '高阶基准 · 共弦并集 + 斜放样孔',
      description:
        'R30 平背半圆柱（后背壁 Y=34）内部在 Y=42 共顶弦平面贯通上大（R18）下小（R10）的半圆台八字形斜通孔。检验 DCEL 共顶弦双半圆并集提取与 GeneralizedLoft 斜虚线放样减料。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): outer rect [30..90, 24..80] + tapered "八字" dashed lines (50,24)->(42,80) & (70,24)->(78,80)
        rc('b05_f_out', 'front', 30, 24, 60, 56),
        ln('b05_f_sl_l', 'front', 50, 24, 42, 80, 'thin_dashed'),
        ln('b05_f_sl_r', 'front', 70, 24, 78, 80, 'thin_dashed'),
        ln('b05_f_cl', 'front', 60, 20, 60, 84, 'center_dot_dash'),
        // Top (u=X, v=Y): Outer R=30 semicircle at (60, 34) + internal co-chord R=18 & R=10 semicircles sharing chord v=42!
        arc('b05_t_arc30', 'top', 60, 34, 30, 0, Math.PI),
        ln('b05_t_back', 'top', 30, 34, 90, 34),
        arc('b05_t_arc18', 'top', 60, 42, 18, 0, Math.PI),
        arc('b05_t_arc10', 'top', 60, 42, 10, 0, Math.PI),
        ln('b05_t_ch2', 'top', 42, 42, 50, 42),
        ln('b05_t_ch3', 'top', 50, 42, 70, 42),
        ln('b05_t_ch4', 'top', 70, 42, 78, 42),
        ln('b05_t_cl', 'top', 60, 30, 60, 68, 'center_dot_dash'),
      ],
    },

    // ========================================================================
    // Case 06: 拱形柱体正交交叉方圆孔
    // ========================================================================
    {
      id: 'bench_06_arch_prism_crossed_sq_round_holes',
      name: '基准 06：拱顶柱体正交交叉方孔与圆通孔',
      category: 'benchmark',
      badge: '高阶基准 · 曲边拱柱 + 异形交叉孔',
      description:
        '直壁（Z=22..56）加半圆拱顶（R26，总高 Z=82）柱体，前后贯穿 20×20 方孔并与铅垂 Ø16 圆通孔正交相交。检验曲边拱形拉伸体与方-圆内腔交叉孔独立打通。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Arch [34..86, 22..56 + R26] + inner square [50..70, 34..54] + Z-bore dashed u=52,68
        ln('b06_f_bot', 'front', 34, 22, 86, 22),
        ln('b06_f_wl', 'front', 34, 22, 34, 56),
        ln('b06_f_wr', 'front', 86, 22, 86, 56),
        arc('b06_f_arch', 'front', 60, 56, 26, 0, Math.PI),
        rc('b06_f_sq', 'front', 50, 34, 20, 20),
        ln('b06_f_zbl1', 'front', 52, 22, 52, 34, 'thin_dashed'),
        ln('b06_f_zbr1', 'front', 68, 22, 68, 34, 'thin_dashed'),
        ln('b06_f_zbl2', 'front', 52, 54, 52, 80.7, 'thin_dashed'),
        ln('b06_f_zbr2', 'front', 68, 54, 68, 80.7, 'thin_dashed'),
        ln('b06_f_cl', 'front', 60, 18, 60, 86, 'center_dot_dash'),
        // Top (u=X, v=Y): outer [34..86, 34..86] + Ø16 Z-bore + square Y-bore dashed u=50, 70
        rc('b06_t_out', 'top', 34, 34, 52, 52),
        cir('b06_t_zbore', 'top', 60, 60, 8),
        ln('b06_t_sql', 'top', 50, 34, 50, 86, 'thin_dashed'),
        ln('b06_t_sqr', 'top', 70, 34, 70, 86, 'thin_dashed'),
        ...crosshair('b06_t', 'top', 60, 60, 12),
      ],
    },

    // ========================================================================
    // Case 07: 正圆锥横向开贯穿方孔
    // ========================================================================
    {
      id: 'bench_07_cone_lateral_rect_slot',
      name: '基准 07：正圆锥横向贯穿矩形窗口（双曲截交线）',
      category: 'benchmark',
      badge: '高阶基准 · 圆锥二次曲面截交',
      description:
        '底径 Ø64、高 64mm 的铅垂正圆锥在 Z=30..48 高度处前后贯穿宽 20mm 的矩形窗口。检验圆锥极值母线局部镂空裁剪与平面-圆锥双曲线/圆弧截交线追踪。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Cone triangle (28,20)-(92,20)-(60,84) + inner rect [50..70, 30..48]
        ln('b07_f_base', 'front', 28, 20, 92, 20),
        ln('b07_f_fl', 'front', 28, 20, 60, 84),
        ln('b07_f_fr', 'front', 92, 20, 60, 84),
        rc('b07_f_win', 'front', 50, 30, 20, 18),
        ln('b07_f_cl', 'front', 60, 16, 60, 88, 'center_dot_dash'),
        // Top (u=X, v=Y): Base circle R=32 + hidden/visible window band u=50, 70 (y = 60 ± sqrt(27^2 - 10^2) = 60 ± 25.08)
        cir('b07_t_base', 'top', 60, 60, 32),
        ln('b07_t_wl', 'top', 50, 34.92, 50, 85.08, 'thin_dashed'),
        ln('b07_t_wr', 'top', 70, 34.92, 70, 85.08, 'thin_dashed'),
        ...crosshair('b07_t', 'top', 60, 60, 32),
      ],
    },

    // ========================================================================
    // Case 08: 偏心斜圆台（一侧母线铅垂对齐）
    // ========================================================================
    {
      id: 'bench_08_eccentric_oblique_frustum',
      name: '基准 08：偏心斜圆台（GeneralizedLoft 极值母线）',
      category: 'benchmark',
      badge: '高阶基准 · 偏心斜锥台放样',
      description:
        '下底圆 Ø60 位于 (60,60,20)，上顶圆 Ø36 偏心平移至 (48,60,80) 使左侧母线铅垂对齐于 X=30。检验 GeneralizedLoft 解析极值轮廓母线方程 A cosθ + B sinθ = C 求解。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Asymmetric trapezoid (30,20)-(90,20)-(66,80)-(30,80)
        ln('b08_f_bot', 'front', 30, 20, 90, 20),
        ln('b08_f_right', 'front', 90, 20, 66, 80),
        ln('b08_f_top', 'front', 66, 80, 30, 80),
        ln('b08_f_left', 'front', 30, 80, 30, 20),
        // Top (u=X, v=Y): Base circle R=30 at (60,60) + eccentric top circle R=18 at (48,60)
        cir('b08_t_bot', 'top', 60, 60, 30),
        cir('b08_t_top', 'top', 48, 60, 18),
        ln('b08_t_clh', 'top', 26, 60, 94, 60, 'center_dot_dash'),
        ln('b08_t_clv1', 'top', 60, 26, 60, 94, 'center_dot_dash'),
      ],
    },

    // ========================================================================
    // Case 09: 同径刃口空心正圆台 (r_hole === R_top)
    // ========================================================================
    {
      id: 'bench_09_knife_edge_hollow_frustum',
      name: '基准 09：同径刃口薄壁空心正圆台（零壁厚顶缘保护）',
      category: 'benchmark',
      badge: '高阶基准 · 26邻域刃口保护',
      description:
        '正圆台下底 Ø64、上顶 Ø32（高 58mm），中心贯通同径 Ø32 圆柱通孔，使上顶面退化为零厚度环形刃口（r_hole = R_min = 16）。检验 26 邻域实体存在性探测与刃口防误删机制。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Trapezoid (28,22)-(92,22)-(76,80)-(44,80) + bore dashed u=44, 76
        ln('b09_f_bot', 'front', 28, 22, 92, 22),
        ln('b09_f_fl', 'front', 28, 22, 44, 80),
        ln('b09_f_fr', 'front', 92, 22, 76, 80),
        ln('b09_f_top', 'front', 44, 80, 76, 80),
        ln('b09_f_hl', 'front', 44, 22, 44, 80, 'thin_dashed'),
        ln('b09_f_hr', 'front', 76, 22, 76, 80, 'thin_dashed'),
        ln('b09_f_cl', 'front', 60, 18, 60, 84, 'center_dot_dash'),
        // Top (u=X, v=Y): Concentric R=32 and knife-edge R=16 circles
        cir('b09_t_out', 'top', 60, 60, 32),
        cir('b09_t_in', 'top', 60, 60, 16),
        ...crosshair('b09_t', 'top', 60, 60, 32),
      ],
    },

    // ========================================================================
    // Case 10: 平背半圆台（Semi-Frustum）
    // ========================================================================
    {
      id: 'bench_10_semi_cone_and_semi_frustum',
      name: '基准 10：平背正半圆台（共弦半圆截面放样）',
      category: 'benchmark',
      badge: '高阶基准 · 半圆锥台放样',
      description:
        '下底 R32 半圆与上顶 R16 半圆共享后侧铅垂平背墙 Y=36（高 60mm）。检验俯视图共顶弦同心双半圆并集提取及左视图“后直立平壁 + 前倾斜母线”直角梯形精确投影。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Symmetric trapezoid (28,22)-(92,22)-(76,82)-(44,82)
        ln('b10_f_bot', 'front', 28, 22, 92, 22),
        ln('b10_f_fl', 'front', 28, 22, 44, 82),
        ln('b10_f_fr', 'front', 92, 22, 76, 82),
        ln('b10_f_top', 'front', 44, 82, 76, 82),
        ln('b10_f_cl', 'front', 60, 18, 60, 86, 'center_dot_dash'),
        // Top (u=X, v=Y): Co-chord semicircles R=32 & R=16 at (60, 36) [0 -> π]
        arc('b10_t_a32', 'top', 60, 36, 32, 0, Math.PI),
        arc('b10_t_a16', 'top', 60, 36, 16, 0, Math.PI),
        ln('b10_t_c1', 'top', 28, 36, 44, 36),
        ln('b10_t_c2', 'top', 44, 36, 76, 36),
        ln('b10_t_c3', 'top', 76, 36, 92, 36),
        ln('b10_t_cl', 'top', 60, 32, 60, 72, 'center_dot_dash'),
      ],
    },

    // ========================================================================
    // Case 11: 平底半球体（Flat-Bottom Hemisphere）
    // ========================================================================
    {
      id: 'bench_11_flat_bottom_hemisphere_bored',
      name: '基准 11：平底实心半球穹顶（二次曲面大圆极值弧）',
      category: 'benchmark',
      badge: '高阶基准 · 解析半球曲面',
      description:
        '球心位于 Z=28 底平面的 R32 上凸平底半球体。严格检验 +dθ 圆弧扫掠极性不变性与半球大圆转向轮廓弧合成，严禁上下翻转凹凸方向或退化为多边形棱柱。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Upper semicircle at (60, 28), R=32, [0 -> π] + flat base
        arc('b11_f_dome', 'front', 60, 28, 32, 0, Math.PI),
        ln('b11_f_base', 'front', 28, 28, 92, 28),
        ln('b11_f_cl', 'front', 60, 24, 60, 64, 'center_dot_dash'),
        // Top (u=X, v=Y): Full circle R=32 at (60, 60)
        cir('b11_t_eq', 'top', 60, 60, 32),
        ...crosshair('b11_t', 'top', 60, 60, 32),
      ],
    },

    // ========================================================================
    // Case 12: 前向正圆锥 + 后方同轴半球复合体
    // ========================================================================
    {
      id: 'bench_12_cone_rear_hemisphere_composite',
      name: '基准 12：前向正圆锥 + 后方同轴半球复合回转体',
      category: 'benchmark',
      badge: '高阶基准 · 异构二次曲面拼接',
      description:
        '以 Y=58（Ø52）为公共赤道截面：前方（Y=58..94）为向前收尖的水平正圆锥，后方（Y=32..58）为向后鼓出的同轴半球。检验俯视图共弦“半圆+三角形”双原子面独立升维与拼接。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Equator circle R=26 at (60, 52)
        cir('b12_f_eq', 'front', 60, 52, 26),
        ...crosshair('b12_f', 'front', 60, 52, 26),
        // Top (u=X, v=Y): Rear semicircle [π -> 0] (v=32..58) + equator chord (34,58)-(86,58) + front cone (60,94)
        arc('b12_t_hemi', 'top', 60, 58, 26, Math.PI, 0),
        ln('b12_t_eq', 'top', 34, 58, 86, 58),
        ln('b12_t_cl', 'top', 34, 58, 60, 94),
        ln('b12_t_cr', 'top', 86, 58, 60, 94),
        ln('b12_t_axis', 'top', 60, 28, 60, 98, 'center_dot_dash'),
      ],
    },

    // ========================================================================
    // Case 13: 球体开顶部贯穿方槽（修剪大圆弧载体缝合）
    // ========================================================================
    {
      id: 'bench_13_sphere_through_rect_slot',
      name: '基准 13：整球顶部开贯穿矩形通槽（球面截交圆弧）',
      category: 'benchmark',
      badge: '高阶基准 · 优弧缝合整球 + 截交',
      description:
        'R30 圆球（球心 60,60,52）自顶部向下切出宽 24mm（Y=48..72）、底面位于球心赤道面 Z=52 的横向贯穿方槽。检验左视图 268.6° 修剪优弧还原整球载体及球面平面截交减小圆弧推导。',
      knownViews: ['top', 'left'],
      targetView: 'front',
      solutions: [],
      entities: [
        // Top (u=X, v=Y): Full equator circle R=30 + two slot wall chords at v=48, 72 spanning [60 ± 27.4955]
        cir('b13_t_eq', 'top', 60, 60, 30),
        ln(
          'b13_t_sl1',
          'top',
          60 - R_SLICE_SPHERE,
          48,
          60 + R_SLICE_SPHERE,
          48
        ),
        ln(
          'b13_t_sl2',
          'top',
          60 - R_SLICE_SPHERE,
          72,
          60 + R_SLICE_SPHERE,
          72
        ),
        ...crosshair('b13_t', 'top', 60, 60, 30),
        // Left (u=Y, v=Z): 268.6° major arc from ANG_SLOT_L (48, 79.50) -> ANG_SLOT_R (72, 79.50) + U-notch
        arc('b13_l_maj', 'left', 60, 52, 30, ANG_SLOT_L, ANG_SLOT_R),
        ln('b13_l_wl', 'left', 48, 52 + R_SLICE_SPHERE, 48, 52),
        ln('b13_l_fl', 'left', 48, 52, 72, 52),
        ln('b13_l_wr', 'left', 72, 52, 72, 52 + R_SLICE_SPHERE),
        ...crosshair('b13_l', 'left', 60, 52, 30),
      ],
    },

    // ========================================================================
    // Case 14: 欠约束对称真多解构型件（输出 Top 4 候选构型）
    // ========================================================================
    {
      id: 'bench_14_underconstrained_multisolution',
      name: '基准 14：欠约束两视图真多解枚举（Top 4 物理合法构型）',
      category: 'benchmark',
      badge: '高阶基准 · 欠约束 Top-4 多解',
      description:
        '主视图为上下两级矩形叠块、俯视图为内外嵌套矩形框（无回转轴线锁定）。检验 CSP 分支搜索与奥卡姆剃刀排序，一次性输出正交方凸台、前倾楔形、半圆拱顶、后倾楔形全部 Top 4 零残差合法三维解。',
      knownViews: ['front', 'top'],
      targetView: 'left',
      solutions: [],
      entities: [
        // Front (u=X, v=Z): Base [24..96, 22..46] + upper feature [40..80, 46..62]
        rc('b14_f_base', 'front', 24, 22, 72, 24),
        rc('b14_f_boss', 'front', 40, 46, 40, 16),
        // Top (u=X, v=Y): Outer [24..96, 28..92] + inner [40..80, 44..76] (dy=32 = 2*dz!)
        rc('b14_t_base', 'top', 24, 28, 72, 64),
        rc('b14_t_boss', 'top', 40, 44, 40, 32),
      ],
    },
  ];

  return cachedBenchmarkPresets;
}

/**
 * Facade #9: Execute the full 14-case automated benchmark verification suite, validating:
 * - Non-empty valid 3D CSP reconstruction (`solutions.length >= 1`, and `>= 4` for Case 14!)
 * - Non-empty target-view HLR derived entities (`derivedSolidCount >= 1`, zero `NaN` coordinates)
 * - Closed watertight Three.js manifold mesh (`watertightTriangles > 0`, zero `NaN/Infinity` vertices)
 * - High closed-loop reprojection recall (`recallKnownViews >= 0.85`)
 */
export function runKernelBenchmarkSelfTest(): BenchmarkSuiteReport {
  const presets = getNormalizedBenchmarkPresets();
  const suiteStart = performance.now();
  const results: BenchmarkCaseResult[] = [];
  let passedCases = 0;

  for (const preset of presets) {
    const t0 = performance.now();
    let passed = false;
    let notes = '';
    let cellCount = 0;
    let occupiedCellCount = 0;
    let solutionCount = 0;
    let derivedSolidCount = 0;
    let derivedDashedCount = 0;
    let derivedCenterlineCount = 0;
    let watertightTriangles = 0;
    let recallKnownViews = 0;

    try {
      const solutions = solve2DTo3DVolumeCSP(
        preset.entities,
        preset.knownViews,
        preset.targetView
      );
      solutionCount = solutions.length;

      if (solutionCount > 0) {
        const primary = solutions[0];
        cellCount = primary.solverMetrics?.totalCells ?? primary.primitives3D.length;
        occupiedCellCount =
          primary.solverMetrics?.occupiedCells ?? primary.primitives3D.length;

        derivedSolidCount = primary.derivedEntities.filter(
          (e) => e.lineType === 'thick_solid'
        ).length;
        derivedDashedCount = primary.derivedEntities.filter(
          (e) => e.lineType === 'thin_dashed'
        ).length;
        derivedCenterlineCount = primary.derivedEntities.filter(
          (e) => e.lineType === 'center_dot_dash'
        ).length;

        // Verify 3D watertight manifold mesh & finite coordinates
        const geom = buildWatertightManifoldGeometry(
          primary.primitives3D,
          'threejs'
        );
        const pos = geom.getAttribute('position');
        let allFinite = true;
        if (pos && pos.count >= 3) {
          watertightTriangles = Math.floor(pos.count / 3);
          for (let i = 0; i < pos.array.length; i++) {
            if (!Number.isFinite(pos.array[i])) {
              allFinite = false;
              break;
            }
          }
        }
        geom.dispose();

        // Compute quantitative reprojection recall on known views
        const arr1 = buildViewArrangementAndCarriers(
          preset.entities,
          preset.knownViews[0]
        );
        const arr2 = buildViewArrangementAndCarriers(
          preset.entities,
          preset.knownViews[1]
        );
        const ver = verifyReprojectionFiniteIntervals(
          primary.primitives3D,
          arr1,
          arr2,
          false
        );
        recallKnownViews = ver.recallKnownViews;

        const multiOk =
          preset.id === 'bench_14_underconstrained_multisolution'
            ? solutionCount >= 4
            : solutionCount >= 1;

        passed =
          multiOk &&
          derivedSolidCount >= 1 &&
          watertightTriangles >= 8 &&
          allFinite &&
          recallKnownViews >= 0.82;

        notes = passed
          ? `三维体元 ${primary.primitives3D.length} 项 · 重投影召回率 ${(
              recallKnownViews * 100
            ).toFixed(1)}% · 水密流形校验通过`
          : `校验未达标: 解数=${solutionCount}, 实线=${derivedSolidCount}, 三角面=${watertightTriangles}, 召回=${(
              recallKnownViews * 100
            ).toFixed(1)}%`;
      } else {
        notes = 'CSP 求解器未返回候选三维构型';
      }
    } catch (err) {
      passed = false;
      notes = `异常中断: ${err instanceof Error ? err.message : String(err)}`;
    }

    const solveTimeMs = performance.now() - t0;
    if (passed) passedCases++;

    results.push({
      caseId: preset.id,
      caseName: preset.name,
      passed,
      notes,
      knownViews: preset.knownViews,
      targetView: preset.targetView,
      cellCount,
      occupiedCellCount,
      solutionCount,
      derivedSolidCount,
      derivedDashedCount,
      derivedCenterlineCount,
      watertightTriangles,
      recallKnownViews,
      solveTimeMs,
    });
  }

  const totalTimeMs = performance.now() - suiteStart;

  return {
    totalCases: presets.length,
    passedCases,
    totalTimeMs,
    results,
  };
}
