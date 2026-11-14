# Лекала для «Конструктора»: из развёртки 3D-модели строятся чистые детали кроя, годные под раскрой.
#
# Развёртка модели — не лекало: её снимали с готовой 3D-формы, поэтому боковые срезы волнистые, левая и правая
# половины детали разные, а сшиваемые срезы разной длины. Здесь с развёртки берутся только опорные точки и общий
# характер линий, а сама деталь строится заново:
#   • перед и спинка симметричны относительно середины, оба рукава одинаковые и тоже симметричные;
#   • плечо и нижний шов рукава — прямые, боковой срез и низ — прямые либо плавные кривые (если так задумано в модели);
#   • пройма, горловина и окат — гладкие кривые Безье без волн;
#   • сшиваемые срезы равны по длине: плечо переда и спинки, боковые срезы, окат рукава и пройма.
# Размеры (S…XXXL) получаются градацией: опорные точки сдвигаются на приращения из GRADE, кривые между ними
# пересчитываются, окат каждый раз подгоняется под длину проймы.
# Все координаты детали — в сантиметрах, ось X от середины детали вправо, ось Y вверх.
import math
import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely.ops import unary_union

SIZES = ["S", "M", "L", "XL", "XXL", "XXXL"]
BASE = "S"                       # размер, которому соответствует сама 3D-модель (если в SHAPE не задан свой base)
# Приращения на один размер, см. Это типовая градация трикотажной футболки, а не табель мер Izum — сверить с технологом.
#   chest, hem — ширина детали по груди и по низу; length — длина от высшей точки плеча; shoulder — ширина по плечам;
#   neck_w — ширина горловины; neck_f / neck_b — глубина горловины переда / спинки; armhole — глубина проймы;
#   sleeve_w — ширина рукава под проймой; under — длина нижнего шва рукава. Высота оката не задаётся: она на каждом
#   размере получается из условия «окат = пройма».
# Ширина рукава растёт в той же доле от груди, что в выкройке-эталоне (shkatulka-sew MT211119: +1,2 см рукава на +2,05 см
# полуобхвата груди); при прежних приращениях рукав на больших размерах выходил на 4–5 см уже эталона.
GRADE = {
    "male": dict(chest=3.0, hem=3.0, length=2.0, shoulder=2.0, neck_w=0.5, neck_f=0.3, neck_b=0.1, armhole=1.0, sleeve_w=1.75, under=0.6),
    "female": dict(chest=2.5, hem=2.5, length=1.5, shoulder=1.5, neck_w=0.4, neck_f=0.3, neck_b=0.1, armhole=0.8, sleeve_w=1.5, under=0.3),
}
# Длина полосы отделки в долях длины среза, к которому она пришивается. В моделях полосы равны своим срезам (1,0).
# Бейку из рибаны на производстве обычно делают короче горловины (около 0,85) — это решает технолог, здесь не заложено.
RIB = dict(neck=1.0, cuff=1.0, hem=1.0, trim=1.0)
# Отступления от исходной модели. 14.11.2026 пользователь отверг лекала, «улучшенные» по сторонним образцам («Получилось
# не то. Собери эти майки из исходных FBX именно этих маек»), поэтому по умолчанию их нет: силуэт, размеры и форма срезов
# берутся из развёртки FBX, а правятся только симметрия половин, волны и зубцы на срезах и длины сшиваемых срезов.
# Что можно включить для модели (ключи словаря):
#   straight=True                         — прямой силуэт: бок отвесный, низ той же ширины, что и грудь;
#   fit=dict(chest=42.0, length=63.5)     — подгонка базового размера под заданные ширину по груди и длину, см;
#   square=True                           — срезы на стыках под прямым углом (пройма к боку и плечу, горловина к плечу, низ к боку).
SHAPE = {"male": {}, "female": {}}
# Припуски на швы, см: линия реза = линия шва + припуск. Тоже типовые значения — сверить с технологом.
ALLOW = dict(seam=1.0, hem=2.5, sleeve_hem=2.0, neck=0.7, strip=0.7)
GAP, MARGIN = 5.0, 3.5           # зазор между деталями на листе и поле листа, см
STRAIGHT = 0.035                 # срез считается прямым, если прогиб меньше этой доли его длины


# ---------- ломаные ----------
def seglen(P): return np.linalg.norm(np.diff(P, axis=0), axis=1)
def arclen(P): return float(seglen(np.asarray(P, float)).sum())
def resample(P, n=None, step=None):
    P = np.asarray(P, float); s = np.concatenate([[0], np.cumsum(seglen(P))])
    if n is None: n = max(2, int(round(s[-1] / step)) + 1)
    t = np.linspace(0, s[-1], n)
    return np.column_stack([np.interp(t, s, P[:, 0]), np.interp(t, s, P[:, 1])])
def cyc(P, i, j):
    """Точки замкнутого контура от i до j включительно, по ходу обхода."""
    n = len(P); i %= n; j %= n
    return P[i:j + 1] if j >= i else np.vstack([P[i:], P[:j + 1]])
def flipx(P): return np.asarray(P, float) * np.array([-1.0, 1.0])
def chord_dev(P):
    """Наибольшее отклонение ломаной от хорды и длина хорды."""
    a, b = P[0], P[-1]; d = b - a; L = float(np.linalg.norm(d))
    if L < 1e-9: return 0.0, 0.0
    return float(np.abs((P[:, 0] - a[0]) * d[1] - (P[:, 1] - a[1]) * d[0]).max() / L), L
def line(a, b, n=60): return np.linspace(np.asarray(a, float), np.asarray(b, float), n)


def corners(P, k, sup, top):
    """Выпуклые углы замкнутого контура (обход против часовой, равномерный шаг), от самых острых."""
    n = len(P)
    a = P - np.roll(P, k, 0); b = np.roll(P, -k, 0) - P
    ang = np.degrees(np.arctan2(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0], (a * b).sum(1)))
    idx = []; A = ang.copy()
    for _ in range(top):
        i = int(np.argmax(A))
        if A[i] < 30: break
        idx.append(i)
        for j in range(-sup, sup + 1): A[(i + j) % n] = -999
    return idx, ang


# ---------- кривые Безье ----------
def bern(n, t):
    t = np.asarray(t, float)[:, None]; i = np.arange(n + 1)[None, :]
    C = np.array([math.comb(n, j) for j in range(n + 1)], float)[None, :]
    return C * t ** i * (1 - t) ** (n - i)
def bez(C, n=160): return bern(len(C) - 1, np.linspace(0, 1, n)) @ C
def fit_bezier(P, deg, dir0=None, dir1=None, iters=14):
    """Кривая Безье степени deg по точкам P с закреплёнными концами. dir0 / dir1 — направление среза в начале и в конце
    (единичный вектор по ходу кривой): соседняя с концом опорная точка тогда лежит на этом луче. Так задаётся прямой угол
    между срезами на стыке и горизонтальная касательная на оси детали."""
    P = np.asarray(P, float); s = np.concatenate([[0], np.cumsum(seglen(P))]); t = s / s[-1]; amin = 0.04 * s[-1]
    C = np.zeros((deg + 1, 2)); C[0] = P[0]; C[-1] = P[-1]
    tt = np.linspace(0, 1, 801)
    ray = {}                                                    # опорная точка -> (начало луча, направление)
    if dir0 is not None: ray[1] = (P[0], np.asarray(dir0, float))
    if dir1 is not None and deg - 1 not in ray: ray[deg - 1] = (P[-1], -np.asarray(dir1, float))
    for _ in range(iters):
        B = bern(deg, t); zero = np.zeros(len(P)); held = {}
        for _try in range(3):
            rhs = P - np.outer(B[:, 0], P[0]) - np.outer(B[:, -1], P[-1]); cols = []; what = []
            for i in range(1, deg):
                if i in ray:
                    o, d = ray[i]; rhs = rhs - np.outer(B[:, i], o)
                    if i in held: rhs = rhs - np.outer(B[:, i], held[i] * d)
                    else: cols.append(np.concatenate([B[:, i] * d[0], B[:, i] * d[1]])); what.append((i, None))
                else:
                    cols.append(np.concatenate([B[:, i], zero])); what.append((i, 0))
                    cols.append(np.concatenate([zero, B[:, i]])); what.append((i, 1))
            z = np.linalg.lstsq(np.array(cols).T, rhs.T.reshape(-1), rcond=None)[0] if cols else []
            short = [i for (i, ax), v in zip(what, z) if ax is None and v < amin]
            for (i, ax), v in zip(what, z):
                if ax is None: C[i] = ray[i][0] + max(v, amin) * ray[i][1]
                else: C[i, ax] = v
            for i in held: C[i] = ray[i][0] + held[i] * ray[i][1]
            if not short: break
            for i in short: held[i] = amin                      # плечо касательной не короче 4 % длины среза
        Q = bern(deg, tt) @ C
        t = tt[((P[:, None, :] - Q[None, :, :]) ** 2).sum(2).argmin(1)]; t[0] = 0; t[-1] = 1
    Q = bern(deg, tt) @ C
    err = np.sqrt(((P[:, None, :] - Q[None, :, :]) ** 2).sum(2).min(1))
    return C, float(err.max())
def smooth(P, dir0=None, dir1=None, tol=0.2):
    """Гладкая кривая по точкам: наименьшая степень Безье (3…5), которая ложится на точки не хуже tol см
    (а если так не ложится ни одна — почти так же хорошо, как пятая). Чем ниже степень, тем спокойнее линия."""
    fits = [fit_bezier(P, deg, dir0, dir1) for deg in (3, 4, 5)]
    lim = max(tol, 1.3 * fits[-1][1])
    for deg, (C, err) in zip((3, 4, 5), fits):
        if err <= lim: return bez(C), err, deg
def unit(v): v = np.asarray(v, float); return v / np.linalg.norm(v)

