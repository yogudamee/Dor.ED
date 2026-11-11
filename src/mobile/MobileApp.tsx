import React, { Suspense, lazy, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Compass,
  Cpu,
  Download,
  Eraser,
  Hand,
  Hexagon,
  Laptop,
  Layers,
  Maximize,
  Minimize2,
  Minus,
  MoreVertical,
  MousePointer,
  MoveUpRight,
  Redo2,
  RotateCcw,
  Scissors,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Square,
  Trash2,
  Undo2,
  Wrench,
  X,
} from 'lucide-react';
import {
  CadEntity,
  DiagnosticIssue,
  LineType,
  PresetCase,
  ReconstructedSolution,
  SnapResult,
  SnapType,
  ToolType,
  ViewType,
} from '../types/cad';
import { MobileCadCanvas2D } from './MobileCadCanvas2D';

const Viewport3D = lazy(() =>
  import('../components/Viewport3D').then((m) => ({ default: m.Viewport3D }))
);

export interface MobileAppProps {
  dict: any;
  appMode: 'free' | 'library';
  onChangeAppMode: (mode: 'free' | 'library') => void;
  localizedPresets: PresetCase[];
  activeLibraryCase: PresetCase | null;
  onEnterLibraryCase: (preset: PresetCase) => void;
  onExitLibraryCase: () => void;
  currentEntities: CadEntity[];
  onChangeEntities: (next: CadEntity[], options?: any) => void;
  onClearCanvas: () => void;
  currentSolutions: ReconstructedSolution[];
  currentSolutionIndex: number;
  onSelectSolution: (idx: number) => void;
  currentDiagnostics: DiagnosticIssue[];
  diagSheetOpen: boolean;
  onSetDiagSheetOpen: (open: boolean) => void;
  onDiagnose: () => void;
  onDerive: () => void;
  onAutoFix: () => void;
  onFixSingleIssue: (issue: DiagnosticIssue) => void;
  onAiAnalyze: () => void;
  aiLoading: boolean;
  aiModel: string;
  aiAnalysisResult: any;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  activeTool: ToolType;
  onSetActiveTool: (tool: ToolType) => void;
  activeLineType: LineType;
  onSetActiveLineType: (lt: LineType) => void;
  enabledSnaps: Record<SnapType, boolean>;
  onToggleSnap: (snapKey: SnapType) => void;
  orthoEnabled: boolean;
  onSetOrthoEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  gridStep: number;
  polygonSides: number;
  offsetDistance: number;
  snapTolerance: number;
  materialPreset: string;
  onOpenDownloadModal: () => void;
  onOpenSettingsModal: () => void;
  onOpenBenchmarkModal: () => void;
  onSwitchToDesktop: () => void;
}

const VIEW_META: Record<
  ViewType,
  { title: string; shortLabel: string; u: string; v: string }
> = {
  front: { title: '主视图', shortLabel: '主视图 (X-Z)', u: 'X', v: 'Z' },
  top: { title: '俯视图', shortLabel: '俯视图 (X-Y)', u: 'X', v: 'Y' },
  left: { title: '左视图', shortLabel: '左视图 (Y-Z)', u: 'Y', v: 'Z' },
};

