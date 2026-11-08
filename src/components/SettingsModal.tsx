import * as import_react from "react";
import * as import_jsx_runtime from "react/jsx-runtime";
import { Check, Copy, Cpu, Terminal, X } from "lucide-react";
import { downloadTextFile } from "../utils/exporters";

// src/components/SettingsModal.tsx
var BUILD_BAT_SCRIPT = `@echo off
chcp 65001 >nul
echo ====================================================================
echo   Dor.ED — Windows Desktop (.exe) Build Script (China Mirror)
echo ====================================================================
set npm_config_registry=https://registry.npmmirror.com/
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
call npm install --registry=https://registry.npmmirror.com/
call npm install -D electron electron-builder --registry=https://registry.npmmirror.com/
call npm run build
call npx electron-builder --win --x64
pause`;
var BUILD_ANDROID_APK_SCRIPT = `@echo off
chcp 65001 >nul
echo ====================================================================
echo   Dor.ED — Android Mobile (.apk) One-Click Build Script
echo ====================================================================
set npm_config_registry=https://registry.npmmirror.com/
call npm install --registry=https://registry.npmmirror.com/
call npm install @capacitor/core @capacitor/cli @capacitor/android --registry=https://registry.npmmirror.com/
call npm run build
if not exist android (
  call npx cap add android
)
call npx cap sync android
cd android
call gradlew.bat assembleDebug
echo ====================================================================
echo   APK 生成成功: android\\app\\build\\outputs\\apk\\debug\\app-debug.apk
echo ====================================================================
pause`;
export const SettingsModal: any = ({
	isOpen,
	onClose,
	language,
	onChangeLanguage,
	gridStep,
	onChangeGridStep,
	offsetDistance,
	onChangeOffsetDistance,
	polygonSides,
	onChangePolygonSides,
	snapTolerance = 11,
	onChangeSnapTolerance = (_v?: any) => {},
	autoDerive = true,
	onChangeAutoDerive = (_v?: any) => {},
	showDynamicHUD = true,
	onChangeShowDynamicHUD = (_v?: any) => {},
	showAlignmentRays = true,
	onChangeShowAlignmentRays = (_v?: any) => {},
	materialPreset = "steel",
	onChangeMaterialPreset = (_v?: any) => {},
	mobileMode = false,
	onChangeMobileMode = (_v?: any) => {},
	aiModel,
	onChangeAiModel,
	aiThinking,
	onChangeAiThinking,
	dict
}) => {
	const [activeTab, setActiveTab] = (0, import_react.useState)("general");
	const [copied, setCopied] = (0, import_react.useState)(false);
	const [copiedApk, setCopiedApk] = (0, import_react.useState)(false);
	if (!isOpen) return null;
	const handleCopyCmd = () => {
		navigator.clipboard.writeText("npm install && npm install -D electron electron-builder && npm run build:exe");
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};
	const handleCopyApkCmd = () => {
		navigator.clipboard.writeText("npm install @capacitor/core @capacitor/cli @capacitor/android && npm run build && npx cap add android && npx cap sync android && cd android && ./gradlew assembleDebug");
		setCopiedApk(true);
		setTimeout(() => setCopiedApk(false), 1600);
	};
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 select-none",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "bg-[#111827] border border-[#263244] rounded-xl w-full max-w-2xl max-h-[84vh] flex flex-col overflow-hidden shadow-2xl",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center justify-between px-5 py-3.5 border-b border-[#263244] bg-[#0D131F]",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-sm font-semibold text-white",
						children: dict.title
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onClose,
						className: "p-1 rounded-lg text-[#94A3B8] hover:text-white hover:bg-[#1E293B]",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "w-4 h-4" })
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "flex items-center gap-2 px-5 py-2 bg-[#0B0F17] border-b border-[#263244] text-xs",
					children: [
						{
							id: "general",
							label: dict.tabs.general
						},
						{
							id: "aiConfig",
							label: dict.tabs.aiConfig
						},
						{
							id: "tutorial",
							label: dict.tabs.tutorial
						},
						{
							id: "packaging",
							label: dict.tabs.packaging
						}
					].map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: () => setActiveTab(t.id),
						className: `px-3 py-1.5 rounded font-medium transition-colors ${activeTab === t.id ? "bg-[#0284C7] text-white" : "text-[#94A3B8] hover:text-white hover:bg-[#161F2E]"}`,
						children: t.label
					}, t.id))
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "p-5 overflow-y-auto space-y-5 text-xs",
					children: [
						activeTab === "general" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "space-y-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.languageLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "flex items-center gap-1.5",
										children: [
											{
												id: "zh-CN",
												label: "简体中文"
											},
											{
												id: "zh-TW",
												label: "繁體中文"
											},
											{
												id: "en",
												label: "English"
											}
										].map((lang) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
											onClick: () => onChangeLanguage(lang.id),
											className: `px-3 py-1.5 rounded font-medium transition-colors ${language === lang.id ? "bg-[#0284C7] text-white" : "bg-[#0B0F17] text-[#94A3B8] hover:text-white border border-[#263244]"}`,
											children: lang.label
										}, lang.id))
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.gridStepLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "flex items-center gap-2",
										children: [
											2,
											4,
											5,
											10
										].map((val) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
											onClick: () => onChangeGridStep(val),
											className: `px-2.5 py-1 rounded font-mono ${gridStep === val ? "bg-[#0284C7] text-white" : "bg-[#0B0F17] text-[#94A3B8] border border-[#263244]"}`,
											children: val
										}, val))
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.offsetDistLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										type: "number",
										min: 1,
										max: 50,
										value: offsetDistance,
										onChange: (e) => onChangeOffsetDistance(Math.max(1, Number(e.target.value))),
										className: "w-20 bg-[#0B0F17] border border-[#263244] rounded px-2.5 py-1 text-right font-mono text-white"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.polygonSidesLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										type: "number",
										min: 3,
										max: 12,
										value: polygonSides,
										onChange: (e) => onChangePolygonSides(Math.max(3, Math.min(12, Number(e.target.value)))),
										className: "w-20 bg-[#0B0F17] border border-[#263244] rounded px-2.5 py-1 text-right font-mono text-white"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.snapRadiusLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "flex items-center gap-2",
										children: [8, 11, 15].map((val) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
											onClick: () => onChangeSnapTolerance(val),
											className: `px-2.5 py-1 rounded font-mono ${snapTolerance === val ? "bg-[#0284C7] text-white" : "bg-[#0B0F17] text-[#94A3B8] border border-[#263244]"}`,
											children: [val, "px"]
										}, val))
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.autoDeriveLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										onClick: () => onChangeAutoDerive(!autoDerive),
										className: `px-3 py-1 rounded font-mono font-semibold transition-colors ${autoDerive ? "bg-[#059669] text-white" : "bg-[#0B0F17] text-[#64748B] border border-[#263244]"}`,
										children: autoDerive ? "ON" : "OFF"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.dynamicHudLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										onClick: () => onChangeShowDynamicHUD(!showDynamicHUD),
										className: `px-3 py-1 rounded font-mono font-semibold transition-colors ${showDynamicHUD ? "bg-[#059669] text-white" : "bg-[#0B0F17] text-[#64748B] border border-[#263244]"}`,
										children: showDynamicHUD ? "ON" : "OFF"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.alignmentRaysLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										onClick: () => onChangeShowAlignmentRays(!showAlignmentRays),
										className: `px-3 py-1 rounded font-mono font-semibold transition-colors ${showAlignmentRays ? "bg-[#059669] text-white" : "bg-[#0B0F17] text-[#64748B] border border-[#263244]"}`,
										children: showAlignmentRays ? "ON" : "OFF"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.materialPresetLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "flex items-center gap-1.5",
										children: ["steel", "aluminum", "brass", "ceramic"].map((matKey) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
											onClick: () => onChangeMaterialPreset(matKey),
											className: `px-2.5 py-1 rounded font-medium transition-colors ${materialPreset === matKey ? "bg-[#0284C7] text-white" : "bg-[#0B0F17] text-[#94A3B8] hover:text-white border border-[#263244]"}`,
											children: dict.materials?.[matKey] || matKey
										}, matKey))
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.mobileModeLabel || "手机 Android 触控界面模式"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										onClick: () => onChangeMobileMode(!mobileMode),
										className: `px-3 py-1 rounded font-mono font-semibold transition-colors ${mobileMode ? "bg-[#059669] text-white" : "bg-[#0B0F17] text-[#64748B] border border-[#263244]"}`,
										children: mobileMode ? "ON" : "OFF"
									})]
								})
							]
						}),
						activeTab === "aiConfig" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "space-y-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.aiSection.providerLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "px-2.5 py-1 rounded bg-[#0B0F17] border border-[#263244] text-[#38BDF8] font-mono font-medium flex items-center gap-1.5",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Cpu, { className: "w-3.5 h-3.5" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Zhipu BigModel (CN Direct)" })]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "p-3 rounded-lg bg-[#161F2E] border border-[#263244] space-y-1.5",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "font-medium text-white",
										children: dict.aiSection.endpointLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "px-2.5 py-1.5 rounded bg-[#0B0F17] border border-[#1E293B] font-mono text-[11px] text-[#10B981] select-all",
										children: "https://open.bigmodel.cn/api/paas/v4/chat/completions"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: aiModel === "glm-4.5-flash" ? dict.aiSection.textModelLabel : dict.aiSection.visionModelLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "flex items-center gap-1.5",
										children: ["glm-4.5-flash", "glm-4v-flash"].map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
											onClick: () => onChangeAiModel(m),
											className: `px-3 py-1.5 rounded font-mono transition-colors ${aiModel === m ? "bg-[#0284C7] text-white" : "bg-[#0B0F17] text-[#94A3B8] hover:text-white border border-[#263244]"}`,
											children: m
										}, m))
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-between p-3 rounded-lg bg-[#161F2E] border border-[#263244]",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-medium text-white",
										children: dict.aiSection.thinkingToggleLabel
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										onClick: () => onChangeAiThinking(!aiThinking),
										className: `px-3 py-1 rounded font-mono transition-colors ${aiThinking ? "bg-[#059669] text-white" : "bg-[#0B0F17] text-[#94A3B8] border border-[#263244]"}`,
										children: aiThinking ? "enabled" : "disabled"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "p-3 rounded-lg bg-[#0B0F17] border border-[#1E293B] text-[#94A3B8] leading-relaxed",
									children: dict.aiSection.offlineGuarantee
								})
							]
						}),
						activeTab === "tutorial" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "space-y-4 select-text",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "text-sm font-semibold text-white border-b border-[#263244] pb-2",
								children: dict.tutorialTitle
							}), dict.tutorialParagraphs.map((sec, idx) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "p-3.5 rounded-lg bg-[#0B0F17] border border-[#1E293B] space-y-1.5",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "text-xs font-semibold text-[#38BDF8]",
									children: sec.heading
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "text-xs text-[#CBD5E1] leading-relaxed whitespace-pre-line",
									children: sec.body
								})]
							}, idx))]
						}),
						activeTab === "packaging" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "space-y-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "p-3.5 rounded-lg bg-[#161F2E] border border-[#263244] space-y-2",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "text-xs font-semibold text-white",
											children: dict.packagingTitle
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "text-xs text-[#94A3B8] leading-relaxed",
											children: dict.packagingDesc
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "pt-2 flex items-center gap-2",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
												onClick: () => downloadTextFile("build-windows-exe.bat", BUILD_BAT_SCRIPT, "application/bat"),
												className: "px-3 py-1.5 rounded bg-[#0284C7] hover:bg-[#0369A1] text-white font-medium flex items-center gap-1.5",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Terminal, { className: "w-3.5 h-3.5" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.downloadBat })]
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
												onClick: handleCopyCmd,
												className: "px-3 py-1.5 rounded bg-[#0B0F17] hover:bg-[#1E293B] border border-[#263244] text-[#CBD5E1] flex items-center gap-1.5",
												children: copied ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "w-3.5 h-3.5 text-[#10B981]" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.copied })] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Copy, { className: "w-3.5 h-3.5" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.copyCmd })] })
											})]
										})
									]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
									className: "text-[11px] font-mono text-[#10B981] bg-[#0B0F17] p-3 rounded-lg border border-[#1E293B] overflow-x-auto",
									children: `npm install --registry=https://registry.npmmirror.com/
npm install -D electron electron-builder --registry=https://registry.npmmirror.com/
npm run build:exe`
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "p-3.5 rounded-lg bg-[#161F2E] border border-[#263244] space-y-2",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "text-xs font-semibold text-[#38BDF8]",
											children: dict.androidPackagingTitle || "Android 手机端 (.apk) 打包配置"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "text-xs text-[#94A3B8] leading-relaxed",
											children: dict.androidPackagingDesc || "基于 Capacitor 一键构建独立安装的 Android 手机版 (.apk)，内置手机专属触控操作模式。"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "pt-2 flex items-center gap-2",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
												onClick: () => downloadTextFile("build-android-apk.bat", BUILD_ANDROID_APK_SCRIPT, "application/bat"),
												className: "px-3 py-1.5 rounded bg-[#059669] hover:bg-[#047857] text-white font-medium flex items-center gap-1.5",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Terminal, { className: "w-3.5 h-3.5" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.downloadApkBat || "下载 Android (.apk) 构建脚本 (.bat)" })]
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
												onClick: handleCopyApkCmd,
												className: "px-3 py-1.5 rounded bg-[#0B0F17] hover:bg-[#1E293B] border border-[#263244] text-[#CBD5E1] flex items-center gap-1.5",
												children: copiedApk ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "w-3.5 h-3.5 text-[#10B981]" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.copied })] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Copy, { className: "w-3.5 h-3.5" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.copyCmd })] })
											})]
										})
									]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
									className: "text-[11px] font-mono text-[#38BDF8] bg-[#0B0F17] p-3 rounded-lg border border-[#1E293B] overflow-x-auto",
									children: `npm install @capacitor/core @capacitor/cli @capacitor/android --registry=https://registry.npmmirror.com/
npm run build && npx cap add android && npx cap sync android
cd android && ./gradlew assembleDebug`
								})
							]
						})
					]
				})
			]
		})
	});
};