# ---------- детали развёртки ----------
def find_pieces(V, UV, tv, tl, r=0.0035):
    """Детали кроя на развёртке. Деталь — связная область листа, занятая треугольниками (сдвоенные слои и подгибы
    лежат поверх своей детали и её не дробят). Тонкие «лоскутки» вдоль швов (уже ~0,7 см) в контур не идут."""
    P2 = UV[tl]; P3 = V[tv]
    a2 = 0.5 * ((P2[:, 1, 0] - P2[:, 0, 0]) * (P2[:, 2, 1] - P2[:, 0, 1]) - (P2[:, 1, 1] - P2[:, 0, 1]) * (P2[:, 2, 0] - P2[:, 0, 0]))
    cr = np.cross(P3[:, 1] - P3[:, 0], P3[:, 2] - P3[:, 0]); a3 = 0.5 * np.linalg.norm(cr, axis=1)
    ok = (np.abs(a2) > 1e-10) & (a3 > 1e-12)
    U = unary_union([Polygon(p).buffer(1e-6) for p in P2[ok]])
    O = U.buffer(-r, join_style="mitre").buffer(r, join_style="mitre")
    comps = [c for c in getattr(O, "geoms", [O]) if c.area > 0.0006]
    cen2 = P2.mean(1); cen3 = P3.mean(1)
    # якобиан «лист -> изделие» по каждому треугольнику: сколько метров ткани в единице листа вдоль U и вдоль V
    E = np.stack([P2[:, 1] - P2[:, 0], P2[:, 2] - P2[:, 0]], -1)                      # (n, 2, 2)
    Ei = np.zeros_like(E); Ei[ok] = np.linalg.inv(E[ok])
    J = np.stack([P3[:, 1] - P3[:, 0], P3[:, 2] - P3[:, 0]], -1) @ Ei                 # (n, 3, 2)
    su, sv = np.linalg.norm(J[:, :, 0], axis=1), np.linalg.norm(J[:, :, 1], axis=1)
    def wmed(x, w):
        o = np.argsort(x); c = np.cumsum(w[o]); return float(x[o][np.searchsorted(c, c[-1] / 2)])
    out = []; owner = np.full(len(tl), -1)
    for c in comps:
        sm = c.buffer(2 * r, join_style="mitre").buffer(-2 * r, join_style="mitre")       # замыкание: впадины вдоль швов
        if sm.geom_type != "Polygon": sm = max(sm.geoms, key=lambda g: g.area)
        sel = shapely.contains_xy(c.buffer(0.004), cen2[:, 0], cen2[:, 1]) & ok & (owner < 0)
        owner[sel] = len(out)
        w = a3[sel]; wa = np.abs(a2[sel])
        X = np.column_stack([cen2[sel], np.ones(int(sel.sum()))])
        coef = np.linalg.lstsq(X * w[:, None], cen3[sel] * w[:, None], rcond=None)[0]      # P = a + u*Pu + v*Pv
        out.append(dict(poly=Polygon(sm.exterior), raw=c, sel=sel, area=float(w.sum()), mir=bool(a2[sel].sum() < 0),
                        scale=wmed(np.sqrt(a3[sel] / np.abs(a2[sel])), wa) * 100, su=wmed(su[sel], wa) * 100, sv=wmed(sv[sel], wa) * 100,
                        m=(cen3[sel] * w[:, None]).sum(0) / w.sum(), nrm=cr[sel].sum(0) / np.linalg.norm(cr[sel].sum(0)), Pu=coef[0], Pv=coef[1]))
    # треугольники без детали (лоскутки, вырожденные) — к ближайшей
    rest = np.where(owner < 0)[0]
    if len(rest):
        d = np.stack([shapely.distance(p["poly"], shapely.points(cen2[rest])) for p in out], 1)
        owner[rest] = d.argmin(1)
    # углы граней, лежащие на внешнем крае развёртки (по ним край детали потом садится на контур лекала)
    rings = shapely.union_all([g.exterior for g in getattr(U, "geoms", [U])])
    edge = np.where(shapely.distance(rings, shapely.points(UV)) < 3e-6)[0]
    return out, owner, edge


def classify(pcs, V):
    """Названия деталей по положению на изделии. Перед смотрит в -Y (Blender), сторона +X модели — левая сторона изделия."""
    W = float(np.ptp(V[:, 0])); z0 = float(V[:, 2].min()); H = float(np.ptp(V[:, 2])); x0 = float((V[:, 0].min() + V[:, 0].max()) / 2)
    for p in pcs:
        (_, (rw, rh), _) = cv_rect(p["poly"])
        short, long = sorted((rw * p["scale"], rh * p["scale"]))
        p["strip"] = short < 6 and long > 5 * short
    big = sorted((p for p in pcs if not p["strip"]), key=lambda p: -p["area"])
    assert len(big) >= 2, "не нашлись перед и спинка"
    fb = sorted(big[:2], key=lambda p: p["nrm"][1])
    fb[0].update(id="front", name="Перед", look="front", twin="back", kind="body")
    fb[1].update(id="back", name="Спинка", look="back", twin="front", kind="body")
    for p in big[2:]:
        left = p["m"][0] - x0 > 0
        p.update(id="sleeve_l" if left else "sleeve_r", name="Левый рукав" if left else "Правый рукав",
                 look="left" if left else "right", twin="sleeve_r" if left else "sleeve_l", kind="sleeve")
    k = 0
    for p in sorted((q for q in pcs if q["strip"]), key=lambda q: -q["m"][2]):
        k += 1; x, y, z = p["m"]; x -= x0; z -= z0
        ymid = float((V[:, 1].min() + V[:, 1].max()) / 2)
        side = "back" if y > ymid else "front"
        if z > H * 0.78 and abs(x) < W * 0.22: nm, look, role = "Бейка горловины", side, "neck"
        elif z < H * 0.16: nm, look, role = "Низ изделия", side, "hem"
        elif abs(x) > W * 0.25: nm, look, role = ("Край левого рукава", "left", "cuff") if x > 0 else ("Край правого рукава", "right", "cuff")
        else: nm, look, role = "Отделка", side, "trim"
        p.update(id="trim%d" % k, name=nm, look=look, twin=None, kind="trim", role=role)
    seen = {}
    for p in pcs: seen.setdefault(p["name"], []).append(p)
    for nm, ps in seen.items():
        if len(ps) > 1:
            for j, p in enumerate(ps): p["name"] = "%s %d" % (nm, j + 1)
    return pcs


