@echo off
rem build.bat —— 按参数交叉编译：build.bat [win^|linux^|mac^|mac:x64]；缺省宿主原生
if "%~1"=="" (
	bun run packages/backend/scripts/build.ts
) else (
	bun run packages/backend/scripts/build.ts --target=%~1
)
