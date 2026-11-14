# Размерный ряд и лекала для изделий, собранных в Marvelous Designer по чертежам md/garments/<вещь>_geo.py
# (худи, свитшот, поло, бомбер). Вызывается из tools/build_model_md.py после выгрузки 3D-модели.
#
# Чертёж параметрический: изделие задано мерками (md/garments/*_geo.py, SIZES). Другой размер — это те же построения
# с мерками, сдвинутыми на приращения STEP. Детали нового размера считаются заново, а не растягиваются.
# Кривые — естественный кубический сплайн через точки чертежа с параметром по длине хорд: так их строит сама программа
# (сверено с краем сетки выгруженных моделей: расхождение 0,0 мм на всех деталях худи, поло и бомбера).
# Сама 3D-модель одна: мужская собрана по меркам размера L, женская — M (BASE); на других размерах она растягивается.
#
# ВАЖНО: приращения STEP — типовая градация трикотажа, те же числа, что у футболок (tools/pattern.py, GRADE), а не табель
# мер Izum; мерки базового размера — мои, по ним собраны модели. Перед запуском в работу всё это должен сверить технолог.
import os, sys, json, math, importlib.util
import numpy as np

sys.dont_write_bytecode = True                    # без __pycache__ в папке сайта

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
MD = os.path.join(os.path.dirname(SITE), "md")
SIZES = ["S", "M", "L", "XL", "XXL", "XXXL"]
BASE = {"men": "L", "women": "M"}
# Приращения мерок чертежа на один размер, мм. chest — ширина детали по груди (полуобхват), sh — от середины до плечевой
# точки, bicep — ширина рукава под проймой, arm — глубина проймы от высшей точки плеча.
STEP = {
    "men": dict(chest=30, length=20, neck=5, fneck=3, bneck=1, sh=10, arm=10, bicep=17.5, sleeve=10, wrist=6, cuff_w=6,
                hem_w=26, hood_h=5, hood_d=4, pk_w=10, pk_top=6, pk_h=4),
    "women": dict(chest=25, length=15, neck=4, fneck=3, bneck=1, sh=7.5, arm=8, bicep=15, sleeve=8, wrist=5, cuff_w=5,
                  hem_w=22, hood_h=4, hood_d=3, pk_w=8, pk_top=5, pk_h=3),
}
# У поло рукав короткий: длина растёт как у футболки, низ рукава — вместе с шириной рукава.
STEP_KIND = {"polo": {"men": dict(sleeve=6, wrist=17.5), "women": dict(sleeve=3, wrist=15)}}
# Припуски, см (как у футболок). face — подгибка лицевого края капюшона, entry — подгибка входа в карман: у них свои
# имена, потому что построение уголка подгибки из tools/pattern.py рассчитано на прямой низ с отвесными боками.
ALLOW = dict(seam=1.0, hem=2.5, sleeve_hem=2.0, neck=0.7, strip=0.7, face=2.5, entry=2.0)
GAP, TGAP, MARGIN = 5.0, 3.0, 3.5                                         # зазоры и поле листа раскроя, см
NAMES = dict(chest="Ширина по груди", length="Длина от плеча", hem="Ширина по низу", shoulders="Ширина по плечам",
             sleeve="Длина рукава от плеча", sleeve_w="Ширина рукава", cuff="Ширина манжеты", neck="Ширина горловины",
             hood="Высота капюшона", pocket="Ширина кармана", placket="Длина планки", collar="Высота воротника")


