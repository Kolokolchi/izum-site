"""Полный оборот для вещей, снятых в три четверти «качелями» (кепка, ушанка).

Ролик Flow такой вещи идёт от позы в три четверти (кадр 0) до почти-спины (кадр T) и тем же путём назад.
Ни строгого вида спереди, ни строгого сзади в нём нет, поэтому одного зеркала мало (см. mirror_turn.py):
между кадром и его зеркалом остаётся дыра в 60–90°. Её закрывают два коротких ролика Flow («Кадры»):
    back  — от кадра T к его зеркалу (поворот через спину),
    front — от зеркала кадра 0 к самому кадру 0 (поворот через лицо).
Оборот: кадры 0..T → ролик back → зеркала T..0 → ролик front → снова кадр 0.

    python -I tools/compose_spin.py keys  <id> <T>                        — ключевые кадры для Flow
    python -I tools/compose_spin.py build <id> <T> <back.mp4> <front.mp4> — кадры полного оборота
    python -I tools/ps_mask.py <id> spin                                  — маски Photoshop новых кадров (todo.txt)
    python -I tools/compose_spin.py masks <id>                            — маски отражённых кадров из них
    python -I tools/make_turntable.py ../Video/spin/<id> <id>             — вырезка, наборы hi/lo

Зеркала делаются с переносом света (relit_mirror из mirror_turn.py), чтобы свет не прыгал на другой бок.
Всё лежит в ../Video/spin/<id>/: key_*.png — для Flow, frames/NNN.png и masks/NNN.png — полный оборот в рабочем
размере, clipmasks/ — маски Photoshop кадров роликов (маска отражённого кадра — отражение маски исходного).
"""
import os, sys, json
import numpy as np, cv2
from PIL import Image
sys.dont_write_bytecode = True     # без __pycache__ в папке сайта
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mirror_turn import relit_mirror, mirror, SIGMA, to_lab, from_lab

WORK = 1440
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIDEO = os.path.join(os.path.dirname(root), "Video")

def read_frames(video, ks, patch=None):
    """Кадры ролика с номерами ks в рабочем размере (RGB). patch — замены испорченных кадров."""
    patch = patch or {}
    want = {k: patch.get(k, k) for k in ks}
    cap = cv2.VideoCapture(video); got = {}; k = -1
    while True:
        ok, f = cap.read()
        if not ok: break
        k += 1
        if k in want.values():
            h, w = f.shape[:2]
            if h != WORK: f = cv2.resize(f, (round(w * WORK / h), WORK), interpolation=cv2.INTER_AREA)
            got[k] = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
    cap.release()
    return {k: got[src] for k, src in want.items()}

def mask(pid, k, shape):
    m = np.array(Image.open(os.path.join(VIDEO, "ps_work", pid, f"{k:03d}.png")).convert("L"))
    if m.shape != shape: m = cv2.resize(m, (shape[1], shape[0]), interpolation=cv2.INTER_LINEAR)
    return m

def setup(pid, T):
    out = os.path.join(VIDEO, "spin", pid); os.makedirs(out, exist_ok=True)
    pp = os.path.join(VIDEO, "ps_work", pid, "patch.json")
    patch = {int(a): int(b) for a, b in json.load(open(pp)).items()} if os.path.exists(pp) else {}
    return out, patch

def axis(pid, T, shape):
    """Ось вращения: среднее положение центра вещи по кадрам 0..T (лицевого симметричного кадра у этих вещей нет)."""
    cs, ws = [], []
    for k in range(0, T + 1):
        xs = np.where((mask(pid, k, shape) > 127).any(0))[0]
        cs.append((xs[0] + xs[-1]) / 2); ws.append(xs[-1] - xs[0])
    return float(np.mean(cs)), float(np.mean(ws))

def mirror_full(rgb, m, ax, sig, bg):
    """Зеркало полного кадра с переносом света; фон, вдвинутый сдвигом, — цветом фона."""
    a = np.dstack([rgb.astype(np.float32), m.astype(np.float32)])
    out = relit_mirror(a, ax, sig)
    w = rgb.shape[1]; s = int(round(2 * ax - (w - 1)))
    if s > 0: out[:, :s, :3] = bg
    elif s < 0: out[:, w + s:, :3] = bg
    return np.clip(out[..., :3], 0, 255).astype(np.uint8), out[..., 3].astype(np.uint8)

