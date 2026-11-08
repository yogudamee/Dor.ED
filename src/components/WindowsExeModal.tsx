import React, { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileCode,
  FileSpreadsheet,
  FolderArchive,
  HardDriveDownload,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import { CadEntity, Primitive3D } from '../types/cad';
import { downloadTextFile, exportToDXF, exportToSTL, exportToSVG } from '../utils/exporters';

interface WindowsExeModalProps {
  isOpen: boolean;
  onClose: () => void;
  entities: CadEntity[];
  primitives: Primitive3D[];
  projectTitle: string;
  onImportEntities: (entities: CadEntity[]) => void;
}

const ELECTRON_MAIN_CODE = `// electron/main.cjs — EngiDraft 3D Windows 桌面端主进程
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#0B0F17',
    title: 'EngiDraft 3D — 工程制图三视图智能推导与三维重建系统',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('engidraft:save-file', async (_event, { defaultName, content, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (!canceled && filePath) {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { saved: true, filePath };
  }
  return { saved: false };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});`;

const BUILD_BAT_SCRIPT = `@echo off
chcp 65001 >nul
echo ====================================================================
echo   EngiDraft 3D — Windows 桌面端 (.exe) 国内免 VPN 一键构建脚本
echo ====================================================================
echo.
echo [0/3] 正在配置国内镜像源 (npmmirror)，无需开启任何 VPN...
set npm_config_registry=https://registry.npmmirror.com/
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
echo.
echo [1/3] 正在从国内镜像高速安装项目依赖与 Electron 打包器...
call npm install --registry=https://registry.npmmirror.com/
call npm install -D electron electron-builder --registry=https://registry.npmmirror.com/
echo.
echo [2/3] 正在编译高精度 2D/3D CAD 前端工程 (Vite Production Build)...
call npm run build
echo.
echo [3/3] 正在调用 electron-builder 生成 Windows 免安装便携版与 NSIS 安装包...
call npx electron-builder --win --x64
echo.
echo ====================================================================
echo   构建完成！请在 release/ 目录下获取生成的 Windows .exe 程序：
echo   - EngiDraft-3D-portable-1.0.0.exe (单文件免安装双击即用版)
echo   - EngiDraft-3D-nsis-1.0.0.exe     (标准 Windows 安装向导版)
echo ====================================================================
pause`;

export const WindowsExeModal: React.FC<WindowsExeModalProps> = ({
  isOpen,
  onClose,
  entities,
  primitives,
  projectTitle,
  onImportEntities,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!isOpen) return null;

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (Array.isArray(parsed.entities)) {
          onImportEntities(parsed.entities);
          onClose();
        }
      } catch {
        // Ignore malformed JSON
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
      <div className="bg-[#111827] border border-[#263244] rounded-xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#263244] bg-[#0D131F]">
          <div>
            <h2 className="text-base font-semibold text-white">
              CAD 工程文件导出与 Windows 桌面端 (.exe) 打包中心
            </h2>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              支持导出 AutoCAD (.dxf)、SolidWorks 三维实体 (.stl)、国标矢量图纸 (.svg) 及一键打包 Windows 可执行程序
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#94A3B8] hover:text-white hover:bg-[#1E293B] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Section 1: CAD & 3D File Exporters */}
          <div>
            <h3 className="text-sm font-semibold text-[#F1F5F9] mb-3">
              01. 导出二维三视图与三维实体模型（工业软件无缝互通）
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <button
                onClick={() => {
                  const dxf = exportToDXF(entities);
                  downloadTextFile('EngiDraft_ThreeViews.dxf', dxf, 'application/dxf');
                }}
                className="p-3.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-left transition-colors group"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <FileSpreadsheet className="w-4 h-4 text-[#38BDF8]" />
                  <span className="text-[11px] font-mono text-[#38BDF8]">.DXF</span>
                </div>
                <div className="text-xs font-semibold text-white group-hover:text-[#38BDF8]">
                  导出 AutoCAD 图纸
                </div>
                <div className="text-[11px] text-[#94A3B8] mt-0.5">
                  含实线/虚线/点画线独立图层
                </div>
              </button>

              <button
                onClick={() => {
                  const svg = exportToSVG(entities, projectTitle);
                  downloadTextFile('EngiDraft_Blueprint.svg', svg, 'image/svg+xml');
                }}
                className="p-3.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-left transition-colors group"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <FileCode className="w-4 h-4 text-[#10B981]" />
                  <span className="text-[11px] font-mono text-[#10B981]">.SVG</span>
                </div>
                <div className="text-xs font-semibold text-white group-hover:text-[#10B981]">
                  导出国标工程图纸
                </div>
                <div className="text-[11px] text-[#94A3B8] mt-0.5">
                  含 GB 标题栏与 45° 宽相等折线
                </div>
              </button>

              <button
                onClick={() => {
                  const stl = exportToSTL(primitives, projectTitle);
                  downloadTextFile('EngiDraft_3D_Model.stl', stl, 'model/stl');
                }}
                className="p-3.5 rounded-lg bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-left transition-colors group"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <HardDriveDownload className="w-4 h-4 text-[#F59E0B]" />
                  <span className="text-[11px] font-mono text-[#F59E0B]">.STL</span>
                </div>
                <div className="text-xs font-semibold text-white group-hover:text-[#F59E0B]">
                  导出 3D 实体网格
                </div>
                <div className="text-[11px] text-[#94A3B8] mt-0.5">
                  可直接用 SolidWorks / Fusion 打开
                </div>
              </button>

              <div className="p-3.5 rounded-lg bg-[#161F2E] border border-[#263244] flex flex-col justify-between">
                <div className="flex items-center justify-between mb-1">
                  <FolderArchive className="w-4 h-4 text-[#A78BFA]" />
                  <span className="text-[11px] font-mono text-[#A78BFA]">.JSON</span>
                </div>
                <div className="text-xs font-semibold text-white mb-2">工程存档保存 / 读取</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const data = JSON.stringify(
                        { projectTitle, exportedAt: new Date().toISOString(), entities },
                        null,
                        2
                      );
                      downloadTextFile('EngiDraft_Project.json', data, 'application/json');
                    }}
                    className="flex-1 px-2 py-1 rounded bg-[#263244] hover:bg-[#334155] text-[11px] text-white flex items-center justify-center gap-1 whitespace-nowrap"
                  >
                    <Download className="w-3 h-3" />
                    <span>保存</span>
                  </button>
                  <label className="flex-1 px-2 py-1 rounded bg-[#263244] hover:bg-[#334155] text-[11px] text-white flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap">
                    <Upload className="w-3 h-3" />
                    <span>加载</span>
                    <input
                      type="file"
                      accept=".json"
                      onChange={handleJsonUpload}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Windows .exe Packaging Instructions & One-Click Script */}
          <div className="pt-2 border-t border-[#263244]">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-[#F1F5F9]">
                  02. Windows 独立桌面端 (.exe) 打包方案（免安装便携版 + NSIS 安装向导版）
                </h3>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  本项目已内置完整的 <code className="text-[#38BDF8] font-mono">electron/main.cjs</code>、
                  <code className="text-[#38BDF8] font-mono">electron/preload.cjs</code> 与{' '}
                  <code className="text-[#38BDF8] font-mono">package.json</code> 打包配置。
                </p>
              </div>
              <button
                onClick={() =>
                  downloadTextFile('build-windows-exe.bat', BUILD_BAT_SCRIPT, 'application/bat')
                }
                className="px-3 py-1.5 rounded-lg bg-[#0284C7] hover:bg-[#0369A1] text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>下载一键打包脚本 (build-windows-exe.bat)</span>
              </button>
            </div>

            <div className="bg-[#0B0F17] border border-[#263244] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#CBD5E1]">
                  本地终端两步打包命令（Windows 10 / 11 64位）：
                </span>
                <button
                  onClick={() =>
                    copyText(
                      'cmd',
                      'npm install && npm install -D electron electron-builder && npm run build:exe'
                    )
                  }
                  className="px-2 py-1 rounded bg-[#161F2E] hover:bg-[#1E293B] text-[11px] text-[#38BDF8] flex items-center gap-1"
                >
                  {copiedKey === 'cmd' ? (
                    <>
                      <Check className="w-3 h-3" />
                      <span>已复制命令</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>复制命令</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="text-xs font-mono text-[#10B981] bg-[#111827] p-3 rounded border border-[#1E293B] overflow-x-auto">
{`# 1. 下载工程到本地后安装依赖与 Electron 构建工具
npm install
npm install -D electron electron-builder

# 2. 一键编译并打包生成 Windows 免安装 Portable .exe 与 NSIS 安装包
npm run build:exe`}
              </pre>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-[#94A3B8]">
                  已内置的 Electron 主进程源码预览 (electron/main.cjs)：
                </span>
                <button
                  onClick={() => copyText('main', ELECTRON_MAIN_CODE)}
                  className="px-2 py-1 rounded bg-[#161F2E] hover:bg-[#1E293B] text-[11px] text-[#94A3B8] hover:text-white flex items-center gap-1"
                >
                  {copiedKey === 'main' ? (
                    <>
                      <Check className="w-3 h-3 text-[#10B981]" />
                      <span>已复制源码</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>复制代码</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="text-[11px] font-mono text-[#CBD5E1] bg-[#0B0F17] p-3 rounded-lg border border-[#1E293B] max-h-48 overflow-y-auto">
                {ELECTRON_MAIN_CODE}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
