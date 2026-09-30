@echo off
chcp 65001 >nul
echo ==============================================
echo  Sonara Radio — Удаление таймера выключения
echo ==============================================
echo.

reg delete "HKCU\Software\Classes\sonarashutdown" /f >nul 2>&1
if exist "%LOCALAPPDATA%\SonaraRadio\shutdown-now.vbs" del /f /q "%LOCALAPPDATA%\SonaraRadio\shutdown-now.vbs"
if exist "%LOCALAPPDATA%\SonaraRadio\uninstall-shutdown.bat" del /f /q "%LOCALAPPDATA%\SonaraRadio\uninstall-shutdown.bat"

echo.
echo [OK] Протокол sonarashutdown: и связанные файлы успешно удалены.
echo.
pause