def keys(pid, T):
    out, patch = setup(pid, T)
    fr = read_frames(os.path.join(VIDEO, f"turn_{pid}4k.mp4"), [0, T], patch)
    shape = fr[0].shape[:2]
    ax, wd = axis(pid, T, shape)
    sig = SIGMA * wd          # радиус поля света — в долях ширины вещи, как в mirror_turn.py
    bg = np.median(np.concatenate([fr[0][:40].reshape(-1, 3), fr[0][-40:].reshape(-1, 3)]), axis=0)
    res = {}
    for name, k in (("front", 0), ("back", T)):
        m = mask(pid, patch.get(k, k), shape)
        mir, _ = mirror_full(fr[k], m, ax, sig, bg)
        res[name] = (fr[k], mir)
    small = lambda im: Image.fromarray(im).resize((1920, 1080), Image.LANCZOS)
    small(res["back"][0]).save(os.path.join(out, "key_back_first.png"))     # кадр T
    small(res["back"][1]).save(os.path.join(out, "key_back_last.png"))      # его зеркало
    small(res["front"][1]).save(os.path.join(out, "key_front_first.png"))   # зеркало кадра 0
    small(res["front"][0]).save(os.path.join(out, "key_front_last.png"))    # кадр 0
    json.dump({"T": T, "ax": ax, "width": wd, "bg": bg.tolist()}, open(os.path.join(out, "spin.json"), "w"))
    print(f"{pid}: ось x={ax:.1f} из {shape[1]}, ключевые кадры в {out}")

