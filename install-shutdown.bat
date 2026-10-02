@echo off
chcp 65001 >nul
echo =============================================
echo  Sonara Radio — Установщик таймера выключения
echo =============================================
echo.

set "APP_DIR=%LOCALAPPDATA%\SonaraRadio\"
if not exist "%APP_DIR%" mkdir "%APP_DIR%"
set "VBS=%APP_DIR%shutdown-now.vbs"
set "UNI=%APP_DIR%uninstall-shutdown.bat"

:: Регистрируем URI-протокол sonarashutdown:
reg add "HKCU\Software\Classes\sonarashutdown" /ve /d "URL:Sonara Shutdown" /f >nul
reg add "HKCU\Software\Classes\sonarashutdown" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\sonarashutdown\shell\open\command" /ve /t REG_SZ /d "\"wscript.exe\" \"%VBS%\"" /f >nul

:: Создаём VBS-helper с подтверждением и задержкой 30 сек
> "%VBS%" echo Set shell = CreateObject("WScript.Shell")
>> "%VBS%" echo Dim res
>> "%VBS%" echo res = shell.Popup("Sonara Radio: таймер сна завершён." ^& Chr(13) ^& Chr(10) ^& "Выключить компьютер через 30 секунд?" ^& Chr(13) ^& Chr(10) ^& "Windows может принудительно закрыть приложения. Сохраните работу." ^& Chr(13) ^& Chr(10) ^& "Нажмите ОК для подтверждения или Отмена.", 25, "Sonara Radio — Автовыключение", 1)
>> "%VBS%" echo If res = 1 Then
>> "%VBS%" echo     shell.Run "shutdown /s /t 30", 0, False
>> "%VBS%" echo Else
>> "%VBS%" echo     shell.Run "shutdown /a", 0, False
>> "%VBS%" echo End If

:: Создаём скрипт удаления
> "%UNI%" echo @echo off
>> "%UNI%" echo reg delete "HKCU\Software\Classes\sonarashutdown" /f ^>nul 2^>^&1
>> "%UNI%" echo del /f /q "%VBS%"
>> "%UNI%" echo del /f /q "%%~f0"
>> "%UNI%" echo echo Sonara Radio shutdown protocol removed.
>> "%UNI%" echo pause

echo.
echo [OK] Установка завершена!
echo       Протокол sonarashutdown: зарегистрирован.
echo       VBS-helper: %VBS%
echo       Деинсталлятор: %UNI%
echo.
echo  Функция "Выключить ПК" в Sonara Radio теперь работает.
echo  Перед выключением появится окно подтверждения на 25 секунд.
echo  Для отмены установки запустите: %UNI%
echo.
pause
