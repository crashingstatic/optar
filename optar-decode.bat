@echo off
rem Convenience wrapper for Windows: runs optar-decode.jar next to this script.
setlocal
set HERE=%~dp0
java -jar "%HERE%optar-decode.jar" %*
exit /b %ERRORLEVEL%
