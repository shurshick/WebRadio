Set shell = CreateObject("WScript.Shell")
Dim res
res = shell.Popup("Sonara Radio: таймер сна завершён." & Chr(13) & Chr(10) & "Выключить компьютер через 30 секунд?" & Chr(13) & Chr(10) & Chr(13) & Chr(10) & "Нажмите ОК для подтверждения или Отмена для прерывания.", 25, "Sonara Radio — Автовыключение", 1)
If res = 1 Then
    shell.Run "shutdown /s /t 30", 0, False
Else
    shell.Run "shutdown /a", 0, False
End If