@echo off
cd /d "%~dp0"
echo Plane das Set (nur neue Songs werden analysiert) ...
python -P plan_set.py
start "" http://127.0.0.1:8141/
python server.py 8141
