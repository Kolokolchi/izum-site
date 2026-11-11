"""Маски вещей через Photoshop («Выделить предмет»). Photoshop должен быть установлен; управляется по COM.

    python -I tools/ps_mask.py <id> [кадры: 0,5,62 | all]

Кадры ролика ../Video/turn_<id>4k.mp4 приводятся к рабочей высоте, каждый открывается в Photoshop,
предмет выделяется, маска сохраняется в ../Video/ps_work/<id>/NNN.png (белое — вещь).
"""
import sys, os, time, subprocess
import cv2
import win32com.client as w

pid = sys.argv[1]
which = sys.argv[2] if len(sys.argv) > 2 else "all"
WORK = 1440
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
video = os.path.join(os.path.dirname(root), "Video", f"turn_{pid}4k.mp4")
work = os.path.join(os.path.dirname(root), "Video", "ps_work", pid)
os.makedirs(work, exist_ok=True)

JS = r'''
(function (src, dst) {
  var prevDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
  var prevUnits = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS;
  try {
    var d = app.open(new File(src));
    var desc = new ActionDescriptor();
    desc.putBoolean(stringIDToTypeID("sampleAllLayers"), false);
    executeAction(stringIDToTypeID("autoCutout"), desc, DialogModes.NO);
    var white = new SolidColor(); white.rgb.red = 255; white.rgb.green = 255; white.rgb.blue = 255;
    var black = new SolidColor(); black.rgb.red = 0; black.rgb.green = 0; black.rgb.blue = 0;
    d.selection.fill(white);
    d.selection.invert();
    d.selection.fill(black);
    d.selection.deselect();
    d.changeMode(ChangeMode.GRAYSCALE);
    var o = new PNGSaveOptions(); o.compression = 3; o.interlaced = false;
    d.saveAs(new File(dst), o, true, Extension.LOWERCASE);
    d.close(SaveOptions.DONOTSAVECHANGES);
    return "ok";
  } catch (e) {
    try { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
    return "err " + e;
  } finally { app.displayDialogs = prevDialogs; app.preferences.rulerUnits = prevUnits; }
})("%s", "%s");
'''

# Щадящий режим: пачка «Выделить предмет» на полной скорости перегревала ноутбук до аварийного выключения.
REST = float(os.environ.get("PS_REST", "9"))        # пауза после каждого кадра, секунд
GPU_MAX = int(os.environ.get("PS_GPU_MAX", "75"))   # выше этой температуры видеокарты ждём остывания

def calm():
    """Photoshop — пониженный приоритет и только 8 логических ядер."""
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "Get-Process Photoshop -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass = 'BelowNormal'; $_.ProcessorAffinity = 0xFF }"],
                   capture_output=True)

def gpu_temp():
    try: return int(subprocess.run(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader"], capture_output=True, text=True, timeout=10).stdout.strip().splitlines()[0])
    except Exception: return -1

def cool():
    time.sleep(REST)
    t = gpu_temp(); waited = 0
    while t >= GPU_MAX and waited < 600:
        if waited == 0: print(pid, f"видеокарта {t} °C — ждём остывания", flush=True)
        time.sleep(20); waited += 20; t = gpu_temp()

def connect():
    ps = w.dynamic.Dispatch("Photoshop.Application.200")   # запускает Photoshop, если он закрыт
    ps._FlagAsMethod("DoJavaScript")
    time.sleep(3); calm()
    return ps

ps = connect()

def run(js):
    """Photoshop иногда падает посреди пачки — переподключаемся и повторяем кадр."""
    global ps
    for attempt in range(4):
        try:
            return ps.DoJavaScript(js)
        except Exception as e:
            print(pid, "сбой Photoshop, переподключение", attempt + 1, flush=True)
            time.sleep(15)
            try: ps = connect()
            except Exception: time.sleep(30)
    return "err нет связи с Photoshop"
cap = cv2.VideoCapture(video)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
want = range(total - 1) if which == "all" else [int(v) for v in which.split(",")]
want = set(want)
t0 = time.time(); done = 0
for k in range(total - 1):
    ok, f = cap.read()
    if not ok: break
    if k not in want: continue
    dst = os.path.join(work, f"{k:03d}.png")
    if os.path.exists(dst): continue
    h, wd = f.shape[:2]
    if h > WORK: f = cv2.resize(f, (round(wd * WORK / h), WORK), interpolation=cv2.INTER_AREA)
    src = os.path.join(work, "_frame.png")
    cv2.imwrite(src, f)
    r = run(JS % (src.replace("\\", "/"), dst.replace("\\", "/")))
    done += 1
    cool()
    if r != "ok" or done % 10 == 0: print(pid, k, r, f"{(time.time() - t0) / done:.1f} с/кадр, видеокарта {gpu_temp()} °C", flush=True)
if os.path.exists(os.path.join(work, "_frame.png")): os.remove(os.path.join(work, "_frame.png"))
print(pid, "готово", done, f"{time.time() - t0:.0f} с")
