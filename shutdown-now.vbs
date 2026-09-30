' Sonara Radio - shutdown computer (helper, no console window)
Set shell = CreateObject("WScript.Shell")
shell.Run "shutdown /s /f /t 0", 0, False