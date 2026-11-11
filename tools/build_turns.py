"""Нарезает ролики ../Video/turn_<id>4k.mp4 и вписывает размеры кадров в data.js.

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
        out = subprocess.run([sys.executable, "-I", os.path.join(root, "tools", "make_turntable.py"), os.path.join(video, f"turn_{pid}4k.mp4"), pid, extra],
                             capture_output=True, text=True, encoding="utf-8")
        print(pid, out.stdout.strip() or out.stderr.strip()[-400:])
        m = json.loads(re.search(r"turn: (\{.*?\})", out.stdout).group(1))
    turn = "{ " + ", ".join(f'{k}: "{v}"' if isinstance(v, str) else f"{k}: {v}" for k, v in m.items()) + " }"
    src, n1 = re.subn(rf'turn: \{{ dir: "img/turn/{pid}"[^\n]*\}},', f"turn: {turn},", src)
    src, n2 = re.subn(rf'(id: "{pid}", img: "[^"]*", )w: \d+, h: \d+,', rf'\g<1>w: {m["ow"]}, h: {m["oh"]},', src)
    assert n1 == 1 and n2 == 1, (pid, n1, n2)
    if only_meta: print(pid, turn)
open(data, "w", encoding="utf-8", newline="\n").write(src)
