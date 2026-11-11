import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  Layers,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  BenchmarkSuiteReport,
  getNormalizedBenchmarkPresets,
  runKernelBenchmarkSelfTest,
} from '../kernel';

export interface BenchmarkSelfTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadBenchmarkCase: (caseId: string) => void;
}

const VIEW_LABEL: Record<string, string> = {
  front: 'V(主)',
  top: 'H(俯)',
  left: 'W(左)',
};

export const BenchmarkSelfTestModal: React.FC<BenchmarkSelfTestModalProps> = ({
  isOpen,
  onClose,
  onLoadBenchmarkCase,
}) => {
  const [report, setReport] = useState<BenchmarkSuiteReport | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const totalBenchCount = getNormalizedBenchmarkPresets().length;

  if (!isOpen) return null;

  const executeSuite = () => {
    if (running) return;
    setRunning(true);
    window.setTimeout(() => {
      try {
        const res = runKernelBenchmarkSelfTest();
        setReport(res);
      } finally {
        setRunning(false);
      }
    }, 24);
  };

  const allPassed =
    report !== null &&
    report.totalCases > 0 &&
    report.passedCases === report.totalCases;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-6 select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl max-h-[90vh] rounded-xl bg-[#0D131F] border border-[#263244] shadow-2xl flex flex-col overflow-hidden text-[#F1F5F9]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 bg-[#111827] border-b border-[#263244] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#0284C7]/20 border border-[#38BDF8]/40 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4 text-[#38BDF8]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-white truncate">
                6 层计算几何与 3D 体元 CSP 求解内核 — {totalBenchCount} 项高阶基准自检
              </h2>
              <p className="text-[11px] text-[#94A3B8] truncate">
                DCEL 平面布置图 · 斜边半空间裁剪 · GeneralizedLoft 广义放样 · 曲边体元 CSP · 定量消隐闭环
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={executeSuite}
              disabled={running}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                running
                  ? 'bg-[#1E293B] text-[#94A3B8] cursor-wait'
                  : 'bg-[#0284C7] hover:bg-[#0369A1] text-white'
              }`}
            >
              {running ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>正在求解 {totalBenchCount} 组三维曲边体元...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>{report ? '重新执行全量基准自检' : `立即执行 ${totalBenchCount} 项基准自检`}</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-[#94A3B8] hover:text-white transition-colors"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {!report && !running && (
            <div className="p-8 rounded-xl bg-[#111827] border border-[#263244] text-center space-y-4">
              <div className="w-12 h-12 rounded-xl bg-[#16273B] border border-[#38BDF8]/40 flex items-center justify-center mx-auto">
                <Cpu className="w-6 h-6 text-[#38BDF8]" />
              </div>
              <div className="space-y-1.5 max-w-xl mx-auto">
                <h3 className="text-sm font-bold text-white">
                  一键验证全部 {totalBenchCount} 道《工程制图》魔鬼变形题与流形网格质量
                </h3>
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  涵盖正六棱柱单孔/正交三通圆孔相贯、横向六棱柱/正六棱锥/正六棱台/内六角通孔、三阶同心圆柱台阶轴、圆锥开方槽、同径刃口薄壁空心圆台、偏心斜圆台、圆锥+半球复合体、共顶弦双半圆斜通孔、拱形正交交叉孔及物理真多解枚举。
                </p>
              </div>
              <button
                type="button"
                onClick={executeSuite}
                className="px-5 py-2 rounded-lg bg-[#0284C7] hover:bg-[#0369A1] text-xs font-semibold text-white inline-flex items-center gap-2 transition-colors"
              >
                <Play className="w-4 h-4" />
                <span>开始运行全量自检 ({totalBenchCount} Cases)</span>
              </button>
            </div>
          )}

          {running && (
            <div className="p-8 rounded-xl bg-[#111827] border border-[#263244] text-center space-y-3">
              <RefreshCw className="w-6 h-6 text-[#38BDF8] animate-spin mx-auto" />
              <div className="text-xs font-medium text-[#E2E8F0]">
                正在依次执行 2D 拓扑剖分、射影半空间升維、3D 曲边体元 CSP 分支定界求解与水密流形网格校验...
              </div>
            </div>
          )}

          {report && !running && (
            <>
              {/* Metrics Summary Row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div
                  className={`p-3.5 rounded-xl border ${
                    allPassed
                      ? 'bg-[#064E3B]/25 border-[#10B981]/60'
                      : 'bg-[#7F1D1D]/25 border-[#EF4444]/60'
                  }`}
                >
                  <div className="text-[11px] text-[#94A3B8] flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981]" />
                    <span>基准通过率</span>
                  </div>
                  <div className="mt-1 text-lg font-bold font-mono text-white">
                    {report.passedCases} / {report.totalCases}
                  </div>
                  <div className="text-[10px] text-[#34D399] mt-0.5">
                    {allPassed ? '100% 零回归通过' : '存在待检项'}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-[#111827] border border-[#263244]">
                  <div className="text-[11px] text-[#94A3B8] flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-[#38BDF8]" />
                    <span>{report.totalCases} 题总计耗时</span>
                  </div>
                  <div className="mt-1 text-lg font-bold font-mono text-[#38BDF8]">
                    {report.totalTimeMs.toFixed(1)} ms
                  </div>
                  <div className="text-[10px] text-[#64748B] mt-0.5">
                    平均 {(report.totalTimeMs / Math.max(1, report.totalCases)).toFixed(1)} ms / 题
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-[#111827] border border-[#263244]">
                  <div className="text-[11px] text-[#94A3B8] flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-[#F59E0B]" />
                    <span>流形三角面片总数</span>
                  </div>
                  <div className="mt-1 text-lg font-bold font-mono text-white">
                    {report.results
                      .reduce((acc, r) => acc + r.watertightTriangles, 0)
                      .toLocaleString()}
                  </div>
                  <div className="text-[10px] text-[#64748B] mt-0.5">
                    代数化简锐边参数化网格 (Outward CCW)
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-[#111827] border border-[#263244]">
                  <div className="text-[11px] text-[#94A3B8] flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-[#10B981]" />
                    <span>重投影平均置信度</span>
                  </div>
                  <div className="mt-1 text-lg font-bold font-mono text-[#10B981]">
                    {(
                      (report.results.reduce((acc, r) => acc + r.recallKnownViews, 0) /
                        Math.max(1, report.results.length)) *
                      100
                    ).toFixed(1)}
                    %
                  </div>
                  <div className="text-[10px] text-[#64748B] mt-0.5">
                    3D → 2D 双向定量消隐验证
                  </div>
                </div>
              </div>

              {/* Detailed Table */}
              <div className="rounded-xl border border-[#263244] bg-[#111827] overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#090D14] border-b border-[#263244] text-[11px] text-[#94A3B8]">
                        <th className="py-2.5 px-3 font-semibold">状态</th>
                        <th className="py-2.5 px-3 font-semibold">高阶基准测试案例</th>
                        <th className="py-2.5 px-2.5 font-semibold whitespace-nowrap">推导方向</th>
                        <th className="py-2.5 px-2.5 font-semibold whitespace-nowrap">占用体元</th>
                        <th className="py-2.5 px-2.5 font-semibold whitespace-nowrap">构型数</th>
                        <th className="py-2.5 px-2.5 font-semibold whitespace-nowrap">导出图元 (实/虚/轴)</th>
                        <th className="py-2.5 px-2.5 font-semibold whitespace-nowrap">流形面数</th>
                        <th className="py-2.5 px-2.5 font-semibold whitespace-nowrap">耗时</th>
                        <th className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E293B]">
                      {report.results.map((item) => (
                        <tr
                          key={item.caseId}
                          className="hover:bg-[#161F2E]/80 transition-colors"
                        >
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {item.passed ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#064E3B]/40 border border-[#10B981]/50 text-[11px] font-medium text-[#34D399]">
                                <CheckCircle2 className="w-3 h-3" />
                                PASS
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#7F1D1D]/40 border border-[#EF4444]/50 text-[11px] font-medium text-[#F87171]">
                                <AlertTriangle className="w-3 h-3" />
                                FAIL
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-semibold text-white">
                              {item.caseName}
                            </div>
                            <div className="text-[11px] text-[#94A3B8] mt-0.5">
                              {item.notes}
                            </div>
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-[11px] text-[#CBD5E1] whitespace-nowrap">
                            {VIEW_LABEL[item.knownViews[0]]}+
                            {VIEW_LABEL[item.knownViews[1]]} →{' '}
                            <span className="text-[#38BDF8] font-semibold">
                              {VIEW_LABEL[item.targetView]}
                            </span>
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-[11px] text-[#CBD5E1] whitespace-nowrap">
                            {item.occupiedCellCount} / {item.cellCount}
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-[11px] whitespace-nowrap">
                            <span
                              className={
                                item.solutionCount > 1
                                  ? 'text-[#38BDF8] font-semibold'
                                  : 'text-[#CBD5E1]'
                              }
                            >
                              {item.solutionCount} 解
                            </span>
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-[11px] whitespace-nowrap">
                            <span className="text-white">{item.derivedSolidCount}</span>
                            {' / '}
                            <span className="text-[#F59E0B]">{item.derivedDashedCount}</span>
                            {' / '}
                            <span className="text-[#06B6D4]">{item.derivedCenterlineCount}</span>
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-[11px] text-[#CBD5E1] whitespace-nowrap">
                            {item.watertightTriangles}
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-[11px] text-[#10B981] whitespace-nowrap">
                            {item.solveTimeMs.toFixed(1)} ms
                          </td>
                          <td className="py-2.5 px-3 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => {
                                onLoadBenchmarkCase(item.caseId);
                                onClose();
                              }}
                              className="px-2.5 py-1 rounded bg-[#16273B] hover:bg-[#0284C7] border border-[#38BDF8]/50 text-[11px] font-medium text-[#E0F2FE] hover:text-white inline-flex items-center gap-1 transition-colors"
                            >
                              <span>载入预览</span>
                              <ArrowUpRight className="w-3 h-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
