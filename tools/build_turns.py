"""Нарезает ролики ../Video/turn_<id>4k.mp4 и вписывает размеры кадров в data.js.
У вещей с mirror (data.js) оборот достраивается зеркалом (mirror_turn.py), с compose — собирается из ролика
и двух коротких роликов через спину и лицо ../Video/turn_<id>_back4k.mp4, _front4k.mp4 (compose_spin.py).

    python -I tools/build_turns.py hoodie cap     — перечисленные вещи
    python -I tools/build_turns.py --meta hoodie  — только вписать размеры (кадры уже нарезаны)
"""
import os, re, subprocess, sys, json
from PIL import Image
import numpy as np

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
video = os.path.join(os.path.dirname(root), "Video")
data = os.path.join(root, "data.js")
args = sys.argv[1:]
only_meta = "--meta" in args
names = [a for a in args if not a.startswith("--")]
sys.stdout.reconfigure(encoding="utf-8")

def meta_from_frames(pid):
    """Размеры по уже нарезанным кадрам: hi/000 — полный кадр, рамка вещи — по плотной альфе."""
    d = os.path.join(root, "img", "turn", pid)
    a = np.array(Image.open(os.path.join(d, "hi", "000.webp")).convert("RGBA"))[..., 3]
    ys, xs = np.where(a > 200)
    return {"dir": f"img/turn/{pid}", "n": len(os.listdir(os.path.join(d, "lo"))), "fw": a.shape[1], "fh": a.shape[0],
            "ox": int(xs.min()), "oy": int(ys.min()), "ow": int(xs.max() + 1 - xs.min()), "oh": int(ys.max() + 1 - ys.min())}

src = open(data, encoding="utf-8").read()
for pid in names:
    if only_meta:
        m = meta_from_frames(pid)
    else:
        block = src[src.index(f'id: "{pid}"'):]
        block = block[:block.index("specs:")]
        extra = ",".join(re.findall(r"\bk: (\d+)", block))   # кадры спины и рукава из places
        src_frames = os.path.join(video, f"turn_{pid}4k.mp4")
        comp = re.search(r"\bcompose: (\d+)", block)     # снята в три четверти: оборот собирается из трёх роликов
        if comp:
            tool = lambda name, *a: subprocess.run([sys.executable, "-I", os.path.join(root, "tools", name), *a], text=True, encoding="utf-8")
            tool("compose_spin.py", "build", pid, comp.group(1), os.path.join(video, f"turn_{pid}_back4k.mp4"), os.path.join(video, f"turn_{pid}_front4k.mp4"))
            tool("ps_mask.py", pid, "spin")                  # маски Photoshop для новых кадров роликов Flow (~12 с на кадр)
            tool("compose_spin.py", "masks", pid)            # маски отражённых кадров — отражением
            src_frames, extra = os.path.join(video, "spin", pid), ""
        out = subprocess.run([sys.executable, "-I", os.path.join(root, "tools", "make_turntable.py"), src_frames, pid, extra],
                             capture_output=True, text=True, encoding="utf-8")
        print(pid, out.stdout.strip() or out.stderr.strip()[-400:])
        m = json.loads(re.search(r"turn: (\{.*?\})", out.stdout).group(1))
        mir = re.search(r"\bmirror: (\d+)", block)       # ролик-«качели»: полный оборот достраивается зеркалом
        if mir:
            out = subprocess.run([sys.executable, "-I", os.path.join(root, "tools", "mirror_turn.py"), pid, mir.group(1)],
                                 capture_output=True, text=True, encoding="utf-8")
            print(out.stdout.strip() or out.stderr.strip()[-400:])
            m["n"] = len(os.listdir(os.path.join(root, "img", "turn", pid, "lo")))
    turn = "{ " + ", ".join(f'{k}: "{v}"' if isinstance(v, str) else f"{k}: {v}" for k, v in m.items()) + " }"
    src, n1 = re.subn(rf'turn: \{{ dir: "img/turn/{pid}"[^\n]*\}},', f"turn: {turn},", src)
    src, n2 = re.subn(rf'(id: "{pid}", img: "[^"]*", )w: \d+, h: \d+,', rf'\g<1>w: {m["ow"]}, h: {m["oh"]},', src)
    assert n1 == 1 and n2 == 1, (pid, n1, n2)
    if only_meta: print(pid, turn)
open(data, "w", encoding="utf-8", newline="\n").write(src)
