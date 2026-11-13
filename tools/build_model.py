# Модель для «Конструктора» из готового FBX с развёрткой по выкройке (Tex/3d model/*.fbx).
#   python -I tools/build_model.py "<файл.fbx>" <id> "<название>"
# Пишет models/<id>.glb и models/<id>.json: детали кроя (контур в сантиметрах на листе развёртки),
# их названия и с какой стороны изделия на них смотреть.
# Работает в два шага: Blender (без окна) приводит сетку к метрам, сглаживает и выгружает GLB и треугольники
# развёртки; затем этот же файл обычным Python находит детали по заливке развёртки — так внутренние швы
# и сдвоенные слои (подгибы) не дробят деталь на куски.
import sys, os, json, math, subprocess

BLENDER = r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(os.path.dirname(HERE), "models")


def in_blender():
    import bpy
    from mathutils import Vector
    src, out = sys.argv[sys.argv.index("--") + 1:][:2]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)
    ob = max((o for o in bpy.data.objects if o.type == "MESH"), key=lambda o: len(o.data.vertices))
    me = ob.data
    me.transform(ob.matrix_world)                       # размеры — в метрах, без масштаба родителя
    ob.parent = None; ob.matrix_world.identity()
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
    off = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)))
    for v in me.vertices: v.co -= off
    for p in me.polygons: p.use_smooth = True
    sub = ob.modifiers.new("sub", "SUBSURF"); sub.levels = 1; sub.render_levels = 1
    sub.uv_smooth = "PRESERVE_BOUNDARIES"
    fin = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    ob.modifiers.clear(); ob.data = fin
    for p in fin.polygons: p.use_smooth = True
    fin.calc_loop_triangles()
    uv = fin.uv_layers.active.data
    tris = []
    for t in fin.loop_triangles:
        a, b, c = (fin.vertices[i].co for i in t.vertices)
        m = (a + b + c) / 3
        tris.append([round(x, 5) for l in t.loops for x in uv[l].uv] + [round(x, 4) for x in (*m, *t.normal)] + [t.area])
    # Швы: одно и то же ребро изделия лежит на листе в двух местах. Записываются пары середин таких рёбер.
    import bmesh
    bm = bmesh.new(); bm.from_mesh(fin)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)      # на случай несваренных швов; сама модель не меняется
    uvl = bm.loops.layers.uv.active
    seams = []
    for e in bm.edges:
        ls = list(e.link_loops)
        if len(ls) < 2: continue
        v0 = e.verts[0]
        def ends(l):
            a, b = l[uvl].uv, l.link_loop_next[uvl].uv
            return (a, b) if l.vert == v0 else (b, a)
        for i in range(len(ls)):
            for j in range(i + 1, len(ls)):
                a0, a1 = ends(ls[i]); b0, b1 = ends(ls[j])
                if (a0 - b0).length < 1e-5 and (a1 - b1).length < 1e-5: continue
                ma, mb = (a0 + a1) / 2, (b0 + b1) / 2
                seams.append([round(ma.x, 5), round(ma.y, 5), round(mb.x, 5), round(mb.y, 5)])
    bm.free()
    json.dump(dict(tris=tris, seams=seams, height=max(v.co.z for v in fin.vertices), verts=len(fin.vertices)), open(out + ".tris.json", "w"))
    for o in list(bpy.data.objects):
        if o is not ob: bpy.data.objects.remove(o, do_unlink=True)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.gltf(filepath=out + ".glb", export_format="GLB", use_selection=True, export_materials="NONE",
                              export_yup=True, export_apply=True)


