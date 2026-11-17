"""Достраивает полный оборот из ролика-«качелей» зеркалом первой половины.

    python -I tools/mirror_turn.py <id> <T>

Часть роликов Flow (худи, футболка, бомбер) не делает полный оборот: вещь доворачивается до спины
(кадр T) и тем же путём возвращается лицом. В слайдере это выглядело как качание, а не 360°.
Вещи симметричны слева направо, поэтому вид с угла −θ — это зеркало вида с угла θ: после спины берём
кадры первой половины в обратном порядке и отражаем их вокруг оси вращения — вещь продолжает
поворачиваться в ту же сторону и возвращается лицом с другого бока.

Свет при отражении тоже переворачивается (у футболки ключевой свет сбоку — на стыке была бы вспышка),
поэтому у каждого отражённого кадра свет возвращается на место: плавное поле яркости ткани (отдельно
жёлтой и чёрной — у них разный цвет, их нельзя усреднять вместе) берётся из исходного кадра в экранных
координатах, и отражённый кадр умножается на отношение «поле исходника / поле отражения».

Читаются только кадры 0..T−1 набора lo, пишутся T+1..2T−1, лишние удаляются — повторный запуск даёт
тот же результат. Набор hi (кадры у камеры) не трогается. Печатает новое n для data.js.
"""
import os, sys
import numpy as np, cv2
from PIL import Image

SIGMA = 0.08                     # радиус поля освещённости в долях ширины вещи (подобран по стыкам 17.11.2026)

def mirror(a, ax):
    """Отражение вокруг вертикали x = ax (ось вращения), сдвиг целым пикселем, пустое — прозрачное."""
    w = a.shape[1]; s = int(round(2 * ax - (w - 1)))
    m = a[:, ::-1]; out = np.zeros_like(a)
    if s >= 0: out[:, s:] = m[:, :w - s]
    else: out[:, :w + s] = m[:, -s:]
    return out

def parts(a):
    """Яркость и доли жёлтой и чёрной ткани (только плотные пиксели)."""
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    yel = np.clip(((r + g) / 2 - b - 12) / 28, 0, 1)
    solid = (al > 200).astype(np.float32)
    return Y, yel * solid, (1 - yel) * solid

M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]])
def to_lab(rgb):                 # sRGB 0..255 → OKLab
    c = rgb / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return np.cbrt(c @ M1.T) @ M2.T
def from_lab(lab):               # OKLab → sRGB 0..255
    c = ((lab @ np.linalg.inv(M2).T) ** 3) @ np.linalg.inv(M1).T
    c = np.clip(c, 0, 1)
    return 255 * np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

def relit_mirror(a, ax, sig):
    Y, yl, dk = parts(a)
    L = np.log(np.maximum(Y, 3))
    m = mirror(a, ax)
    _, ylm, dkm = parts(m)
    corr = np.zeros(Y.shape, np.float32); wsum = np.zeros(Y.shape, np.float32)
    for w, wm in ((yl, ylm), (dk, dkm)):
        den = cv2.GaussianBlur(w, (0, 0), sig)
        F = cv2.GaussianBlur(L * w, (0, 0), sig) / np.maximum(den, 1e-4)
        ok = (den > 0.05).astype(np.float32)
        Fm = mirror(np.dstack([F, ok]), ax)
        c = np.where((ok > 0) & (Fm[..., 1] > 0.5), F - Fm[..., 0], 0)     # поле там, где ткань есть в обоих
        corr += c * wm; wsum += wm
    corr = np.where(wsum > 1e-3, corr / np.maximum(wsum, 1e-3), 0)
    # Поправка — в светлоте OKLab (яркость ~ L³). Простое умножение RGB осветляло бы тень жёлтой ткани,
    # не меняя её оттенка: у жёлтой в тени он оранжевее, и осветлённый бок выходил рыжим пятном.
    # Поэтому оттенок жёлтой ткани берётся по её же кривой «светлота → (a, b)» из исходного кадра.
    lab_src = to_lab(a[..., :3]); lab = to_lab(m[..., :3])
    Ln = np.clip(lab[..., 0] * np.exp(corr / 3), 0, 1)
    sel = (yl > 0.9) & (a[..., 3] > 250)
    if sel.sum() > 500:
        bins = np.linspace(0.2, 1.0, 41); idx = np.digitize(lab_src[..., 0][sel], bins)
        cen, ca, cb = [], [], []
        for i in range(1, len(bins)):
            v = idx == i
            if v.sum() >= 30:
                cen.append((bins[i - 1] + bins[i]) / 2)
                ca.append(np.median(lab_src[..., 1][sel][v])); cb.append(np.median(lab_src[..., 2][sel][v]))
        if len(cen) >= 2:
            da = np.interp(Ln, cen, ca) - np.interp(lab[..., 0], cen, ca)
            db = np.interp(Ln, cen, cb) - np.interp(lab[..., 0], cen, cb)
            lab[..., 1] += da * ylm; lab[..., 2] += db * ylm
    lab[..., 0] = Ln
    m[..., :3] = np.where(wsum[..., None] > 1e-3, from_lab(lab), m[..., :3])
    return m

def main():
    pid, T = sys.argv[1], int(sys.argv[2])
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lo = os.path.join(root, "img", "turn", pid, "lo")
    path = lambda k: os.path.join(lo, f"{k:03d}.webp")
    load = lambda k: np.asarray(Image.open(path(k)).convert("RGBA")).astype(np.float32)
    a0 = load(0)
    xs = np.where((a0[..., 3] > 128).any(0))[0]
    ax = (xs[0] + xs[-1]) / 2        # лицевой кадр симметричен — центр его рамки лежит на оси вращения
    sig = SIGMA * (xs[-1] - xs[0])
    for k in range(T + 1, 2 * T):
        out = relit_mirror(load(2 * T - k), ax, sig)
        Image.fromarray(np.round(out).astype(np.uint8), "RGBA").save(path(k), quality=82, method=5)
    for f in os.listdir(lo):
        if f.endswith(".webp") and int(f[:3]) >= 2 * T: os.remove(os.path.join(lo, f))
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"{pid}: оборот из {2 * T} кадров (0..{T} — ролик, {T + 1}..{2 * T - 1} — зеркало), ось x={ax:.1f}; n: {2 * T}")

if __name__ == "__main__":
    main()
