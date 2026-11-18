' 启动 dsh-pet 独立模式（不依赖 DSH 宿主）：隐藏控制台、脱离启动它的进程树。
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\projects\dsh-pet\dsh-pet"
sh.Run """E:\env\nodejs\node.exe"" ""E:\projects\dsh-pet\dsh-pet\lib\standalone.js""", 0, False
