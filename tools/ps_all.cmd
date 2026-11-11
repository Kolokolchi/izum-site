@echo off
rem Vyrezka vseh veshchej v Photoshop, shchadyashchij rezhim (pauzy i kontrol temperatury - v ps_mask.py)
cd /d "%~dp0.."
set PS_REST=10
set PS_GPU_MAX=86
for %%p in (cap ushanka tote hoodie sweatshirt tshirt polo bomber) do python -I tools\ps_mask.py %%p all >> "..\Video\ps_work\run.log" 2>&1
echo ALL DONE >> "..\Video\ps_work\run.log"