def cv_rect(poly):
    """Наименьший описанный прямоугольник: (центр, (ширина, высота), угол) — как cv2.minAreaRect, но средствами shapely."""
    r = np.array(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    a, b = np.linalg.norm(r[1] - r[0]), np.linalg.norm(r[2] - r[1])
    return r.mean(0), (float(a), float(b)), 0.0


# ---------- опорные точки ----------
def orient(p, x0):
    """Матрица, которая ставит деталь «как носят»: верх изделия вверху листа, зеркальная развёртка отражена обратно."""
    if p["kind"] == "body": g = np.array([p["Pu"][2], p["Pv"][2]])
    elif p["kind"] == "sleeve":
        s = 1.0 if p["m"][0] - x0 > 0 else -1.0                    # окат — выше и ближе к телу
        g = np.array([p["Pu"][2] - s * p["Pu"][0], p["Pv"][2] - s * p["Pv"][0]])
    else:
        b = p["poly"].bounds; g = np.array([0.0, 1.0]) if (b[2] - b[0]) * p["su"] >= (b[3] - b[1]) * p["sv"] else np.array([1.0, 0.0])
    k = int(np.round(np.arctan2(g[0], g[1]) / (np.pi / 2))) % 4          # на сколько четвертей повернуть, чтобы g смотрел вверх
    c, s_ = [(1, 0), (0, 1), (-1, 0), (0, -1)][k]
    R = np.array([[c, -s_], [s_, c]], float)
    if p["mir"]: R = np.array([[-1.0, 0], [0, 1.0]]) @ R
    return R


def contour(p, N, scale):
    """Контур детали в сантиметрах после поворота N, обход против часовой, шаг 1 мм. Возвращает точки и их же в единицах листа."""
    E = np.array(p["poly"].exterior.coords)[:-1]
    Q = E @ N.T * scale
    if Polygon(Q).exterior.is_ccw is False: Q = Q[::-1]
    Q = resample(np.vstack([Q, Q[:1]]), step=0.1)[:-1]
    return Q, (Q / scale) @ N                                       # N ортогональна: обратная = транспонированная


def tilt_of(pairs):
    """Наклон оси симметрии по серединам парных точек (радианы от вертикали)."""
    M = np.array([(a + b) / 2 for a, b in pairs])
    if len(M) < 2 or np.ptp(M[:, 1]) < 1e-6: return 0.0
    return float(np.arctan(np.polyfit(M[:, 1], M[:, 0], 1)[0]))


def marks_body(P):
    idx, ang = corners(P, 12, 25, 8)
    assert len(idx) == 8, "у детали тела ожидалось 8 углов, найдено %d" % len(idx)
    by_y = sorted(idx, key=lambda i: P[i, 1])
    lr = lambda two: sorted(two, key=lambda i: P[i, 0])
    (HL, HR), (UL, UR), (SL, SR), (NL, NR) = lr(by_y[:2]), lr(by_y[2:4]), lr(by_y[4:6]), lr(by_y[6:])
    return dict(HL=HL, HR=HR, UL=UL, UR=UR, SL=SL, SR=SR, NL=NL, NR=NR)


def marks_sleeve(P):
    idx, ang = corners(P, 12, 25, 4)
    assert len(idx) == 4, "у рукава ожидалось 4 угла, найдено %d" % len(idx)
    by_y = sorted(idx, key=lambda i: P[i, 1])
    lr = lambda two: sorted(two, key=lambda i: P[i, 0])
    (HL, HR), (UL, UR) = lr(by_y[:2]), lr(by_y[2:])
    return dict(HL=HL, HR=HR, UL=UL, UR=UR)


def on_axis(P, i, j, cx):
    """Индекс точки контура между i и j (по ходу обхода), ближайшей к оси x = cx."""
    n = len(P); ids = [(i + q) % n for q in range((j - i) % n + 1)]
    return ids[int(np.argmin(np.abs(P[ids, 0] - cx)))]


def halves(P, m, cx, names):
    """Усреднённые половины срезов: правая половина и отражённая левая. names — [(имя, от, до, от_лев, до_лев)]."""
    out = {}
    for nm, a, b, c, d in names:
        R = resample(cyc(P, m[a], m[b]), 240) - [cx, 0]
        L = flipx(resample(cyc(P, m[c], m[d]), 240) - [cx, 0])[::-1]
        out[nm] = dict(R=R, L=L, avg=(R + L) / 2, asym=float(np.linalg.norm(R - L, axis=1).max()))
    return out


def read_piece(p, x0, scale):
    """Опорные точки и усреднённые срезы одной детали (ось симметрии — в x = cx)."""
    N = orient(p, x0)
    for _ in range(2):                                              # второй проход — после поправки наклона оси
        P, Puv = contour(p, N, scale)
        if p["kind"] == "body":
            m = marks_body(P); t = tilt_of([(P[m[a + "L"]], P[m[a + "R"]]) for a in "HUSN"])
        elif p["kind"] == "sleeve":
            m = marks_sleeve(P); t = tilt_of([(P[m[a + "L"]], P[m[a + "R"]]) for a in "HU"])
        else: m, t = {}, 0.0
        if abs(t) < 1e-4: break
        c, s = math.cos(t), math.sin(t); N = np.array([[c, -s], [s, c]]) @ N       # поворот на +t ставит ось вертикально
    p.update(N=N, P=P, Puv=Puv, m=dict(m), tilt=math.degrees(t))
    if p["kind"] == "body":
        cx = float(np.mean([(P[m[a + "L"], 0] + P[m[a + "R"], 0]) / 2 for a in "HUSN"]))
        m["B"] = on_axis(P, m["HL"], m["HR"], cx); m["C"] = on_axis(P, m["NR"], m["NL"], cx)
        hv = halves(P, m, cx, [("hem", "B", "HR", "HL", "B"), ("side", "HR", "UR", "UL", "HL"), ("arm", "UR", "SR", "SL", "UL"),
                               ("sh", "SR", "NR", "NL", "SL"), ("neck", "NR", "C", "C", "NL")])
        # вырез «мысом»: в середине горловины угол, а не дуга
        a = P[m["C"]] - P[(m["C"] - 15) % len(P)]; b = P[(m["C"] + 15) % len(P)] - P[m["C"]]
        p["vneck"] = abs(math.degrees(math.atan2(a[0] * b[1] - a[1] * b[0], float(a @ b)))) > 35
        p["marks"] = ["B", "HR", "UR", "SR", "NR", "C", "NL", "SL", "UL", "HL", "B"]
    elif p["kind"] == "sleeve":
        cx = float(np.mean([(P[m[a + "L"], 0] + P[m[a + "R"], 0]) / 2 for a in "HU"]))
        m["B"] = on_axis(P, m["HL"], m["HR"], cx); m["T"] = on_axis(P, m["UR"], m["UL"], cx)
        hv = halves(P, m, cx, [("hem", "B", "HR", "HL", "B"), ("under", "HR", "UR", "UL", "HL"), ("cap", "UR", "T", "T", "UL")])
        p["marks"] = ["B", "HR", "UR", "T", "UL", "HL", "B"]
    else:
        idx, _ = corners(P, 6, 10, 4)
        assert len(idx) == 4, "у полосы отделки ожидалось 4 угла, найдено %d" % len(idx)
        c = P[idx].mean(0)
        for i in idx: m[("B" if P[i, 1] < c[1] else "T") + ("L" if P[i, 0] < c[0] else "R")] = i
        w = (np.linalg.norm(P[m["BR"]] - P[m["BL"]]) + np.linalg.norm(P[m["TR"]] - P[m["TL"]])) / 2
        h = (np.linalg.norm(P[m["TL"]] - P[m["BL"]]) + np.linalg.norm(P[m["TR"]] - P[m["BR"]])) / 2
        p.update(w=w / scale, h=h / scale, m=m, marks=["BL", "BR", "TR", "TL", "BL"])
        return p
    p.update(cx=cx, hv=hv, m=m)
    return p


# ---------- построение базовых лекал ----------
def blend(P, a, b):
    """Перенос среза на новые концы a и b: точки сдвигаются плавно от одного конца к другому. Направление среза
    на концах не меняется — горизонтальная касательная в середине горловины и низа остаётся горизонтальной."""
    P = np.asarray(P, float); a = np.asarray(a, float); b = np.asarray(b, float)
    s = np.concatenate([[0], np.cumsum(seglen(P))]); t = s / s[-1]; w = (t * t * (3 - 2 * t))[:, None]
    return P + (1 - w) * (a - P[0]) + w * (b - P[-1])


def solve(f, lo, hi, target, n=60):
    """Корень f(x) = target на отрезке, f монотонна."""
    up = f(hi) > f(lo)
    for _ in range(n):
        mid = (lo + hi) / 2
        if (f(mid) < target) == up: lo = mid
        else: hi = mid
    return (lo + hi) / 2


def mean_y(P):
    s = np.concatenate([[0], np.cumsum(seglen(P))])
    return float(np.trapezoid(P[:, 1], s) / s[-1])


def build(q):
    """Срезы правой половины детали по опорным точкам: прямые — отрезками, кривые — переносом шаблона на точки."""
    P, T, md = q["pts"], q["tpl"], q["mode"]
    ln = lambda key, a, b: line(P[a], P[b]) if md.get(key) == "line" else blend(T[key], P[a], P[b])
    if q["kind"] == "body":
        q["seg"] = dict(hem=ln("hem", "B", "H"), side=ln("side", "H", "U"), arm=blend(T["arm"], P["U"], P["S"]),
                        sh=line(P["S"], P["N"]), neck=blend(T["neck"], P["N"], P["C"]))
    else:
        q["seg"] = dict(hem=ln("hem", "B", "H"), under=line(P["H"], P["U"]), cap=blend(T["cap"], P["U"], P["T"]))
    return q


def fit_cap(sl, arm, how):
    """Окат рукава по длине проймы: меняется высота оката (how = "height") или ширина рукава ("width")."""
    P = sl["pts"]
    if how == "height":
        def f(h): P["T"] = np.array([0.0, h]); return 2 * arclen(build(sl)["seg"]["cap"])
        h0 = float(P["T"][1]); f(solve(f, h0 * 0.5, h0 * 2.5, arm))
    else:
        U0, H0 = P["U"].copy(), P["H"].copy()
        def f(x): P["U"] = np.array([x, 0.0]); P["H"] = H0 + [x - U0[0], 0]; return 2 * arclen(build(sl)["seg"]["cap"])
        f(solve(f, U0[0] * 0.6, U0[0] * 2.5, arm))


def true_up(pat, cap):
    """Сопряжение срезов: плечо переда = плечо спинки, бок переда = бок спинки, окат = пройма переда + пройма спинки."""
    f, b = pat["front"], pat["back"]
    L = float(np.mean([np.linalg.norm(q["pts"]["S"] - q["pts"]["N"]) for q in (f, b)]))
    for q in (f, b):
        d = q["pts"]["S"] - q["pts"]["N"]; q["pts"]["S"] = q["pts"]["N"] + d * L / np.linalg.norm(d)
        build(q)
    Ls = [arclen(q["seg"]["side"]) for q in (f, b)]
    if abs(Ls[0] - Ls[1]) > 1e-7:                                     # низ детали сдвигается по вертикали, пока бока не сравняются
        L = float(np.mean(Ls))
        for q in (f, b):
            P = q["pts"]; H0, B0 = P["H"].copy(), P["B"].copy()
            def length(dy, q=q, P=P, H0=H0, B0=B0):
                P["H"] = H0 + [0, dy]; P["B"] = B0 + [0, dy]; return arclen(build(q)["seg"]["side"])
            length(solve(length, -8, 8, L))
    if "sleeve" in pat: fit_cap(pat["sleeve"], arclen(f["seg"]["arm"]) + arclen(b["seg"]["arm"]), cap)
    nf, nb = 2 * arclen(f["seg"]["neck"]), 2 * arclen(b["seg"]["neck"])
    Ln = dict(neck=nf + nb, neck_long=max(nf, nb), neck_short=min(nf, nb), hem_front=2 * arclen(f["seg"]["hem"]), hem_back=2 * arclen(b["seg"]["hem"]),
              cuff=2 * arclen(pat["sleeve"]["seg"]["hem"]) if "sleeve" in pat else 0)
    for t in pat["trims"]: t["w"] = round(Ln[t["on"]] * RIB[t["role"]], 1) if t["on"] else round(t["w0"], 1)     # отделка — по длине своего среза
    return pat


def draft(pcs, V, opts=None, log=print):
    """Базовые лекала (размер модели) по деталям развёртки. opts: side / hem / sleeve_hem = "line" | "curve" (иначе — по прогибу)."""
    opts = opts or {}
    x0 = float((V[:, 0].min() + V[:, 0].max()) / 2)
    body = [p for p in pcs if p["kind"] == "body"]; sleeves = [p for p in pcs if p["kind"] == "sleeve"]; trims = [p for p in pcs if p["kind"] == "trim"]
    bs = float(np.average([p["scale"] for p in body], weights=[p["area"] for p in body]))       # перед и спинка — в одном масштабе
    ss = float(np.mean([p["scale"] for p in sleeves])) if sleeves else bs
    for p in pcs: read_piece(p, x0, bs if p["kind"] == "body" else ss if p["kind"] == "sleeve" else 100.0)
    for p in trims:                                                     # полоса: длина и высота — каждая по своему масштабу ткани
        along_u = abs(p["N"][0, 0]) > 0.5
        p["w"] *= p["su"] if along_u else p["sv"]; p["h"] *= p["sv"] if along_u else p["su"]
    mode = lambda key, auto: opts.get(key) or ("line" if auto else "curve")

    B = {}
    for p in body:
        hv = p["hv"]; yN = float(hv["sh"]["avg"][-1][1])
        raw = {k: v["avg"] - [0, yN] for k, v in hv.items()}
        pts = dict(B=raw["hem"][0] * [0, 1], H=raw["side"][0], U=raw["arm"][0], S=raw["sh"][0], N=raw["sh"][-1] * [1, 0], C=raw["neck"][-1] * [0, 1])
        dev, L = chord_dev(raw["side"])
        md = dict(hem=mode("hem", abs(pts["B"][1] - pts["H"][1]) / pts["H"][0] < 0.06), side=mode("side", dev / L < STRAIGHT))
        if md["hem"] == "line":                                         # прямой низ — на среднем уровне исходного
            y = mean_y(raw["hem"]); pts["B"] = np.array([0.0, y]); pts["H"] = np.array([pts["H"][0], y])
        if opts.get("straight"):                                        # прямой силуэт: бок отвесный, низ той же ширины, что и грудь
            log("%s: прямой силуэт — низ расширен с %.0f до %.0f мм (в модели он уже груди)" % (p["name"], 20 * pts["H"][0], 20 * pts["U"][0]))
            md = dict(hem="line", side="line"); y = mean_y(raw["hem"])
            pts["B"] = np.array([0.0, y]); pts["H"] = np.array([pts["U"][0], y])
        # Кривые идут по развёртке модели. В середине детали горловина и низ горизонтальны — иначе на оси симметрии был бы
        # излом. С ключом square срезы ещё и сходятся на стыках под прямым углом (пройма — к боковому и плечевому срезам,
        # горловина — к плечевому, низ — к боковому): так строят лекала, но в самих моделях пройма подходит к боку под 115–135°.
        tpl = {}; sq = opts.get("square")
        if md["side"] == "curve":
            tpl["side"] = smooth(raw["side"])[0]; t_u, t_h = unit(tpl["side"][-1] - tpl["side"][-4]), unit(tpl["side"][3] - tpl["side"][0])
        else: t_u = t_h = unit(pts["U"] - pts["H"])
        d_sh = unit(pts["N"] - pts["S"])                                # вдоль плеча к горловине
        arm, e1, d1 = smooth(raw["arm"], dir0=[-t_u[1], t_u[0]], dir1=[d_sh[1], -d_sh[0]]) if sq else smooth(raw["arm"])
        nk, e2, d2 = smooth(raw["neck"]) if p["vneck"] else smooth(raw["neck"], dir0=[-d_sh[1], d_sh[0]] if sq else None, dir1=[-1.0, 0.0])
        tpl.update(arm=arm, neck=nk)
        if md["hem"] == "curve": tpl["hem"] = smooth(raw["hem"], dir0=[1.0, 0.0], dir1=[t_h[1], -t_h[0]] if sq else None)[0]
        B[p["id"]] = dict(id=p["id"], kind="body", pts=pts, tpl=tpl, mode=md, vneck=p["vneck"], straight=bool(opts.get("straight")))
        log("%s: левая и правая половины в модели расходятся — бок до %.1f мм, пройма %.1f мм, плечо %.1f мм, горловина %.1f мм, низ %.1f мм" % (
            p["name"], *(10 * hv[k]["asym"] for k in ("side", "arm", "sh", "neck", "hem"))))
        log("   бок — %s, низ — %s; пройма — кривая %d-й степени (от модели отходит до %.1f мм), горловина — %d-й (до %.1f мм)" % (
            "прямая" if md["side"] == "line" else "плавная кривая", "прямая" if md["hem"] == "line" else "плавная кривая", d1, e1 * 10, d2, e2 * 10))
    f, b = B["front"], B["back"]
    # перед и спинка: общие опорные точки там, где они и так почти совпадают
    def unify(names, tol=0.6):
        if max(float(np.abs(f["pts"][n] - b["pts"][n]).max()) for n in names) > tol: return False
        for n in names: f["pts"][n] = b["pts"][n] = (f["pts"][n] + b["pts"][n]) / 2
        return True
    same_sh = unify(["N", "S"]); same_side = f["mode"] == b["mode"] and unify(["U", "H"])
    if same_side:
        yb = (f["pts"]["B"][1] + b["pts"]["B"][1]) / 2
        for q in (f, b): q["pts"]["B"] = np.array([0.0, q["pts"]["H"][1] if q["mode"]["hem"] == "line" else yb])
        if f["mode"]["side"] == "curve": f["tpl"]["side"] = b["tpl"]["side"] = (f["tpl"]["side"] + b["tpl"]["side"]) / 2
    log("Перед и спинка: плечевые точки %s, боковые %s" % ("общие" if same_sh else "свои, срезы сведены по длине", "общие — боковые срезы одинаковы" if same_side else "свои, срезы сведены по длине"))
    out = dict(front=f, back=b, trims=[], scale=dict(body=bs, sleeve=ss))
    # отделка: длина полосы — по срезу, к которому она пришивается; ширина — из модели, с округлением до миллиметра
    necks = sorted((p for p in trims if p["role"] == "neck"), key=lambda p: -p["w"])
    for p in trims:
        t = dict(id=p["id"], kind="trim", role=p["role"], look=p["look"], h=round(p["h"], 1), w0=p["w"], w=p["w"])
        if p["role"] == "neck": t["on"] = "neck" if len(necks) == 1 else ("neck_long" if p is necks[0] else "neck_short")
        elif p["role"] == "hem": t["on"] = "hem_" + ("back" if p["look"] == "back" else "front")
        elif p["role"] == "cuff": t["on"] = "cuff"
        else: t["on"] = None
        out["trims"].append(t)
    out["bands"] = dict(hem=any(t["role"] == "hem" for t in out["trims"]), cuff=any(t["role"] == "cuff" for t in out["trims"]))
    for q in (f, b): build(q)
    true_up(out, None)
    if sleeves:
        raws = {k: np.mean([p["hv"][k]["avg"] - [0, p["hv"]["cap"]["avg"][0][1]] for p in sleeves], axis=0) for k in ("hem", "under", "cap")}
        pts = dict(B=raws["hem"][0] * [0, 1], H=raws["under"][0], U=raws["cap"][0] * [1, 0], T=raws["cap"][-1] * [0, 1])
        md = dict(hem=mode("sleeve_hem", abs(pts["B"][1] - pts["H"][1]) / pts["H"][0] < 0.06))
        if md["hem"] == "line":
            y = mean_y(raws["hem"]); pts["B"] = np.array([0.0, y]); pts["H"] = np.array([pts["H"][0], y])
        cap, e, dg = smooth(raws["cap"], dir1=[-1.0, 0.0])
        tpl = dict(cap=cap)
        if md["hem"] == "curve": tpl["hem"] = smooth(raws["hem"], dir0=[1.0, 0.0])[0]
        sl = build(dict(id="sleeve", kind="sleeve", pts=pts, tpl=tpl, mode=md))
        # Масштаб рукава по сетке известен с точностью в несколько процентов. В этих пределах (±4 %) он берётся таким,
        # чтобы окат сошёлся с проймой; остаток добирается высотой оката.
        arm = arclen(f["seg"]["arm"]) + arclen(b["seg"]["arm"]); was = 2 * arclen(sl["seg"]["cap"]); h0 = float(pts["T"][1])
        k = float(np.clip(arm / was, 0.96, 1.04))
        sl["pts"] = {n: v * k for n, v in pts.items()}; sl["tpl"] = {n: v * k for n, v in tpl.items()}; out["scale"]["sleeve"] = ss * k
        out["sleeve"] = build(sl)
        true_up(out, "height")
        log("Рукав: окат в модели %.1f см при пройме %.1f см (перед %.1f + спинка %.1f). Масштаб рукава поправлен на %+.1f %%, высота оката %.1f → %.1f см — длины сравнялись" % (
            was, arm, arclen(f["seg"]["arm"]), arclen(b["seg"]["arm"]), (k - 1) * 100, h0 * k, sl["pts"]["T"][1]))
        log("   низ — %s; окат — кривая %d-й степени (до %.1f мм); левая и правая половины в модели расходятся — окат до %.1f мм, нижний шов %.1f мм" % (
            "прямой" if md["hem"] == "line" else "плавная кривая", dg, e * 10,
            10 * max(p["hv"]["cap"]["asym"] for p in sleeves), 10 * max(p["hv"]["under"]["asym"] for p in sleeves)))
    fit = opts.get("fit")
    if fit:                                                             # подгонка базового размера под заданные мерки
        was = dict((k, v) for k, _, v in measures(out)); k = fit["chest"] / (2 * f["pts"]["U"][0])
        for q in [f, b] + ([out["sleeve"]] if "sleeve" in out else []):
            q["pts"] = {n: v * k for n, v in q["pts"].items()}; q["tpl"] = {n: v * k for n, v in q["tpl"].items()}; build(q)
        for t in out["trims"]: t["w0"] *= k
        for _ in range(3):                                              # низ опускается, бока снова сводятся по длине
            extra = fit["length"] + hem_at(b, b["pts"]["N"][0])
            for q in (f, b):
                q["pts"]["H"] = q["pts"]["H"] - [0, extra]; q["pts"]["B"] = q["pts"]["B"] - [0, extra]; build(q)
            true_up(out, "height" if "sleeve" in out else None)
        out["fit"] = k; now = dict((k_, v) for k_, _, v in measures(out))
        log("Подгонка под стандартный размер: детали увеличены на %.1f %% (ширина по груди %.0f → %.0f мм), низ опущен ещё на %.0f мм (длина от плеча %.0f → %.0f мм)" % (
            (k - 1) * 100, was["chest"] * 10, now["chest"] * 10, (now["length"] - was["length"] * k) * 10, was["length"] * 10, now["length"] * 10))
    log("масштаб: тело %.2f см на единицу листа, рукава %.2f" % (bs, out["scale"]["sleeve"]))
    for t in out["trims"]: log("%s: %.1f × %.1f см (в модели %.1f см)" % (next(p["name"] for p in trims if p["id"] == t["id"]), t["w"], t["h"], t["w0"]))
    return out


# ---------- градация ----------
def grade(base, k, g):
    """Лекала на k размеров больше базового (k < 0 — меньше) по приращениям g."""
    if k == 0: return base
    out = dict(trims=[dict(t) for t in base["trims"]], scale=base["scale"], bands=base["bands"], fit=base.get("fit", 1.0))
    for key in ("front", "back"):
        q = base[key]; P = q["pts"]
        N = P["N"] + [g["neck_w"] / 2 * k, 0]
        slope = (P["S"][1] - P["N"][1]) / (P["S"][0] - P["N"][0])       # наклон плеча не меняется
        xs = P["S"][0] + g["shoulder"] / 2 * k
        pts = dict(N=N, S=np.array([xs, N[1] + (xs - N[0]) * slope]), C=P["C"] - [0, (g["neck_f"] if key == "front" else g["neck_b"]) * k],
                   U=P["U"] + [g["chest"] / 2 * k, -g["armhole"] * k], H=P["H"] + [g["hem"] / 2 * k, -g["length"] * k], B=P["B"] - [0, g["length"] * k])
        if q.get("straight"): pts["H"][0] = pts["U"][0]                 # прямой силуэт остаётся прямым на любом размере
        out[key] = build(dict(id=q["id"], kind="body", mode=q["mode"], vneck=q["vneck"], tpl=q["tpl"], pts=pts, straight=q.get("straight", False)))
    if "sleeve" in base:
        q = base["sleeve"]; P = q["pts"]
        dx = g["sleeve_w"] / 2 * k
        pts = dict(U=P["U"] + [dx, 0], T=P["T"].copy(), H=P["H"] + [dx, -g["under"] * k], B=P["B"] - [0, g["under"] * k])
        out["sleeve"] = build(dict(id="sleeve", kind="sleeve", mode=q["mode"], tpl=q["tpl"], pts=pts))
    return true_up(out, "height")


def hem_at(q, x):
    """Высота линии низа детали на расстоянии x от её середины."""
    P = q["seg"]["hem"]
    return float(np.interp(x, P[:, 0], P[:, 1]))


def measures(pat):
    """Табель мер готового изделия (без припусков), см. Длина — как в заводских табелях: по спинке, от высшей точки плеча
    отвесно до низа."""
    f, b, sl = pat["front"], pat["back"], pat.get("sleeve")
    m = [("chest", "Ширина по груди", 2 * f["pts"]["U"][0]), ("length", "Длина от плеча", -hem_at(b, b["pts"]["N"][0])), ("hem", "Ширина по низу", 2 * f["pts"]["H"][0]),
         ("shoulders", "Ширина по плечам", 2 * b["pts"]["S"][0]), ("neck", "Ширина горловины", 2 * f["pts"]["N"][0]), ("neck_f", "Глубина горловины переда", -f["pts"]["C"][1]),
         ("armhole", "Глубина проймы", -f["pts"]["U"][1])]
    if sl: m += [("sleeve", "Длина рукава", sl["pts"]["T"][1] - sl["pts"]["B"][1]), ("sleeve_w", "Ширина рукава", 2 * sl["pts"]["U"][0]), ("sleeve_hem", "Ширина рукава по низу", 2 * sl["pts"]["H"][0])]
    return [(k, n, round(float(v), 1)) for k, n, v in m]


# ---------- контур детали ----------
def outline(q, bands=None):
    """Срезы детали по порядку обхода (против часовой): [(имя, вид припуска, точки)]. Начало координат: у тела — высшая
    точка плеча на оси, у рукава — концы оката на оси, у полосы — её середина."""
    if q["kind"] == "trim":
        w, h = q["w"] / 2, q["h"] / 2
        c = [np.array(v, float) for v in ((-w, -h), (w, -h), (w, h), (-w, h))]
        return [(nm, "strip", line(c[i], c[(i + 1) % 4], 8 if i % 2 else 40)) for i, nm in enumerate(("bottom", "right", "top", "left"))]
    S = q["seg"]; bands = bands or {}
    order = ["hem", "side", "arm", "sh", "neck"] if q["kind"] == "body" else ["hem", "under", "cap"]
    # низ с притачной полосой (манжета, пояс) — обычный шов, без полосы — подгибка
    kind = dict(neck="neck", hem=("seam" if bands.get("hem") else "hem") if q["kind"] == "body" else ("seam" if bands.get("cuff") else "sleeve_hem"))
    R = [(nm + "R", kind.get(nm, "seam"), S[nm]) for nm in order]
    L = [(nm + "L", kind.get(nm, "seam"), flipx(S[nm])[::-1]) for nm in reversed(order)]
    return R + L


def ring(segs):
    """Замкнутый контур из срезов без повторов на стыках."""
    return np.vstack([s[2][:-1] for s in segs])


def offset_ring(segs, allow):
    """Линия реза: каждый срез отодвинут наружу на свой припуск, соседние срезы продолжены до пересечения.
    У подгибки (низ изделия, низ рукава без манжеты) боковой край припуска — зеркальное отражение шва относительно линии
    низа: подогнутый припуск ложится на деталь край в край, даже когда рукав сужается книзу."""
    HEMS = ("hem", "sleeve_hem")
    offs = []
    for nm, kind, P in segs:
        d = np.gradient(P, axis=0); n = np.column_stack([d[:, 1], -d[:, 0]])      # наружу при обходе против часовой
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        offs.append(P + n * allow[kind])
    out = []; skip = None
    for i, O in enumerate(offs):
        j = (i + 1) % len(offs); Pi, Pj = segs[i][2], segs[j][2]; ki, kj = segs[i][1], segs[j][1]
        if skip is not None:                                    # начало среза — не ниже линии низа у предыдущего угла
            O = O[[(x - skip[0]) @ skip[1] <= 1e-9 for x in O]]; skip = None
        if (ki in HEMS) != (kj in HEMS):
            Pc = Pi[-1]; mir = lambda v: v - 2 * (v @ nh) * nh
            if ki in HEMS:                                      # подгибка, за ней шов
                h = unit(Pi[-1] - Pi[-2]); nh = np.array([h[1], -h[0]]); d = unit(Pj[1] - Pj[0])
                Q = Pc + allow[kj] * np.array([d[1], -d[0]]); q = (Q - Pc) @ nh; dn = d @ nh
                C1 = Pc + mir(Q - Pc) + (allow[ki] + q) / -dn * mir(d); C0 = Q - q / dn * d
                out.extend(O.tolist()); out += [C1.tolist(), C0.tolist()]; skip = (Pc, nh)
            else:                                               # шов, за ним подгибка
                h = unit(Pj[1] - Pj[0]); nh = np.array([h[1], -h[0]]); d = unit(Pi[-1] - Pi[-2])
                Q = Pc + allow[ki] * np.array([d[1], -d[0]]); q = (Q - Pc) @ nh; dn = d @ nh
                C1 = Pc + mir(Q - Pc) - (allow[kj] + q) / dn * mir(d); C0 = Q - q / dn * d
                out.extend(O[[(x - Pc) @ nh <= 1e-9 for x in O]].tolist()); out += [C0.tolist(), C1.tolist()]
            continue
        Pn = offs[j]
        a, da = O[-1], unit(O[-1] - O[-2]); b, db = Pn[0], unit(Pn[1] - Pn[0])
        M = np.array([da, -db]).T
        out.extend(O.tolist())
        if abs(np.linalg.det(M)) > 0.05 and np.linalg.norm(a - b) > 1e-6:
            t = np.linalg.solve(M, b - a); X = a + t[0] * da
            if t[0] >= 0 and t[1] <= 0 and np.linalg.norm(X - a) < 12: out.append(X.tolist())
    R = Polygon(out).buffer(0)
    if R.geom_type != "Polygon": R = max(R.geoms, key=lambda g: g.area)
    return np.array(R.exterior.coords)[:-1]


def at_dist(P, d):
    """Точка среза на расстоянии d от его начала и нормаль наружу в этой точке."""
    s = np.concatenate([[0], np.cumsum(seglen(P))]); d = float(np.clip(d, 0, s[-1]))
    i = int(np.clip(np.searchsorted(s, d) - 1, 0, len(P) - 2)); t = (d - s[i]) / max(s[i + 1] - s[i], 1e-12)
    tg = P[i + 1] - P[i]; tg = tg / np.linalg.norm(tg)
    return P[i] + (P[i + 1] - P[i]) * t, np.array([tg[1], -tg[0]])


def notches(pat, pid, fx=1):
    """Надсечки для сборки: середины горловины, низа и оката, контрольные точки проймы и оката (перед — одна, спинка — две).
    Возвращает [(точка, нормаль, вид припуска)] в координатах детали."""
    q = pat["sleeve"] if pid.startswith("sleeve") else pat.get(pid)
    if not q or q["kind"] == "trim": return []
    segs = {nm: (kind, P) for nm, kind, P in outline(q, pat["bands"])}
    out = []
    def put(nm, d, from_end=False, double=False):
        kind, P = segs[nm]; L = arclen(P)
        for dd in ((d - 0.4, d + 0.4) if double else (d,)):
            pt, n = at_dist(P, L - dd if from_end else dd); out.append((pt, n, kind))
    fa, ba = 0.4 * arclen(pat["front"]["seg"]["arm"]), 0.4 * arclen(pat["back"]["seg"]["arm"])
    if q["kind"] == "body":
        put("hemR", 0); put("neckR", 0, from_end=True)
        d = fa if pid == "front" else ba
        put("armR", d, double=pid == "back"); put("armL", d, from_end=True, double=pid == "back")
    else:
        put("hemR", 0)
        # Плечевой шов приходит не в середину оката: пройма переда длиннее проймы спинки. Надсечка плеча стоит на расстоянии
        # длины проймы переда от того конца оката, который смотрит на перед изделия.
        kind, R = segs["capR"]; full = np.vstack([R, segs["capL"][1][1:]])
        fl = arclen(pat["front"]["seg"]["arm"])
        out.append((*at_dist(full, fl if fx > 0 else arclen(full) - fl), kind))
        front, back = ("capR", "capL") if fx > 0 else ("capL", "capR")       # с какой стороны детали перед изделия
        put(front, fa, from_end=front == "capL"); put(back, ba, from_end=back == "capL", double=True)
    return out


# ---------- раскладка на листе ----------
TGAP = 3.0
def place(pat, ids):
    """Раскладка деталей: перед и спинка, под ними рукава, ниже отделка. Лист: X вправо, Y вниз, сантиметры.
    Возвращает детали (каждая со сдвигом ox, oy: точка детали (x, y) лежит на листе в (ox + x, oy - y)) и размер листа."""
    its = []
    order = dict(neck=0, cuff=1, hem=2, trim=3)
    qs = [("front", pat["front"]), ("back", pat["back"])]
    if "sleeve" in pat: qs += [(i, pat["sleeve"]) for i in ("sleeve_r", "sleeve_l") if i in ids]
    qs += [(t["id"], t) for t in sorted(pat["trims"], key=lambda t: (order[t["role"]], t["id"]))]
    for pid, q in qs:
        segs = outline(q, pat["bands"]); R = ring(segs); lo, hi = R.min(0), R.max(0)
        its.append(dict(id=pid, q=q, segs=segs, lo=lo, hi=hi, w=float(hi[0] - lo[0]), h=float(hi[1] - lo[1])))
    rows = [[i for i in its if i["q"]["kind"] == "body"], [i for i in its if i["q"]["kind"] == "sleeve"]]
    width = sum(i["w"] for i in rows[0]) + GAP * (len(rows[0]) - 1)
    row = []; x = 0.0
    for i in (i for i in its if i["q"]["kind"] == "trim"):
        if row and x + i["w"] > width + 1e-6: rows.append(row); row = []; x = 0.0
        row.append(i); x += i["w"] + TGAP
    if row: rows.append(row)
    y = MARGIN
    for row in rows:
        if not row: continue
        gap = TGAP if row[0]["q"]["kind"] == "trim" else GAP; x = MARGIN
        for i in row:
            i["ox"] = float(x - i["lo"][0]); i["oy"] = float(y + i["hi"][1]); x += i["w"] + gap
        y += max(i["h"] for i in row) * (2 if row[0]["q"]["kind"] == "trim" else 1) + gap
    W = max(i["ox"] + i["hi"][0] for i in its) + MARGIN
    H = max(i["oy"] - i["lo"][1] + (i["h"] if i["q"]["kind"] == "trim" else 0) for i in its) + MARGIN
    return its, float(W), float(H)


def on_sheet(i, P): return np.column_stack([i["ox"] + np.asarray(P)[:, 0], i["oy"] - np.asarray(P)[:, 1]])


def compact(P, tol=0.01):
    """Ломаная без лишних точек (допуск 0,1 мм)."""
    from shapely.geometry import LineString
    return np.array(LineString(P).simplify(tol, preserve_topology=False).coords)


def sheet_ring(i, tol=0.01):
    """Контур детали на листе: срезы упрощены по отдельности, углы сохраняются точно."""
    return np.vstack([compact(on_sheet(i, s[2]), tol)[:-1] for s in i["segs"]])


def seam_pairs(its, step=0.7):
    """Швы для перехода нанесения с детали на деталь: пары точек «здесь — там» на листе. Боковые швы переда и спинки
    (правый край одной детали сшивается с левым краем другой) и нижний шов рукава."""
    by = {i["id"]: i for i in its}; out = []
    def pairs(ia, na, ib, nb):
        A = dict((s[0], s[2]) for s in ia["segs"])[na]; Bq = dict((s[0], s[2]) for s in ib["segs"])[nb]
        if na.endswith("L"): A = A[::-1]                            # оба среза — от низа вверх
        if nb.endswith("L"): Bq = Bq[::-1]
        n = max(4, int(arclen(A) / step) + 1)
        a = on_sheet(ia, resample(A, n)); b = on_sheet(ib, resample(Bq, n))
        return [round(float(v), 2) for row in np.hstack([a, b]) for v in row]
    if "front" in by and "back" in by:
        out.append(["back", "front", pairs(by["back"], "sideL", by["front"], "sideR")])
        out.append(["back", "front", pairs(by["back"], "sideR", by["front"], "sideL")])
    for sid in ("sleeve_l", "sleeve_r"):
        if sid in by: out.append([sid, sid, pairs(by[sid], "underR", by[sid], "underL")])
    return out


# ---------- перенос развёртки модели на лекала ----------
def mvc(X, P, Q, chunk=2500):
    """Координаты средних значений: точки X внутри (и около) многоугольника P переносятся вслед за его границей в Q.
    Граница P переходит точно в Q, внутри — гладко; линейное отображение границы даёт линейное отображение внутри."""
    out = np.empty((len(X), 2))
    for a in range(0, len(X), chunk):
        x = X[a:a + chunk]; s = P[None] - x[:, None]
        r = np.linalg.norm(s, axis=2); s2 = np.roll(s, -1, 1); r2 = np.roll(r, -1, 1)
        A = s[..., 0] * s2[..., 1] - s[..., 1] * s2[..., 0]; D = (s * s2).sum(2)
        den = r * r2 + D; bad = np.abs(den) < 1e-13
        tn = A / np.where(bad, 1.0, den)
        w = (np.roll(tn, 1, 1) + tn) / np.maximum(r, 1e-13)
        res = (w[..., None] * Q[None]).sum(1) / w.sum(1)[:, None]
        for j in np.where(bad.any(1))[0]:                          # точка на стороне многоугольника
            i = int(np.argmax(bad[j])); t = r[j, i] / max(r[j, i] + r2[j, i], 1e-13)
            res[j] = Q[i] * (1 - t) + Q[(i + 1) % len(Q)] * t
        for j in np.where(r.min(1) < 1e-11)[0]: res[j] = Q[int(np.argmin(r[j]))]
        out[a:a + chunk] = res
    return out


def correspondence(p, i, step=0.25):
    """Соответствие границ: срез детали на развёртке модели — тот же срез лекала на листе, точка к точке по доле длины."""
    old, new = [], []
    for (a, b), (nm, kind, S) in zip(zip(p["marks"], p["marks"][1:]), i["segs"]):
        n = max(6, int(arclen(S) / step) + 1)
        old.append(resample(cyc(p["Puv"], p["m"][a], p["m"][b]), n)[:-1]); new.append(on_sheet(i, resample(S, n))[:-1])
    return np.vstack(old), np.vstack(new)


def remap(pcs, its, UV, loop_piece, edge_loops):
    """Новая развёртка модели: координаты каждого угла грани на листе лекал (см). Края деталей садятся точно на контур лекала."""
    by = {i["id"]: i for i in its}
    out = np.zeros((len(UV), 2)); snapped = 0
    for k, p in enumerate(pcs):
        sel = np.where(loop_piece == k)[0]
        if not len(sel): continue
        i = by[p["id"]]; old, new = correspondence(p, i)
        X = mvc(UV[sel], old, new)
        poly = Polygon(sheet_ring(i, 0.002)); ext = poly.exterior
        pts = shapely.points(X)
        edge = np.isin(sel, edge_loops)                             # вершины внешнего края детали — на контур лекала
        d = shapely.distance(ext, pts)
        move = (~shapely.contains(poly, pts)) | (edge & (d < 1.5))
        if move.any():
            proj = shapely.line_interpolate_point(ext, shapely.line_locate_point(ext, pts[move]))
            X[move] = np.column_stack([shapely.get_x(proj), shapely.get_y(proj)]); snapped += int(move.sum())
        out[sel] = X
    return out, snapped


def seam_fix(pcs, its, X, V, tl, tv, loop_piece, owner, band=4.0):
    """Развёртка у швов — по лекалам (после remap). В модели шов — одна линия, а на развёртке её точки у одной детали
    бывают в два столбика: край детали и ряд внутри, до 9 мм от него (полоска между ними в 3D нулевой ширины). remap
    сажал на контур только край, поэтому на модели у шва пропадает до 9 мм картинки, и через шов видна ступенька;
    к тому же точки двух сшиваемых краёв стояли на лекалах по-разному (до 6 мм). Здесь каждая точка шва (бок, плечо,
    нижний шов рукава) встаёт на свой срез лекала по той же доле длины шва, что и парная точка соседней детали, — как
    при шитье по надсечкам; сдвиг плавно гасится внутрь детали (гармонически, на полосе band см). Лекала не меняются.
    Возвращает новую развёртку и журнал."""
    from scipy.spatial import cKDTree
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve
    from shapely.geometry import LineString, Point
    lv = np.empty(len(X), int); lv[tl.ravel()] = tv.ravel()
    kind = [p["kind"] for p in pcs]; by = {i["id"]: i for i in its}
    used = np.unique(tl.ravel())
    cand = used[np.array([kind[loop_piece[l]] != "trim" for l in used])]
    cp = cKDTree(V[lv[cand]]).query_pairs(1e-3, output_type="ndarray")                              # одна точка модели (до 1 мм)
    raw_all = [(int(cand[a]), int(cand[b])) for a, b in cp]
    dist = np.linalg.norm(V[lv[cand[cp[:, 0]]]] - V[lv[cand[cp[:, 1]]]], axis=1) if len(cp) else []
    # У подмышки сетка частая: в 1 мм от точки бывает несколько точек другого края, в том числе соседних по шву.
    # Пара шва — только ближайшие для обеих точек (с запасом 0,2 мм: несколько совпадающих точек одной детали — все пары);
    # на той же детали отдельно дальний край (шов рукава) и подгибка рядом.
    grp = lambda l, m: (int(loop_piece[m]), bool(np.linalg.norm(X[l] - X[m]) >= 8) if loop_piece[l] == loop_piece[m] else None)
    best = {}
    for (a, b), d in zip(raw_all, dist):
        for l, m in ((a, b), (b, a)):
            k = (l, grp(l, m)); best[k] = min(best.get(k, 1.0), d)
    raw = [(a, b) for (a, b), d in zip(raw_all, dist) if d <= best[(a, grp(a, b))] + 2e-4 and d <= best[(b, grp(b, a))] + 2e-4]
    # подгибка низа: деталь сшита сама с собой в 1,5–8 см; полоса подгибки внутри вещи, точки швов в ней не берутся
    folds = {}
    for la, lb in raw_all:
        k = int(loop_piece[la]); dd = float(np.linalg.norm(X[la] - X[lb]))
        if k == int(loop_piece[lb]) and 1.5 <= dd < 8: folds.setdefault(k, []).append(LineString([X[la], X[lb]]))
    fz = {k: shapely.union_all(v).buffer(0.4) for k, v in folds.items()}
    fw = {k: max(g.length for g in v) for k, v in folds.items()}                 # ширина подгибки детали, см
    in_fold = lambda l: int(loop_piece[l]) in fz and fz[int(loop_piece[l])].contains(Point(X[l]))
    # Каждая пара — на своём срезе лекал: бок (side), плечо (sh), нижний шов рукава (under); доля длины — вдоль среза.
    segs, hems = {}, {}
    for k, p in enumerate(pcs):
        it = by[p["id"]]
        segs[k] = [(nm, LineString(on_sheet(it, S))) for nm, kd, S in it["segs"] if nm[:-1] in ("side", "sh", "under")]
        hems[k] = [LineString(on_sheet(it, S)) for nm, kd, S in it["segs"] if nm.startswith("hem")]
    # у среза низа край загнут внутрь — подгибка: там края сходятся крест-накрест, эти точки не трогаем
    at_hem = lambda l: any(h.distance(Point(X[l])) < fw.get(int(loop_piece[l]), 0) + 0.3 for h in hems[int(loop_piece[l])])
    def seg_of(k, l):
        # точка шва — у самого среза (внутренний ряд у края — до 1,2 см) и напротив него, а не за его концом (там уже низ)
        if not segs[k]: return None
        q = Point(X[l]); dd = [g.distance(q) for _, g in segs[k]]; i = int(np.argmin(dd))
        t = segs[k][i][1].project(q, normalized=True)
        return segs[k][i][0] if dd[i] < 0.2 or (dd[i] < 1.2 and 0.005 < t < 0.995) else None
    by_seg = {}
    for la, lb in raw:
        ka, kb = int(loop_piece[la]), int(loop_piece[lb])
        if kind[ka] != kind[kb]: continue                                   # пройма (тело — рукав) не трогается
        if ka == kb and np.linalg.norm(X[la] - X[lb]) < 8: continue          # та же точка детали или подгибка
        if in_fold(la) or in_fold(lb) or at_hem(la) or at_hem(lb): continue
        sa, sb = seg_of(ka, la), seg_of(kb, lb)
        if not sa or not sb or (ka == kb and sa == sb): continue
        if (ka, sa) > (kb, sb): la, lb, ka, kb, sa, sb = lb, la, kb, ka, sb, sa
        by_seg.setdefault((ka, sa, kb, sb), []).append((la, lb))
    target, log = {}, []
    cen = {k: sheet_ring(by[p["id"]]).mean(0) for k, p in enumerate(pcs)}                     # середина детали на листе
    for (ka, na, kb, nb), C in by_seg.items():
        if len(C) < 6: continue
        Ga = dict(segs[ka])[na]; Gb = dict(segs[kb])[nb]
        name = "%s.%s>%s.%s" % (pcs[ka]["id"], na, pcs[kb]["id"], nb)
        if abs(Ga.length - Gb.length) > 0.08 * max(Ga.length, Gb.length):
            log.append("%s: срезы %.1f и %.1f см — не трогаю" % (name, Ga.length, Gb.length)); continue
        fa = np.array([Ga.project(Point(X[la]), normalized=True) for la, _ in C])
        fb = np.array([Gb.project(Point(X[lb]), normalized=True) for _, lb in C])
        flip = np.corrcoef(fa, fb)[0, 1] < 0
        if flip: fb = 1 - fb
        # пары, которые расходятся по длине сильнее прочих, — не шов (складка сетки у края), их не трогаем
        r = np.abs(fa - fb) * Ga.length
        ok = r <= max(1.0, 3 * float(np.median(r)))
        if ok.sum() < 6: continue
        C = [c for c, o in zip(C, ok) if o]; fa, fb, r0 = fa[ok], fb[ok], float(r.max())
        # порядок пар вдоль шва — по 3D-модели (там шов гладкий), доли длины — средние двух срезов
        Q = V[lv[[la for la, _ in C]]]; dvec = np.linalg.svd(Q - Q.mean(0))[2][0]; t = (Q - Q.mean(0)) @ dvec
        u = (fa + fb) / 2
        if np.corrcoef(t, u)[0, 1] < 0: t = -t
        u = np.sort(u)[np.argsort(np.argsort(t))]
        # Точка встаёт на срез; если она в модели не на самом шве, а на расстоянии d от парной точки (внутренний ряд у края,
        # полоска шириной ~1 мм) — на столько же внутрь детали: полоска сохраняет свою настоящую ширину, а не сплющивается.
        def put(G, k, ff, d):
            pt_ = G.interpolate(ff, normalized=True); q0 = G.interpolate(max(0, ff - 0.01), normalized=True); q1 = G.interpolate(min(1, ff + 0.01), normalized=True)
            tx_, ty_ = q1.x - q0.x, q1.y - q0.y; tl_ = np.hypot(tx_, ty_) or 1; nx_, ny_ = -ty_ / tl_, tx_ / tl_
            if (cen[k][0] - pt_.x) * nx_ + (cen[k][1] - pt_.y) * ny_ < 0: nx_, ny_ = -nx_, -ny_
            return (pt_.x + nx_ * d, pt_.y + ny_ * d)
        for (la, lb), f in zip(C, u):
            d3 = float(np.linalg.norm(V[lv[la]] - V[lv[lb]])) * 100
            pa = put(Ga, ka, f, d3); pb = put(Gb, kb, 1 - f if flip else f, d3)
            if max(np.hypot(pa[0] - X[la, 0], pa[1] - X[la, 1]), np.hypot(pb[0] - X[lb, 0], pb[1] - X[lb, 1])) > 1.2: continue   # не та точка
            target.setdefault(la, []).append(pa); target.setdefault(lb, []).append(pb)
        log.append("%s: %d пар (отброшено %d), срез %.1f см, пары расходились по длине до %.1f мм" % (name, len(C), int((~ok).sum()), Ga.length, float(np.abs(fa - fb).max()) * Ga.length * 10))
    if not target: return X.copy(), log
    # узлы: углы граней одной детали в одной вершине и одной точке листа
    keys = {}
    node = np.full(len(X), -1)
    for l in used:
        k = (int(loop_piece[l]), int(lv[l]), int(round(X[l, 0] * 1000)), int(round(X[l, 1] * 1000)))
        node[l] = keys.setdefault(k, len(keys))
    nN = len(keys); NX = np.zeros((nN, 2)); NP = np.zeros(nN, int)
    NX[node[used]] = X[used]; NP[node[used]] = loop_piece[used]
    fix = {}
    for l, ts in target.items(): fix.setdefault(node[l], []).extend(ts)
    D = np.zeros((nN, 2)); isfix = np.zeros(nN, bool)
    for n, ts in fix.items(): D[n] = np.mean(ts, 0) - NX[n]; isfix[n] = True
    worst = float(np.linalg.norm(D[isfix], axis=1).max())
    # полоса у шва: узлы той же детали ближе band см к закреплённым; дальше — сдвиг ноль
    near = np.zeros(nN, bool)
    for k in set(NP[isfix].tolist()):
        f = np.where(isfix & (NP == k))[0]; m = np.where(NP == k)[0]
        dd, _ = cKDTree(NX[f]).query(NX[m]); near[m[dd < band]] = True
    # Сдвиг точек шва расходится по полосе плавно: сдвиг каждой точки полосы — взвешенное среднее сдвигов соседей с весами
    # средних значений по самой 3D-форме (по настоящим расстояниям ткани). Края полосы не двигаются, точки шва — на
    # своих местах. Нулевые в 3D треугольники (полоска у шва) в веса не идут.
    N3 = np.zeros((nN, 3)); N3[node[used]] = V[lv[used]]
    T = node[tl]; P3n = N3[T]
    a3n = np.linalg.norm(np.cross(P3n[:, 1] - P3n[:, 0], P3n[:, 2] - P3n[:, 0]), axis=1)
    okt = (a3n > 1e-10) & (T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])
    rr, cc, ww = [], [], []
    for kk in range(3):
        i, j, l = T[okt, kk], T[okt, (kk + 1) % 3], T[okt, (kk + 2) % 3]
        e1, e2 = N3[j] - N3[i], N3[l] - N3[i]; n1, n2 = np.linalg.norm(e1, axis=1), np.linalg.norm(e2, axis=1)
        th = np.arccos(np.clip((e1 * e2).sum(1) / np.maximum(n1 * n2, 1e-15), -1, 1)); t2 = np.tan(th / 2)
        rr += [i, i]; cc += [j, l]; ww += [t2 / np.maximum(n1, 1e-12), t2 / np.maximum(n2, 1e-12)]
    # и слабые равные веса по всем рёбрам — чтобы узел, у которого все треугольники нулевые, тоже встал на место
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); E = E[E[:, 0] != E[:, 1]]; E = np.unique(np.sort(E, 1), axis=0)
    eps = 1e-3 * float(np.median(np.concatenate(ww)))
    rr = np.concatenate(rr + [E[:, 0], E[:, 1]]); cc = np.concatenate(cc + [E[:, 1], E[:, 0]]); ww = np.concatenate(ww + [np.full(len(E) * 2, eps)])
    free = near & ~isfix
    nf = int(free.sum()); idx = -np.ones(nN, int); idx[free] = np.arange(nf)
    U0 = D.copy()                                                            # сдвиг: у шва — до своего места на срезе, вне полосы — ноль
    sel = free[rr]
    rf, cf, wf = rr[sel], cc[sel], ww[sel]
    diag = np.bincount(idx[rf], weights=wf, minlength=nf)
    inner = free[cf]
    rows = np.concatenate([np.arange(nf), idx[rf[inner]]]); cols = np.concatenate([np.arange(nf), idx[cf[inner]]])
    vals = np.concatenate([diag, -wf[inner]])
    rhs = np.zeros((nf, 2))
    np.add.at(rhs, idx[rf[~inner]], wf[~inner, None] * U0[cf[~inner]])
    if nf:
        M = coo_matrix((vals, (rows, cols)), shape=(nf, nf)).tocsr()
        U0[free, 0] = spsolve(M, rhs[:, 0]); U0[free, 1] = spsolve(M, rhs[:, 1])
    Y = X.copy(); Y[used] = X[used] + U0[node[used]]
    # точки, которых сдвиг вынес за контур лекала, — обратно на контур (иначе на модели у шва цвет ткани вместо картинки)
    out_n = 0
    for k, p in enumerate(pcs):
        sel_ = used[loop_piece[used] == k]
        if not len(sel_): continue
        poly = Polygon(sheet_ring(by[p["id"]], 0.002)); ext = poly.exterior; pts = shapely.points(Y[sel_])
        mv = ~shapely.contains(poly, pts) & (shapely.distance(ext, pts) > 0.002)
        if mv.any():
            pr = shapely.line_interpolate_point(ext, shapely.line_locate_point(ext, pts[mv]))
            Y[sel_[mv]] = np.column_stack([shapely.get_x(pr), shapely.get_y(pr)]); out_n += int(mv.sum())
    if out_n: log.append("за контур вышло и возвращено на него точек: %d" % out_n)
    # проверка: сколько видимых граней (не нулевых в 3D) перевернулось
    ar = lambda P: (P[:, 1, 0] - P[:, 0, 0]) * (P[:, 2, 1] - P[:, 0, 1]) - (P[:, 1, 1] - P[:, 0, 1]) * (P[:, 2, 0] - P[:, 0, 0])
    P3 = V[tv]; a3 = np.linalg.norm(np.cross(P3[:, 1] - P3[:, 0], P3[:, 2] - P3[:, 0]), axis=1)
    A0, A1 = ar(X[tl]), ar(Y[tl])
    sgn = np.array([np.sign(np.sum(np.sign(A0[owner == k]))) or 1.0 for k in range(len(pcs))])
    s0, s1 = A0 * sgn[owner], A1 * sgn[owner]
    vis = a3 > 0.05 * np.median(a3)
    newflip = int(((s0 > 0) & (s1 <= 0) & vis).sum()); fixed = int(((s0 <= 0) & (s1 > 0) & vis).sum())
    log.append("точки шва сдвинуты до %.1f мм; видимых граней перевернулось %d, расправилось %d" % (worst * 10, newflip, fixed))
    return Y, log


