'============================================================================
' create-shortcut.vbs - Create desktop shortcuts for easy access
'============================================================================
' Right-click and run this file to create shortcuts on your desktop
'============================================================================

Set oWS = WScript.CreateObject("WScript.Shell")

' Get the current directory
strDir = oWS.CurrentDirectory

' Create shortcut for start-server.bat
Set oLink = oWS.CreateShortcut(oWS.SpecialFolders("Desktop") & "\Start Church Overlay Server.lnk")
oLink.TargetPath = strDir & "\start-server.bat"
oLink.WorkingDirectory = strDir
oLink.Description = "Start the Church Overlay WebSocket server"
oLink.IconLocation = "cmd.exe,0"
oLink.Save

MsgBox "Shortcut created: Start Church Overlay Server.lnk", vbInformation, "Success"
