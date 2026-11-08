import React, { useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FolderUp,
  Laptop,
  Package,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react';
import { CadEntity } from '../types/cad';
import { downloadTextFile } from '../utils/exporters';

interface DualDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onExportFormat: (fmt: 'svg' | 'dxf' | 'png' | 'stl' | 'json') => void;
  onImportJson?: (entities: CadEntity[], fileName: string) => void;
  isMobileView: boolean;
  onSwitchPlatform: (targetMobile: boolean) => void;
}

const WIN_BUILD_BAT = `@echo off
chcp 65001 >nul
echo ========================================================
echo   Dor.ED 3D Engineering CAD - Windows (.exe) Builder
echo ========================================================
echo [1/3] Configuring China npmmirror & Electron mirror...
call npm config set registry https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo [2/3] Installing dependencies...
call npm install
echo [3/3] Building frontend & packaging Windows .exe...
call npm run build
call npx electron-builder --win --x64
echo ========================================================
echo   Done! Check the /release folder for your .exe file.
echo ========================================================
pause
`;

const ANDROID_BUILD_BAT = `@echo off
chcp 65001 >nul
echo ========================================================
echo   Dor.ED 3D Engineering CAD - Android (.apk) Builder
echo ========================================================
echo [1/4] Configuring npmmirror...
call npm config set registry https://registry.npmmirror.com
echo [2/4] Installing dependencies & Capacitor Android...
call npm install
call npm install @capacitor/core @capacitor/cli @capacitor/android
echo [3/4] Building mobile-optimized web bundle...
call npm run build
echo [4/4] Syncing Android project...
call npx cap sync android
echo ========================================================
echo   Done! Run "npx cap open android" or "./gradlew assembleDebug"
echo   inside /android to generate the installable .apk file.
echo ========================================================
pause
`;

