import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Compass,
  Cpu,
  Download,
  Eraser,
  FolderOpen,
  Hand,
  Hexagon,
  Layers,
  Maximize,
  Minus,
  MousePointer,
  MoveUpRight,
  Play,
  Redo2,
  RotateCcw,
  Scissors,
  Settings,
  ShieldAlert,
  Smartphone,
  Square,
  StepForward,
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
  SnapType,
  ToolType,
  ViewType,
} from '../types/cad';
import { CadViewport2D } from '../components/CadViewport2D';
import { Viewport3D } from '../components/Viewport3D';
import { FileExplorerPanel } from '../components/FileExplorerPanel';

export interface DesktopAppProps {
  dict: any;
  appMode: 'free' | 'library';
  onChangeAppMode: (mode: 'free' | 'library') => void;
  localizedPresets: PresetCase[];
  activeLibraryCase: PresetCase | null;
  onEnterLibraryCase: (preset: PresetCase) => void;
  onExitLibraryCase: () => void;
  currentEntities: CadEntity[];
  onChangeEntities: (next: CadEntity[], options?: any) => void;
  freeEntities: CadEntity[];
  onLoadFreeEntities: (loaded: CadEntity[], name: string) => void;
  onNewBlankFree: () => void;
  currentSolutions: ReconstructedSolution[];
  currentSolutionIndex: number;
  onSelectSolution: (idx: number) => void;
  currentDiagnostics: DiagnosticIssue[];
  freeDiagDrawerOpen: boolean;
  onSetFreeDiagDrawerOpen: (open: boolean) => void;
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
  showDynamicHUD: boolean;
  showAlignmentRays: boolean;
  materialPreset: string;
  onOpenDownloadModal: () => void;
  onOpenSettingsModal: () => void;
  onSwitchToMobile: () => void;
}