# ---------- чертёж ----------
def load(kind):
    spec = importlib.util.spec_from_file_location(kind + "_geo", os.path.join(MD, "garments", kind + "_geo.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def draft(mod, kind, gender, meas):
    """Чертёж изделия по заданным меркам (функция чертежа читает их из SIZES своего файла)."""
    saved = mod.SIZES; mod.SIZES = {gender: dict(meas)}
    try: return getattr(mod, kind)(gender)
    finally: mod.SIZES = saved


def spline(seq, step=2.0):
    """Кривая через точки участка (от угла до угла), как её строит Marvelous Designer; два угла подряд — прямая."""
    P = np.array(seq, float); n = len(P)
    if n == 2: return P
    t = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]); h = np.diff(t)
    A = np.zeros((n, n)); R = np.zeros((n, 2)); A[0, 0] = A[-1, -1] = 1
    for i in range(1, n - 1):
        A[i, i - 1] = h[i - 1]; A[i, i] = 2 * (h[i - 1] + h[i]); A[i, i + 1] = h[i]
        R[i] = 3 * ((P[i + 1] - P[i]) / h[i] - (P[i] - P[i - 1]) / h[i - 1])
    c = np.linalg.solve(A, R); out = []
    for i in range(n - 1):
        b = (P[i + 1] - P[i]) / h[i] - h[i] * (2 * c[i] + c[i + 1]) / 3; d = (c[i + 1] - c[i]) / (3 * h[i])
        for j in range(max(2, int(h[i] / step))):
            s = h[i] * j / max(2, int(h[i] / step)); out.append(P[i] + b * s + c[i] * s * s + d * s ** 3)
    out.append(P[-1])
    return np.array(out)


def arclen(P): return float(np.linalg.norm(np.diff(P, axis=0), axis=1).sum())
def near(a, b): return math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01


def segments(piece):
    """Срезы детали по обходу против часовой стрелки: [[имя среза, ломаная в мм]] (у каждого среза концы — углы детали)."""
    pts = piece["pts"]; n = len(pts); corners = [i for i in range(n) if pts[i][2] == 0]
    segs = []
    for k, a in enumerate(corners):
        b = corners[(k + 1) % len(corners)]; seq = [pts[a][:2]]; i = a
        while i != b: i = (i + 1) % n; seq.append(pts[i][:2])
        name = next((en for en, (ea, eb) in piece["edges"].items()
                     if (near(ea, seq[0]) and near(eb, seq[-1])) or (near(ea, seq[-1]) and near(eb, seq[0]))), "edge%d" % k)
        segs.append([name, spline(seq)])
    R = np.vstack([P[:-1] for _, P in segs]); x, y = R[:, 0], R[:, 1]
    if float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) < 0:          # начерчена по часовой — развернуть
        segs = [[nm, P[::-1]] for nm, P in reversed(segs)]
    return segs


def edge(piece, segs, name):
    """Срез в том направлении, в каком он записан в чертеже (доли швов считаются от его начала)."""
    P = dict(segs)[name]
    return P if near(P[0], piece["edges"][name][0]) else P[::-1]


def part(P, f0, f1, n=None):
    """Часть среза между долями длины f0 и f1 (f0 > f1 — в обратную сторону), n равноотстоящих точек."""
    d = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]); L = d[-1]
    n = n or max(4, int(abs(f1 - f0) * L / 7) + 1)
    s = np.linspace(f0 * L, f1 * L, n)
    return np.column_stack([np.interp(s, d, P[:, 0]), np.interp(s, d, P[:, 1])])


# ---------- градация ----------
def lengths(g):
    S = {n: segments(p) for n, p in g["pieces"].items()}
    L = lambda n, e: arclen(dict(S[n])[e])
    return S, L


def graded(mod, kind, gender, k, ref):
    """Мерки размера на k шагов больше базового. Окат рукава и низ капюшона подгоняются так, чтобы посадка
    (разница длин сшиваемых срезов) осталась такой же, как у базового размера."""
    base = dict(mod.SIZES[gender]); st = dict(STEP[gender]); st.update(STEP_KIND.get(kind, {}).get(gender, {}))
    m = dict(base)
    for key, d in st.items():
        if key in m: m[key] = base[key] + d * k
    if k == 0: return m

    def keep(key, diff, target, lo, hi):
        for _ in range(36):
            m[key] = (lo + hi) / 2
            if diff(draft(mod, kind, gender, m)) < target: lo = m[key]
            else: hi = m[key]
        m[key] = round(m[key], 1)
    if "cap_ease" in ref: keep("cap", cap_ease, ref["cap_ease"], 40.0, 240.0)
    if "hood_ease" in ref: keep("hood_neck", hood_ease, ref["hood_ease"], 120.0, 420.0)
    return m


def cap_ease(g):
    _, L = lengths(g)
    return L("sleeve_l", "cap") - L("front", "armhole_l") - L("back", "armhole_l")


