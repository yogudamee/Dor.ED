@echo off
chcp 65001 >nul
echo ====================================================================
echo   EngiDraft 3D — Windows 桌面端 (.exe) 国内免 VPN 一键构建脚本
echo ====================================================================
echo.
echo [0/3] 正在配置国内阿里云/淘宝镜像源 (npmmirror)，无需开启任何 VPN...
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
echo   构建完成！请在 release\ 目录下获取生成的 Windows .exe 程序：
echo   - EngiDraft-3D-portable-1.0.0.exe (单文件免安装双击即用版)
echo   - EngiDraft-3D-nsis-1.0.0.exe     (标准 Windows 安装向导版)
echo ====================================================================
pause