export const MobileApp: React.FC<MobileAppProps> = ({
  dict,
  appMode,
  onChangeAppMode,
  localizedPresets,
  activeLibraryCase,
  onEnterLibraryCase,
  onExitLibraryCase,
  currentEntities,
  onChangeEntities,
  onClearCanvas,
  currentSolutions,
  currentSolutionIndex,
  onSelectSolution,
  currentDiagnostics,
  diagSheetOpen,
  onSetDiagSheetOpen,
  onDiagnose,
  onDerive,
  onAutoFix,
  onFixSingleIssue,
  onAiAnalyze,
  aiLoading,
  aiModel,
  aiAnalysisResult,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  activeTool,
  onSetActiveTool,
  activeLineType,
  onSetActiveLineType,
  enabledSnaps,
  onToggleSnap,
  orthoEnabled,
  onSetOrthoEnabled,
  gridStep,
  polygonSides,
  offsetDistance,
  snapTolerance,
  materialPreset,
  onOpenDownloadModal,
  onOpenSettingsModal,
  onOpenBenchmarkModal,
  onSwitchToDesktop,
}) => {
  // Active main viewport tab: 'front' | 'top' | 'left' | '3d'
  const [activeTab, setActiveTab] = useState<'front' | 'top' | 'left' | '3d'>('front');
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'classic' | 'benchmark'>('all');
  // Upper Cross-View Alignment Reference Strip (Expanded by default per user choice)
  const [refStripExpanded, setRefStripExpanded] = useState<boolean>(true);
  // Popover & Sheet states
  const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false);
  const [snapPopoverOpen, setSnapPopoverOpen] = useState<boolean>(false);
  const [xRayMode, setXRayMode] = useState<boolean>(false);
  const [activeSnapStatus, setActiveSnapStatus] = useState<SnapResult | null>(null);

  // Shared 3D engineering cursor across active view and reference strip
  const [sharedCursor, setSharedCursor] = useState<{
    x: number | null;
    y: number | null;
    z: number | null;
    activeView: ViewType | null;
  }>({
    x: 60,
    y: 60,
    z: 40,
    activeView: 'front',
  });

  // Wide-screen preview phone frame mode (9:19.5 phone frame on wide screens, full-bleed on phones)
  const [isWideViewport, setIsWideViewport] = useState<boolean>(
    typeof window !== 'undefined' && window.innerWidth >= 640
  );
  const [usePhoneShellOnWide, setUsePhoneShellOnWide] = useState<boolean>(true);

  useEffect(() => {
    const onResize = () => {
      setIsWideViewport(window.innerWidth >= 640);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const currentSolution =
    currentSolutions[currentSolutionIndex] || currentSolutions[0] || null;

  // Determine the two companion 2D views for the upper Cross-View Reference Strip
  const active2DView: ViewType = activeTab === '3d' ? 'front' : activeTab;
  const companionViews: ViewType[] = (['front', 'top', 'left'] as ViewType[]).filter(
    (v) => v !== active2DView
  );

  const isShowingLibraryList = appMode === 'library' && !activeLibraryCase;

  const mobileCoreContent = (
    <div
      className="flex flex-col w-full h-full bg-[#0B0F17] text-[#F1F5F9] overflow-hidden select-none relative"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 1. TOP COMPACT NAVIGATION BAR */}
      <header className="flex items-center justify-between gap-1.5 px-2.5 py-2 bg-[#0D131F] border-b border-[#263244] shrink-0 z-30">
        {/* Left: Brand + Mode Switcher */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-sm font-bold tracking-tight text-white font-display">
            {dict.appName}
          </span>
          <div className="flex items-center bg-[#0B0F17] p-0.5 rounded-lg border border-[#1E293B] text-[11px]">
            <button
              onClick={() => onChangeAppMode('free')}
              className={`min-h-[30px] px-2 py-0.5 rounded-md font-medium transition-colors whitespace-nowrap ${
                appMode === 'free'
                  ? 'bg-[#0284C7] text-white'
                  : 'text-[#94A3B8]'
              }`}
            >
              自由
            </button>
            <button
              onClick={() => onChangeAppMode('library')}
              className={`min-h-[30px] px-2 py-0.5 rounded-md font-medium transition-colors whitespace-nowrap ${
                appMode === 'library'
                  ? 'bg-[#0284C7] text-white'
                  : 'text-[#94A3B8]'
              }`}
            >
              题库
            </button>
          </div>
          {appMode === 'library' && activeLibraryCase && (
            <button
              onClick={onExitLibraryCase}
              className="min-h-[32px] px-2 py-1 rounded-lg bg-[#161F2E] border border-[#263244] text-[11px] text-[#CBD5E1] flex items-center gap-0.5"
              title="返回题库列表"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Center: Prominent Undo / Redo Buttons */}
        {!isShowingLibraryList && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              title="撤销 (Undo)"
              className={`min-w-[38px] min-h-[36px] rounded-lg border flex items-center justify-center transition-colors ${
                canUndo
                  ? 'bg-[#161F2E] active:bg-[#1E293B] border-[#263244] text-white'
                  : 'bg-[#0B0F17] border-[#1E293B] text-[#475569]'
              }`}
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              title="重做 (Redo)"
              className={`min-w-[38px] min-h-[36px] rounded-lg border flex items-center justify-center transition-colors ${
                canRedo
                  ? 'bg-[#161F2E] active:bg-[#1E293B] border-[#263244] text-white'
                  : 'bg-[#0B0F17] border-[#1E293B] text-[#475569]'
              }`}
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Right: Diagnose + Derive + More Menu */}
        <div className="flex items-center gap-1.5 shrink-0">
          {!isShowingLibraryList && (
            <>
              <button
                onClick={() => {
                  onDiagnose();
                  onSetDiagSheetOpen(true);
                }}
                className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#161F2E] active:bg-[#1E293B] border border-[#263244] text-xs font-medium text-[#E2E8F0] flex items-center gap-1 whitespace-nowrap"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-[#F59E0B]" />
                <span>诊断</span>
                {currentDiagnostics.length > 0 && (
                  <span className="text-[10px] font-mono text-[#EF4444]">
                    ({currentDiagnostics.length})
                  </span>
                )}
              </button>

              <button
                onClick={onDerive}
                className="min-h-[36px] px-3 py-1 rounded-lg bg-[#0284C7] active:bg-[#0369A1] text-xs font-semibold text-white flex items-center gap-1 whitespace-nowrap shadow-sm"
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>推导</span>
              </button>
            </>
          )}

          <div className="relative">
            <button
              onClick={() => setMoreMenuOpen((prev) => !prev)}
              className="min-w-[36px] min-h-[36px] rounded-lg bg-[#161F2E] active:bg-[#1E293B] border border-[#263244] flex items-center justify-center text-[#CBD5E1]"
              title="更多操作"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {moreMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setMoreMenuOpen(false)}
                />
                <div className="absolute right-0 mt-1.5 w-48 bg-[#111827] border border-[#263244] rounded-xl shadow-2xl py-1.5 z-50 text-xs divide-y divide-[#1E293B]">
                  <div className="py-1">
                    <button
                      onClick={() => {
                        setMoreMenuOpen(false);
                        onOpenBenchmarkModal();
                      }}
                      className="w-full px-3.5 py-2.5 text-left text-[#38BDF8] hover:bg-[#1E293B] flex items-center gap-2.5 font-medium"
                    >
                      <ShieldCheck className="w-4 h-4 text-[#38BDF8]" />
                      <span>12 题内核基准自检</span>
                    </button>
                    <button
                      onClick={() => {
                        setMoreMenuOpen(false);
                        onOpenDownloadModal();
                      }}
                      className="w-full px-3.5 py-2.5 text-left text-[#E2E8F0] hover:bg-[#1E293B] flex items-center gap-2.5"
                    >
                      <Download className="w-4 h-4 text-[#38BDF8]" />
                      <span>双端下载 / 导出图纸</span>
                    </button>
                    <button
                      onClick={() => {
                        setMoreMenuOpen(false);
                        onOpenSettingsModal();
                      }}
                      className="w-full px-3.5 py-2.5 text-left text-[#E2E8F0] hover:bg-[#1E293B] flex items-center gap-2.5"
                    >
                      <Settings className="w-4 h-4 text-[#94A3B8]" />
                      <span>系统设置与参数</span>
                    </button>
                  </div>

                  <div className="py-1">
                    {appMode === 'library' && activeLibraryCase ? (
                      <button
                        onClick={() => {
                          setMoreMenuOpen(false);
                          onEnterLibraryCase(activeLibraryCase);
                        }}
                        className="w-full px-3.5 py-2.5 text-left text-[#F59E0B] hover:bg-[#1E293B] flex items-center gap-2.5"
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span>重置当前题目</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setMoreMenuOpen(false);
                          onClearCanvas();
                        }}
                        className="w-full px-3.5 py-2.5 text-left text-[#EF4444] hover:bg-[#1E293B] flex items-center gap-2.5"
                      >
                        <Trash2 className="w-4 h-4" />
                        <span>清空当前画布</span>
                      </button>
                    )}

                    <button
                      onClick={() => {
                        setMoreMenuOpen(false);
                        onSwitchToDesktop();
                      }}
                      className="w-full px-3.5 py-2.5 text-left text-[#10B981] hover:bg-[#1E293B] flex items-center gap-2.5 font-medium"
                    >
                      <Laptop className="w-4 h-4" />
                      <span>💻 切换至电脑版</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* LIBRARY LIST MODE */}
      {isShowingLibraryList ? (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-[#0B0F17]">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <h1 className="text-base font-bold text-white">
                {dict.libraryView.title}
              </h1>
              <p className="text-xs text-[#94A3B8]">{dict.libraryView.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={onOpenBenchmarkModal}
              className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#059669] text-xs font-semibold text-white flex items-center gap-1 shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>基准自检</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {(
              [
                { id: 'all', label: `全部 (${localizedPresets.length})` },
                {
                  id: 'classic',
                  label: `经典题 (${localizedPresets.filter((p) => p.category !== 'benchmark').length})`,
                },
                {
                  id: 'benchmark',
                  label: `高阶基准 (${localizedPresets.filter((p) => p.category === 'benchmark').length})`,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setLibraryFilter(tab.id)}
                className={`min-h-[32px] px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap ${
                  libraryFilter === tab.id
                    ? 'bg-[#0284C7] text-white'
                    : 'bg-[#111827] text-[#94A3B8] border border-[#263244]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="space-y-2.5">
            {localizedPresets
              .filter((p) =>
                libraryFilter === 'all'
                  ? true
                  : libraryFilter === 'benchmark'
                  ? p.category === 'benchmark'
                  : p.category !== 'benchmark'
              )
              .map((preset, index) => (
                <div
                  key={preset.id}
                  onClick={() => onEnterLibraryCase(preset)}
                  className="p-3.5 rounded-xl bg-[#111827] active:bg-[#161F2E] border border-[#263244] space-y-2 cursor-pointer"
                >
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#38BDF8]">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <span>{preset.badge}</span>
                  </div>
                  <div className="text-sm font-semibold text-white">
                    {preset.name}
                  </div>
                  <p className="text-xs text-[#94A3B8] leading-relaxed">
                    {preset.description}
                  </p>
                  <div className="pt-2 border-t border-[#1E293B] flex items-center justify-between">
                    <span className="text-[11px] font-mono text-[#64748B]">
                      {preset.solutions.length > 0
                        ? `${preset.solutions.length} ${dict.libraryView.solutionsTitle}`
                        : 'CSP 体元约束实时求解'}
                    </span>
                    <span className="px-3 py-1 rounded-lg bg-[#0284C7] text-xs font-medium text-white">
                      {dict.libraryView.enterBtn}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <>
          {/* 2. COLLAPSIBLE UPPER CROSS-VIEW ALIGNMENT REFERENCE STRIP */}
          <section className="bg-[#090D14] border-b border-[#263244] shrink-0">
            <button
              onClick={() => setRefStripExpanded((prev) => !prev)}
              className="w-full flex items-center justify-between px-3 py-1.5 bg-[#0D131F]/90 text-[11px] text-[#94A3B8] border-b border-[#1E293B]/80"
            >
              <div className="flex items-center gap-2 truncate">
                <span className="font-semibold text-[#E2E8F0]">
                  三等关系对齐联动窗
                </span>
                <span className="text-[10px] text-[#38BDF8] font-mono">
                  长X={sharedCursor.x !== null ? sharedCursor.x.toFixed(0) : 0} ·
                  宽Y={sharedCursor.y !== null ? sharedCursor.y.toFixed(0) : 0} ·
                  高Z={sharedCursor.z !== null ? sharedCursor.z.toFixed(0) : 0}
                </span>
              </div>
              <div className="flex items-center gap-1 text-[#38BDF8] shrink-0">
                <span className="text-[10px]">
                  {refStripExpanded ? '收起' : '展开'}
                </span>
                {refStripExpanded ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </div>
            </button>

            {refStripExpanded && (
              <div className="h-[152px] grid grid-cols-3 gap-[1px] bg-[#263244]">
                {companionViews.map((vKey) => {
                  const meta = VIEW_META[vKey];
                  return (
                    <div key={vKey} className="relative w-full h-full min-h-0">
                      <MobileCadCanvas2D
                        view={vKey}
                        title={meta.title}
                        axisLabels={{ u: meta.u, v: meta.v }}
                        entities={currentEntities}
                        onChangeEntities={onChangeEntities}
                        activeTool={activeTool}
                        onSwitchToSelect={() => onSetActiveTool('select')}
                        activeLineType={activeLineType}
                        onChangeActiveLineType={onSetActiveLineType}
                        enabledSnaps={enabledSnaps}
                        orthoEnabled={orthoEnabled}
                        gridStep={gridStep}
                        polygonSides={polygonSides}
                        offsetDistance={offsetDistance}
                        snapTolerance={snapTolerance}
                        sharedCursor={sharedCursor}
                        onUpdateSharedCursor={setSharedCursor}
                        diagnostics={currentDiagnostics}
                        compact={true}
                        onTapCompact={() => setActiveTab(vKey)}
                      />
                    </div>
                  );
                })}

                {/* Mini 3D Reference Window */}
                <div
                  className="relative w-full h-full min-h-0 bg-[#090D14] cursor-pointer"
                  onClick={() => setActiveTab('3d')}
                >
                  <Suspense
                    fallback={
                      <div className="w-full h-full bg-[#090D14] flex items-center justify-center text-[10px] text-[#64748B]">
                        3D...
                      </div>
                    }
                  >
                    <Viewport3D
                      primitives={currentSolution?.primitives3D || []}
                      hoveredFeatureId={null}
                      isFullscreen={false}
                      onToggleFullscreen={() => setActiveTab('3d')}
                      xRayMode={xRayMode}
                      onToggleXRay={() => setXRayMode((prev) => !prev)}
                      materialPreset={materialPreset as any}
                      labels={dict.view3D}
                    />
                  </Suspense>
                  <div className="absolute top-1.5 left-1.5 pointer-events-none px-1.5 py-0.5 rounded bg-[#111827]/90 border border-[#263244] text-[10px] font-semibold text-[#38BDF8]">
                    3D 预览
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 3. CENTRAL FULL-WIDTH MAIN ACTIVE VIEWPORT */}
          <main className="flex-1 flex flex-col min-h-0 relative bg-[#0D131F]">
            {/* High-Contrast View Switcher Tabs */}
            <div className="grid grid-cols-4 gap-1 p-1.5 bg-[#0B0F17] border-b border-[#263244] shrink-0">
              {(
                [
                  { id: 'front', label: '主视图 (X-Z)' },
                  { id: 'top', label: '俯视图 (X-Y)' },
                  { id: 'left', label: '左视图 (Y-Z)' },
                  { id: '3d', label: '3D 立体' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`min-h-[38px] px-1.5 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap truncate ${
                    activeTab === tab.id
                      ? 'bg-[#0284C7] text-white shadow-sm'
                      : 'bg-[#161F2E] text-[#94A3B8] border border-[#263244]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Active Canvas or Full 3D Viewport */}
            <div className="flex-1 relative min-h-0 w-full">
              {activeTab === '3d' ? (
                <Suspense
                  fallback={
                    <div className="w-full h-full bg-[#0D131F] flex items-center justify-center text-xs text-[#64748B]">
                      3D 视窗就绪中...
                    </div>
                  }
                >
                  <Viewport3D
                    primitives={currentSolution?.primitives3D || []}
                    hoveredFeatureId={null}
                    isFullscreen={false}
                    onToggleFullscreen={() => setActiveTab('front')}
                    xRayMode={xRayMode}
                    onToggleXRay={() => setXRayMode((prev) => !prev)}
                    materialPreset={materialPreset as any}
                    labels={dict.view3D}
                  />
                </Suspense>
              ) : (
                <>
                  <MobileCadCanvas2D
                    view={activeTab}
                    title={VIEW_META[activeTab].title}
                    axisLabels={{
                      u: VIEW_META[activeTab].u,
                      v: VIEW_META[activeTab].v,
                    }}
                    entities={currentEntities}
                    onChangeEntities={onChangeEntities}
                    activeTool={activeTool}
                    onSwitchToSelect={() => onSetActiveTool('select')}
                    activeLineType={activeLineType}
                    onChangeActiveLineType={onSetActiveLineType}
                    enabledSnaps={enabledSnaps}
                    orthoEnabled={orthoEnabled}
                    gridStep={gridStep}
                    polygonSides={polygonSides}
                    offsetDistance={offsetDistance}
                    snapTolerance={snapTolerance}
                    sharedCursor={sharedCursor}
                    onUpdateSharedCursor={setSharedCursor}
                    onSnapStatusChange={setActiveSnapStatus}
                    diagnostics={currentDiagnostics}
                  />

                  {/* Top-Left Translucent Coordinate & Snap HUD */}
                  <div className="absolute top-2.5 left-2.5 z-10 pointer-events-none px-2.5 py-1 rounded-lg bg-[#0B0F17]/85 backdrop-blur-sm border border-[#263244] text-[10px] font-mono space-y-0.5">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[#38BDF8]">
                        X:{sharedCursor.x !== null ? sharedCursor.x.toFixed(0) : 0}
                      </span>
                      <span className="text-[#10B981]">
                        Y:{sharedCursor.y !== null ? sharedCursor.y.toFixed(0) : 0}
                      </span>
                      <span className="text-[#F59E0B]">
                        Z:{sharedCursor.z !== null ? sharedCursor.z.toFixed(0) : 0}
                      </span>
                    </div>
                    {activeSnapStatus && (
                      <div className="text-[#22D3EE] truncate">
                        已捕捉：{activeSnapStatus.label} (
                        {activeSnapStatus.point.u.toFixed(0)},{' '}
                        {activeSnapStatus.point.v.toFixed(0)})
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Bottom Floating Candidate Solution Switcher Strip */}
              {currentSolutions.length > 1 && (
                <div className="absolute bottom-2.5 left-2.5 right-2.5 z-20 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#0D131F]/95 border border-[#38BDF8]/40 shadow-lg overflow-x-auto">
                  <span className="text-[11px] font-semibold text-[#38BDF8] shrink-0">
                    多解:
                  </span>
                  {currentSolutions.map((sol, idx) => (
                    <button
                      key={sol.id}
                      onClick={() => onSelectSolution(idx)}
                      className={`min-h-[32px] px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors ${
                        idx === currentSolutionIndex
                          ? 'bg-[#0284C7] text-white'
                          : 'bg-[#161F2E] text-[#CBD5E1] border border-[#263244]'
                      }`}
                    >
                      解{idx + 1}: {sol.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </main>

          {/* 4. BOTTOM DUAL-LAYER THUMB DOCK */}
          <footer className="bg-[#0D131F] border-t border-[#263244] shrink-0 z-30 pb-[env(safe-area-inset-bottom)]">
            {/* Upper Layer: Line Type Switcher + OSNAP Popover Trigger */}
            <div className="flex items-center justify-between gap-1 px-2 py-1.5 border-b border-[#1E293B] relative">
              <div className="flex items-center gap-1 overflow-x-auto">
                {[
                  {
                    id: 'thick_solid' as LineType,
                    label: '粗实线',
                    preview: '━━',
                    color: 'text-white',
                  },
                  {
                    id: 'thin_dashed' as LineType,
                    label: '细虚线',
                    preview: '╌╌',
                    color: 'text-[#F59E0B]',
                  },
                  {
                    id: 'center_dot_dash' as LineType,
                    label: '点画线',
                    preview: '─·─',
                    color: 'text-[#06B6D4]',
                  },
                  {
                    id: 'construction' as LineType,
                    label: '辅助线',
                    preview: '···',
                    color: 'text-[#10B981]',
                  },
                ].map((lt) => (
                  <button
                    key={lt.id}
                    onClick={() => onSetActiveLineType(lt.id)}
                    className={`min-h-[36px] px-2.5 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
                      activeLineType === lt.id
                        ? 'bg-[#1E293B] text-white border border-[#38BDF8]'
                        : 'bg-[#111827] text-[#94A3B8] border border-[#263244]'
                    }`}
                  >
                    <span className={`font-mono font-bold ${lt.color}`}>
                      {lt.preview}
                    </span>
                    <span>{lt.label}</span>
                  </button>
                ))}
              </div>

              <button
                onClick={() => setSnapPopoverOpen((prev) => !prev)}
                className={`min-h-[36px] px-2.5 py-1 rounded-lg border text-[11px] font-medium flex items-center gap-1 shrink-0 ${
                  snapPopoverOpen || orthoEnabled
                    ? 'bg-[#16273B] border-[#38BDF8] text-[#E0F2FE]'
                    : 'bg-[#111827] border-[#263244] text-[#CBD5E1]'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-[#38BDF8]" />
                <span>捕捉设置</span>
              </button>

              {/* OSNAP & Ortho Popover */}
              {snapPopoverOpen && (
                <div className="absolute bottom-full right-2 mb-2 w-64 p-3 rounded-2xl bg-[#111827] border border-[#38BDF8]/60 shadow-2xl z-50 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white">
                      对象捕捉 (OSNAP) 与正交
                    </span>
                    <button
                      onClick={() => setSnapPopoverOpen(false)}
                      className="p-1 text-[#94A3B8] hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <button
                    onClick={() => onSetOrthoEnabled((prev) => !prev)}
                    className={`w-full min-h-[38px] px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center justify-between ${
                      orthoEnabled
                        ? 'bg-[#059669] border-[#10B981] text-white'
                        : 'bg-[#0B0F17] border-[#263244] text-[#94A3B8]'
                    }`}
                  >
                    <span>正交锁定 (水平/竖直 90°)</span>
                    <span>{orthoEnabled ? '已开启' : '已关闭'}</span>
                  </button>

                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        'grid',
                        'endpoint',
                        'midpoint',
                        'center',
                        'quadrant',
                        'intersection',
                      ] as SnapType[]
                    ).map((sn) => {
                      const sInfo = dict.snaps.items[sn];
                      return (
                        <button
                          key={sn}
                          onClick={() => onToggleSnap(sn)}
                          className={`min-h-[38px] rounded-xl text-xs font-medium border transition-colors ${
                            enabledSnaps[sn]
                              ? 'bg-[#16273B] border-[#06B6D4] text-[#E0F2FE]'
                              : 'bg-[#0B0F17] border-[#1E293B] text-[#64748B]'
                          }`}
                        >
                          {sInfo.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Lower Layer: Horizontal Scrollable Touch Drawing Toolbar (>= 44x44px buttons) */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto">
              {[
                { id: 'select' as ToolType, label: '选择', icon: MousePointer },
                { id: 'pan' as ToolType, label: '手型平移', icon: Hand },
                { id: 'line' as ToolType, label: '直线', icon: Minus },
                { id: 'rect' as ToolType, label: '矩形', icon: Square },
                { id: 'polygon' as ToolType, label: '多边形', icon: Hexagon },
                { id: 'circle' as ToolType, label: '圆', icon: Circle },
                { id: 'arc' as ToolType, label: '圆弧', icon: Compass },
                { id: 'tangent' as ToolType, label: '切线', icon: MoveUpRight },
                { id: 'trim' as ToolType, label: '修剪', icon: Scissors },
                { id: 'extend' as ToolType, label: '延伸', icon: Maximize },
                { id: 'offset' as ToolType, label: '偏移', icon: Layers },
                { id: 'erase' as ToolType, label: '擦除', icon: Eraser },
              ].map((tool) => {
                const Icon = tool.icon;
                const active = activeTool === tool.id;
                return (
                  <button
                    key={tool.id}
                    onClick={() => {
                      onSetActiveTool(tool.id);
                      if (activeTab === '3d') {
                        setActiveTab('front');
                      }
                    }}
                    className={`min-w-[54px] min-h-[46px] px-2.5 py-1 rounded-xl flex flex-col items-center justify-center gap-1 shrink-0 transition-colors ${
                      active
                        ? 'bg-[#0284C7] text-white shadow-md'
                        : 'bg-[#161F2E] text-[#CBD5E1] border border-[#263244]'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-[10px] font-medium whitespace-nowrap">
                      {tool.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </footer>
        </>
      )}

      {/* Diagnostics & AI Bottom Sheet Drawer */}
      {diagSheetOpen && (
        <div
          className="absolute inset-0 z-50 bg-black/60 backdrop-blur-xs flex flex-col justify-end"
          onClick={() => onSetDiagSheetOpen(false)}
        >
          <div
            className="max-h-[75%] bg-[#111827] border-t border-[#38BDF8]/50 rounded-t-3xl flex flex-col overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-[#334155] rounded-full mx-auto mt-2.5 mb-1 shrink-0" />
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#263244] shrink-0">
              <span className="text-sm font-bold text-white">
                {dict.diagnoseDrawer.title} ({currentDiagnostics.length})
              </span>
              <button
                onClick={() => onSetDiagSheetOpen(false)}
                className="min-w-[36px] min-h-[36px] rounded-lg bg-[#161F2E] flex items-center justify-center text-[#94A3B8]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {currentDiagnostics.length === 0 ? (
                <div className="p-3.5 rounded-xl bg-[#064E3B]/30 border border-[#10B981] space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#34D399]">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{dict.diagnoseDrawer.passed}</span>
                  </div>
                  <p className="text-xs text-[#A7F3D0] leading-relaxed">
                    {dict.diagnoseDrawer.passedDesc}
                  </p>
                </div>
              ) : (
                <>
                  <button
                    onClick={onAutoFix}
                    className="w-full min-h-[42px] py-2 px-3 rounded-xl bg-[#059669] text-xs font-semibold text-white flex items-center justify-center gap-1.5"
                  >
                    <Wrench className="w-4 h-4" />
                    <span>{dict.diagnoseDrawer.autoFix}</span>
                  </button>
                  {currentDiagnostics.map((issue) => (
                    <div
                      key={issue.id}
                      className="p-3 rounded-xl bg-[#7F1D1D]/25 border border-[#EF4444] space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-1.5 text-xs font-semibold text-white">
                          <AlertTriangle className="w-4 h-4 text-[#EF4444] shrink-0 mt-0.5" />
                          <span>{issue.title}</span>
                        </div>
                        {issue.fixPayload && (
                          <button
                            onClick={() => onFixSingleIssue(issue)}
                            className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[#059669] text-[11px] font-medium text-white shrink-0"
                          >
                            {dict.diagnoseDrawer.fixSingle}
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-[#CBD5E1]">{issue.description}</p>
                      {issue.suggestion && (
                        <p className="text-[11px] text-[#34D399]">
                          {issue.suggestion}
                        </p>
                      )}
                    </div>
                  ))}
                </>
              )}

              <div className="pt-2 border-t border-[#263244] space-y-2">
                <button
                  onClick={onAiAnalyze}
                  disabled={aiLoading}
                  className="w-full min-h-[42px] py-2 px-3 rounded-xl bg-[#16273B] border border-[#38BDF8]/50 text-xs font-semibold text-[#38BDF8] flex items-center justify-center gap-1.5"
                >
                  <Cpu className="w-4 h-4" />
                  <span>
                    {aiLoading ? '...' : dict.diagnoseDrawer.aiAnalyzeBtn}
                  </span>
                </button>
                {aiAnalysisResult && (
                  <div className="p-3 rounded-xl bg-[#0B0F17] border border-[#263244] text-xs text-[#CBD5E1] space-y-1">
                    <div className="font-semibold text-[#38BDF8]">{aiModel}</div>
                    <p className="leading-relaxed">{aiAnalysisResult.summary}</p>
                    {aiAnalysisResult.underConstrainedReason && (
                      <p className="text-[#F59E0B]">
                        {aiAnalysisResult.underConstrainedReason}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // On wide desktop screens, wrap in a centered 9:19.5 Portrait Phone Simulator Shell (unless user toggles full-bleed)
  if (isWideViewport && usePhoneShellOnWide) {
    return (
      <div className="w-screen h-screen bg-[#06090F] flex flex-col items-center justify-between p-3 overflow-hidden select-none">
        {/* Top Simulator Control Bar for Desktop Preview */}
        <div className="w-full max-w-4xl flex items-center justify-between px-4 py-2 rounded-xl bg-[#0D131F] border border-[#263244] text-xs shrink-0">
          <div className="flex items-center gap-2 text-[#10B981] font-medium">
            <Smartphone className="w-4 h-4" />
            <span>手机竖屏触控专版 (9:19.5 Portrait Simulator)</span>
            <span className="text-[#64748B] hidden sm:inline">
              · 支持单指 36px 防遮挡十字准星、点按/拖拽绘图与双指缩放
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setUsePhoneShellOnWide(false)}
              className="px-2.5 py-1 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-[#CBD5E1] flex items-center gap-1"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>铺满窗口</span>
            </button>
            <button
              onClick={onSwitchToDesktop}
              className="px-3 py-1 rounded-lg bg-[#0284C7] hover:bg-[#0369A1] font-semibold text-white flex items-center gap-1.5"
            >
              <Laptop className="w-3.5 h-3.5" />
              <span>返回电脑四视图工作站</span>
            </button>
          </div>
        </div>

        {/* Centered 9:19.5 Portrait Phone Frame */}
        <div className="flex-1 min-h-0 flex items-center justify-center py-2 w-full">
          <div className="w-[412px] h-full max-h-[892px] rounded-[38px] p-2.5 bg-[#1E293B] border-2 border-[#334155] shadow-2xl flex flex-col overflow-hidden relative">
            <div className="w-24 h-1.5 bg-[#0B0F17] rounded-full mx-auto mb-1.5 shrink-0" />
            <div className="flex-1 min-h-0 w-full rounded-[28px] overflow-hidden border border-[#263244]">
              {mobileCoreContent}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <div className="w-screen h-[100dvh] overflow-hidden">{mobileCoreContent}</div>;
};