# ---------- файлы под раскрой ----------
NAMES_EN = dict(front="FRONT", back="BACK", sleeve_l="SLEEVE LEFT", sleeve_r="SLEEVE RIGHT")
def cut_files(path, title, size, its, W, H, pat, names, fx, allow):
    """Лекала в натуральную величину: SVG (для печати и вёрстки нанесения) и DXF (для раскройного плоттера и САПР).
    Линия реза — с припусками, линия шва — контур готовой детали. Единицы — миллиметры."""
    al = dict(allow)
    svg = {k: [] for k in ("cut", "sew", "fold", "mark", "text")}; dxf = []
    def pl(layer, P, closed=True):
        dxf.append("0\nPOLYLINE\n8\n%s\n66\n1\n70\n%d" % (layer, 1 if closed else 0))
        for x, y in P: dxf.append("0\nVERTEX\n8\n%s\n10\n%.3f\n20\n%.3f" % (layer, x * 10, (H - y) * 10))
        dxf.append("0\nSEQEND")
    path_d = lambda P, closed=True: "M" + " L".join("%.2f %.2f" % (x * 10, y * 10) for x, y in P) + (" Z" if closed else "")
    for i in its:
        q = i["q"]; nm = names[i["id"]]
        if q["kind"] == "trim":
            # Полоса отделки (бейка, манжета, пояс) складывается вдоль пополам: кроится вдвое шире готовой. Верхняя половина —
            # лицевая (на ней нанесение из конструктора), нижняя уходит внутрь; между ними линия сгиба.
            x0, x1 = i["ox"] + i["lo"][0], i["ox"] + i["hi"][0]; y0, y1 = i["oy"] - i["hi"][1], i["oy"] - i["lo"][1]; a = al["strip"]; h = y1 - y0
            sew = np.array([[x0, y0], [x1, y0], [x1, y1 + h], [x0, y1 + h]])
            cut = np.array([[x0 - a, y0 - a], [x1 + a, y0 - a], [x1 + a, y1 + h + a], [x0 - a, y1 + h + a]])
            fold = [[x0 - a, y1], [x1 + a, y1]]
            svg["fold"].append('<path d="%s"/>' % path_d(fold, False)); pl("FOLD", fold, False)
        else:
            sew = sheet_ring(i, 0.002); cut = compact(on_sheet(i, offset_ring(i["segs"], al)), 0.002)
        svg["cut"].append('<path d="%s"/>' % path_d(cut)); svg["sew"].append('<path d="%s"/>' % path_d(sew))
        pl("CUT", cut); pl("SEW", sew)
        for pt, n, kind in notches(pat, i["id"], fx.get(i["id"], 1)):
            a = on_sheet(i, [pt])[0]; b = on_sheet(i, [pt + n * al[kind]])[0]
            svg["mark"].append('<path d="%s"/>' % path_d([a, b], False)); pl("NOTCH", [a, b], False)
        cx = i["ox"] + (i["lo"][0] + i["hi"][0]) / 2; cy = i["oy"] - (i["lo"][1] + i["hi"][1]) / 2
        if q["kind"] != "trim":                                     # долевая нить — вдоль детали
            g = i["h"] * 0.22; gx = cx + i["w"] * 0.25
            for P in ([[gx, cy - g], [gx, cy + g]], [[gx - 0.5, cy - g + 1], [gx, cy - g], [gx + 0.5, cy - g + 1]], [[gx - 0.5, cy + g - 1], [gx, cy + g], [gx + 0.5, cy + g - 1]]):
                svg["mark"].append('<path d="%s"/>' % path_d(P, False)); pl("GRAIN", P, False)
            svg["text"].append('<text x="%.1f" y="%.1f" text-anchor="middle" font-size="9" font-weight="700">%s</text>' % (cx * 10, cy * 10, nm))
            svg["text"].append('<text x="%.1f" y="%.1f" text-anchor="middle" font-size="6">размер %s · %d × %d мм · 1 деталь</text>' % (cx * 10, cy * 10 + 10, size, round(i["w"] * 10), round(i["h"] * 10)))
            dxf.append("0\nTEXT\n8\nTEXT\n10\n%.2f\n20\n%.2f\n40\n8\n1\n%s %s" % ((cx - 4) * 10, (H - cy) * 10, NAMES_EN.get(i["id"], i["id"].upper()), size))
        else:
            cy += i["h"] / 2
            svg["text"].append('<text x="%.1f" y="%.1f" font-size="5" dominant-baseline="middle">%s · %s · в готовом виде %d × %d мм, крой %d × %d мм со сгибом вдоль</text>' % (
                (i["ox"] + i["hi"][0] + 1.5) * 10, cy * 10, nm, size, round(i["w"] * 10), round(i["h"] * 10), round((i["w"] + 2 * al["strip"]) * 10), round((2 * i["h"] + 2 * al["strip"]) * 10)))
            dxf.append("0\nTEXT\n8\nTEXT\n10\n%.2f\n20\n%.2f\n40\n5\n1\n%s %s FOLD" % ((i["ox"] + i["hi"][0] + 1.5) * 10, (H - cy) * 10 - 2.5, i["id"].upper(), size))
    note = "Izum · %s · размер %s · сплошная линия — рез, пунктир — шов, штрихпунктир — сгиб · припуски: швы %d мм, низ %d мм, низ рукава %d мм, горловина %d мм, отделка %d мм" % (
        title, size, al["seam"] * 10, (al["seam"] if pat["bands"]["hem"] else al["hem"]) * 10, (al["seam"] if pat["bands"]["cuff"] else al["sleeve_hem"]) * 10, al["neck"] * 10, al["strip"] * 10)
    Hs = H + 1.5
    with open(path + ".svg", "w", encoding="utf-8") as fh:
        fh.write('<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">\n<title>%s</title>\n' % (W * 10, Hs * 10, W * 10, Hs * 10, note))
        fh.write('<g id="cut" fill="none" stroke="#000" stroke-width="0.35">\n%s\n</g>\n' % "\n".join(svg["cut"]))
        fh.write('<g id="sew" fill="none" stroke="#0a6fc2" stroke-width="0.25" stroke-dasharray="4 2.5">\n%s\n</g>\n' % "\n".join(svg["sew"]))
        fh.write('<g id="fold" fill="none" stroke="#c2410c" stroke-width="0.25" stroke-dasharray="6 2 1 2">\n%s\n</g>\n' % "\n".join(svg["fold"]))
        fh.write('<g id="marks" fill="none" stroke="#000" stroke-width="0.3">\n%s\n</g>\n' % "\n".join(svg["mark"]))
        fh.write('<g id="text" font-family="Arial, sans-serif" fill="#000">\n%s\n<text x="%.1f" y="%.1f" font-size="5">%s</text>\n</g>\n</svg>\n' % ("\n".join(svg["text"]), MARGIN * 10, (Hs - 1.2) * 10, note))
    layers = [("CUT", 7), ("SEW", 5), ("FOLD", 6), ("NOTCH", 1), ("GRAIN", 3), ("TEXT", 2)]
    head = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n%d\n" % len(layers)
    head += "".join("0\nLAYER\n2\n%s\n70\n0\n62\n%d\n6\nCONTINUOUS\n" % l for l in layers) + "0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n"
    with open(path + ".dxf", "w", encoding="ascii", newline="\r\n") as fh:
        fh.write(head + "\n".join(dxf) + "\n0\nENDSEC\n0\nEOF\n")
