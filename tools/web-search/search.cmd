@echo off
rem ASCII-only on purpose: cmd reads .cmd files in the system codepage, so a
rem non-ASCII comment here gets mangled into bytes that can split the line.
node --preserve-symlinks-main "%~dp0search.mjs" %*
