Option Explicit
Dim cmd
cmd = "wscript.exe //nologo ""E:\projects\dsh-pet\pet-standalone.vbs"""
Dim wmi
Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2:Win32_Process")
Dim rc
rc = wmi.Create(cmd)
WScript.Echo "create rc=" & rc