def main():
    import numpy as np, cv2
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    src, mid, title = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(MODELS, exist_ok=True)
    out = os.path.join(MODELS, mid)
    r = subprocess.run([BLENDER, "-b", "--python", os.path.abspath(__file__), "--", os.path.abspath(src), out],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not os.path.exists(out + ".tris.json"):
        print(r.stdout[-3000:], r.stderr[-2000:]); sys.exit("Blender не выгрузил модель")
    d = json.load(open(out + ".tris.json")); os.remove(out + ".tris.json")
    T = np.array(d["tris"], dtype=np.float64)
    uv = T[:, :6].reshape(-1, 3, 2); cen = T[:, 6:9]; nor = T[:, 9:12]; area = T[:, 12]
    e1, e2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
    suv = (e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) / 2      # со знаком: отрицательная — развёртка детали зеркальна
    auv = np.abs(suv)
    uvc = uv.mean(1)
    ok = auv > 1e-9
    # сантиметров в единице развёртки: по площади ткани против площади на листе (медиана по треугольникам)
    A = float(np.median(np.sqrt(area[ok] / auv[ok]))) * 100
    N = 4096
    px = np.round(np.stack([uv[..., 0] * (N - 1), (1 - uv[..., 1]) * (N - 1)], -1)).astype(np.int32)
    mask = np.zeros((N, N), np.uint8)
    for t in px: cv2.fillConvexPoly(mask, t, 255)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    # У моделей вдоль швов бывают тонкие «лоскутки» развёртки — вытянутые треугольники шириной 1–3 мм рядом с краем детали.
    # Если обводить и их, контур детали получается зубчатым. Размыкание срезает всё, что уже ~0,7 см; сами края деталей не сдвигаются.
    r = max(3, int(round(0.35 * (N - 1) / A)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cpx = px.mean(1).round().astype(int).clip(0, N - 1)
    comp = lab[cpx[:, 1], cpx[:, 0]]
    W = float(np.ptp(cen[:, 0])); H = float(d["height"])
    raw = []
    ENV = max(8, int(round(3.0 * (N - 1) / A)))            # радиус огибающей контура, 3 см
    KERN = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * ENV + 1, 2 * ENV + 1))
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < N * N * 0.0006: continue
        sel = comp == i
        if not sel.any() or area[sel].sum() <= 0: continue
        # Контур детали — гладкая огибающая её ткани. У развёрток, снятых с готовой 3D-формы, края деталей волнистые
        # (выступы и впадины до сантиметра вдоль швов); если обводить их точно, раскрой выглядит рваным. Замыкание кругом
        # 3 см перекрывает впадины, но чужую ткань в контур не берёт. Вся ткань детали остаётся внутри контура.
        x0, y0, bw, bh = (int(st[i, k]) for k in (cv2.CC_STAT_LEFT, cv2.CC_STAT_TOP, cv2.CC_STAT_WIDTH, cv2.CC_STAT_HEIGHT))
        pad = ENV + 3
        xa, ya, xb, yb = max(0, x0 - pad), max(0, y0 - pad), min(N, x0 + bw + pad), min(N, y0 + bh + pad)
        roi = lab[ya:yb, xa:xb]
        own = (roi == i).astype(np.uint8)
        env = cv2.morphologyEx(cv2.copyMakeBorder(own, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0), cv2.MORPH_CLOSE, KERN)[pad:-pad, pad:-pad].copy()
        env[cv2.dilate(((roi > 0) & (roi != i)).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0] = 0
        env[own > 0] = 1
        cs, _ = cv2.findContours(env, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE, offset=(xa, ya))
        c = max(cs, key=cv2.contourArea)
        c = cv2.approxPolyDP(c, max(2.0, 0.08 * (N - 1) / A), True)[:, 0, :]
        w = area[sel]
        (_, (rw, rh), _) = cv2.minAreaRect(c)
        short, long = sorted((rw, rh))
        # куда на изделии ведут оси листа: плоскость P = a + u*Pu + v*Pv по треугольникам детали
        X = np.column_stack([uvc[sel], np.ones(int(sel.sum()))])
        coef = np.linalg.lstsq(X * w[:, None], cen[sel] * w[:, None], rcond=None)[0]
        raw.append(dict(c=c, comp=i, m=(cen[sel] * w[:, None]).sum(0) / w.sum(), nrm=(nor[sel] * w[:, None]).sum(0) / w.sum(),
                        area=float(w.sum()), strip=short * A / N < 6 and long > 5 * short,
                        Pu=coef[0], sel=sel, mir=bool(suv[sel].sum() < 0)))
    big = sorted((p for p in raw if not p["strip"]), key=lambda p: -p["area"])
    assert len(big) >= 2, "не нашлись перед и спинка"
    # перед смотрит на зрителя (-Y в Blender); сторона +X модели — левая сторона изделия
    fb = sorted(big[:2], key=lambda p: p["nrm"][1])
    fb[0].update(id="front", name="Перед", look="front", twin="back", kind="body")
    fb[1].update(id="back", name="Спинка", look="back", twin="front", kind="body")
    for p in big[2:]:
        left = p["m"][0] > 0
        p.update(id="sleeve_l" if left else "sleeve_r", name="Левый рукав" if left else "Правый рукав",
                 look="left" if left else "right", twin="sleeve_r" if left else "sleeve_l", kind="sleeve")
    k = 0
    for p in sorted((q for q in raw if q["strip"]), key=lambda q: -q["m"][2]):
        k += 1; x, y, z = p["m"]
        if z > H * 0.78 and abs(x) < W * 0.22: nm, look = "Бейка горловины", "back" if y > 0 else "front"
        elif z < H * 0.16: nm, look = "Низ изделия", "back" if y > 0 else "front"
        elif abs(x) > W * 0.25: nm, look = ("Край левого рукава", "left") if x > 0 else ("Край правого рукава", "right")
        else: nm, look = "Отделка", "back" if y > 0 else "front"
        p.update(id="trim%d" % k, name=nm, look=look, twin=None, kind="trim")
    seen = {}
    for p in raw:                                      # одинаковые названия нумеруются
        seen.setdefault(p["name"], []).append(p)
    for nm, ps in seen.items():
        if len(ps) > 1:
            for j, p in enumerate(ps): p["name"] = "%s %d" % (nm, j + 1)
    order = {"body": 0, "sleeve": 1, "trim": 2}
    pieces = []
    for p in sorted(raw, key=lambda p: (order[p["kind"]], p["id"] != "front", p["id"])):
        pts = [[round(x / (N - 1) * A, 2), round((1 - y / (N - 1)) * A, 2)] for x, y in p["c"].tolist()]
        xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
        pieces.append(dict(id=p["id"], name=p["name"], kind=p["kind"], look=p["look"], twin=p["twin"],
                           w=round(max(xs) - min(xs), 1), h=round(max(ys) - min(ys), 1), outline=pts))
        extra = ""
        if p["kind"] == "sleeve":
            # fx: +1 — перед изделия справа на детали, -1 — слева (перед смотрит в -Y).
            # hem: с какой стороны детали низ рукава — тот край листа, который на изделии дальше от тела и ниже
            v = uvc[p["sel"]][:, 1]; c3 = cen[p["sel"]]; far = np.abs(c3[:, 0]) - c3[:, 2]
            hi, lo = v >= np.quantile(v, 0.85), v <= np.quantile(v, 0.15)
            pieces[-1].update(fx=1 if p["Pu"][1] < 0 else -1, hem="top" if far[hi].mean() > far[lo].mean() else "bottom")
            extra = "  перед %s, низ %s" % ("справа" if pieces[-1]["fx"] > 0 else "слева", "сверху" if pieces[-1]["hem"] == "top" else "снизу")
        if p["mir"]: pieces[-1]["mir"] = True; extra += "  РАЗВЁРТКА ЗЕРКАЛЬНА"
        print("%-9s %-22s %5.1f × %5.1f см  точек %d%s" % (p["id"], p["name"], pieces[-1]["w"], pieces[-1]["h"], len(pts), extra))
    # ---- швы между деталями: по ним нанесение продолжается с одной детали на соседнюю ----
    by_comp = {p["comp"]: p for p in raw}

    def comp_at(u, v):                                 # середина ребра лежит на самой границе детали — ищем ближайшую
        x, y = int(round(u * (N - 1))), int(round((1 - v) * (N - 1)))
        for r in range(0, 10):
            win = lab[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1]; nz = win[win > 0]
            if nz.size: return int(np.bincount(nz).argmax())
        return 0

    groups = {}
    for ua, va, ub, vb in d.get("seams", []):
        pa, pb = by_comp.get(comp_at(ua, va)), by_comp.get(comp_at(ub, vb))
        if not pa or not pb or "trim" in (pa["kind"], pb["kind"]): continue     # отделка — отдельные детали, на них рисунок не переходит
        dist = math.hypot(ua - ub, va - vb) * A
        # внутри одной детали настоящий шов только у рукава (нижний, край к краю); остальное — подгибы и сдвоенные слои
        if pa is pb and (pa["kind"] != "sleeve" or dist < 5): continue
        row = [ua * A, va * A, ub * A, vb * A]
        if pa["id"] > pb["id"]: pa, pb, row = pb, pa, row[2:] + row[:2]
        groups.setdefault((pa["id"], pb["id"]), []).extend(round(x, 2) for x in row)
    # Между двумя деталями швов бывает несколько (оба бока и оба плеча у переда со спинкой). Они разносятся
    # по отдельным записям: соседние точки шва лежат рядом, между разными швами — десятки сантиметров.
    seams = []
    for (a, b), flat in sorted(groups.items()):
        pts = [flat[i:i + 4] for i in range(0, len(flat), 4)]
        par = list(range(len(pts)))
        def find(i):
            while par[i] != i: par[i] = par[par[i]]; i = par[i]
            return i
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                if math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < 2.5 and math.hypot(pts[i][2] - pts[j][2], pts[i][3] - pts[j][3]) < 2.5:
                    par[find(i)] = find(j)
        parts = {}
        for i, q in enumerate(pts): parts.setdefault(find(i), []).extend(q)
        for part in sorted(parts.values(), key=len, reverse=True):
            if len(part) >= 12: seams.append([a, b, part])          # обрывки из одной-двух точек — не шов
    for a, b, flat in seams: print("шов %-9s — %-9s точек %d" % (a, b, len(flat) // 4))
    json.dump(dict(id=mid, title=title, atlas=round(A, 2), height=round(H, 4), pieces=pieces, seams=seams),
              open(out + ".json", "w", encoding="utf-8"), ensure_ascii=False)
    print("%s: лист %.1f см, высота изделия %.1f см, вершин %d, %.0f КБ" % (mid, A, H * 100, d["verts"], os.path.getsize(out + ".glb") / 1024))


if __name__ == "__main__":
    try:
        import bpy  # noqa: F401
        in_blender()
    except ImportError:
        main()