export const DesktopApp: React.FC<DesktopAppProps> = ({
  dict,
  appMode,
  onChangeAppMode,
  localizedPresets,
  activeLibraryCase,
  onEnterLibraryCase,
  onExitLibraryCase,
  currentEntities,
  onChangeEntities,
  freeEntities,
  onLoadFreeEntities,
  onNewBlankFree,
  currentSolutions,
  currentSolutionIndex,
  onSelectSolution,
  currentDiagnostics,
  freeDiagDrawerOpen,
  onSetFreeDiagDrawerOpen,
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
  showDynamicHUD,
  showAlignmentRays,
  materialPreset,
  onOpenDownloadModal,
  onOpenSettingsModal,
  onSwitchToMobile,
}) => {
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [hoveredToolKey, setHoveredToolKey] = useState<string | null>(null);
  const [sharedZoom, setSharedZoom] = useState(3);
  const [sharedPan, setSharedPan] = useState({ x: 36, y: 0 });
  const [sharedCursor, setSharedCursor] = useState<{
    x: number | null;
    y: number | null;
    z: number | null;
    activeView: ViewType | null;
  }>({
    x: 60,
    y: 60,
    z: 40,
    activeView: null,
  });
  const [hoveredFeatureId, setHoveredFeatureId] = useState<string | null>(null);
  const [is3DFullscreen, setIs3DFullscreen] = useState(false);
  const [xRayMode, setXRayMode] = useState(false);
  const [showProjectionSteps, setShowProjectionSteps] = useState(true);
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  const currentSolution =
    currentSolutions[currentSolutionIndex] || currentSolutions[0] || null;

  const undoRedoRef = useRef({ onUndo, onRedo });
  undoRedoRef.current = { onUndo, onRedo };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          undoRedoRef.current.onUndo();
          return;
        }
        if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault();
          undoRedoRef.current.onRedo();
          return;
        }
        return;
      }
      if (e.altKey) return;
      if (e.key === 'F8') {
        e.preventDefault();
        onSetOrthoEnabled((prev) => !prev);
      } else if (e.key === 'Escape') {
        setIs3DFullscreen(false);
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        const lineTypeKeyMap: Record<string, LineType> = {
          '1': 'thick_solid',
          '2': 'thin_dashed',
          '3': 'center_dot_dash',
          '4': 'construction',
        };
        if (lineTypeKeyMap[e.key]) {
          onSetActiveLineType(lineTypeKeyMap[e.key]);
        }
      } else {
        const key = e.key.toUpperCase();
        const shortcutMap: Record<string, ToolType> = {
          V: 'select',
          H: 'pan',
          L: 'line',
          R: 'rect',
          P: 'polygon',
          C: 'circle',
          A: 'arc',
          G: 'tangent',
          T: 'trim',
          E: 'extend',
          O: 'offset',
          D: 'erase',
        };
        if (shortcutMap[key]) {
          onSetActiveTool(shortcutMap[key]);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onSetActiveLineType, onSetActiveTool, onSetOrthoEnabled]);

  const handleViewportTransformChange = (
    nextZoom: number,
    nextPan: { x: number; y: number }
  ) => {
    setSharedZoom(nextZoom);
    setSharedPan(nextPan);
  };

  const isShowingLibraryGrid = appMode === 'library' && !activeLibraryCase;

  return (
    <div
      className="flex flex-col w-screen h-screen bg-[#0B0F17] text-[#F1F5F9] overflow-hidden select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Top Desktop Workstation Header */}
      <header className="flex items-center justify-between gap-4 px-4 py-2 bg-[#0D131F] border-b border-[#263244] shrink-0">
        {/* Left: Brand + Mode Switcher + Undo/Redo */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-base font-bold tracking-tight text-white font-display">
            {dict.appName}
          </span>
          {appMode === 'free' && (
            <button
              onClick={() => setFilePanelOpen((prev) => !prev)}
              className={`p-1.5 rounded border transition-colors ${
                filePanelOpen
                  ? 'bg-[#16273B] border-[#38BDF8] text-[#38BDF8]'
                  : 'bg-[#161F2E] border-[#263244] text-[#94A3B8] hover:text-white'
              }`}
              title={dict.topActions.dataPanel}
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="flex items-center bg-[#0B0F17] p-0.5 rounded-lg border border-[#1E293B] text-xs">
            <button
              onClick={() => onChangeAppMode('free')}
              className={`px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${
                appMode === 'free'
                  ? 'bg-[#0284C7] text-white'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              {dict.modes.free}
            </button>
            <button
              onClick={() => {
                onChangeAppMode('library');
                setFilePanelOpen(false);
                onSetFreeDiagDrawerOpen(false);
              }}
              className={`px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${
                appMode === 'library'
                  ? 'bg-[#0284C7] text-white'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              {dict.modes.library}
            </button>
          </div>

          {!isShowingLibraryGrid && (
            <div className="flex items-center gap-1 pl-2 border-l border-[#263244]">
              <button
                onClick={onUndo}
                disabled={!canUndo}
                title="撤销 [Ctrl+Z]"
                className={`p-1.5 rounded border text-xs transition-colors ${
                  canUndo
                    ? 'bg-[#161F2E] hover:bg-[#1E293B] border-[#263244] text-[#E2E8F0]'
                    : 'bg-[#0B0F17] border-[#1E293B] text-[#475569] cursor-not-allowed'
                }`}
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onRedo}
                disabled={!canRedo}
                title="重做 [Ctrl+Y]"
                className={`p-1.5 rounded border text-xs transition-colors ${
                  canRedo
                    ? 'bg-[#161F2E] hover:bg-[#1E293B] border-[#263244] text-[#E2E8F0]'
                    : 'bg-[#0B0F17] border-[#1E293B] text-[#475569] cursor-not-allowed'
                }`}
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {appMode === 'library' && activeLibraryCase && (
            <div className="flex items-center gap-1.5 pl-2 border-l border-[#263244]">
              <button
                onClick={onExitLibraryCase}
                className="px-2.5 py-1 rounded bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-xs text-[#CBD5E1] flex items-center gap-1 whitespace-nowrap"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{dict.topActions.backToLibrary}</span>
              </button>
              <button
                onClick={() => onEnterLibraryCase(activeLibraryCase)}
                className="px-2 py-1 rounded bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-xs text-[#94A3B8] hover:text-white flex items-center gap-1 whitespace-nowrap"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{dict.topActions.resetExercise}</span>
              </button>
            </div>
          )}
        </div>

        {/* Center: GB/T 4458.4 Line Type Bar */}
        {!isShowingLibraryGrid && (
          <div className="flex items-center gap-1 bg-[#0B0F17] p-0.5 rounded-lg border border-[#1E293B] shrink-0 overflow-x-auto">
            {[
              { id: 'thick_solid' as LineType, keyHint: '1', preview: '━━', color: 'text-white' },
              { id: 'thin_dashed' as LineType, keyHint: '2', preview: '╌╌', color: 'text-[#F59E0B]' },
              { id: 'center_dot_dash' as LineType, keyHint: '3', preview: '─·─', color: 'text-[#06B6D4]' },
              { id: 'construction' as LineType, keyHint: '4', preview: '···', color: 'text-[#10B981]' },
            ].map((lt) => (
              <button
                key={lt.id}
                onClick={() => onSetActiveLineType(lt.id)}
                title={`${dict.lineTypes[lt.id]} [快捷键 ${lt.keyHint}]`}
                className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                  activeLineType === lt.id
                    ? 'bg-[#1E293B] text-white border border-[#38BDF8]/50'
                    : 'text-[#94A3B8] hover:text-white'
                }`}
              >
                <span className={`font-mono font-bold ${lt.color}`}>{lt.preview}</span>
                <span>{dict.lineTypes[lt.id]}</span>
                <span className="text-[10px] font-mono text-[#64748B]">[{lt.keyHint}]</span>
              </button>
            ))}
          </div>
        )}

        {/* Right: Platform Switch + Diagnose + Derive + Dual Download/Export + Settings */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onSwitchToMobile}
            title="切换至手机竖屏触控专版 (Mobile Portrait App)"
            className="px-2.5 py-1.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#10B981]/50 text-xs font-medium text-[#10B981] hover:text-white flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>📱 切换至手机版</span>
          </button>

          {!isShowingLibraryGrid && (
            <>
              <button
                onClick={onDiagnose}
                className="px-3 py-1.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-xs font-medium text-[#E2E8F0] flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-[#F59E0B]" />
                <span>{dict.topActions.diagnose}</span>
              </button>

              <button
                onClick={onDerive}
                className="px-3.5 py-1.5 rounded-lg bg-[#0284C7] hover:bg-[#0369A1] text-xs font-semibold text-white flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>{dict.topActions.derive}</span>
              </button>

              <button
                onClick={onOpenDownloadModal}
                className="px-3 py-1.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-xs font-medium text-[#E2E8F0] flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5 text-[#38BDF8]" />
                <span>下载 / 导出</span>
              </button>
            </>
          )}

          <button
            onClick={onOpenSettingsModal}
            className="p-1.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-[#94A3B8] hover:text-white transition-colors"
            title={dict.topActions.settings}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {isShowingLibraryGrid ? (
        <div className="flex-1 overflow-y-auto p-8 bg-[#0B0F17]">
          <div className="max-w-5xl mx-auto space-y-6">
            <div>
              <h1 className="text-xl font-bold text-white font-display">
                {dict.libraryView.title}
              </h1>
              <p className="text-xs text-[#94A3B8] mt-1">{dict.libraryView.subtitle}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {localizedPresets.map((preset, index) => (
                <div
                  key={preset.id}
                  onClick={() => {
                    onEnterLibraryCase(preset);
                    const firstSol = preset.solutions[0];
                    setShowProjectionSteps(true);
                    setActiveStepIndex(
                      firstSol?.projectionSteps.length
                        ? firstSol.projectionSteps.length - 1
                        : 0
                    );
                  }}
                  className="group p-5 rounded-xl bg-[#111827] hover:bg-[#161F2E] border border-[#263244] hover:border-[#38BDF8] cursor-pointer transition-all flex flex-col justify-between space-y-4"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono text-[#38BDF8]">
                      <span>0{index + 1}</span>
                      <span>{preset.badge}</span>
                    </div>
                    <h2 className="text-sm font-semibold text-white group-hover:text-[#38BDF8] transition-colors">
                      {preset.name}
                    </h2>
                    <p className="text-xs text-[#94A3B8] leading-relaxed">
                      {preset.description}
                    </p>
                  </div>
                  <div className="pt-2 border-t border-[#1E293B] flex items-center justify-between">
                    <span className="text-[11px] font-mono text-[#64748B]">
                      {preset.solutions.length} {dict.libraryView.solutionsTitle}
                    </span>
                    <span className="px-3 py-1 rounded bg-[#0284C7] text-xs font-medium text-white">
                      {dict.libraryView.enterBtn}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {appMode === 'free' && (
            <FileExplorerPanel
              isOpen={filePanelOpen}
              onClose={() => setFilePanelOpen(false)}
              dict={dict.filePanel}
              currentEntities={freeEntities}
              onLoadEntities={onLoadFreeEntities}
              onNewBlank={onNewBlankFree}
            />
          )}

          {/* Left Desktop Drawing & OSNAP Sidebar */}
          <aside className="w-36 bg-[#111827] border-r border-[#263244] flex flex-col justify-between p-2 shrink-0">
            <div className="space-y-1">
              {[
                { id: 'select' as ToolType, icon: MousePointer },
                { id: 'pan' as ToolType, icon: Hand },
                { id: 'line' as ToolType, icon: Minus },
                { id: 'rect' as ToolType, icon: Square },
                { id: 'polygon' as ToolType, icon: Hexagon },
                { id: 'circle' as ToolType, icon: Circle },
                { id: 'arc' as ToolType, icon: Compass },
                { id: 'tangent' as ToolType, icon: MoveUpRight },
                { id: 'trim' as ToolType, icon: Scissors },
                { id: 'extend' as ToolType, icon: Maximize },
                { id: 'offset' as ToolType, icon: Layers },
                { id: 'erase' as ToolType, icon: Eraser },
              ].map((tool) => {
                const Icon = tool.icon;
                const active = activeTool === tool.id;
                const tInfo = dict.tools[tool.id] || {
                  label: tool.id,
                  desc: '',
                  shortcut: '',
                };
                const fullTooltip = `${tInfo.label}：${tInfo.desc} [${tInfo.shortcut}]`;
                return (
                  <div
                    key={tool.id}
                    className="relative"
                    onMouseEnter={() => setHoveredToolKey(tool.id)}
                    onMouseLeave={() => setHoveredToolKey(null)}
                  >
                    <button
                      onClick={() => onSetActiveTool(tool.id)}
                      className={`w-full px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-[#0284C7] text-white'
                          : 'bg-[#161F2E] text-[#CBD5E1] hover:bg-[#1E293B] border border-[#263244]'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <span>{tInfo.label}</span>
                    </button>
                    {hoveredToolKey === tool.id && (
                      <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 px-2.5 py-1.5 rounded bg-[#0B0F17] border border-[#38BDF8] text-[11px] text-white whitespace-nowrap shadow-xl pointer-events-none">
                        {fullTooltip}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pt-2 border-t border-[#263244] space-y-1.5">
              <div className="flex items-center justify-between px-0.5">
                <span className="text-[11px] font-medium text-[#94A3B8]">
                  {dict.snaps.title}
                </span>
                <button
                  onClick={() => onSetOrthoEnabled((prev) => !prev)}
                  title={`${dict.snaps.ortho} [F8]`}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    orthoEnabled ? 'bg-[#059669] text-white' : 'bg-[#161F2E] text-[#64748B]'
                  }`}
                >
                  {dict.snaps.ortho}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1">
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
                      title={sInfo.desc}
                      className={`py-1 rounded text-[11px] font-medium border transition-colors ${
                        enabledSnaps[sn]
                          ? 'bg-[#16273B] border-[#06B6D4]/60 text-[#E0F2FE]'
                          : 'bg-[#0B0F17] border-[#1E293B] text-[#64748B]'
                      }`}
                    >
                      {sInfo.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          {/* Center 4-Quadrant CAD Workstation Grid */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <main className="flex-1 relative grid grid-cols-2 grid-rows-2 gap-[1px] bg-[#263244] min-w-0 min-h-0">
              {/* Top-Left: Front View (X-Z) */}
              <div
                className={
                  is3DFullscreen ? 'hidden' : 'relative w-full h-full min-h-0'
                }
              >
                <CadViewport2D
                  view="front"
                  title={dict.views.front}
                  axisLabels={{ u: 'X', v: 'Z' }}
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
                  showDynamicHUD={showDynamicHUD}
                  showAlignmentRays={showAlignmentRays}
                  sharedCursor={sharedCursor}
                  onUpdateSharedCursor={setSharedCursor}
                  hoveredFeatureId={hoveredFeatureId}
                  onHoverFeature={setHoveredFeatureId}
                  showProjectionSteps={appMode === 'library' && showProjectionSteps}
                  projectionSteps={
                    appMode === 'library'
                      ? currentSolution?.projectionSteps || []
                      : []
                  }
                  activeStepIndex={activeStepIndex}
                  diagnostics={currentDiagnostics}
                  zoom={sharedZoom}
                  pan={sharedPan}
                  onChangeViewportTransform={handleViewportTransformChange}
                />
              </div>

              {/* Top-Right: Left View (Y-Z) */}
              <div
                className={
                  is3DFullscreen ? 'hidden' : 'relative w-full h-full min-h-0'
                }
              >
                <CadViewport2D
                  view="left"
                  title={dict.views.left}
                  axisLabels={{ u: 'Y', v: 'Z' }}
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
                  showDynamicHUD={showDynamicHUD}
                  showAlignmentRays={showAlignmentRays}
                  sharedCursor={sharedCursor}
                  onUpdateSharedCursor={setSharedCursor}
                  hoveredFeatureId={hoveredFeatureId}
                  onHoverFeature={setHoveredFeatureId}
                  showProjectionSteps={appMode === 'library' && showProjectionSteps}
                  projectionSteps={
                    appMode === 'library'
                      ? currentSolution?.projectionSteps || []
                      : []
                  }
                  activeStepIndex={activeStepIndex}
                  diagnostics={currentDiagnostics}
                  zoom={sharedZoom}
                  pan={sharedPan}
                  onChangeViewportTransform={handleViewportTransformChange}
                />
              </div>

              {/* Bottom-Left: Top View (X-Y) */}
              <div
                className={
                  is3DFullscreen ? 'hidden' : 'relative w-full h-full min-h-0'
                }
              >
                <CadViewport2D
                  view="top"
                  title={dict.views.top}
                  axisLabels={{ u: 'X', v: 'Y' }}
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
                  showDynamicHUD={showDynamicHUD}
                  showAlignmentRays={showAlignmentRays}
                  sharedCursor={sharedCursor}
                  onUpdateSharedCursor={setSharedCursor}
                  hoveredFeatureId={hoveredFeatureId}
                  onHoverFeature={setHoveredFeatureId}
                  showProjectionSteps={appMode === 'library' && showProjectionSteps}
                  projectionSteps={
                    appMode === 'library'
                      ? currentSolution?.projectionSteps || []
                      : []
                  }
                  activeStepIndex={activeStepIndex}
                  diagnostics={currentDiagnostics}
                  zoom={sharedZoom}
                  pan={sharedPan}
                  onChangeViewportTransform={handleViewportTransformChange}
                />
              </div>

              {/* Bottom-Right: Interactive 3D CAD Viewport + Candidate Solutions */}
              <div
                className={
                  is3DFullscreen
                    ? 'col-span-2 row-span-2 relative w-full h-full min-h-0'
                    : 'relative w-full h-full min-h-0'
                }
              >
                <Viewport3D
                  primitives={currentSolution?.primitives3D || []}
                  hoveredFeatureId={hoveredFeatureId}
                  isFullscreen={is3DFullscreen}
                  onToggleFullscreen={() => setIs3DFullscreen((prev) => !prev)}
                  xRayMode={xRayMode}
                  onToggleXRay={() => setXRayMode((prev) => !prev)}
                  materialPreset={materialPreset as any}
                  labels={dict.view3D}
                />

                {appMode === 'free' && currentSolutions.length > 1 && (
                  <div className="absolute bottom-2.5 left-2.5 right-2.5 z-50 pointer-events-auto flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#0D131F]/95 backdrop-blur-md border border-[#38BDF8]/40 shadow-lg">
                    <span className="text-[11px] font-medium text-[#38BDF8] shrink-0">
                      {dict.libraryView.solutionsTitle} ({currentSolutions.length})
                    </span>
                    <div className="flex items-center gap-1 overflow-x-auto pointer-events-auto">
                      {currentSolutions.map((sol, idx) => (
                        <button
                          key={sol.id}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectSolution(idx);
                          }}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer pointer-events-auto ${
                            idx === currentSolutionIndex
                              ? 'bg-[#0284C7] text-white shadow-sm'
                              : 'bg-[#161F2E] text-[#CBD5E1] hover:text-white border border-[#263244]'
                          }`}
                          title={sol.description}
                        >
                          {sol.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </main>
          </div>

          {/* Right Diagnostics Drawer (Free Mode) */}
          {appMode === 'free' && freeDiagDrawerOpen && (
            <aside className="w-72 bg-[#111827] border-l border-[#263244] flex flex-col min-h-0 shrink-0">
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[#263244] bg-[#0D131F]">
                <span className="text-xs font-semibold text-white">
                  {dict.diagnoseDrawer.title}
                </span>
                <button
                  onClick={() => onSetFreeDiagDrawerOpen(false)}
                  className="p-1 rounded text-[#94A3B8] hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {currentDiagnostics.length === 0 ? (
                  <div className="p-3 rounded-lg bg-[#064E3B]/30 border border-[#10B981] space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[#34D399]">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{dict.diagnoseDrawer.passed}</span>
                    </div>
                    <p className="text-[11px] text-[#A7F3D0] leading-relaxed">
                      {dict.diagnoseDrawer.passedDesc}
                    </p>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={onAutoFix}
                      className="w-full py-1.5 px-3 rounded bg-[#059669] hover:bg-[#047857] text-xs font-medium text-white flex items-center justify-center gap-1.5"
                    >
                      <Wrench className="w-3.5 h-3.5" />
                      <span>{dict.diagnoseDrawer.autoFix}</span>
                    </button>
                    {currentDiagnostics.map((issue) => (
                      <div
                        key={issue.id}
                        className="p-2.5 rounded-lg bg-[#7F1D1D]/25 border border-[#EF4444] space-y-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-1.5 text-xs font-semibold text-white">
                            <AlertTriangle className="w-3.5 h-3.5 text-[#EF4444] shrink-0 mt-0.5" />
                            <span>{issue.title}</span>
                          </div>
                          {issue.fixPayload && (
                            <button
                              onClick={() => onFixSingleIssue(issue)}
                              className="px-2 py-0.5 rounded bg-[#059669] hover:bg-[#047857] text-[10px] font-medium text-white shrink-0 transition-colors"
                            >
                              {dict.diagnoseDrawer.fixSingle}
                            </button>
                          )}
                        </div>
                        <p className="text-[11px] text-[#CBD5E1]">{issue.description}</p>
                        {issue.suggestion && (
                          <p className="text-[10px] text-[#34D399]">{issue.suggestion}</p>
                        )}
                      </div>
                    ))}
                  </>
                )}

                <div className="pt-2 border-t border-[#263244] space-y-2">
                  <button
                    onClick={onAiAnalyze}
                    disabled={aiLoading}
                    className="w-full py-1.5 px-3 rounded bg-[#16273B] hover:bg-[#1E293B] border border-[#38BDF8]/50 text-xs font-medium text-[#38BDF8] flex items-center justify-center gap-1.5"
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>
                      {aiLoading ? '...' : dict.diagnoseDrawer.aiAnalyzeBtn}
                    </span>
                  </button>
                  {aiAnalysisResult && (
                    <div className="p-2.5 rounded-lg bg-[#0B0F17] border border-[#263244] text-[11px] text-[#CBD5E1] space-y-1">
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
            </aside>
          )}

          {/* Right Exercise Sidebar (Library Mode) */}
          {appMode === 'library' && activeLibraryCase && (
            <aside className="w-76 bg-[#111827] border-l border-[#263244] flex flex-col min-h-0 shrink-0">
              <div className="px-3.5 py-2.5 border-b border-[#263244] bg-[#0D131F]">
                <div className="text-xs font-semibold text-white truncate">
                  {activeLibraryCase.name}
                </div>
                <div className="text-[11px] text-[#F59E0B] mt-0.5">
                  {dict.libraryView.tempNotice}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-4">
                {currentSolutions.length > 1 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-[#E2E8F0]">
                      {dict.libraryView.solutionsTitle} ({currentSolutions.length})
                    </div>
                    <div className="space-y-1.5">
                      {currentSolutions.map((sol, idx) => (
                        <button
                          key={sol.id}
                          onClick={() => onSelectSolution(idx)}
                          className={`w-full text-left p-2.5 rounded border text-xs transition-colors ${
                            idx === currentSolutionIndex
                              ? 'bg-[#16273B] border-[#38BDF8] text-white'
                              : 'bg-[#161F2E] border-[#263244] text-[#CBD5E1]'
                          }`}
                        >
                          <div className="font-semibold">{sol.title}</div>
                          <div className="text-[11px] text-[#94A3B8] mt-0.5">
                            {sol.description}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {currentSolution && currentSolution.projectionSteps.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-[#161F2E] border border-[#263244] space-y-2">
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => setShowProjectionSteps((prev) => !prev)}
                        className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 ${
                          showProjectionSteps
                            ? 'bg-[#059669] text-white'
                            : 'bg-[#0B0F17] text-[#94A3B8]'
                        }`}
                      >
                        <Play className="w-3 h-3" />
                        <span>{dict.libraryView.showSteps}</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowProjectionSteps(true);
                          setActiveStepIndex((prev) =>
                            prev + 1 < currentSolution.projectionSteps.length
                              ? prev + 1
                              : 0
                          );
                        }}
                        className="px-2 py-1 rounded bg-[#0284C7] text-white text-[11px] flex items-center gap-1"
                      >
                        <StepForward className="w-3 h-3" />
                        <span>{dict.libraryView.nextStep}</span>
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {currentSolution.projectionSteps.map((st, idx) => (
                        <div
                          key={st.id}
                          onClick={() => {
                            setShowProjectionSteps(true);
                            setActiveStepIndex(idx);
                          }}
                          className={`p-2 rounded border text-xs cursor-pointer transition-colors ${
                            idx === activeStepIndex && showProjectionSteps
                              ? 'bg-[#064E3B]/40 border-[#10B981] text-white'
                              : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
                          }`}
                        >
                          <div className="font-semibold">
                            Step {st.stepNumber}: {st.title}
                          </div>
                          <div className="text-[11px] text-[#94A3B8] mt-0.5">
                            {st.description}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">
                      {dict.diagnoseDrawer.title}
                    </span>
                    {currentDiagnostics.length > 0 && (
                      <button
                        onClick={onAutoFix}
                        className="px-2 py-0.5 rounded bg-[#059669] text-[11px] text-white"
                      >
                        {dict.diagnoseDrawer.autoFix}
                      </button>
                    )}
                  </div>
                  {currentDiagnostics.map((issue) => (
                    <div
                      key={issue.id}
                      className="p-2.5 rounded border border-[#EF4444]/70 bg-[#7F1D1D]/20 text-xs space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-white">{issue.title}</div>
                        {issue.fixPayload && (
                          <button
                            onClick={() => onFixSingleIssue(issue)}
                            className="px-2 py-0.5 rounded bg-[#059669] hover:bg-[#047857] text-[10px] font-medium text-white shrink-0 transition-colors"
                          >
                            {dict.diagnoseDrawer.fixSingle}
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-[#CBD5E1]">{issue.description}</p>
                      {issue.suggestion && (
                        <p className="text-[10px] text-[#34D399]">{issue.suggestion}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          )}
        </div>
      )}

      {/* Bottom CAD Coordinate Status Bar */}
      <footer className="flex items-center justify-between px-4 py-1 bg-[#0D131F] border-t border-[#263244] text-[11px] font-mono shrink-0">
        <div className="flex items-center gap-5">
          <span className="text-[#38BDF8] tabular-nums">
            X: {sharedCursor.x !== null ? sharedCursor.x.toFixed(1) : '0.0'}
          </span>
          <span className="text-[#10B981] tabular-nums">
            Y: {sharedCursor.y !== null ? sharedCursor.y.toFixed(1) : '0.0'}
          </span>
          <span className="text-[#F59E0B] tabular-nums">
            Z: {sharedCursor.z !== null ? sharedCursor.z.toFixed(1) : '0.0'}
          </span>
        </div>
      </footer>
    </div>
  );
};
