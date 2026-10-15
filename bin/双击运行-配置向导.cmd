@echo off
rem ============================================================
rem  dsh-remote-agent setup launcher (double-click entry)
rem  Content is ASCII-only on purpose: cmd.exe parses batch files
rem  in the OEM codepage, non-ASCII text here WILL be garbled.
rem  The Chinese file name is fine (NTFS is Unicode); keep the
rem  file CONTENT ASCII.
rem ============================================================
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] "node" not found in PATH.
  echo         Please install Node.js 22+ first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo Starting dsh-remote-agent setup wizard ...
echo (Answer the questions in this window. Enter = default.)
echo.
node bin\dsh-remote-setup.js %*

echo.
echo Done. You can close this window.
pause
