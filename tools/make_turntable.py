"""Раскладывает ролик-«вертушку» (объект на белом фоне, полный оборот) на кадры с прозрачным фоном.

    python -I tools/make_turntable.py <video.mp4> <id> [кадры через запятую: 36,62]

Ролик может быть любого разрешения (720p, 1080p, 4K): кадр приводится к рабочей высоте WORK,
вырезается, и пишутся два набора кадров:
    img/turn/<id>/hi/NNN.webp — полный размер, только позы у камеры: лицо, спина, оба бока (см. is_hi)
    img/turn/<id>/lo/NNN.webp — половина, весь оборот (очередь и вращение)
Печатает строку turn: {...} для data.js (размеры — в пикселях набора hi).
"""
import sys, os, json
import numpy as np, cv2
from PIL import Image

video, pid = sys.argv[1], sys.argv[2]
WORK = 1440                      # рабочая высота кадра: вещь получается ~1100–1300 px в высоту
HI_KEEP = 14                     # сколько первых кадров сохранять в полном размере (hero.js: HI_FRAMES)

EXTRA = [int(v) for v in sys.argv[3].split(",") if v] if len(sys.argv) > 3 else []   # кадры спины, рукава и т. п.

def is_hi(k, n):
    """Кадры полного размера — позы, в которых вещь останавливается у камеры: лицо (первые кадры)
    и кадры мест нанесения из data.js (спина, рукав) с соседями. То же правило — в hero.js, hiFrames()."""
    return k < HI_KEEP or any(abs(k - e) <= 1 for e in EXTRA)

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(root, "img", "turn", pid)
for tier in ("hi", "lo"):
    d = os.path.join(out, tier)
    os.makedirs(d, exist_ok=True)
    for old in os.listdir(d): os.remove(os.path.join(d, old))
for old in os.listdir(out):      # кадры прежнего формата лежали прямо в папке
    p = os.path.join(out, old)
    if os.path.isfile(p): os.remove(p)

def frames():
    cap = cv2.VideoCapture(video)
    while True:
        ok, f = cap.read()
        if not ok: break
        h, w = f.shape[:2]
        if h > WORK: f = cv2.resize(f, (round(w * WORK / h), WORK), interpolation=cv2.INTER_AREA)
        yield cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
    cap.release()

def odd(v): v = max(3, int(round(v))); return v if v % 2 else v + 1

def cut(im):
    """RGBA: фон убран, цвет на полупрозрачных краях очищен от фона."""
    im = im.astype(np.float32)
    h, w, _ = im.shape
    s = h / 720.0                # пороги подобраны на 720p — масштабируем под рабочую высоту
    band = max(24, h // 14)
    m = np.zeros((h, w), bool); m[:band] = m[-band:] = True; m[:, :band] = m[:, -band:] = True
    white = np.median(im[m], axis=0).min() >= 250
    if white:
        bg = np.full((h, w, 3), 255.0, np.float32)
    else:                        # фон не чисто белый — подгоняем плавную поверхность по рамке кадра
        yy, xx = np.mgrid[0:h, 0:w]
        X = np.stack([np.ones_like(xx), xx / w, yy / h, (xx / w) ** 2, (yy / h) ** 2, xx * yy / (w * h)], -1).astype(np.float32)
        bg = np.zeros((h, w, 3), np.float32)
        for c in range(3):
            sel = m.copy()
            for _ in range(3):
                coef, *_ = np.linalg.lstsq(X[sel], im[..., c][sel], rcond=None)
                fit = X @ coef
                sel = m & (np.abs(im[..., c] - fit) < 10)
                if sel.sum() < 500: sel = m; break
            bg[..., c] = fit
        bg = np.clip(bg, 1, 255)
    floor = 0.03 if white else 0.12
    lo = (bg - im) / np.maximum(bg, 1); hi = (im - bg) / np.maximum(255 - bg, 24)
    a = np.clip(np.maximum(lo, hi).max(axis=2), 0, 1)
    low = (a < 0.38).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(low, connectivity=4)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    # фон — всё светлое, что касается рамки кадра, и замкнутые просветы (между рукавом и корпусом, в ручках сумки);
    # порог площади маленький, иначе узкие просветы остаются белыми полосками
    keep = np.array([i > 0 and (i in edge or st[i, cv2.CC_STAT_AREA] > 90 * s * s) for i in range(n)])
    k5 = odd(5 * s)
    region = cv2.dilate(keep[lab].astype(np.uint8), np.ones((k5, k5), np.uint8)) > 0
    alpha = np.where(region, np.clip((a - floor) / (1 - floor), 0, 1), 1.0)
    solid = (alpha > 0.25).astype(np.uint8)
    n3, lab3, st3, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    areas = st3[:, cv2.CC_STAT_AREA].copy(); areas[0] = 0
    k41 = odd(41 * s)
    ok = cv2.dilate((areas >= 0.08 * areas.max())[lab3].astype(np.uint8), np.ones((k41, k41), np.uint8)) > 0
    alpha = np.where(ok, alpha, 0.0)
    aa = np.maximum(alpha, 1e-3)[..., None]
    col = np.clip(np.where(region[..., None], (im - bg * (1 - aa)) / aa, im), 0, 255)
    return np.dstack([col, alpha * 255]).astype(np.uint8)

MASKS = os.path.join(os.path.dirname(root), "Video", "ps_work", pid)   # маски Photoshop: tools/ps_mask.py

def cut_ps(im, mask):
    """RGBA по маске Photoshop («Выделить предмет»): ровный край без следов сжатия ролика и без тени.
    Край поджимается на пиксель и сглаживается; цвет в приграничной полосе берётся изнутри вещи,
    чтобы белый фон съёмки не давал светлой каймы."""
    im = im.astype(np.float32)
    solid = (mask > 127).astype(np.uint8)
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    alpha = cv2.GaussianBlur(cv2.erode(solid, k3).astype(np.float32), (0, 0), 0.85)
    core = cv2.erode(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))).astype(np.float32)
    den = cv2.GaussianBlur(core, (0, 0), 3.0)
    fill = cv2.GaussianBlur(im * core[..., None], (0, 0), 3.0) / np.maximum(den, 1e-3)[..., None]
    col = np.where(core[..., None] > 0, im, np.where(den[..., None] > 0.01, fill, 0))
    return np.dstack([np.clip(col, 0, 255), alpha * 255]).astype(np.uint8)

