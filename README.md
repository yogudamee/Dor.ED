# Dor.ED (EngiDraft 3D) — 工业级 2D-to-3D 精确体元代数与重投影闭环 CAD 内核系统

**Dor.ED (EngiDraft 3D)** 是一款严格遵循 **GB/T 4458.1 第一角投影标准** 与 **GB/T 4458.4 机械制图图线规范** 的逆向三维重建与画法几何智能诊断 CAD 系统。系统内置纯离线 **6 层精确体元代数与有限区间重投影闭环求解内核（Exact Profile-Product & GeneralizedLoft Volume Algebra Kernel）**，能够从任意两个正交视图自动反演水密流形三维实体（欠约束真多解按奥卡姆剃刀最小曲面复杂度排序输出 Top 4 构型），并推导定量消隐后的第三视图；同时 100% 保持桌面四视窗工作站与手机竖屏触控专版的物理级前端隔离。

---

## ✨ 六层精确体元代数与重投影闭环内核架构 (`src/kernel/`)

1. **核心坐标契约与绕序不变性层 (`core/types.ts` & `core/coordSystem.ts`)**
   - 锁定工程空间 $X, Y, Z \in [0, 120]\text{ mm}$ 与第一角视线方向（`front: +Y -> -Y`，`top: +Z -> -Z`，`left: -X -> +X`）。
   - 严格维持 `+dθ` 圆弧参数扫掠方向不变性，并对 `engineering <-> threejs`（$(X-60, Z-50, Y-60)$，$\det = -1$）坐标置换执行右手系外法向与三角面片绕序翻转校正。

2. **Layer 1 & 2 — 二维平面布置图与连续载体还原层 (`arrangement2d/`)**
   - **无损拆解与精确求交 (`preprocessAndSplit.ts`)**：将 `rect` / `polygon` 无损拆解为基础线段（严格隔离 `center_dot_dash` 与 `construction` 不参与实虚面切割），执行 Line/Circle/Arc 全图元精确求交、$\le 1.5\text{ mm}$ T 型节点打断与 $\le 2.0\text{ mm}$ 微缝桥接。
   - **DCEL 最小原子面与共弦并集 (`dcelFaces.ts`)**：基于出射切向角与有向曲率（$\pm 1/R$）构建双向连接边表（DCEL），完整保留多级并列阶梯子环，并通过共享内弦并集算子（$f_a \cup f_b$）提取共顶弦双半圆及正多边形棱柱外包络。
   - **跨孔共线缝合与连续载体还原 (`carrierGraph.ts`)**：对方向角偏差 $\le 1.0^\circ$、法向偏移 $\le 0.8\text{ mm}$ 的跨内孔/跨凸台共线实虚线段缝合还原为解析切割直线载体（独立保留 `solidIntervals` 与 `dashedIntervals` 证据），识别同轴“前实后虚”柱面载体、修剪优弧整圆载体及开放 U 型凹槽。

3. **Layer 3 — 精确解析曲面与广义直纹放样升维层 (`lifting3d/`)**
   - **解析 SDF 与广义放样算子 (`analyticSurfaces.ts`)**：内置任意斜平面（Sutherland-Hodgman 精确半空间裁剪）、圆柱、球、平底半球、圆锥/圆台及广义直纹放样体 `GeneralizedLoft`（$S(s,t) = (1-t)\Gamma_0(s) + t\Gamma_1(s)$）的精确 SDF、解析梯度与极值母线闭式求解器（$A\cos\theta + B\sin\theta = C$），**彻底杜绝正交 AABB 包围盒切块退化**。
   - **正实体升维与可见开口除料通道 (`solidVolumeBuilder.ts` & `voidChannelBuilder.ts`)**：全对称构建球、平底半球、正/偏心圆锥圆台、半圆台、正六棱柱、拱顶柱及带顶槽/切角的回转母体；严格遵循**可见开口定律**独立配对正交内环与细虚线带（交叉孔取并集除料，T 型支孔自动延展至主孔轴心，零体心孤立气泡）。