def hood_ease(g):
    _, L = lengths(g)
    return L("hood_l", "neck") - (L("front", "neck") + L("back", "neck")) / 2


def measures(kind, m, g):
    """Табель мер готового изделия, см: (ключ, значение)."""
    box = lambda n: (max(q[0] for q in g["pieces"][n]["pts"]) - min(q[0] for q in g["pieces"][n]["pts"]))
    m = g["measures"]                                   # с высотой оката, которую подогнал сам чертёж
    band = m.get("hem_h", 0)
    cuff_h = m.get("cuff_h", m.get("band_h", 0))
    out = [("chest", m["chest"]), ("length", m["length"] + band),
           ("hem", m["hem_w"] if "hem_w" in m else box("hem") / 2 if "hem" in g["pieces"] else m["chest"]),
           ("shoulders", 2 * m["sh"]), ("sleeve", m["cap"] + m["sleeve"] + cuff_h), ("sleeve_w", m["bicep"]),
           ("cuff", m["cuff_w"] if "cuff_w" in m else box("band_l")), ("neck", m["neck"])]
    if kind == "hoodie": out += [("hood", m["hood_h"]), ("pocket", m["pk_w"])]
    if kind == "polo": out += [("placket", m["pl_h"])]
    if kind == "bomber": out += [("collar", m["collar_h"])]
    return [(k, round(v / 10, 1)) for k, v in out]


# ---------- припуски и файлы раскроя ----------
def allow_kind(kind, geo, name):
    """Какой припуск у среза: шов, подгибка низа, подгибка входа в карман, горловина, отделка."""
    if geo in ("front", "back", "front_l", "front_r"):
        return "neck" if name == "neck" else "hem" if name == "bottom" and kind == "polo" else "seam"
    if geo.startswith("sleeve"): return "seam"
    if geo.startswith("hood"): return "face" if name == "face" else "seam"
    if geo == "pocket": return "entry" if name.startswith("open") else "seam"
    return "strip"


def folded(geo):
    """Полоса из рибаны, которая кроится вдвое шире готовой и складывается вдоль: манжеты, пояс, бейка, воротник бомбера."""
    return geo.startswith(("cuff", "band", "hem", "neckband")) or geo == "collar"


def notch_marks(g):
    """Надсечки: точки, где внутри среза сходятся швы (середина оката, плечевые точки на бейке, воротнике и поясе).
    {деталь: [(срез, доля длины)]}"""
    out = {}
    for A, ea, a0, a1, B, eb, b0, b1 in g["seams"]:
        for n, e, fs in ((A, ea, (a0, a1)), (B, eb, (b0, b1))):
            if e.startswith("@"): continue
            for f in fs:
                if 0.02 < f < 0.98: out.setdefault(n, set()).add((e, round(float(f), 4)))
    return out


