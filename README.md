# Dor.ED — 工业级 2D-to-3D 逆向工程与智能制图诊断 CAD 内核系统

**Dor.ED** 是一款严格遵循 **GB/T 4458.1 第一角画法** 与 **GB/T 4458.4 机械制图图线标准** 的计算几何逆向工程与画法几何智能诊断 CAD 系统。系统内置纯离线 **6 层计算几何与三维曲边体元约束满足求解引擎（6-Layer Computational Geometry & 3D Cellular CSP Kernel）**，能够从任意两个正交视图自动反演具有零重投影残差的三维水密流形实体（支持物理真多解按奥卡姆剃刀复杂度排序输出前 4 组构型），并推导定量消隐后的第三视图；同时保持桌面四视图工作站与手机竖屏触控专版的物理级前端隔离。

---

## ✨ 六层计算几何与体元求解内核架构 (`src/kernel/`)

1. **Layer 1 — 2D 平面布置图与载体还原层 (`arrangement2d`)**
   - **精确求交与微缝桥接 (`snapAndSplit.ts`)**：支持 Line-Line、Line-Circle/Arc、Circle-Circle 精确解析求交、T 型节点/切点打断、$\le 1.2^\circ$ 正交微偏校准、$\le 2.5\text{mm}$ 端点微缝桥接以及实虚重叠优先级去重（`thick_solid > thin_dashed > center_dot_dash`）。
   - **DCEL 最小原子面与并集环提取 (`dcelBuilder.ts`)**：基于出射切向角与有向曲率（$\pm 1/R$）构建平面双向连接边表（DCEL），自动剪除悬空毛刺边，提取全部最小闭合子环与多面并集轮廓，杜绝丢失多级叠放阶梯。
   - **解析载体自动缝合 (`carrierReconstruction.ts`)**：自动将被圆孔或内框打断的共线实/虚线段缝合还原为贯穿母线，将同心实弧+虚弧或修剪优弧还原为完整解析圆，并统一识别平行细虚线带与八字形斜细虚线对。

2. **Layer 2 — 3D 解析半空间与广义直纹放样升维层 (`lifting3d`)**
   - **广义直纹放样算子 (`GeneralizedLoft`)**：统一通过 $\mathcal{S}(s,t) = (1-t)\Gamma_0(s) + t\Gamma_1(s)$ 参数化表达正/斜/偏心圆锥与圆台、共顶弦半圆锥、半圆台斜通孔及多级同轴回转体，内置解析有向距离场（SDF）、解析梯度及闭式三角方程转向轮廓母线求解器（$A\cos\theta + B\sin\theta = C$）。
   - **全对称跨视图射影升维 (`candidateLifter.ts`)**：对主-俯（V-H）、主-左（V-W）、俯-左（H-W）完全对称处理，自动配对生成多级同轴阶梯凸台、球/平底半球/圆锥+半球复合回转体、斜置锥台通孔以及受内部实线环锁定的有界盲槽/局部正交内孔。

3. **Layer 3 — 三维曲边体元分解与布尔 CSP 约束求解层 (`solver`)**
   - **曲边原子体元复形 (`CellComplex3D`)**：在两视图射影视觉包络（Visual Hull）内，采用**解析半空间符号向量** $\boldsymbol{\sigma}_k \in \{-1, +1\}^M$ 与自适应八叉树/曲面交点**见证点（Witness Points）**精确定义曲边原子体元，绝不使用粗糙多面体近似二次曲面。
   - **预编译双向定量重投影评估器 (`reprojectionVerifier.ts`)**：基于视线射线采样点的 $O(M)$ 半空间查表与差分深度对 `(rayMinus, rayPlus)` 毫秒级计算已知两视图实线/虚线召回率与幻影线条惩罚，搜索全程零 Three.js 网格开销。
   - **分支定界求解与布尔代数化简 (`cspOccupancySolver.ts`)**：结合单元传播（空视线剪枝 + 唯一支撑强制）与受保护分支定界搜索（内置迭代节点上限与超时熔断），按奥卡姆剃刀最少暴露边界面积排序输出最多 **Top 4** 零残差合法三维构型，并对相邻实心体元（$x_a = x_b = 1$）执行布尔代数合并消去内部共面缝隙。

4. **Layer 4 — 三维曲面相贯线数值追踪层 (`ssi`)**
   - **预测-校正牛顿步进追踪器 (`ssiMarchingTracer.ts`)**：沿双曲面叉积切向量 $\mathbf{t} = \nabla f_1 \times \nabla f_2$ 步进并执行二维 Newton-Raphson 投影校正，精确生成正交/偏心异径圆柱双曲鞍形相贯线、圆锥开槽截交抛物/椭圆弧等高阶空间交线。