4. **Layer 4 — 代数共面消融、曲面局部截切对偶求解与 CSP 闭环层 (`solver/`)**
   - **代数布尔共面消融 (`volumeCoalescer.ts`)**：对同属正实体或同属边缘除料块的相邻单元合并消融内部贴合共面（严禁施加负向内缩产生乐高碎块沟槽）。
   - **边缘局部截切与破孔阶梯切口求解器 (`peripheralCutoutSolver.ts`)**：基于**共享轴积聚性对偶过滤定理（Shared-Axis Edge-On Duality）**过滤二次曲面截交母线伪平面，在光滑母体 $\mathcal{B}$ 内构建曲面解析子胞体复形（Curved-Analytic Sub-Cells），联合第一角虚实跃变传播、3D 邻接连通性与**对偶减法切割刷（外部空气面外扩 $+1.5\text{ mm}$、内部台阶面 $0.00\text{ mm}$ 精确贴合）**攻克外包络不变时的圆柱/套筒铣扁与破孔切口。
   - **有限线段区间级重投影验证 (`finiteReprojectionVerifier.ts`)**：严格计算投影采样点到用户实际绘制**有限线段 `[p1, p2]` 与有限圆弧段**的距离（超出端点的悬伸投影全额计入幽灵线惩罚），强制执行“无虚线不打假孔”、内部台阶线真实高度跳变与外墙防误劈三大硬约束。
   - **受保护 CSP 求解与真多解枚举 (`volumeCSPSolver.ts`)**：内置 `MAX_CSP_ITERATIONS` 与 `TIME_BUDGET_MS` 熔断保护，对欠约束两视图自动按奥卡姆剃刀最小曲面复杂度排序输出最多 **Top 4** 合法三维构型。

5. **Layer 5 — 三维曲面相贯线追踪与定量消隐重构层 (`ssi/` & `hlr/`)**
   - **解析平面-柱面截交与双曲面牛顿步进追踪 (`ssiTracer.ts`)**：内置正交切块与圆柱面闭式解析截交母线/台阶圆弧提取器，结合 $\nabla\phi_1 \times \nabla\phi_2$ 切向预测与二维正交 Newton-Raphson 校正，完整覆盖 `solid_solid`、`solid_void` 与内腔破孔/交叉孔 `void_void` 相贯线。
   - **环形肩面完整提取、刃口保护与原生图元拟合 (`edgeExtractor3D.ts` / `visibilityClassifier.ts` / `curveFitter2D.ts`)**：完整保留同轴阶梯环形肩面整圆轮廓，减法切块棱边按 CSG 有效边界面精准裁剪（跨孔自动断开），内置 26 邻域同径刃口保护与 T 型交点打断，经 6 步二分法定位遮挡跃变点并还原原生 `line / circle / arc` 及中心线。

6. **Layer 6 — 水密流形网格、GB/T 智能诊断与 16 项高阶基准自检层 (`mesh/` / `diagnostics/` / `benchmark/`)**
   - **水密流形 CSG 网格与 STL 导出 (`watertightMesher.ts`)**：采用单原语高精度参数化网格（`radialSegments = 72`）+ 二维耳切剖分 + $3 \times 3$ 面网格纯空气校验单侧外延 `1.5mm` + `three-bvh-csg` 布尔求差，过滤面积 $< 10^{-5}$ 退化面并强制校核外法向与 30° 折痕分裂法向。
   - **GB/T 4458.1 三视图诊断与单条修复 (`threeViewDiagnostics.ts`)**：支持中英繁三语的长对正、高平齐、宽相等、悬空未闭合、虚实冲突、缺失中心线及欠约束多解检测与一键修复。
   - **16 道高难度基准测试集 (`benchmarkSuite.ts`)**：覆盖三阶同轴阶梯轴、正六棱柱单孔/十字交叉孔、跨台阶半露半嵌圆柱、共顶弦双半圆八字斜孔、拱柱交叉方圆孔、圆锥横向方窗、偏心斜圆台、同径刃口空心圆台、平背半圆台、平底半球、圆锥+后半球复合体、球体开贯穿方槽、欠约束 Top 4 真多解枚举、**空心圆筒上下双阶对称铣扁与破孔切口**及**开放顶槽+底部边缘切口复合圆柱**。

---

## 📁 项目目录结构