def cut_files(path, title, size, kind, g, S, info):
    """Лекала в натуральную величину: SVG и DXF, слои как у футболок (CUT — рез, SEW — шов, FOLD — сгиб, NOTCH, GRAIN, TEXT)."""
    sys.path.insert(0, HERE)
    import pattern as pt
    items = []
    for geo, p in g["pieces"].items():
        if geo not in info: continue
        segs = [(nm, allow_kind(kind, geo, nm), P / 10.0) for nm, P in S[geo]]
        R = np.vstack([s[2][:-1] for s in segs]); lo, hi = R.min(0), R.max(0)
        items.append(dict(geo=geo, id=info[geo]["id"], name=info[geo]["name"], kind=info[geo]["kind"], segs=segs, lo=lo, hi=hi,
                          w=float(hi[0] - lo[0]), h=float(hi[1] - lo[1]), fold=folded(geo)))
    rows = [[i for i in items if i["kind"] == k] for k in ("body", "sleeve", "part")]
    rows += [[i] for i in items if i["kind"] == "trim"]          # полосы отделки — по одной в ряд: подпись стоит справа от полосы
    y = MARGIN
    for row in rows:
        if not row: continue
        trim = row[0]["kind"] == "trim"; gap = TGAP if trim else GAP; x = MARGIN
        for i in row:
            i["ox"] = float(x - i["lo"][0]); i["oy"] = float(y + i["hi"][1]); x += i["w"] + gap
        y += max(i["h"] * (2 if i["fold"] else 1) for i in row) + gap
    W = max(i["ox"] + i["hi"][0] for i in items) + MARGIN
    H = max(i["oy"] - i["lo"][1] + (i["h"] if i["fold"] else 0) for i in items) + MARGIN
    marks = notch_marks(g)
    svg = {k: [] for k in ("cut", "sew", "fold", "mark", "text")}; dxf = []

    def pl(layer, P, closed=True):
        dxf.append("0\nPOLYLINE\n8\n%s\n66\n1\n70\n%d" % (layer, 1 if closed else 0))
        for x, y in P: dxf.append("0\nVERTEX\n8\n%s\n10\n%.3f\n20\n%.3f" % (layer, x * 10, (H - y) * 10))
        dxf.append("0\nSEQEND")
    path_d = lambda P, closed=True: "M" + " L".join("%.2f %.2f" % (x * 10, y * 10) for x, y in P) + (" Z" if closed else "")
    for i in items:
        if i["fold"]:
            # Полоса складывается вдоль пополам: кроится вдвое шире готовой. Верхняя половина — лицевая, нижняя уходит внутрь.
            x0, x1 = i["ox"] + i["lo"][0], i["ox"] + i["hi"][0]; y0, y1 = i["oy"] - i["hi"][1], i["oy"] - i["lo"][1]; a = ALLOW["strip"]; h = y1 - y0
            sew = np.array([[x0, y0], [x1, y0], [x1, y1 + h], [x0, y1 + h]])
            cut = np.array([[x0 - a, y0 - a], [x1 + a, y0 - a], [x1 + a, y1 + h + a], [x0 - a, y1 + h + a]])
            fold = [[x0 - a, y1], [x1 + a, y1]]
            svg["fold"].append('<path d="%s"/>' % path_d(fold, False)); pl("FOLD", fold, False)
        else:
            sew = pt.sheet_ring(i, 0.002); cut = pt.compact(pt.on_sheet(i, pt.offset_ring(i["segs"], ALLOW)), 0.002)
        svg["cut"].append('<path d="%s"/>' % path_d(cut)); svg["sew"].append('<path d="%s"/>' % path_d(sew))
        pl("CUT", cut); pl("SEW", sew)
        for en, f in sorted(marks.get(i["geo"], ())):
            P = edge(g["pieces"][i["geo"]], S[i["geo"]], en) / 10.0; q = part(P, max(0.0, f - 0.01), min(1.0, f + 0.01), 3)
            ccw = dict((s[0], s[2]) for s in i["segs"])[en]; same = near(ccw[0] * 10, P[0] * 10)
            d = (q[2] - q[0]) * (1 if same else -1); d /= max(np.linalg.norm(d), 1e-9); nrm = np.array([d[1], -d[0]])
            al = ALLOW["strip"] if i["fold"] else ALLOW[allow_kind(kind, i["geo"], en)]
            if i["fold"]:                              # у сложенной полосы пришивается весь край: надсечка на верхнем крае
                a = np.array([i["ox"] + q[1][0], i["oy"] - i["hi"][1]]); b = a - [0, al]
            else:
                a = pt.on_sheet(i, [q[1]])[0]; b = pt.on_sheet(i, [q[1] + nrm * al])[0]
            svg["mark"].append('<path d="%s"/>' % path_d([a, b], False)); pl("NOTCH", [a, b], False)
        cx = i["ox"] + (i["lo"][0] + i["hi"][0]) / 2; cy = i["oy"] - (i["lo"][1] + i["hi"][1]) / 2
        if i["kind"] != "trim":                         # долевая нить — вдоль детали
            gl = i["h"] * 0.22; gx = cx + i["w"] * 0.25
            for P in ([[gx, cy - gl], [gx, cy + gl]], [[gx - 0.5, cy - gl + 1], [gx, cy - gl], [gx + 0.5, cy - gl + 1]], [[gx - 0.5, cy + gl - 1], [gx, cy + gl], [gx + 0.5, cy + gl - 1]]):
                svg["mark"].append('<path d="%s"/>' % path_d(P, False)); pl("GRAIN", P, False)
            fs = 9 if i["w"] > 30 else 6
            svg["text"].append('<text x="%.1f" y="%.1f" text-anchor="middle" font-size="%d" font-weight="700">%s</text>' % (cx * 10, cy * 10, fs, i["name"]))
            svg["text"].append('<text x="%.1f" y="%.1f" text-anchor="middle" font-size="%d">размер %s · %d × %d мм · 1 деталь</text>' % (cx * 10, cy * 10 + fs + 1, fs - 3, size, round(i["w"] * 10), round(i["h"] * 10)))
            dxf.append("0\nTEXT\n8\nTEXT\n10\n%.2f\n20\n%.2f\n40\n8\n1\n%s %s" % ((cx - 4) * 10, (H - cy) * 10, i["id"].upper(), size))
        else:
            ty = cy + (i["h"] / 2 if i["fold"] else 0)
            how = "в готовом виде %d × %d мм, крой %d × %d мм со сгибом вдоль" % (round(i["w"] * 10), round(i["h"] * 10), round((i["w"] + 2 * ALLOW["strip"]) * 10), round((2 * i["h"] + 2 * ALLOW["strip"]) * 10)) if i["fold"] \
                else "%d × %d мм, припуск %d мм" % (round(i["w"] * 10), round(i["h"] * 10), ALLOW["strip"] * 10)
            svg["text"].append('<text x="%.1f" y="%.1f" font-size="5" dominant-baseline="middle">%s · %s · %s</text>' % ((i["ox"] + i["hi"][0] + 1.5) * 10, ty * 10, i["name"], size, how))
            dxf.append("0\nTEXT\n8\nTEXT\n10\n%.2f\n20\n%.2f\n40\n5\n1\n%s %s%s" % ((i["ox"] + i["hi"][0] + 1.5) * 10, (H - ty) * 10 - 2.5, i["id"].upper(), size, " FOLD" if i["fold"] else ""))
    note = "Izum · %s · размер %s · сплошная линия — рез, пунктир — шов, штрихпунктир — сгиб · припуски: швы %d мм, подгибка низа и края капюшона %d мм, вход в карман %d мм, горловина %d мм, отделка %d мм" % (
        title, size, ALLOW["seam"] * 10, ALLOW["hem"] * 10, ALLOW["entry"] * 10, ALLOW["neck"] * 10, ALLOW["strip"] * 10)
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
    return W, H