5. **Layer 5 — 定量消隐与 GB/T 标准图线重构层 (`hlr`)**
   - **环形台阶肩面与薄壁刃口保护 (`silhouetteAndCrease.ts`)**：完整保留同轴阶梯圆柱/圆台外圈环形肩面（$r \in [R_1, R_2]$）的三维整圆边界，确保侧视图投射出不间断贯穿粗实线；同时对同径内孔与锥台顶面相接处（$r_{\text{hole}} \approx R_{\min}$）实施薄壁刃口保护，并将除料孔内壁母线严格裁剪在基体实心内部锁定为 `thin_dashed`。
   - **二分跃变精化与图线合成 (`quantitativeHLR.ts` & `curveReconstruction2D.ts`)**：通过 6 步二分法精确定位遮挡可见性跃变点，严格按 `thick_solid > thin_dashed > center_dot_dash` 优先级合并共线线段与同心圆弧，输出纯净原生 CAD 图元与标准十字中心线/回转轴线。

6. **Layer 6 — 锐边水密流形网格、智能诊断与 19 题基准自检层 (`mesh` / `diagnostics` / `benchmark`)**
   - **统一锐边水密流形网格 (`manifoldMesher.ts`)**：严禁使用导致机械棱角圆钝的 Marching Cubes；针对任意凸/凹多边形棱柱、棱锥、棱台及多边形内腔通孔采用精确顶点半空间裁剪与二维耳切法（Ear-Clipping）三角剖分，结合开口轴向单侧空气延展与 28° 面积加权折痕分裂法向消除孔口锯齿毛刺；`Viewport3D` WebGL 渲染与 `.STL` 工业实体导出统一共用代数微融合 + BVH-CSG 精确裁剪流形网格器（强制校核 `Number.isFinite` 与外法向逆时针绕序 Outward CCW）。
   - **GB/T 4458.1 智能诊断与一键修复 (`gbtDiagnostics.ts`)**：支持长对正（$\Delta X$）、高平齐（$\Delta Z$）、宽相等（$\Delta Y$）、悬空未闭合轮廓以及圆十字中心线/回转轴线缺失检测与单条精准修复。
   - **19 项高阶魔鬼题基准自检 (`selfTestSuite.ts` & `BenchmarkSelfTestModal.tsx`)**：内置 19 道高难度工程制图变形题（覆盖正六棱柱单圆通孔、正六棱柱正交三通圆孔 45° 相贯、正六棱柱、横向六棱柱、正六棱锥、正六棱台、内六角通孔、三阶阶梯轴、偏心斜圆台、同径刃口圆台、锥球复合体、共弦双半圆斜孔、圆锥双曲线截交、马鞍相贯与多解枚举，同步接入前端题库与一键自检面板），实时校验体元数量、重投影精度、导出图线分类与流形三角面片水密性。

---

## 🖥️ 双端物理隔离与核心交互契约

- **桌面端四视图工作站 (`src/desktop/DesktopApp.tsx`)**：四宫格标准三视图（主 V / 左 W / 俯 H）+ 交互式 PBR 3D 视窗（内置 React Error Boundary 异常隔离保护）、完整对象捕捉（OSNAP）、动态尺寸 HUD、键盘快捷键与右侧诊断/教学分步抽屉。
- **手机竖屏触控专版 (`src/mobile/MobileApp.tsx`)**：独立 `100dvh` 竖屏组件树（宽屏支持 9:19.5 真机壳模拟预览），配备顶部三等关系对齐联动窗、单指 36px 防遮挡偏移十字准星、双指捏合缩放平移与底部双层大尺寸拇指工具栏。
- **严格手动【推导】与自由二次编辑**：系统绝不在绘图过程中自动重算覆盖画布；仅在点击 **【推导】** 按钮时执行一次内核求解，推导写入目标视图的所有图元均支持自由点选、夹点编辑、修剪（Trim）、延伸（Extend）、擦除与 `Delete`/`Backspace` 删除。

---

## 📁 项目目录结构