export const DualDownloadModal: React.FC<DualDownloadModalProps> = ({
  isOpen,
  onClose,
  onExportFormat,
  onImportJson,
  isMobileView,
  onSwitchPlatform,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const appUrl = typeof window !== 'undefined' ? window.location.href : 'https://dored-cad.app';

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onImportJson) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const list = Array.isArray(parsed) ? parsed : parsed?.entities;
        if (Array.isArray(list)) {
          onImportJson(list, file.name);
          onClose();
        }
      } catch {
        // ignore invalid json
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 backdrop-blur-sm p-3 sm:p-6 select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90dvh] bg-[#0D131F] border border-[#263244] rounded-2xl shadow-2xl flex flex-col overflow-hidden text-[#F1F5F9]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#111827] border-b border-[#263244] shrink-0">
          <div className="flex items-center gap-2.5">
            <Download className="w-4 h-4 text-[#38BDF8]" />
            <h2 className="text-sm sm:text-base font-bold tracking-tight text-white">
              双端下载与图纸导出中心 (Desktop & Mobile Hub)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="min-w-[36px] min-h-[36px] rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] flex items-center justify-center text-[#94A3B8] hover:text-white transition-colors"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
          {/* Section 1: Drawing & 3D Model Export */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#38BDF8]">
                📄 图纸与三维实体导出 (CAD / 3D Exports)
              </span>
              {onImportJson && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="px-2.5 py-1 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-xs font-medium text-[#CBD5E1] hover:text-white flex items-center gap-1.5 transition-colors"
                  >
                    <FolderUp className="w-3.5 h-3.5 text-[#10B981]" />
                    <span>导入 JSON 工程文件</span>
                  </button>
                </>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <button
                onClick={() => onExportFormat('svg')}
                className="p-3 rounded-xl bg-[#111827] hover:bg-[#16273B] border border-[#263244] hover:border-[#38BDF8] flex flex-col items-start gap-1.5 transition-all text-left group"
              >
                <FileCode2 className="w-4 h-4 text-[#38BDF8]" />
                <div className="text-xs font-semibold text-white group-hover:text-[#38BDF8]">
                  SVG 矢量蓝图
                </div>
                <div className="text-[10px] text-[#94A3B8]">GB/T 国标三视图框</div>
              </button>

              <button
                onClick={() => onExportFormat('png')}
                className="p-3 rounded-xl bg-[#111827] hover:bg-[#16273B] border border-[#263244] hover:border-[#38BDF8] flex flex-col items-start gap-1.5 transition-all text-left group"
              >
                <FileImage className="w-4 h-4 text-[#10B981]" />
                <div className="text-xs font-semibold text-white group-hover:text-[#10B981]">
                  PNG 高清图片
                </div>
                <div className="text-[10px] text-[#94A3B8]">1840×1360 视网膜级</div>
              </button>

              <button
                onClick={() => onExportFormat('dxf')}
                className="p-3 rounded-xl bg-[#111827] hover:bg-[#16273B] border border-[#263244] hover:border-[#38BDF8] flex flex-col items-start gap-1.5 transition-all text-left group"
              >
                <FileText className="w-4 h-4 text-[#F59E0B]" />
                <div className="text-xs font-semibold text-white group-hover:text-[#F59E0B]">
                  DXF 工程图纸
                </div>
                <div className="text-[10px] text-[#94A3B8]">AutoCAD R12 兼容</div>
              </button>

              <button
                onClick={() => onExportFormat('stl')}
                className="p-3 rounded-xl bg-[#111827] hover:bg-[#16273B] border border-[#263244] hover:border-[#38BDF8] flex flex-col items-start gap-1.5 transition-all text-left group"
              >
                <Package className="w-4 h-4 text-[#A855F7]" />
                <div className="text-xs font-semibold text-white group-hover:text-[#A855F7]">
                  STL 三维模型
                </div>
                <div className="text-[10px] text-[#94A3B8]">SolidWorks / 3D打印</div>
              </button>

              <button
                onClick={() => onExportFormat('json')}
                className="p-3 rounded-xl bg-[#111827] hover:bg-[#16273B] border border-[#263244] hover:border-[#38BDF8] flex flex-col items-start gap-1.5 transition-all text-left group col-span-2 sm:col-span-1"
              >
                <FileJson className="w-4 h-4 text-[#06B6D4]" />
                <div className="text-xs font-semibold text-white group-hover:text-[#06B6D4]">
                  JSON 工程包
                </div>
                <div className="text-[10px] text-[#94A3B8]">跨端无损存档</div>
              </button>
            </div>
          </div>

          {/* Section 2: Dual Platform Isolation & Download Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Desktop Workstation Card */}
            <div className="p-4 rounded-xl bg-[#111827] border border-[#263244] flex flex-col justify-between space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Laptop className="w-4 h-4 text-[#38BDF8]" />
                    <span className="text-sm font-bold text-white">
                      💻 电脑端下载 (Windows .exe)
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-[#38BDF8]">
                    PC 四宫格工作站
                  </span>
                </div>
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  专为大屏键鼠设计：主/俯/左/3D 四视窗同屏联动，支持滚轮光标缩放、中键平移与 1-4 国标线型快捷键。
                </p>
                <div className="p-2.5 rounded-lg bg-[#0B0F17] border border-[#1E293B] font-mono text-[11px] text-[#CBD5E1] flex items-center justify-between gap-2">
                  <span className="truncate">npm install && npm run dist:win</span>
                  <button
                    onClick={() => handleCopy('win', 'npm install && npm run dist:win')}
                    className="px-2 py-1 rounded bg-[#161F2E] hover:bg-[#1E293B] text-[10px] text-[#38BDF8] flex items-center gap-1 shrink-0"
                  >
                    {copiedKey === 'win' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'win' ? '已复制' : '复制'}</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                <button
                  onClick={() =>
                    downloadTextFile('build_windows_exe.bat', WIN_BUILD_BAT, 'application/bat')
                  }
                  className="flex-1 py-2 px-3 rounded-lg bg-[#0284C7] hover:bg-[#0369A1] text-xs font-semibold text-white flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下载 Windows (.exe) 构建脚本</span>
                </button>
                {isMobileView && (
                  <button
                    onClick={() => {
                      onSwitchPlatform(false);
                      onClose();
                    }}
                    className="py-2 px-3 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-xs font-medium text-[#E2E8F0] whitespace-nowrap"
                  >
                    切换至电脑版
                  </button>
                )}
              </div>
            </div>

            {/* Mobile Portrait App Card */}
            <div className="p-4 rounded-xl bg-[#111827] border border-[#263244] flex flex-col justify-between space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-[#10B981]" />
                    <span className="text-sm font-bold text-white">
                      📱 手机端下载 (Android .apk / PWA)
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-[#10B981]">
                    9:16 竖屏触控专版
                  </span>
                </div>
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  专为手机单手竖屏定制：上方「三等关系对齐联动窗」+ 全宽主画布 + 36px 防遮挡偏移准星 + 双指捏合缩放平移。
                </p>
                <div className="p-2.5 rounded-lg bg-[#0B0F17] border border-[#1E293B] flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-[#E2E8F0]">
                      手机浏览器免安装直达 / 添加到主屏幕：
                    </div>
                    <div className="text-[10px] font-mono text-[#64748B] truncate mt-0.5">
                      {appUrl}
                    </div>
                  </div>
                  <button
                    onClick={() => handleCopy('url', appUrl)}
                    className="px-2.5 py-1.5 rounded bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-[10px] font-medium text-[#10B981] flex items-center gap-1 shrink-0"
                  >
                    {copiedKey === 'url' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'url' ? '已复制链接' : '复制手机链接'}</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                <button
                  onClick={() =>
                    downloadTextFile('build_android_apk.bat', ANDROID_BUILD_BAT, 'application/bat')
                  }
                  className="flex-1 py-2 px-3 rounded-lg bg-[#059669] hover:bg-[#047857] text-xs font-semibold text-white flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下载 Android (.apk) 构建脚本</span>
                </button>
                {!isMobileView && (
                  <button
                    onClick={() => {
                      onSwitchPlatform(true);
                      onClose();
                    }}
                    className="py-2 px-3 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#10B981]/50 text-xs font-medium text-[#10B981] flex items-center justify-center gap-1 whitespace-nowrap"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>预览手机竖屏版</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
