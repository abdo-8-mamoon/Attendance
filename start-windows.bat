@echo off
cd /d "%~dp0"
echo Starting Milestones Group HR...
where py >nul 2>&1
if errorlevel 1 (
  where python >nul 2>&1
  if errorlevel 1 (
    echo Python 3 was not found. Install Python 3, then run this file again.
    pause
    exit /b 1
  )
  set "PYTHON_CMD=python"
) else (
  set "PYTHON_CMD=py -3"
)
start "" /b cmd /c "ping 127.0.0.1 -n 3 >nul & start http://127.0.0.1:8080/"
echo The app will open in your default browser at http://127.0.0.1:8080/
%PYTHON_CMD% -m http.server 8080 --bind 127.0.0.1
pause
