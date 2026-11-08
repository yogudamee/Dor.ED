import { LineType, SnapType, ToolType, ViewType } from "../types/cad";
export type Language = "zh-CN" | "zh-TW" | "en";
export type I18nDict = typeof I18N["zh-CN"];

// src/utils/i18n.ts
export const I18N: Record<Language, any> = {
	"zh-CN": {
		appName: "Dor.ED",
		modes: {
			free: "自由绘图",
			library: "经典题库"
		},
		topActions: {
			diagnose: "诊断",
			derive: "推导",
			export: "导出",
			settings: "设置",
			backToLibrary: "退出题库",
			resetExercise: "重置",
			dataPanel: "文件目录"
		},
		lineTypes: {
			thick_solid: "粗实线",
			thin_dashed: "细虚线",
			center_dot_dash: "细点画线",
			construction: "辅助线"
		},
		views: {
			front: "主视图",
			left: "左视图",
			top: "俯视图"
		},
		view3D: {
			front: "正视",
			left: "左视",
			top: "俯视",
			iso: "轴测",
			xray: "透视",
			fullscreen: "放大",
			exitFullscreen: "还原"
		},
		tools: {
			select: {
				label: "选择",
				desc: "拾取图元并与3D联动高亮",
				shortcut: "V"
			},
			pan: {
				label: "平移",
				desc: "单指或左键拖拽平移图纸视口",
				shortcut: "H"
			},
			line: {
				label: "直线",
				desc: "连续绘制折线段（首次右键取消起点，再次右键回选择）",
				shortcut: "L"
			},
			rect: {
				label: "矩形",
				desc: "指定对角顶点绘制矩形",
				shortcut: "R"
			},
			polygon: {
				label: "多边形",
				desc: "指定中心与半径绘制正多边形",
				shortcut: "P"
			},
			circle: {
				label: "圆",
				desc: "指定圆心与半径绘圆",
				shortcut: "C"
			},
			arc: {
				label: "圆弧",
				desc: "依次指定圆心、起点与终点角度绘弧",
				shortcut: "A"
			},
			tangent: {
				label: "切线",
				desc: "自动吸附圆周切点绘制切线",
				shortcut: "G"
			},
			trim: {
				label: "修剪",
				desc: "在交点处剪除线段或圆弧多余部分",
				shortcut: "T"
			},
			extend: {
				label: "延伸",
				desc: "将线段或圆弧延伸至最近边界",
				shortcut: "E"
			},
			offset: {
				label: "偏移",
				desc: "按设定距离生成平行线或同心圆弧",
				shortcut: "O"
			},
			erase: {
				label: "擦除",
				desc: "点击删除选中的二维图元",
				shortcut: "D"
			}
		},
		snaps: {
			title: "捕捉",
			ortho: "正交",
			items: {
				grid: {
					label: "网格",
					desc: "吸附坐标网格与跨视图对齐线"
				},
				endpoint: {
					label: "端点",
					desc: "吸附线段或圆弧端点"
				},
				midpoint: {
					label: "中点",
					desc: "吸附线段中点"
				},
				center: {
					label: "圆心",
					desc: "吸附圆或圆弧中心"
				},
				quadrant: {
					label: "象限",
					desc: "吸附圆周0°/90°/180°/270°点"
				},
				intersection: {
					label: "交点",
					desc: "吸附两图元真实交点"
				}
			}
		},
		filePanel: {
			title: "数据目录",
			appFolder: "应用目录",
			localFolder: "本地目录",
			mountDiskFolder: "选择本地文件夹",
			newDrawing: "新建空白图纸",
			saveCurrent: "保存当前图纸",
			fileNamePlaceholder: "输入文件名...",
			emptyFolder: "当前目录暂无工程文件",
			mountedLabel: "已挂载目录："
		},
		libraryView: {
			title: "经典题库",
			subtitle: "点击任一题目进入三视图工作台；退出题库后所有临时改动将自动复原。",
			enterBtn: "进入练习",
			tempNotice: "临时练习模式（退出自动还原）",
			stepsTitle: "推导步骤",
			showSteps: "显示步骤射线",
			nextStep: "下一步",
			solutionsTitle: "候选构型"
		},
		diagnoseDrawer: {
			title: "诊断内容",
			passed: "三视图校验通过",
			passedDesc: "X、Y、Z 轴向坐标完全对齐，轮廓闭合且无虚实线冲突。",
			autoFix: "全部修复",
			fixSingle: "修复此项",
			aiAnalyzeBtn: "AI 空间推理",
			aiAnalyzing: "推理中...",
			close: "关闭",
			solutionsHeader: "切换多解构型："
		},
		settingsModal: {
			title: "系统设置",
			tabs: {
				general: "常规与语言",
				aiConfig: "AI 接口配置",
				tutorial: "使用教学",
				packaging: "打包配置"
			},
			languageLabel: "界面语言",
			gridStepLabel: "网格捕捉间距",
			offsetDistLabel: "默认偏移距离",
			polygonSidesLabel: "正多边形边数",
			snapRadiusLabel: "对象捕捉灵敏度 (OSNAP)",
			autoDeriveLabel: "实时自动推导 3D 与第三视图",
			dynamicHudLabel: "绘图动态尺寸与坐标浮窗 (HUD)",
			alignmentRaysLabel: "跨视图 X/Y/Z 实时对齐射线",
			materialPresetLabel: "3D 实体工程材质",
			mobileModeLabel: "手机 Android 触控界面模式",
			materials: {
				steel: "钛合金钢",
				aluminum: "银白铝材",
				brass: "精密黄铜",
				ceramic: "工程陶瓷"
			},
			silentModeNote: "静音工程模式：全软件已永久禁用任何音效与背景音。",
			aiSection: {
				providerLabel: "预设国内直连引擎",
				endpointLabel: "接口地址 (Base URL)",
				textModelLabel: "几何与拓扑推理模型",
				visionModelLabel: "多模态视觉辅助模型",
				thinkingToggleLabel: "深度思考模式 (Thinking)",
				offlineGuarantee: "离线保障：在未配置密钥或完全断网环境下，本地 CSG 布尔重建、消隐投影及圆/线修剪延伸算法 100% 独立离线运行。"
			},
			tutorialTitle: "Dor.ED 纯文字使用教学手册",
			tutorialParagraphs: [
				{
					heading: "一、视图与坐标系约定（X / Y / Z）",
					body: "左上为主视图（反映 X 与 Z），左下为俯视图（反映 X 与 Y），右上为左视图（反映 Y 与 Z），右下为交互式 3D 视窗。在俯视图与左视图移动光标或绘图时，两视图通过共享的 Y 坐标实时投射“宽相等”对齐捕捉虚线。"
				},
				{
					heading: "二、2D 绘图、快捷键与复制粘贴规则",
					body: "1. 线型快捷键 [1 / 2 / 3 / 4]：按 1 切换粗实线、2 切换细虚线、3 切换细点画线、4 切换辅助线；若当前已选中图元，按 1/2/3/4 会直接将选中图元批量转换为对应线型。\n2. 复制与粘贴 [Ctrl+C / Ctrl+V / Ctrl+A]：在 2D 视图选中图元后按 Ctrl+C 复制，按 Ctrl+V 粘贴（自动偏移网格间距并保持选中以便直接拖拽定位），按 Ctrl+A 全选当前视图图元。\n3. 直线 [L] 支持连续绘制：左键定起点与终点，右键或按 Enter/Space 结束当前折线；修剪 [T] 与延伸 [E] 支持圆弧与直线精确交点裁剪。"
				},
				{
					heading: "三、3D 视窗操控与手机 Android 触控模式",
					body: "右下角 3D 视窗提供 [正视 | 左视 | 俯视 | 轴测 | 透视] 按钮。开启“手机 Android 触控模式”后，支持单视图全屏切换（主视/俯视/左视/3D/四视图）、双指捏合缩放平移，以及屏幕悬浮【完成线段 / 复制 / 粘贴 / 删除】触控快捷栏。"
				},
				{
					heading: "四、自由绘图文件管理与经典题库",
					body: "自由绘图与经典题库完全独立。在自由绘图模式下，点击左上角文件夹图标可展开左侧数据目录面板，支持挂载本地磁盘指定文件夹或使用应用内置目录读写。在经典题库中的任何修改仅作临时推演，退出题库后自动恢复原状。"
				}
			],
			packagingTitle: "Windows 桌面端 (.exe) 打包配置",
			packagingDesc: "项目已配置国内阿里云镜像（npmmirror），无需开启 VPN 即可在本地编译生成免安装便携版与安装向导版 .exe 文件。",
			downloadBat: "下载 Windows (.exe) 构建脚本 (.bat)",
			androidPackagingTitle: "Android 手机端 (.apk) 打包配置",
			androidPackagingDesc: "基于 Capacitor 与阿里云 Gradle 镜像一键构建独立安装的 Android 手机版 (.apk)，内置手机专属触控操作模式（双指缩放平移、单视图全屏切换与悬浮编辑栏）。",
			downloadApkBat: "下载 Android (.apk) 构建脚本 (.bat)",
			copyCmd: "复制构建命令",
			copied: "已复制"
		}
	},
	"zh-TW": {
		appName: "Dor.ED",
		modes: {
			free: "自由繪圖",
			library: "經典題庫"
		},
		topActions: {
			diagnose: "診斷",
			derive: "推導",
			export: "匯出",
			settings: "設定",
			backToLibrary: "退出題庫",
			resetExercise: "重置",
			dataPanel: "檔案目錄"
		},
		lineTypes: {
			thick_solid: "粗實線",
			thin_dashed: "細虛線",
			center_dot_dash: "細點畫線",
			construction: "輔助線"
		},
		views: {
			front: "主視圖",
			left: "左視圖",
			top: "俯視圖"
		},
		view3D: {
			front: "正視",
			left: "左視",
			top: "俯視",
			iso: "軸測",
			xray: "透視",
			fullscreen: "放大",
			exitFullscreen: "還原"
		},
		tools: {
			select: {
				label: "選擇",
				desc: "拾取圖元並與3D聯動高亮",
				shortcut: "V"
			},
			pan: {
				label: "平移",
				desc: "單指或左鍵拖曳平移圖紙視口",
				shortcut: "H"
			},
			line: {
				label: "直線",
				desc: "連續繪製折線段（首次右鍵取消起點，再次右鍵回選擇）",
				shortcut: "L"
			},
			rect: {
				label: "矩形",
				desc: "指定對角頂點繪製矩形",
				shortcut: "R"
			},
			polygon: {
				label: "多邊形",
				desc: "指定中心與半徑繪製正多邊形",
				shortcut: "P"
			},
			circle: {
				label: "圓",
				desc: "指定圓心與半徑繪圓",
				shortcut: "C"
			},
			arc: {
				label: "圓弧",
				desc: "依序指定圓心、起點與終點角度繪弧",
				shortcut: "A"
			},
			tangent: {
				label: "切線",
				desc: "自動吸附圓周切點繪製切線",
				shortcut: "G"
			},
			trim: {
				label: "修剪",
				desc: "在交點處剪除線段或圓弧多餘部分",
				shortcut: "T"
			},
			extend: {
				label: "延伸",
				desc: "將線段或圓弧延伸至最近邊界",
				shortcut: "E"
			},
			offset: {
				label: "偏移",
				desc: "按設定距離生成平行線或同心圓弧",
				shortcut: "O"
			},
			erase: {
				label: "擦除",
				desc: "點擊刪除選中的二維圖元",
				shortcut: "D"
			}
		},
		snaps: {
			title: "捕捉",
			ortho: "正交",
			items: {
				grid: {
					label: "網格",
					desc: "吸附座標網格與跨視圖對齊線"
				},
				endpoint: {
					label: "端點",
					desc: "吸附線段或圓弧端點"
				},
				midpoint: {
					label: "中點",
					desc: "吸附線段中點"
				},
				center: {
					label: "圓心",
					desc: "吸附圓或圓弧中心"
				},
				quadrant: {
					label: "象限",
					desc: "吸附圓周0°/90°/180°/270°點"
				},
				intersection: {
					label: "交點",
					desc: "吸附兩圖元真實交點"
				}
			}
		},
		filePanel: {
			title: "資料目錄",
			appFolder: "應用目錄",
			localFolder: "本機目錄",
			mountDiskFolder: "選擇本機資料夾",
			newDrawing: "新建空白圖紙",
			saveCurrent: "儲存目前圖紙",
			fileNamePlaceholder: "輸入檔名...",
			emptyFolder: "目前目錄暫無工程檔案",
			mountedLabel: "已掛載目錄："
		},
		libraryView: {
			title: "經典題庫",
			subtitle: "點擊任一題目進入三視圖工作台；退出題庫後所有臨時改動將自動復原。",
			enterBtn: "進入練習",
			tempNotice: "臨時練習模式（退出自動還原）",
			stepsTitle: "推導步驟",
			showSteps: "顯示步驟射線",
			nextStep: "下一步",
			solutionsTitle: "候選構型"
		},
		diagnoseDrawer: {
			title: "診斷內容",
			passed: "三視圖校驗通過",
			passedDesc: "X、Y、Z 軸向座標完全對齊，輪廓閉合且無虛實線衝突。",
			autoFix: "全部修復",
			fixSingle: "修復此項",
			aiAnalyzeBtn: "AI 空間推理",
			aiAnalyzing: "推理中...",
			close: "關閉",
			solutionsHeader: "切換多解構型："
		},
		settingsModal: {
			title: "系統設定",
			tabs: {
				general: "常規與語言",
				aiConfig: "AI 介面配置",
				tutorial: "使用教學",
				packaging: "打包配置"
			},
			languageLabel: "介面語言",
			gridStepLabel: "網格捕捉間距",
			offsetDistLabel: "預設偏移距離",
			polygonSidesLabel: "正多邊形邊數",
			snapRadiusLabel: "物件捕捉靈敏度 (OSNAP)",
			autoDeriveLabel: "即時自動推導 3D 與第三視圖",
			dynamicHudLabel: "繪圖動態尺寸與座標浮窗 (HUD)",
			alignmentRaysLabel: "跨視圖 X/Y/Z 即時對齊射線",
			materialPresetLabel: "3D 實體工程材質",
			mobileModeLabel: "手機 Android 觸控介面模式",
			materials: {
				steel: "鈦合金鋼",
				aluminum: "銀白鋁材",
				brass: "精密黃銅",
				ceramic: "工程陶瓷"
			},
			silentModeNote: "靜音工程模式：全軟體已永久停用任何音效與背景音。",
			aiSection: {
				providerLabel: "預設直連引擎",
				endpointLabel: "介面位址 (Base URL)",
				textModelLabel: "幾何與拓撲推理模型",
				visionModelLabel: "多模態視覺輔助模型",
				thinkingToggleLabel: "深度思考模式 (Thinking)",
				offlineGuarantee: "離線保障：在未配置金鑰或完全斷網環境下，本機 CSG 布林重建、消隱投影及圓/線修剪延伸演算法 100% 獨立離線運行。"
			},
			tutorialTitle: "Dor.ED 純文字使用教學手冊",
			tutorialParagraphs: [
				{
					heading: "一、視圖與座標系約定（X / Y / Z）",
					body: "左上為主視圖（反映 X 與 Z），左下為俯視圖（反映 X 與 Y），右上為左視圖（反映 Y 與 Z），右下為互動式 3D 視窗。在俯視圖與左視圖移動游標或繪圖時，兩視圖透過共享的 Y 座標即時投射「寬相等」對齊捕捉虛線。"
				},
				{
					heading: "二、2D 繪圖、快速鍵與複製貼上規則",
					body: "1. 線型快速鍵 [1 / 2 / 3 / 4]：按 1 切換粗實線、2 切換細虛線、3 切換細點畫線、4 切換輔助線；若目前已選中圖元，按 1/2/3/4 會直接將選中圖元批次轉換為對應線型。\n2. 複製與貼上 [Ctrl+C / Ctrl+V / Ctrl+A]：在 2D 視圖選中圖元後按 Ctrl+C 複製，按 Ctrl+V 貼上，按 Ctrl+A 全選目前視圖圖元。\n3. 直線 [L] 支援連續繪製：左鍵定起點與終點，右鍵或按 Enter/Space 結束目前折線。"
				},
				{
					heading: "三、3D 視窗操控與手機 Android 觸控模式",
					body: "右下角 3D 視窗提供 [正視 | 左視 | 俯視 | 軸測 | 透視] 按鈕。開啟「手機 Android 觸控模式」後，支援單視圖全螢幕切換、雙指捏合縮放平移，以及懸浮【完成線段 / 複製 / 貼上 / 刪除】觸控快捷欄。"
				},
				{
					heading: "四、自由繪圖檔案管理與經典題庫",
					body: "自由繪圖與經典題庫完全獨立。在自由繪圖模式下，點擊左上角資料夾圖示可展開左側資料目錄面板，支援掛載本機磁碟指定資料夾或使用應用內建目錄讀寫。在經典題庫中的任何修改僅作臨時推演，退出題庫後自動恢復原狀。"
				}
			],
			packagingTitle: "Windows 桌面端 (.exe) 打包配置",
			packagingDesc: "專案已配置國內鏡像（npmmirror），無需開啟 VPN 即可在本機編譯生成免安裝便攜版與安裝精靈版 .exe 檔案。",
			downloadBat: "下載 Windows (.exe) 建置腳本 (.bat)",
			androidPackagingTitle: "Android 手機端 (.apk) 打包配置",
			androidPackagingDesc: "基於 Capacitor 與阿里雲 Gradle 鏡像一鍵建置獨立安裝的 Android 手機版 (.apk)，內建手機專屬觸控操作模式。",
			downloadApkBat: "下載 Android (.apk) 建置腳本 (.bat)",
			copyCmd: "複製建置命令",
			copied: "已複製"
		}
	},
	en: {
		appName: "Dor.ED",
		modes: {
			free: "Free CAD",
			library: "Library"
		},
		topActions: {
			diagnose: "Diagnose",
			derive: "Derive",
			export: "Export",
			settings: "Settings",
			backToLibrary: "Exit Library",
			resetExercise: "Reset",
			dataPanel: "Files"
		},
		lineTypes: {
			thick_solid: "Solid",
			thin_dashed: "Dashed",
			center_dot_dash: "Center",
			construction: "Guide"
		},
		views: {
			front: "Front",
			left: "Left",
			top: "Top"
		},
		view3D: {
			front: "Front",
			left: "Left",
			top: "Top",
			iso: "ISO",
			xray: "X-Ray",
			fullscreen: "Expand",
			exitFullscreen: "Restore"
		},
		tools: {
			select: {
				label: "Select",
				desc: "Pick entity and highlight 3D feature",
				shortcut: "V"
			},
			pan: {
				label: "Pan",
				desc: "Drag to pan the 2D drawing viewport",
				shortcut: "H"
			},
			line: {
				label: "Line",
				desc: "Draw continuous chained lines (1st right-click ends chain, 2nd returns to Select)",
				shortcut: "L"
			},
			rect: {
				label: "Rect",
				desc: "Draw rectangle by two diagonal corners",
				shortcut: "R"
			},
			polygon: {
				label: "Polygon",
				desc: "Draw regular polygon by center and radius",
				shortcut: "P"
			},
			circle: {
				label: "Circle",
				desc: "Draw circle by center and radius",
				shortcut: "C"
			},
			arc: {
				label: "Arc",
				desc: "Draw circular arc by center, start, and end angle",
				shortcut: "A"
			},
			tangent: {
				label: "Tangent",
				desc: "Snap to circle tangent point automatically",
				shortcut: "G"
			},
			trim: {
				label: "Trim",
				desc: "Trim line, circle, or arc at nearest intersections",
				shortcut: "T"
			},
			extend: {
				label: "Extend",
				desc: "Extend line or arc to nearest boundary",
				shortcut: "E"
			},
			offset: {
				label: "Offset",
				desc: "Create parallel line or concentric circle/arc",
				shortcut: "O"
			},
			erase: {
				label: "Erase",
				desc: "Delete clicked entity",
				shortcut: "D"
			}
		},
		snaps: {
			title: "Snap",
			ortho: "Ortho",
			items: {
				grid: {
					label: "Grid",
					desc: "Snap to coordinate grid and cross-view alignment"
				},
				endpoint: {
					label: "End",
					desc: "Snap to segment or arc endpoints"
				},
				midpoint: {
					label: "Mid",
					desc: "Snap to segment midpoint"
				},
				center: {
					label: "Cen",
					desc: "Snap to circle or arc center"
				},
				quadrant: {
					label: "Quad",
					desc: "Snap to 0°/90°/180°/270° quadrant points"
				},
				intersection: {
					label: "Int",
					desc: "Snap to exact intersection point"
				}
			}
		},
		filePanel: {
			title: "Data Panel",
			appFolder: "App Folder",
			localFolder: "Disk Folder",
			mountDiskFolder: "Select Local Folder",
			newDrawing: "New Blank Drawing",
			saveCurrent: "Save Drawing",
			fileNamePlaceholder: "File name...",
			emptyFolder: "No CAD files in this folder",
			mountedLabel: "Mounted: "
		},
		libraryView: {
			title: "Classic Library",
			subtitle: "Select an exercise to open its 3-view workspace. Changes reset automatically upon exit.",
			enterBtn: "Open",
			tempNotice: "Sandbox Mode (Resets on exit)",
			stepsTitle: "Steps",
			showSteps: "Show Step Rays",
			nextStep: "Next Step",
			solutionsTitle: "Solutions"
		},
		diagnoseDrawer: {
			title: "Diagnostics",
			passed: "All Views Valid",
			passedDesc: "X, Y, Z coordinates are aligned, loops are closed, and hidden lines match.",
			autoFix: "Fix All",
			fixSingle: "Fix Issue",
			aiAnalyzeBtn: "AI Reasoning",
			aiAnalyzing: "Analyzing...",
			close: "Close",
			solutionsHeader: "Candidate Solutions:"
		},
		settingsModal: {
			title: "Settings",
			tabs: {
				general: "General",
				aiConfig: "AI Engine",
				tutorial: "User Guide",
				packaging: "EXE Build"
			},
			languageLabel: "Language",
			gridStepLabel: "Grid Snap Step",
			offsetDistLabel: "Offset Distance",
			polygonSidesLabel: "Polygon Sides",
			snapRadiusLabel: "OSNAP Sensitivity Radius",
			autoDeriveLabel: "Auto-Derive 3D & Third View",
			dynamicHudLabel: "Dynamic Dimension & Coord HUD",
			alignmentRaysLabel: "Cross-View X/Y/Z Alignment Rays",
			materialPresetLabel: "3D Solid Material Preset",
			mobileModeLabel: "Mobile Android Touch UI Mode",
			materials: {
				steel: "Titanium Steel",
				aluminum: "Silver Aluminum",
				brass: "Precision Brass",
				ceramic: "Tech Ceramic"
			},
			silentModeNote: "Silent CAD Mode: All audio and sound effects are permanently disabled.",
			aiSection: {
				providerLabel: "Direct AI Engine",
				endpointLabel: "Endpoint (Base URL)",
				textModelLabel: "Geometry & Topology Model",
				visionModelLabel: "Multimodal Vision Model",
				thinkingToggleLabel: "Deep Thinking Mode",
				offlineGuarantee: "Offline Guarantee: Local CSG boolean reconstruction, hidden-line projection, and circle/line trim/extend operate 100% offline without network dependencies."
			},
			tutorialTitle: "Dor.ED Plain-Text User Guide",
			tutorialParagraphs: [
				{
					heading: "1. Coordinate System & Views (X / Y / Z)",
					body: "Top-Left is Front (X, Z), Bottom-Left is Top (X, Y), Top-Right is Left (Y, Z), and Bottom-Right is the 3D viewport. Moving the cursor or drawing in Top (X, Y) and Left (Y, Z) directly projects synchronized Y-coordinate alignment dashed lines between the two views."
				},
				{
					heading: "2. 2D Drawing, Shortcuts & Copy/Paste Rules",
					body: "1. Line Type Shortcuts [1 / 2 / 3 / 4]: Press 1 for Solid, 2 for Dashed, 3 for Center, 4 for Guide. If entities are selected, pressing 1/2/3/4 batch-converts their line type.\n2. Copy & Paste [Ctrl+C / Ctrl+V / Ctrl+A]: Select entities and press Ctrl+C to copy, Ctrl+V to paste with automatic grid offset, or Ctrl+A to select all in the active view.\n3. Line [L] supports continuous chaining: right-click or press Enter/Space to end chain."
				},
				{
					heading: "3. 3D Viewport Controls & Mobile Android Touch Mode",
					body: "The top-left of the 3D viewport provides [Front | Left | Top | ISO | X-Ray]. Enabling Mobile Touch Mode switches to a touch-optimized layout with full-screen single-view tabs, two-finger pinch zoom/pan, and floating Copy/Paste/Delete/Finish action buttons."
				},
				{
					heading: "4. Free CAD File Manager & Classic Library",
					body: "Free CAD and Classic Library run independently. In Free CAD, toggle the left Data Panel to mount a local disk folder or use the built-in app folder. In Classic Library, any edits reset automatically when you exit."
				}
			],
			packagingTitle: "Windows Desktop (.exe) Build Setup",
			packagingDesc: "Configured with mirror acceleration for building standalone Portable and NSIS installer .exe packages.",
			downloadBat: "Download Windows (.exe) Script (.bat)",
			androidPackagingTitle: "Android Mobile (.apk) Build Setup",
			androidPackagingDesc: "Powered by Capacitor & Gradle mirrors to package a standalone Android (.apk) with dedicated mobile touch controls.",
			downloadApkBat: "Download Android (.apk) Script (.bat)",
			copyCmd: "Copy Command",
			copied: "Copied"
		}
	}
};
