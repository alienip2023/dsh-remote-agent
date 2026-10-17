@echo off
rem ============================================================
rem  dsh-remote-agent setup launcher (double-click entry)
rem  Content is ASCII-only on purpose: cmd.exe parses batch files
rem  in the OEM codepage, non-ASCII text here WILL be garbled.
rem  The FILE NAME is ASCII too: npm packs into a tar archive, and a
rem  non-ASCII name comes out as mojibake on extract (verified: the
rem  0.4.0 tarball shipped a mojibake name). NTFS itself is fine;
rem  the tar layer is not. Keep both name and content ASCII.
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
