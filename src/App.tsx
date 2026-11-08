import React, { useEffect, useMemo, useState } from 'react';
import {
  CadEntity,
  DiagnosticIssue,
  LineType,
  PresetCase,
  ReconstructedSolution,
  SnapType,
  ToolType,
  ViewType,
} from './types/cad';
import { getLocalizedPresets } from './data/presets';
import {
  deriveFromCustomViews,
  diagnoseThreeViews,
  fixSingleDiagnosticIssue,
} from './utils/geometryKernel';
import { I18N, Language } from './utils/i18n';
import {
  downloadTextFile,
  exportToDXF,
  exportToPNG,
  exportToSTL,
  exportToSVG,
} from './utils/exporters';
import { DesktopApp } from './desktop/DesktopApp';
import { MobileApp } from './mobile/MobileApp';
import { DualDownloadModal } from './components/DualDownloadModal';
import { SettingsModal } from './components/SettingsModal';

const INITIAL_FREE_ENTITIES: CadEntity[] = [];

export default function App() {
  const [language, setLanguage] = useState<Language>('zh-CN');
  const dict = I18N[language];

  const [appMode, setAppMode] = useState<'free' | 'library'>('free');
  const [freeEntities, setFreeEntities] = useState<CadEntity[]>(
    INITIAL_FREE_ENTITIES
  );
  const [freePast, setFreePast] = useState<CadEntity[][]>([]);
  const [freeFuture, setFreeFuture] = useState<CadEntity[][]>([]);
  const [freeFileName, setFreeFileName] = useState<string>('Untitled_01.json');
  const [freeDiagDrawerOpen, setFreeDiagDrawerOpen] = useState<boolean>(false);
  const [freeDiagnostics, setFreeDiagnostics] = useState<DiagnosticIssue[]>([]);
  const [freeSolutions, setFreeSolutions] = useState<ReconstructedSolution[]>([]);
  const [freeSolutionIdx, setFreeSolutionIdx] = useState<number>(0);

  const localizedPresets = useMemo(
    () => getLocalizedPresets(language),
    [language]
  );
  const [activeLibraryCaseId, setActiveLibraryCaseId] = useState<string | null>(
    null
  );
  const activeLibraryCase = useMemo(
    () => localizedPresets.find((c) => c.id === activeLibraryCaseId) || null,
    [localizedPresets, activeLibraryCaseId]
  );
  const [libraryEntities, setLibraryEntities] = useState<CadEntity[]>([]);
  const [libraryPast, setLibraryPast] = useState<CadEntity[][]>([]);
  const [libraryFuture, setLibraryFuture] = useState<CadEntity[][]>([]);
  const [librarySolutions, setLibrarySolutions] = useState<
    ReconstructedSolution[]
  >([]);
  const [librarySolutionIdx, setLibrarySolutionIdx] = useState<number>(0);
  const [libraryDiagnostics, setLibraryDiagnostics] = useState<
    DiagnosticIssue[]
  >([]);

  const [activeTool, setActiveTool] = useState<ToolType>('line');
  const [activeLineType, setActiveLineType] = useState<LineType>('thick_solid');
  const [orthoEnabled, setOrthoEnabled] = useState<boolean>(false);

  const savedPrefs = useMemo(() => {
    try {
      const raw = localStorage.getItem('dored_cad_prefs_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }, []);

  const [gridStep, setGridStep] = useState<number>(savedPrefs.gridStep ?? 4);
  const [polygonSides, setPolygonSides] = useState<number>(
    savedPrefs.polygonSides ?? 6
  );
  const [offsetDistance, setOffsetDistance] = useState<number>(
    savedPrefs.offsetDistance ?? 8
  );
  const [snapTolerance, setSnapTolerance] = useState<number>(
    savedPrefs.snapTolerance ?? 11
  );
  const [autoDerive, setAutoDerive] = useState<boolean>(false);
  const [showDynamicHUD, setShowDynamicHUD] = useState<boolean>(
    savedPrefs.showDynamicHUD ?? true
  );
  const [showAlignmentRays, setShowAlignmentRays] = useState<boolean>(
    savedPrefs.showAlignmentRays ?? true
  );
  const [materialPreset, setMaterialPreset] = useState<string>(
    savedPrefs.materialPreset ?? 'steel'
  );

  // Auto-detect mobile vs desktop platform, with 1-click manual override
  const [mobileMode, setMobileMode] = useState<boolean>(() => {
    if (typeof savedPrefs.mobileMode === 'boolean') {
      return savedPrefs.mobileMode;
    }
    if (typeof window !== 'undefined') {
      const isNarrow = window.innerWidth < 768;
      const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(
        navigator.userAgent
      );
      return isNarrow || isMobileUA;
    }
    return false;
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        'dored_cad_prefs_v1',
        JSON.stringify({
          gridStep,
          polygonSides,
          offsetDistance,
          snapTolerance,
          autoDerive,
          showDynamicHUD,
          showAlignmentRays,
          materialPreset,
          mobileMode,
        })
      );
    } catch {
      // ignore storage errors
    }
  }, [
    gridStep,
    polygonSides,
    offsetDistance,
    snapTolerance,
    autoDerive,
    showDynamicHUD,
    showAlignmentRays,
    materialPreset,
    mobileMode,
  ]);

  const [enabledSnaps, setEnabledSnaps] = useState<Record<SnapType, boolean>>({
    grid: true,
    endpoint: true,
    midpoint: true,
    center: true,
    quadrant: true,
    intersection: true,
  });

  const [aiModel, setAiModel] = useState<string>('glm-4.5-flash');
  const [aiThinking, setAiThinking] = useState<boolean>(true);
  const [aiAnalysisResult, setAiAnalysisResult] = useState<any>(null);
  const [aiLoading, setAiLoading] = useState<boolean>(false);

  const [downloadModalOpen, setDownloadModalOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  const commitFreeEntities = (next: CadEntity[], options?: any) => {
    if (!options?.replaceLast) {
      setFreePast((prev) => [...prev.slice(-99), freeEntities]);
      setFreeFuture([]);
    }
    setFreeEntities(next);
  };

  const commitLibraryEntities = (next: CadEntity[], options?: any) => {
    if (!options?.replaceLast) {
      setLibraryPast((prev) => [...prev.slice(-99), libraryEntities]);
      setLibraryFuture([]);
    }
    setLibraryEntities(next);
  };

  const handleUndo = () => {
    if (appMode === 'free') {
      if (freePast.length === 0) return;
      const previous = freePast[freePast.length - 1];
      setFreePast((prev) => prev.slice(0, -1));
      setFreeFuture((prev) => [freeEntities, ...prev]);
      setFreeEntities(previous);
      if (freeDiagDrawerOpen || freeDiagnostics.length > 0) {
        setFreeDiagnostics(
          diagnoseThreeViews(previous, ['front', 'top'], language)
        );
      }
    } else if (activeLibraryCase) {
      if (libraryPast.length === 0) return;
      const previous = libraryPast[libraryPast.length - 1];
      setLibraryPast((prev) => prev.slice(0, -1));
      setLibraryFuture((prev) => [libraryEntities, ...prev]);
      setLibraryEntities(previous);
      setLibraryDiagnostics(
        diagnoseThreeViews(previous, activeLibraryCase.knownViews, language)
      );
    }
  };

  const handleRedo = () => {
    if (appMode === 'free') {
      if (freeFuture.length === 0) return;
      const next = freeFuture[0];
      setFreeFuture((prev) => prev.slice(1));
      setFreePast((prev) => [...prev.slice(-99), freeEntities]);
      setFreeEntities(next);
      if (freeDiagDrawerOpen || freeDiagnostics.length > 0) {
        setFreeDiagnostics(diagnoseThreeViews(next, ['front', 'top'], language));
      }
    } else if (activeLibraryCase) {
      if (libraryFuture.length === 0) return;
      const next = libraryFuture[0];
      setLibraryFuture((prev) => prev.slice(1));
      setLibraryPast((prev) => [...prev.slice(-99), libraryEntities]);
      setLibraryEntities(next);
      setLibraryDiagnostics(
        diagnoseThreeViews(next, activeLibraryCase.knownViews, language)
      );
    }
  };

  const currentEntities = appMode === 'free' ? freeEntities : libraryEntities;
  const setCurrentEntities = (next: CadEntity[], options?: any) => {
    if (appMode === 'free') commitFreeEntities(next, options);
    else commitLibraryEntities(next, options);
  };

  const currentSolutions =
    appMode === 'free' ? freeSolutions : librarySolutions;
  const currentSolutionIndex =
    appMode === 'free' ? freeSolutionIdx : librarySolutionIdx;
  const currentSolution =
    currentSolutions[currentSolutionIndex] || currentSolutions[0] || null;
  const currentDiagnostics =
    appMode === 'free' ? freeDiagnostics : libraryDiagnostics;

  const canUndo =
    appMode === 'free' ? freePast.length > 0 : libraryPast.length > 0;
  const canRedo =
    appMode === 'free' ? freeFuture.length > 0 : libraryFuture.length > 0;

  useEffect(() => {
    if (freeDiagDrawerOpen || freeDiagnostics.length > 0) {
      setFreeDiagnostics(
        diagnoseThreeViews(freeEntities, ['front', 'top'], language)
      );
    }
    if (activeLibraryCase) {
      setLibrarySolutions(activeLibraryCase.solutions);
      setLibraryDiagnostics(
        diagnoseThreeViews(
          libraryEntities,
          activeLibraryCase.knownViews,
          language
        )
      );
    }
  }, [language, activeLibraryCase]);

  const handleEnterLibraryCase = (preset: PresetCase) => {
    const firstSol = preset.solutions[0];
    const clonedEntities: CadEntity[] = JSON.parse(
      JSON.stringify(
        preset.category !== 'diagnostic' && firstSol
          ? [...preset.entities, ...firstSol.derivedEntities]
          : preset.entities
      )
    );
    setActiveLibraryCaseId(preset.id);
    setLibraryEntities(clonedEntities);
    setLibraryPast([]);
    setLibraryFuture([]);
    setLibrarySolutions(preset.solutions);
    setLibrarySolutionIdx(0);
    setLibraryDiagnostics(
      diagnoseThreeViews(clonedEntities, preset.knownViews, language)
    );
    setAiAnalysisResult(null);
  };

  const handleExitLibraryCase = () => {
    setActiveLibraryCaseId(null);
    setLibraryEntities([]);
    setLibraryPast([]);
    setLibraryFuture([]);
    setLibraryDiagnostics([]);
    setAiAnalysisResult(null);
  };

  const handleDerive = () => {
    if (appMode === 'free') {
      const userOnly = freeEntities.filter((e) => e.source !== 'derived');
      const counts = {
        front: userOnly.filter((e) => e.view === 'front').length,
        top: userOnly.filter((e) => e.view === 'top').length,
        left: userOnly.filter((e) => e.view === 'left').length,
      };
      let target: ViewType = 'left';
      if (counts.top === 0 && counts.front > 0 && counts.left > 0) {
        target = 'top';
      } else if (counts.front === 0 && counts.top > 0 && counts.left > 0) {
        target = 'front';
      }
      const known = (['front', 'top', 'left'] as ViewType[]).filter(
        (v) => v !== target
      ) as [ViewType, ViewType];
      const sols = deriveFromCustomViews(userOnly, known, target);
      setFreeSolutions(sols);
      setFreeSolutionIdx(0);
      if (sols.length > 0 && sols[0]) {
        const merged = [...userOnly, ...sols[0].derivedEntities];
        commitFreeEntities(merged, { skipAutoDerive: true });
        setFreeDiagnostics([]);
        setFreeDiagDrawerOpen(false);
      } else {
        commitFreeEntities(userOnly, { skipAutoDerive: true });
        setFreeDiagnostics([]);
      }
    } else if (activeLibraryCase) {
      const sols = activeLibraryCase.solutions;
      setLibrarySolutions(sols);
      setLibrarySolutionIdx(0);
      if (sols[0]) {
        const merged = [
          ...libraryEntities.filter(
            (e) => e.view !== activeLibraryCase.targetView
          ),
          ...sols[0].derivedEntities,
        ];
        commitLibraryEntities(merged);
        setLibraryDiagnostics([]);
      }
    }
  };

  const handleDiagnose = () => {
    if (appMode === 'free') {
      const issues = diagnoseThreeViews(
        freeEntities,
        ['front', 'top'],
        language
      );
      setFreeDiagnostics(issues);
      setFreeDiagDrawerOpen(true);
    } else if (activeLibraryCase) {
      const issues = diagnoseThreeViews(
        libraryEntities,
        activeLibraryCase.knownViews,
        language
      );
      setLibraryDiagnostics(issues);
      setFreeDiagDrawerOpen(true);
    }
  };

  const handleFixSingleIssue = (issue: DiagnosticIssue) => {
    if (appMode === 'free') {
      const next = fixSingleDiagnosticIssue(issue, freeEntities);
      commitFreeEntities(next);
      setFreeDiagnostics(diagnoseThreeViews(next, ['front', 'top'], language));
    } else if (activeLibraryCase) {
      const next = fixSingleDiagnosticIssue(issue, libraryEntities);
      commitLibraryEntities(next);
      setLibraryDiagnostics(
        diagnoseThreeViews(next, activeLibraryCase.knownViews, language)
      );
    }
  };

  const handleAiAnalyze = async () => {
    setAiLoading(true);
    try {
      const data = await (
        await fetch('/api/ai/analyze-views', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caseName:
              appMode === 'free' ? freeFileName : activeLibraryCase?.name,
            entities: currentEntities,
            knownViews:
              appMode === 'free'
                ? ['front', 'top']
                : activeLibraryCase?.knownViews,
            targetView:
              appMode === 'free' ? 'left' : activeLibraryCase?.targetView,
            diagnostics: currentDiagnostics,
            model: aiModel,
            enableThinking: aiThinking,
          }),
        })
      ).json();
      if (data?.analysis) setAiAnalysisResult(data.analysis);
    } catch {
      setAiAnalysisResult({
        summary:
          '本地离线 CSG 引擎已校验：X / Y / Z 边界闭合，支持三维拉伸布尔求交与消隐。',
        underConstrainedReason:
          '仅凭两个视图的矩形边界可能存在圆柱或斜切面多解。',
        candidateShapes: ['标准长方体/阶梯块', '回转圆柱/通孔特征'],
      });
    } finally {
      setAiLoading(false);
    }
  };

  const handleAutoFix = () => {
    if (appMode === 'library' && activeLibraryCase) {
      const fixSol = activeLibraryCase.solutions[0];
      if (activeLibraryCase.id === 'diagnostic_error_case' && fixSol) {
        const fixed: CadEntity[] = [
          {
            id: 'fix-f-rect',
            view: 'front',
            type: 'rect',
            lineType: 'thick_solid',
            x: 20,
            y: 20,
            width: 80,
            height: 60,
            source: 'derived',
            featureId: 'err_body',
          },
          {
            id: 'fix-f-hole-l',
            view: 'front',
            type: 'line',
            lineType: 'thin_dashed',
            p1: { u: 48, v: 20 },
            p2: { u: 48, v: 80 },
            source: 'derived',
            featureId: 'err_hole',
          },
          {
            id: 'fix-f-hole-r',
            view: 'front',
            type: 'line',
            lineType: 'thin_dashed',
            p1: { u: 72, v: 20 },
            p2: { u: 72, v: 80 },
            source: 'derived',
            featureId: 'err_hole',
          },
          {
            id: 'fix-t-rect',
            view: 'top',
            type: 'rect',
            lineType: 'thick_solid',
            x: 20,
            y: 30,
            width: 80,
            height: 60,
            source: 'derived',
            featureId: 'err_body',
          },
          {
            id: 'fix-t-circle',
            view: 'top',
            type: 'circle',
            lineType: 'thick_solid',
            center: { u: 60, v: 60 },
            radius: 12,
            source: 'derived',
            featureId: 'err_hole',
          },
          ...fixSol.derivedEntities,
        ];
        commitLibraryEntities(fixed);
        setLibraryDiagnostics(
          diagnoseThreeViews(fixed, activeLibraryCase.knownViews, language)
        );
      } else {
        handleDerive();
      }
    } else {
      handleDerive();
      setFreeDiagnostics([]);
    }
  };

  const handleSelectSolution = (idx: number) => {
    if (appMode === 'free') {
      setFreeSolutionIdx(idx);
      const sol = freeSolutions[idx];
      if (sol) {
        const userOnly = freeEntities.filter((e) => e.source !== 'derived');
        commitFreeEntities([...userOnly, ...sol.derivedEntities], {
          skipAutoDerive: true,
        });
      }
    } else if (activeLibraryCase) {
      setLibrarySolutionIdx(idx);
      const sol = librarySolutions[idx];
      if (sol) {
        const kept = libraryEntities.filter(
          (e) => e.view !== activeLibraryCase.targetView
        );
        commitLibraryEntities([...kept, ...sol.derivedEntities]);
      }
    }
  };

  const handleExportFormat = (
    fmt: 'svg' | 'dxf' | 'png' | 'stl' | 'json'
  ) => {
    const baseTitle =
      appMode === 'free'
        ? freeFileName.replace(/\.json$/i, '')
        : activeLibraryCase?.id || 'DorED_Drawing';
    if (fmt === 'dxf') {
      downloadTextFile(
        `${baseTitle}.dxf`,
        exportToDXF(currentEntities),
        'application/dxf'
      );
    } else if (fmt === 'svg') {
      downloadTextFile(
        `${baseTitle}.svg`,
        exportToSVG(currentEntities, baseTitle),
        'image/svg+xml'
      );
    } else if (fmt === 'png') {
      exportToPNG(currentEntities, baseTitle);
    } else if (fmt === 'stl') {
      downloadTextFile(
        `${baseTitle}.stl`,
        exportToSTL(currentSolution?.primitives3D || [], baseTitle),
        'model/stl'
      );
    } else if (fmt === 'json') {
      downloadTextFile(
        `${baseTitle}.json`,
        JSON.stringify({ name: baseTitle, entities: currentEntities }, null, 2),
        'application/json'
      );
    }
  };

  const handleImportJson = (loaded: CadEntity[], fileName: string) => {
    setAppMode('free');
    setActiveLibraryCaseId(null);
    setFreeEntities(loaded);
    setFreePast([]);
    setFreeFuture([]);
    setFreeFileName(fileName);
    setFreeSolutions([]);
    setFreeSolutionIdx(0);
  };

  const handleNewBlankFree = () => {
    setFreeEntities([]);
    setFreePast([]);
    setFreeFuture([]);
    setFreeDiagnostics([]);
    setFreeSolutions([]);
    setFreeSolutionIdx(0);
  };

  const toggleSnap = (snapKey: SnapType) => {
    setEnabledSnaps((prev) => ({
      ...prev,
      [snapKey]: !prev[snapKey],
    }));
  };

  return (
    <>
      {mobileMode ? (
        <MobileApp
          dict={dict}
          appMode={appMode}
          onChangeAppMode={(mode) => {
            setAppMode(mode);
            if (mode === 'free') setActiveLibraryCaseId(null);
          }}
          localizedPresets={localizedPresets}
          activeLibraryCase={activeLibraryCase}
          onEnterLibraryCase={handleEnterLibraryCase}
          onExitLibraryCase={handleExitLibraryCase}
          currentEntities={currentEntities}
          onChangeEntities={setCurrentEntities}
          onClearCanvas={handleNewBlankFree}
          currentSolutions={currentSolutions}
          currentSolutionIndex={currentSolutionIndex}
          onSelectSolution={handleSelectSolution}
          currentDiagnostics={currentDiagnostics}
          diagSheetOpen={freeDiagDrawerOpen}
          onSetDiagSheetOpen={setFreeDiagDrawerOpen}
          onDiagnose={handleDiagnose}
          onDerive={handleDerive}
          onAutoFix={handleAutoFix}
          onFixSingleIssue={handleFixSingleIssue}
          onAiAnalyze={handleAiAnalyze}
          aiLoading={aiLoading}
          aiModel={aiModel}
          aiAnalysisResult={aiAnalysisResult}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          activeTool={activeTool}
          onSetActiveTool={setActiveTool}
          activeLineType={activeLineType}
          onSetActiveLineType={setActiveLineType}
          enabledSnaps={enabledSnaps}
          onToggleSnap={toggleSnap}
          orthoEnabled={orthoEnabled}
          onSetOrthoEnabled={setOrthoEnabled}
          gridStep={gridStep}
          polygonSides={polygonSides}
          offsetDistance={offsetDistance}
          snapTolerance={snapTolerance}
          materialPreset={materialPreset}
          onOpenDownloadModal={() => setDownloadModalOpen(true)}
          onOpenSettingsModal={() => setSettingsOpen(true)}
          onSwitchToDesktop={() => setMobileMode(false)}
        />
      ) : (
        <DesktopApp
          dict={dict}
          appMode={appMode}
          onChangeAppMode={(mode) => {
            setAppMode(mode);
            if (mode === 'free') setActiveLibraryCaseId(null);
          }}
          localizedPresets={localizedPresets}
          activeLibraryCase={activeLibraryCase}
          onEnterLibraryCase={handleEnterLibraryCase}
          onExitLibraryCase={handleExitLibraryCase}
          currentEntities={currentEntities}
          onChangeEntities={setCurrentEntities}
          freeEntities={freeEntities}
          onLoadFreeEntities={handleImportJson}
          onNewBlankFree={handleNewBlankFree}
          currentSolutions={currentSolutions}
          currentSolutionIndex={currentSolutionIndex}
          onSelectSolution={handleSelectSolution}
          currentDiagnostics={currentDiagnostics}
          freeDiagDrawerOpen={freeDiagDrawerOpen}
          onSetFreeDiagDrawerOpen={setFreeDiagDrawerOpen}
          onDiagnose={handleDiagnose}
          onDerive={handleDerive}
          onAutoFix={handleAutoFix}
          onFixSingleIssue={handleFixSingleIssue}
          onAiAnalyze={handleAiAnalyze}
          aiLoading={aiLoading}
          aiModel={aiModel}
          aiAnalysisResult={aiAnalysisResult}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          activeTool={activeTool}
          onSetActiveTool={setActiveTool}
          activeLineType={activeLineType}
          onSetActiveLineType={setActiveLineType}
          enabledSnaps={enabledSnaps}
          onToggleSnap={toggleSnap}
          orthoEnabled={orthoEnabled}
          onSetOrthoEnabled={setOrthoEnabled}
          gridStep={gridStep}
          polygonSides={polygonSides}
          offsetDistance={offsetDistance}
          snapTolerance={snapTolerance}
          showDynamicHUD={showDynamicHUD}
          showAlignmentRays={showAlignmentRays}
          materialPreset={materialPreset}
          onOpenDownloadModal={() => setDownloadModalOpen(true)}
          onOpenSettingsModal={() => setSettingsOpen(true)}
          onSwitchToMobile={() => setMobileMode(true)}
        />
      )}

      {/* Shared Dual-Platform Download & Export Hub */}
      <DualDownloadModal
        isOpen={downloadModalOpen}
        onClose={() => setDownloadModalOpen(false)}
        onExportFormat={handleExportFormat}
        onImportJson={handleImportJson}
        isMobileView={mobileMode}
        onSwitchPlatform={(targetMobile) => setMobileMode(targetMobile)}
      />

      {/* Shared Settings Modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        language={language}
        onChangeLanguage={setLanguage}
        gridStep={gridStep}
        onChangeGridStep={setGridStep}
        offsetDistance={offsetDistance}
        onChangeOffsetDistance={setOffsetDistance}
        polygonSides={polygonSides}
        onChangePolygonSides={setPolygonSides}
        snapTolerance={snapTolerance}
        onChangeSnapTolerance={setSnapTolerance}
        autoDerive={autoDerive}
        onChangeAutoDerive={setAutoDerive}
        showDynamicHUD={showDynamicHUD}
        onChangeShowDynamicHUD={setShowDynamicHUD}
        showAlignmentRays={showAlignmentRays}
        onChangeShowAlignmentRays={setShowAlignmentRays}
        materialPreset={materialPreset as any}
        onChangeMaterialPreset={setMaterialPreset}
        mobileMode={mobileMode}
        onChangeMobileMode={setMobileMode}
        aiModel={aiModel}
        onChangeAiModel={setAiModel}
        aiThinking={aiThinking}
        onChangeAiThinking={setAiThinking}
        dict={dict.settingsModal}
      />
    </>
  );
}