# ---------- описание для конструктора ----------
def uv_frame(obj):
    """Где на текстуре лежит раскладка базового размера: наименьшие u, v и размах развёртки модели."""
    us, vs = [], []
    for line in open(obj, encoding="utf-8", errors="replace"):
        if line.startswith("vt "):
            p = line.split(); us.append(float(p[1])); vs.append(float(p[2]))
    return min(us), min(vs), max(us) - min(us), max(vs) - min(vs)


def build(kind, gender, mid, title):
    """Переписывает models/<id>.json в вид с размерным рядом и пишет models/lekala/<id>_<размер>.svg и .dxf."""
    from shapely.geometry import LineString
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    mod = load(kind); path = os.path.join(SITE, "models", mid + ".json")
    old = json.load(open(path, encoding="utf-8"))
    assert "pieces" in old and all("geo" in p for p in old["pieces"]), "нужно описание прежнего вида с именами деталей чертежа"
    assert not any(p.get("mir") for p in old["pieces"]), "зеркальная развёртка у чертёжной модели"
    info = {p["geo"]: p for p in old["pieces"]}
    g0 = draft(mod, kind, gender, mod.SIZES[gender]); ref = {}
    if kind in ("hoodie", "sweatshirt"): ref["cap_ease"] = cap_ease(g0)      # у поло и бомбера окат подгоняет сам чертёж
    if kind == "hoodie": ref["hood_ease"] = hood_ease(g0)
    k0 = SIZES.index(BASE[gender]); u0, v0, du, dv = uv_frame(os.path.join(MD, "export", "%s_%s.obj" % (kind, gender)))
    os.makedirs(os.path.join(SITE, "models", "lekala"), exist_ok=True)
    simp = lambda P: np.array(LineString(P).simplify(0.01, preserve_topology=False).coords)
    sizes = {}; ch0 = None; A = None
    for k, s in sorted(enumerate(SIZES), key=lambda t: t[0] != k0):           # базовый размер — первым
        m = graded(mod, kind, gender, k - k0, ref); g = draft(mod, kind, gender, m); S, L = lengths(g)
        allp = np.vstack([P for n in S for _, P in S[n]]); (x0, y0), (x1, y1) = allp.min(0), allp.max(0)
        if s == BASE[gender]:
            # Лист базового размера — сама текстура модели: раскладка чертежа лежит на ней в том же масштабе.
            mm_u = (x1 - x0) / du; A = mm_u / 10.0
            assert abs((y1 - y0) / dv / mm_u - 1) < 0.004, "раскладка чертежа не совпала с развёрткой модели: %.1f и %.1f мм на единицу" % (mm_u, (y1 - y0) / dv)
            bx, by = u0 * A, (1 - v0) * A; sheet = [round(A, 1), round(A, 1)]
        else:
            bx, by = MARGIN, MARGIN + (y1 - y0) / 10.0; sheet = [round((x1 - x0) / 10 + 2 * MARGIN, 1), round((y1 - y0) / 10 + 2 * MARGIN, 1)]
        on = lambda P: np.column_stack([bx + (P[:, 0] - x0) / 10.0, by - (P[:, 1] - y0) / 10.0])
        pieces = []
        for p in old["pieces"]:
            R = np.vstack([simp(on(P))[:-1] for _, P in S[p["geo"]]])
            rec = dict(id=p["id"], name=p["name"], kind=p["kind"], look=p["look"], twin=p["twin"],
                       w=round(float(np.ptp(R[:, 0])), 1), h=round(float(np.ptp(R[:, 1])), 1), outline=[[round(float(x), 2), round(float(y), 2)] for x, y in R])
            if p["kind"] == "sleeve": rec.update(fx=p["fx"], hem=p["hem"])
            pieces.append(rec)
        seams = []
        for a, ea, a0, a1, b, eb, b0, b1 in g["seams"]:
            if not ((ea.startswith("side") and eb.startswith("side")) or (a == b and ea.startswith("under"))): continue
            if a not in info or b not in info: continue
            PA = part(edge(g["pieces"][a], S[a], ea), a0, a1); PB = part(edge(g["pieces"][b], S[b], eb), b0, b1, len(PA))
            ia, ib = info[a]["id"], info[b]["id"]
            if ia > ib: ia, ib, PA, PB = ib, ia, PB, PA
            seams.append([ia, ib, [round(float(v), 2) for row in np.hstack([on(PA), on(PB)]) for v in row]])
        ms = measures(kind, m, g); ch = dict(ms)
        if ch0 is None: ch0 = ch
        sizes[s] = dict(sheet=sheet, k3=[round(ch["chest"] / ch0["chest"], 4), round(ch["length"] / ch0["length"], 4)], pieces=pieces, seams=seams, chart=[[k_, v] for k_, v in ms])
        W, H = cut_files(os.path.join(SITE, "models", "lekala", "%s_%s" % (mid, s)), title, s, kind, g, S, info)
        print("%-5s " % s + "  ".join("%s %.1f" % (NAMES[k_], v) for k_, v in ms[:5]) + "   лист раскроя %.0f × %.0f см" % (W, H))
    json.dump(dict(id=mid, title=title, atlas=round(A, 2), height=old["height"], base=BASE[gender], order=SIZES, source="drawing",
                   chart=[[k_, NAMES[k_]] for k_, _ in measures(kind, mod.SIZES[gender], g0)], allow=ALLOW,
                   sizes={s: sizes[s] for s in SIZES}), open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("%s: размеры %s (модель — %s), лист текстуры %.1f см, описание %.0f КБ, лекала — models/lekala/%s_<размер>.svg и .dxf" % (
        mid, "–".join((SIZES[0], SIZES[-1])), BASE[gender], A, os.path.getsize(path) / 1024, mid))


if __name__ == "__main__":
    build(*sys.argv[1:5])
