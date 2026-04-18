@echo off
rem Convenience wrapper for Windows: runs optar.jar that sits next to this script.
setlocal
set HERE=%~dp0
java -jar "%HERE%optar.jar" %*
exit /b %ERRORLEVEL%
