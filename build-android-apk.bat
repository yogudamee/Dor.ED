@echo off
chcp 65001 >nul
echo ====================================================================
echo   Dor.ED — Android 手机端 (.apk) 一键构建脚本 (国内镜像加速)
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
echo   APK 构建完成！安装包路径:
echo   android\app\build\outputs\apk\debug\app-debug.apk
echo ====================================================================
pause