```text
├── src/
│   ├── kernel/                       # 6 层工业级计算几何与 3D 体元 CSP 逆向内核
│   │   ├── types.ts                  # 内核全链路数据结构与类型契约
│   │   ├── arrangement2d/            # Layer 1: 精确求交打断、DCEL 最小原子面与载体缝合还原
│   │   │   ├── snapAndSplit.ts
│   │   │   ├── dcelBuilder.ts
│   │   │   └── carrierReconstruction.ts
│   │   ├── lifting3d/                # Layer 2: GeneralizedLoft 算子、解析半空间与全对称跨视图升维
│   │   │   ├── generalizedLoft.ts
│   │   │   ├── surfacePrimitives.ts
│   │   │   └── candidateLifter.ts
│   │   ├── solver/                   # Layer 3: 曲边体元复形、预编译重投影验证器与分支定界 CSP 求解器
│   │   │   ├── cellDecomposition.ts
│   │   │   ├── reprojectionVerifier.ts
│   │   │   └── cspOccupancySolver.ts
│   │   ├── ssi/                      # Layer 4: 三维双曲面相贯线预测-校正牛顿追踪器
│   │   │   └── ssiMarchingTracer.ts
│   │   ├── hlr/                      # Layer 5: 锐边/转向轮廓提取、定量消隐与纯净 2D 图线合成
│   │   │   ├── silhouetteAndCrease.ts
│   │   │   ├── quantitativeHLR.ts
│   │   │   └── curveReconstruction2D.ts
│   │   ├── mesh/                     # Layer 6a: 锐边水密流形网格生成器与 ASCII STL 导出器
│   │   │   └── manifoldMesher.ts
│   │   ├── diagnostics/              # Layer 6b: GB/T 4458.1 三等关系与中心线智能诊断及自动修复
│   │   │   └── gbtDiagnostics.ts
│   │   ├── benchmark/                # Layer 6c: 19 道高难度工程制图基准测试集与自动化回归验证
│   │   │   ├── benchmarkCases.ts
│   │   │   └── selfTestSuite.ts
│   │   ├── pipeline.ts               # 端到端逆向重建与第三视图推导主编排管线
│   │   └── index.ts                  # 内核统一导出入口
│   ├── desktop/
│   │   └── DesktopApp.tsx            # 桌面端四视图 CAD 工作站（物理隔离）
│   ├── mobile/
│   │   ├── MobileApp.tsx             # 手机竖屏触控专版工作台（物理隔离）
│   │   └── MobileCadCanvas2D.tsx     # 移动端双指缩放与防遮挡准星画布
│   ├── components/
│   │   ├── CadViewport2D.tsx         # 桌面端 2D 正交视图交互画布
│   │   ├── Viewport3D.tsx            # Three.js PBR 水密流形渲染视窗（含 ErrorBoundary 保护）
│   │   ├── BenchmarkSelfTestModal.tsx# 19 项内核基准一键自检与载入预览面板
│   │   ├── DualDownloadModal.tsx     # DXF / SVG / PNG / 水密 STL / JSON 双端导出中心
│   │   ├── FileExplorerPanel.tsx     # 本地工程文件管理面板
│   │   └── SettingsModal.tsx         # 系统参数、多语言与跨平台打包配置
│   ├── utils/
│   │   ├── geometryKernel.ts         # 兼容前端调用的内核门面 API 与 2D 交互几何工具（OSNAP/Trim/Extend/Offset）
│   │   ├── csgPrimitives.ts          # 3D 原语与多边形采样门面桥接层
│   │   ├── exporters.ts              # 标准 DXF / SVG / 高清 PNG / 水密流形 STL 导出器
│   │   └── i18n.ts                   # 简体中文 / 繁體中文 / English 国际化字典
│   ├── data/
│   │   └── presets.ts                # 经典教材题库 + 19 道高阶计算几何基准测试案例
│   ├── types/
│   │   └── cad.ts                    # 全局 CAD 图元、三维原语与诊断类型定义
│   ├── App.tsx                       # 顶层状态协调与双端路由入口
│   └── main.tsx                      # 应用挂载入口
├── electron/
│   └── main.cjs                      # Electron Windows 桌面端主进程
├── capacitor.config.json             # Capacitor Android 移动端配置
└── package.json                      # 依赖配置与构建脚本
```

---

## ⌨️ 桌面端键盘快捷键

| 快捷键 | 功能说明 | 备注 |
| :--- | :--- | :--- |
| **`1` / `2` / `3` / `4`** | 切换 **粗实线 / 细虚线 / 细点画线 / 辅助线** | 选中图元时可直接批量修改线型 |
| **`V` / `H`** | **选择工具** / **手型平移** | 支持夹点拖拽、窗口选与交叉选 |
| **`L` / `R` / `P`** | **直线** / **矩形** / **正多边形** | 直线支持连续折线绘制（右键或 `Enter` 结束） |
| **`C` / `A` / `G`** | **圆** / **圆弧** / **几何公切线** | 自动计算并吸附圆周精确切点 |
| **`T` / `E` / `O` / `D`** | **修剪 (Trim)** / **延伸 (Extend)** / **偏移 (Offset)** / **擦除** | 实时精确交点裁剪与同心偏移 |
| **`F8`** | 开启 / 关闭 **正交锁定 (Ortho)** | 按住 `Shift` 支持 45° 极轴锁定 |
| **`Ctrl + Z` / `Ctrl + Y`** | **撤销** / **重做** | 最多保存 100 步历史栈 |
| **`Delete` / `Backspace`** | **删除**当前选中的图元（含推导生成的图元） | 绝不触发自动重算回弹 |

---

## 🚀 本地开发、验证与跨平台构建

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器（端口 3000）
npm run dev

# 3. TypeScript 静态类型检查与生产构建
npm run lint
npm run build
```

- **Windows 桌面端打包 (`.exe`)**：`npm run build:exe`（基于 Electron + `electron-builder`）。
- **Android 移动端打包 (`.apk`)**：执行 `build-android-apk.bat` 或通过 Capacitor 同步构建 `npx cap sync android`。

---

## 📄 开源协议
本项目采用 MIT License 开源，适用于画法几何教学、工程制图智能批改与计算几何固态建模研究。