```text
├── src/
│   ├── kernel/                       # 6 层精确体元代数与重投影闭环三维计算几何内核
│   │   ├── index.ts                  # 统一对外暴露全部 9 个 Kernel Facade API
│   │   ├── core/
│   │   │   ├── types.ts              # 内核内部高精度几何载体、DCEL、体元、SSI 与 HLR 数据契约
│   │   │   └── coordSystem.ts        # 第一角正逆投影映射、+dθ 圆弧采样与 det=-1 右手绕序校正
│   │   ├── arrangement2d/
│   │   │   ├── preprocessAndSplit.ts # 图元拆解、点画线隔离、精确求交、T 型打断与微缝桥接
│   │   │   ├── dcelFaces.ts          # 平面 DCEL 曲边最小原子面提取与共享内弦并集算子
│   │   │   └── carrierGraph.ts       # 共线实/虚载体缝合、修剪优弧整圆还原与斜虚线/凹槽识别
│   │   ├── lifting3d/
│   │   │   ├── analyticSurfaces.ts   # 解析二次曲面与 GeneralizedLoft SDF、梯度及极值母线求导
│   │   │   ├── solidVolumeBuilder.ts # 跨视图精确截面乘积、半空间裁剪与二次曲面/放样正实体升维
│   │   │   └── voidChannelBuilder.ts # 遵循可见开口定律的多轴独立通孔、斜孔与 T 型支孔升维
│   │   ├── solver/
│   │   │   ├── volumeCoalescer.ts    # 相邻正体元与减法切块内部贴合共面代数合并消融
│   │   │   ├── peripheralCutoutSolver.ts # 共享轴积聚性对偶、曲面解析子胞体与对偶减法局部截切求解器
│   │   │   ├── finiteReprojectionVerifier.ts # 有限线段/圆弧区间级双向定量消隐重投影验证器
│   │   │   └── volumeCSPSolver.ts    # 带迭代/时间预算熔断的 CSP 求解与 Top 4 真多解枚举
│   │   ├── ssi/
│   │   │   └── ssiTracer.ts          # 解析柱面截交与双曲面交线牛顿步进追踪器
│   │   ├── hlr/
│   │   │   ├── edgeExtractor3D.ts    # 3D 锐边、环形台阶整圆轮廓、极值母线与 26 邻域刃口保护
│   │   │   ├── visibilityClassifier.ts # 2D 视在交点打断、二分跃变精化与视线深度遮挡分类
│   │   │   └── curveFitter2D.ts      # 图线优先级合并、原生圆/弧/线拟合与正交中心线合成
│   │   ├── mesh/
│   │   │   └── watertightMesher.ts   # 高精度水密流形 CSG 网格生成、锐边提取与 ASCII STL 导出
│   │   ├── diagnostics/
│   │   │   └── threeViewDiagnostics.ts # GB/T 4458.1 三等对齐、拓扑闭合与虚实冲突诊断修复
│   │   ├── benchmark/
│   │   │   └── benchmarkSuite.ts     # 16 道高难度工程制图基准题库与全量自动化自检套件
│   │   └── kernel.test.ts            # 基于 node:test 的纯计算几何内核单元测试套件
│   ├── desktop/
│   │   └── DesktopApp.tsx            # 桌面端四视窗 CAD 工作站（双端物理隔离）
│   ├── mobile/
│   │   ├── MobileApp.tsx             # 手机竖屏触控专版工作台（双端物理隔离）
│   │   └── MobileCadCanvas2D.tsx     # 移动端双指捏合缩放与防遮挡偏移准星画布
│   ├── components/
│   │   ├── CadViewport2D.tsx         # 桌面端 2D 正交视图交互画布
│   │   ├── Viewport3D.tsx            # Three.js PBR 水密流形三维视窗（含 ErrorBoundary 保护）
│   │   ├── BenchmarkSelfTestModal.tsx# 14 项高阶内核基准一键自检与载入预览面板
│   │   ├── DualDownloadModal.tsx     # DXF / SVG / PNG / 水密 STL / JSON 导出中心
│   │   ├── FileExplorerPanel.tsx     # 本地工程文件与预设题库管理面板
│   │   └── SettingsModal.tsx         # 系统参数、多语言与跨平台说明面板
│   ├── utils/
│   │   ├── geometryKernel.ts         # 前端门面重导出与 12 种 2D 交互绘图编辑工具（OSNAP/Trim/Extend/Offset）
│   │   ├── csgPrimitives.ts          # 几何采样辅助桥接工具
│   │   ├── exporters.ts              # 标准 DXF / SVG / 高清 PNG / 水密 STL 导出器
│   │   └── i18n.ts                   # 简体中文 / 繁體中文 / English 国际化字典
│   ├── data/
│   │   └── presets.ts                # 经典教材题库 + 14 道高难度计算几何基准案例
│   ├── types/
│   │   ├── cad.ts                    # 全局二维图元、三维体元、投影教学步骤与诊断类型契约
│   │   └── kernel.ts                 # 扩展内核辅助类型定义
│   ├── App.tsx                       # 顶层状态协调与双端自适应入口
│   └── main.tsx                      # 应用挂载入口
├── electron/                         # Electron Windows 桌面端主进程与预加载脚本
├── capacitor.config.json             # Capacitor Android 移动端打包配置
└── package.json                      # 依赖配置与脚本
```

---

## 🚀 本地开发、内核单元测试与构建

```bash
# 1. 安装依赖
npm install

# 2. 运行计算几何内核单元测试（含 16 道基准题全量验证）
npx --yes tsx --test src/kernel/kernel.test.ts

# 3. 启动开发服务器（端口 3000）
npm run dev

# 4. TypeScript 静态类型检查与生产构建
npm run lint
npm run build
```

---

## 📄 开源协议
本项目采用 MIT License 开源，适用于画法几何教学、工程制图智能批改与计算几何固态建模研究。
