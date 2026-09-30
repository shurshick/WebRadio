@echo off
title Sonara Radio - register shutdown protocol
set "APP_DIR=%~dp0"

reg add "HKCU\Software\Classes\sonarashutdown" /ve /d "URL:Sonara Shutdown" /f >nul
reg add "HKCU\Software\Classes\sonarashutdown" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\sonarashutdown\DefaultIcon" /ve /d "shell32.dll,200" /f >nul
reg add "HKCU\Software\Classes\sonarashutdown\shell\open\command" /ve /t REG_SZ /d "\"%SystemRoot%\System32\wscript.exe\" \"%APP_DIR%shutdown-now.vbs\"" /f >nul

echo sonarashutdown: protocol registered OK
echo Sonara Radio can now shut down the PC when the sleep timer fires.
pause