def half(c):
    """Уменьшение вдвое с предумноженной прозрачностью — цвет прозрачных пикселей не затекает в край."""
    p = c.astype(np.float32); a = p[..., 3:] / 255
    p[..., :3] *= a
    q = cv2.resize(p, (max(1, c.shape[1] // 2), max(1, c.shape[0] // 2)), interpolation=cv2.INTER_AREA)
    qa = np.maximum(q[..., 3:] / 255, 1e-4)
    q[..., :3] = np.where(q[..., 3:] > 0.5, q[..., :3] / qa, 0)
    return Image.fromarray(np.clip(q, 0, 255).astype(np.uint8), "RGBA")

# Проход 1: общая рамка по всем кадрам и поиск скачков — на уменьшенных кадрах, это быстро.
Q = 4
boxes, small, total = [], [], 0
for f in frames():
    total += 1
    q = cv2.resize(f, (f.shape[1] // Q, f.shape[0] // Q), interpolation=cv2.INTER_AREA)
    c = cut(q)
    ys, xs = np.where(c[..., 3] > 12)
    boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    p = c.astype(np.float32); p[..., :3] *= p[..., 3:] / 255
    small.append(cv2.resize(p, (160, 120), interpolation=cv2.INTER_AREA))
    H, W = f.shape[:2]
want = total - 1                 # последний кадр равен первому — в петлю его не берём
b = np.array(boxes[:want])
pad = 2 * Q
x0, y0 = max(0, b[:, 0].min() * Q - pad), max(0, b[:, 1].min() * Q - pad)
x1, y1 = min(W, b[:, 2].max() * Q + pad), min(H, b[:, 3].max() * Q + pad)

step = np.array([np.abs(small[k] - small[(k + 1) % want]).mean() for k in range(want)])
med = np.median(step)
# Скачок — одиночный всплеск. Только отмечаем: смешивать позы нельзя (двойной контур), лечится перегенерацией.
jumps = [int(k) for k in range(want) if step[k] > 3.2 * med and step[k] > 2.2 * max(step[(k - 2) % want], step[(k + 2) % want])]

# Проход 2: вырезаем в рабочем размере и сразу пишем оба набора.
meta = None; used_ps = 0
for k, f in enumerate(frames()):
    if k >= want: break
    mp = os.path.join(MASKS, f"{k:03d}.png")
    if os.path.exists(mp):
        mask = np.array(Image.open(mp).convert("L"))
        if mask.shape != f.shape[:2]: mask = cv2.resize(mask, (f.shape[1], f.shape[0]), interpolation=cv2.INTER_LINEAR)
        c = cut_ps(f, mask)[y0:y1, x0:x1]; used_ps += 1
    else:
        c = cut(f)[y0:y1, x0:x1]
    hi = Image.fromarray(c, "RGBA")
    # Полный размер нужен только там, где вещь останавливается (первые градусы оборота):
    # в движении показываются кадры lo, иначе один оборот весил бы ~10 МБ и ~700 МБ в памяти.
    if is_hi(k, want): hi.save(os.path.join(out, "hi", f"{k:03d}.webp"), quality=88, method=5)
    half(c).save(os.path.join(out, "lo", f"{k:03d}.webp"), quality=82, method=5)
    if k == 0:                   # рамка самой вещи (без тени) в нулевом кадре
        ys, xs = np.where(c[..., 3] > 200)
        meta = {"dir": f"img/turn/{pid}", "n": want, "fw": int(x1 - x0), "fh": int(y1 - y0),
                "ox": int(xs.min()), "oy": int(ys.min()), "ow": int(xs.max() + 1 - xs.min()), "oh": int(ys.max() + 1 - ys.min())}

size = lambda t: sum(os.path.getsize(os.path.join(out, t, f)) for f in os.listdir(os.path.join(out, t))) // 1024
sys.stdout.reconfigure(encoding="utf-8")
print("turn:", json.dumps(meta), f"  // hi {size('hi')} КБ, lo {size('lo')} КБ, исходный кадр {W}x{H}, кадров {total}, масок Photoshop {used_ps}, скачки: {jumps}")