def read_all(video):
    cap = cv2.VideoCapture(video); out = []
    while True:
        ok, f = cap.read()
        if not ok: break
        h, w = f.shape[:2]
        if h != WORK: f = cv2.resize(f, (round(w * WORK / h), WORK), interpolation=cv2.INTER_AREA if h > WORK else cv2.INTER_CUBIC)
        out.append(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
    cap.release()
    return out

def small(im):                   # для сравнения кадров: серый, 320 по ширине, размыт — шум сжатия ролика не в счёт
    g = cv2.resize(cv2.cvtColor(im, cv2.COLOR_RGB2GRAY), (320, 180), interpolation=cv2.INTER_AREA).astype(np.float32)
    return cv2.GaussianBlur(g, (0, 0), 2.0)

def item_mask(rgb, bg):
    """Грубая маска вещи по отличию от фона — для поля света и поиска позы (вырезку делает Photoshop)."""
    m = (np.abs(rgb.astype(np.float32) - bg).max(axis=2) > 35).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n > 1: m = (lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    return m * 255

def flat(f, m, bg):              # вещь по маске на ровном фоне: позы сравниваются без фона съёмки
    a = m.astype(np.float32)[..., None] / 255
    return np.clip(f.astype(np.float32) * a + bg * (1 - a), 0, 255).astype(np.uint8)

def half(clip, key, step, bg):
    """Половина ролика у его точного конца. Flow держит последний кадр ролика точно, а первый — как придётся
    (у кепки ролик начинался с другой позы), поэтому берётся участок от симметричной позы (строго сзади или
    спереди) до конца; другую половину даёт его зеркало. Симметрия меряется зеркалом вокруг центра самой вещи:
    ось вращения в ролике Flow не совпадает с осью исходного ролика. Кадры прореживаются до шага поворота
    как у соседних кадров оборота. Возвращает (кадр симметричной позы, центр вещи в нём, взятые кадры)."""
    L = len(clip); best = None
    for i in range(L // 8, L - L // 8):
        f = clip[i]; mk = item_mask(f, bg); xs = np.where((mk > 0).any(0))[0]; c = (xs[0] + xs[-1]) / 2
        mm = mirror(np.dstack([f.astype(np.float32), mk.astype(np.float32)]), c)
        d = float(np.abs(small(flat(f, mk, bg)) - small(flat(mm[..., :3], mm[..., 3], bg))).mean())
        if best is None or d < best[0]: best = (d, i, c)
    asym, m, cm = best
    sm = [small(f) for f in clip]
    keep, last = [m], sm[m]
    for i in range(m + 1, L - 1):
        if np.abs(sm[i] - last).mean() >= step and np.abs(sm[-1] - sm[i]).mean() >= step * 0.5:
            keep.append(i); last = sm[i]
    end_d = float(np.abs(sm[-1] - small(key)).mean())
    print(f"  ролик {L} кадров: симметричная поза — кадр {m} (асимметрия {asym:.2f}, центр {cm:.1f}), взято {len(keep)}, "
          f"конец к ключевому кадру {end_d:.2f}")
    return m, cm, keep

def mpath(out, n): return os.path.join(out, "masks", f"{int(n):03d}.png")
def cpath(out, src): return os.path.join(out, "clipmasks", f"{src[0]}_{src[1]}_{src[2]:03d}.png")

def harvest(out, frames):
    """Маски кадров роликов из masks/ → clipmasks/ (маска отражённого кадра отражается обратно)."""
    os.makedirs(os.path.join(out, "clipmasks"), exist_ok=True)
    got = 0
    for plain in (True, False):                   # маска Photoshop исходного кадра надёжнее отражённой
        for n, src in frames.items():
            a = src[3]
            if (a is None) != plain: continue
            mp, cp = mpath(out, n), cpath(out, src)
            if os.path.exists(cp) or not os.path.exists(mp): continue
            mk = cv2.imread(mp, cv2.IMREAD_GRAYSCALE)
            cv2.imwrite(cp, mk if a is None else mirror(mk, a)); got += 1
    return got

def spread(out, frames):
    """Маски кадров роликов из clipmasks/ → masks/: у отражённых — отражением вокруг той же оси."""
    done = 0
    for n, src in frames.items():
        cp = cpath(out, src)
        if not os.path.exists(cp): continue
        mk = cv2.imread(cp, cv2.IMREAD_GRAYSCALE)
        cv2.imwrite(mpath(out, n), mk if src[3] is None else mirror(mk, src[3])); done += 1
    return done

def legacy_frames(meta):
    """Раскладка кадров первой сборки 17.11.2026 (по подписи sig и осям axes) — чтобы забрать её маски."""
    T, sb, sf, szb, szf = meta["sig"]; ax = meta["ax"]; axes = meta.get("axes", {})
    fr, n = {}, T + 1
    def put(name, size, sel):
        nonlocal n
        for i in reversed(sel): fr[str(n)] = [name, size, i, axes.get(str(n), ax)]; n += 1
        for i in sel[1:]: fr[str(n)] = [name, size, i, None]; n += 1
    put("back", szb, sb); n += T + 1; put("front", szf, sf)
    return fr

def build(pid, T, back, front):
    out, patch = setup(pid, T)
    meta = json.load(open(os.path.join(out, "spin.json")))
    ax, sig = meta["ax"], SIGMA * meta["width"]; bg = np.array(meta["bg"], np.float32)
    prev = meta.get("frames") or (legacy_frames(meta) if "sig" in meta else {})
    if prev: print(f"  маски кадров роликов из прошлой сборки: {harvest(out, prev)}")
    orig = read_frames(os.path.join(VIDEO, f"turn_{pid}4k.mp4"), range(T + 1), patch)
    shape = orig[0].shape[:2]
    om = {k: mask(pid, patch.get(k, k), shape) for k in range(T + 1)}
    mir = {k: mirror_full(orig[k], om[k], ax, sig, bg) for k in range(T + 1)}
    # шаг между соседними кадрами оборота — по середине первой половины (у разворота ролик замедляется)
    sm = [small(orig[k]) for k in range(T + 1)]
    step = float(np.median([np.abs(sm[k + 1] - sm[k]).mean() for k in range(8, T - 8)]))

    def yel(rgb):                # доля жёлтой ткани в пикселе — как в шейдере
        f = rgb.astype(np.float32)
        return np.clip(((f[..., 0] + f[..., 1]) / 2 - f[..., 2] - 12) / 28, 0, 1)

    def gap(video, key, name):
        """Дуга между ключевыми кадрами: зеркала половины ролика в обратном порядке, затем сама половина
        (в симметричной позе рядом стоят кадр и его зеркало). Цвет: Flow чуть разбеливает жёлтый (канал B
        выше на ~13) — сдвиг в OKLab меряется на последнем кадре ролика (по позе он совпадает с ключевым)
        и прикладывается к жёлтой ткани всех взятых кадров. Ось зеркала: в симметричной позе — центр вещи,
        к концу ролика плавно приходит к оси исходного ролика (там зеркало кадра = зеркальный ключевой кадр)."""
        clip = read_all(video); size = os.path.getsize(video); L = len(clip)
        m, cm, sel = half(clip, key, step, bg)
        mk = (item_mask(key, bg) > 0) & (yel(key) > 0.99)
        me = (item_mask(clip[-1], bg) > 0) & (yel(clip[-1]) > 0.99)
        dlab = to_lab(key[mk].astype(np.float64)).mean(0) - to_lab(clip[-1][me].astype(np.float64)).mean(0)
        print(f"  цвет ролика к ключевому кадру: ΔL {dlab[0]:+.4f}, Δa {dlab[1]:+.4f}, Δb {dlab[2]:+.4f}; ось зеркала {cm:.1f} → {ax:.1f}")
        fr = {}
        for i in sel:
            f = clip[i].copy(); w = yel(f); on = w > 0
            lab = to_lab(f[on].astype(np.float64)) + dlab * w[on][:, None]
            f[on] = np.clip(np.round(from_lab(lab)), 0, 255).astype(np.uint8)
            fr[i] = f
        axes = {i: cm + (ax - cm) * (i - m) / max(1, L - 1 - m) for i in sel}
        res = [(mirror_full(fr[i], item_mask(fr[i], bg), axes[i], sig, bg)[0], [name, size, i, axes[i]]) for i in reversed(sel)]
        return res + [(fr[i], [name, size, i, None]) for i in sel]

    seq = [(orig[k], om[k], None) for k in range(T + 1)]                   # ролик: 0 → T
    seq += [(f, None, s) for f, s in gap(back, mir[T][0], "back")]         # через спину: T → зеркало T
    seq += [(*mir[k], None) for k in range(T, -1, -1)]                      # зеркала: T → 0
    seq += [(f, None, s) for f, s in gap(front, orig[0], "front")]         # через лицо: зеркало 0 → 0
    fdir, mdir = os.path.join(out, "frames"), os.path.join(out, "masks")
    for d in (fdir, mdir):
        os.makedirs(d, exist_ok=True)
        for f in os.listdir(d): os.remove(os.path.join(d, f))
    frames, todo = {}, []
    for n, (rgb, m, src) in enumerate(seq):
        cv2.imwrite(os.path.join(fdir, f"{n:03d}.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 3])
        if m is not None: cv2.imwrite(mpath(out, n), m)
        if src is not None:
            frames[str(n)] = src
            if src[3] is None and not os.path.exists(cpath(out, src)): todo.append(f"{n:03d}.png")
    spread(out, frames)
    meta["frames"] = frames; meta.pop("sig", None); meta.pop("axes", None)
    json.dump(meta, open(os.path.join(out, "spin.json"), "w"))
    tp = os.path.join(out, "todo.txt")
    if todo: open(tp, "w").write("\n".join(todo))
    elif os.path.exists(tp): os.remove(tp)
    nb = sum(1 for s in frames.values() if s[0] == "back")
    print(f"{pid}: оборот {len(seq)} кадров — ролик 0..{T}, через спину {nb}, зеркало {T + 1}, через лицо {len(frames) - nb}; "
          f"шаг {step:.2f}; " + (f"Photoshop нужен {len(todo)} кадрам (todo.txt), затем compose_spin.py masks {pid}" if todo else "все маски есть"))

def masks(pid):
    out = os.path.join(VIDEO, "spin", pid)
    meta = json.load(open(os.path.join(out, "spin.json")))
    h = harvest(out, meta["frames"]); d = spread(out, meta["frames"])
    left = [n for n in range(len(os.listdir(os.path.join(out, "frames")))) if not os.path.exists(mpath(out, n))]
    tp = os.path.join(out, "todo.txt")
    if not left and os.path.exists(tp): os.remove(tp)
    print(f"{pid}: новых масок кадров роликов {h}, разложено {d}; без маски {len(left)}")

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    cmd, pid = sys.argv[1], sys.argv[2]
    T = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    if cmd == "keys": keys(pid, T)
    elif cmd == "masks": masks(pid)
    else: build(pid, T, sys.argv[4], sys.argv[5])
