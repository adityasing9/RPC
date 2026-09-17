@echo off
:: BatchGotAdmin
:-------------------------------------
REM --> Check for permissions
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"

REM --> If error flag set, we do not have admin.
if '%errorlevel%' NEQ '0' (
    echo Requesting administrative privileges...
    goto UACPrompt
) else ( goto gotAdmin )

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
    set params = %*:"=""
    echo UAC.ShellExecute "cmd.exe", "/c ""%~s0"" %params%", "", "runas", 1 >> "%temp%\getadmin.vbs"

    "%temp%\getadmin.vbs"
    del "%temp%\getadmin.vbs"
    exit /B

:gotAdmin
    pushd "%CD%"
    CD /D "%~dp0"
:--------------------------------------

echo Adding Windows Firewall rule for RCPC (Port 8765)...
netsh advfirewall firewall delete rule name="RCPC Agent" >nul 2>&1
netsh advfirewall firewall add rule name="RCPC Agent" dir=in action=allow protocol=TCP localport=8765

echo Updating Windows Task Scheduler (Allow running on battery without stopping)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0; Set-ScheduledTask -TaskName 'RCPC_Windows_Agent' -Settings $settings -ErrorAction SilentlyContinue"

echo.
echo ========================================================
echo   SUCCESS! Windows Firewall & Background Task Configured!
echo ========================================================
echo.
pause
