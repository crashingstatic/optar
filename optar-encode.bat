@echo off
rem Convenience wrapper for Windows: runs optar-encode.jar next to this script.
setlocal
set HERE=%~dp0
java -jar "%HERE%optar-encode.jar" %*
exit /b %ERRORLEVEL%
