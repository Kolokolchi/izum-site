# Модель для «Конструктора» из готового FBX (Tex/3d model/*.fbx).
#   python -I tools/build_model.py "<файл.fbx>" <id> "<название>" [male|female] [размер самой модели, по умолчанию S]
# Пишет:
#   models/<id>.glb            — 3D-модель с развёрткой, переложенной на чистые лекала;
#   models/<id>.json           — детали кроя по размерам S…XXXL (контуры на листе, швы, табель мер);
#   models/lekala/<id>_<размер>.svg и .dxf — лекала в натуральную величину под раскрой (линия реза и линия шва).
# Развёртка самой модели под раскрой не годится (её снимали с готовой 3D-формы: срезы волнистые, половины разные),
# поэтому детали строятся заново — см. tools/pattern.py. Работа в три шага:
#   1) Blender без окна выгружает сетку и развёртку как есть;
#   2) обычный Python строит лекала базового размера, градацию и новую развёртку (каждая деталь модели переносится
#      на своё лекало);
#   3) Blender записывает новую развёртку в модель, сглаживает сетку и выгружает GLB.
import sys, os, json, subprocess

BLENDER = r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(os.path.dirname(HERE), "models")


def in_blender():
    import bpy
    from mathutils import Vector
    step, src, out = sys.argv[sys.argv.index("--") + 1:][:3]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)
    ob = max((o for o in bpy.data.objects if o.type == "MESH"), key=lambda o: len(o.data.vertices))
    me = ob.data
    me.transform(ob.matrix_world)                       # размеры — в метрах, без масштаба родителя
    ob.parent = None; ob.matrix_world.identity()
    uv = me.uv_layers.active.data
    if step == "dump":
        json.dump(dict(verts=[[round(c, 6) for c in v.co] for v in me.vertices], polys=[list(p.vertices) for p in me.polygons],
                       loops=[list(p.loop_indices) for p in me.polygons], uv=[[round(l.uv.x, 6), round(l.uv.y, 6)] for l in uv]), open(out + ".mesh.json", "w"))
        return
    new = json.load(open(out + ".uv.json"))
    assert len(new) == len(uv), "развёртка не подходит к сетке"
    for l, (u, v) in zip(uv, new): l.uv = (u, v)
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
    off = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)))
    for v in me.vertices: v.co -= off
    for p in me.polygons: p.use_smooth = True
    sub = ob.modifiers.new("sub", "SUBSURF"); sub.levels = 1; sub.render_levels = 1
    # развёртка при сглаживании — линейная: иначе Blender сглаживает её внутри детали и уводит точки шва со среза
    # лекал, куда их поставил pattern.seam_fix (на модели через шов снова видна ступенька 1–4 мм)
    sub.uv_smooth = "NONE"
    fin = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    ob.modifiers.clear(); ob.data = fin
    for p in fin.polygons: p.use_smooth = True
    json.dump(dict(height=max(v.co.z for v in fin.vertices), verts=len(fin.vertices)), open(out + ".info.json", "w"))
    for o in list(bpy.data.objects):
        if o is not ob: bpy.data.objects.remove(o, do_unlink=True)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.gltf(filepath=out + ".glb", export_format="GLB", use_selection=True, export_materials="NONE",
                              export_yup=True, export_apply=True)


def blender(step, src, out, made):
    r = subprocess.run([BLENDER, "-b", "--python", os.path.abspath(__file__), "--", step, os.path.abspath(src), out],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not os.path.exists(made):
        print(r.stdout[-3000:], r.stderr[-2000:]); sys.exit("Blender не справился с шагом «%s»" % step)


def main():
    import numpy as np
    sys.dont_write_bytecode = True                      # без __pycache__ в папке сайта
    sys.path.insert(0, HERE)
    import pattern as pt
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    src, mid, title = sys.argv[1], sys.argv[2], sys.argv[3]
    cut = sys.argv[4] if len(sys.argv) > 4 else ("female" if "fem" in mid else "male")
    os.makedirs(os.path.join(MODELS, "lekala"), exist_ok=True)
    out = os.path.join(MODELS, mid)
    blender("dump", src, out, out + ".mesh.json")
    d = json.load(open(out + ".mesh.json")); os.remove(out + ".mesh.json")
    V = np.array(d["verts"]); UV = np.array(d["uv"])
    tv, tl, tp = [], [], []
    for pi, (p, ls) in enumerate(zip(d["polys"], d["loops"])):
        for j in range(1, len(p) - 1): tv.append((p[0], p[j], p[j + 1])); tl.append((ls[0], ls[j], ls[j + 1])); tp.append(pi)
    tv, tl, tp = np.array(tv), np.array(tl), np.array(tp)

    # ---- лекала базового размера и градация ----
    pcs, owner, edge = pt.find_pieces(V, UV, tv, tl)
    pt.classify(pcs, V)
    try: base = pt.draft(pcs, V, pt.SHAPE.get(cut))
    except AssertionError as err:
        # Лекала умеют строиться только для футболки (перед, спинка, два рукава, полосы отделки). Изделие с другими
        # деталями — капюшон, карман, манжеты — выгружается по-прежнему: контуры берутся с развёртки как есть, без размеров.
        print("Лекала не построены (%s) — модель выгружается с развёрткой как есть, без размерного ряда." % err)
        sys.exit(subprocess.run([sys.executable, "-I", os.path.join(HERE, "build_model_raw.py"), *sys.argv[1:4]]).returncode)
    names = {p["id"]: p for p in pcs}
    # Какому размеру соответствует сама 3D-модель: пятый аргумент командной строки (например L), иначе pattern.BASE.
    BASE = sys.argv[5] if len(sys.argv) > 5 else (pt.SHAPE.get(cut) or {}).get("base", pt.BASE)
    assert BASE in pt.SIZES, "нет такого размера: %s" % BASE
    k0 = pt.SIZES.index(BASE)
    pats = {s: pt.grade(base, k - k0, pt.GRADE[cut]) for k, s in enumerate(pt.SIZES)}
    allow = dict(pt.ALLOW)

    # ---- новая развёртка модели: лист базового размера и есть текстура ----
    its, W, H = pt.place(base, set(names))
    A = round(max(W, H) + 0.05, 1)
    poly_owner = np.zeros(len(d["polys"]), int); poly_owner[tp[::-1]] = owner[::-1]
    loop_piece = np.zeros(len(UV), int)
    for pi, ls in enumerate(d["loops"]): loop_piece[ls] = poly_owner[pi]
    X, snapped = pt.remap(pcs, its, UV, loop_piece, edge)
    # точки швов — на срезы лекал по одной доле длины на обеих деталях (как по надсечкам), см. pattern.seam_fix
    X, flog = pt.seam_fix(pcs, its, X, V, tl, tv, loop_piece, owner)
    for s_ in flog: print("шов " + s_)
    json.dump([[round(x / A, 6), round(1 - y / A, 6)] for x, y in X.tolist()], open(out + ".uv.json", "w"))
    P2 = X[tl]; P3 = V[tv]
    a2 = 0.5 * ((P2[:, 1, 0] - P2[:, 0, 0]) * (P2[:, 2, 1] - P2[:, 0, 1]) - (P2[:, 1, 1] - P2[:, 0, 1]) * (P2[:, 2, 0] - P2[:, 0, 0]))
    a3 = 0.5 * np.linalg.norm(np.cross(P3[:, 1] - P3[:, 0], P3[:, 2] - P3[:, 0]), axis=1)
    big = a3 > np.median(a3) * 0.05
    print("новая развёртка: %d углов граней, из них %d посажены на контур лекал; перевёрнуто %d треугольников из %d (тонкие лоскутки у швов)" % (
        len(UV), snapped, int((a2[big] > 0).sum()), int(big.sum())))
    # с какой стороны рукава перед изделия: +1 — справа на листе (перед смотрит в -Y)
    fx = {}
    cen2, cen3 = P2.mean(1), P3.mean(1)
    for k, p in enumerate(pcs):
        if p["kind"] != "sleeve": continue
        s = owner == k; w = a3[s]
        M = np.column_stack([cen2[s], np.ones(int(s.sum()))])
        coef = np.linalg.lstsq(M * w[:, None], cen3[s] * w[:, None], rcond=None)[0]
        fx[p["id"]] = 1 if coef[0][1] < 0 else -1
    # проверка по сетке: какие края переда и спинки на самом деле сшиты и насколько совпадают точки шва
    by = {i["id"]: i for i in its}
    key = lambda v: tuple(np.round(V[v], 5))
    edges = {}
    for pi, (p, ls) in enumerate(zip(d["polys"], d["loops"])):
        for j in range(len(p)):
            a, b = p[j], p[(j + 1) % len(p)]; ka, kb = key(a), key(b)
            la, lb = ls[j], ls[(j + 1) % len(p)]
            edges.setdefault((ka, kb) if ka <= kb else (kb, ka), []).append((la, lb) if ka <= kb else (lb, la))
    cross = same = 0; gaps = []
    for uses in edges.values():
        for i in range(len(uses)):
            for j in range(i + 1, len(uses)):
                ia, ib = pcs[loop_piece[uses[i][0]]]["id"], pcs[loop_piece[uses[j][0]]]["id"]
                if {ia, ib} != {"front", "back"}: continue
                ma, mb = X[list(uses[i])].mean(0), X[list(uses[j])].mean(0)
                if np.linalg.norm(ma - mb) < 1e-6: continue
                qa, qb = by[ia], by[ib]
                ya, yb = qa["oy"] - ma[1], qb["oy"] - mb[1]                      # высота над... от высшей точки плеча вниз (отрицательная)
                if ya > base["front"]["pts"]["U"][1] or yb > base["back"]["pts"]["U"][1]: continue   # выше подмышки — плечо
                sa, sb = np.sign(ma[0] - qa["ox"]), np.sign(mb[0] - qb["ox"])
                if sa * sb < 0: cross += 1
                else: same += 1
                gaps.append(abs(ya - yb))
    assert cross > same, "боковые швы модели идут не «правый край переда — левый край спинки»: %d против %d" % (cross, same)
    print("проверка по сетке: %d рёбер бокового шва соединяют правый край одной детали с левым краем другой (наоборот — %d); точки шва на переде и спинке расходятся по высоте в среднем на %.1f мм, наибольшее %.1f мм" % (
        cross, same, 10 * float(np.mean(gaps)), 10 * float(np.max(gaps))))

    # ---- описание для конструктора ----
    r2 = lambda P: [[round(float(x), 2), round(float(y), 2)] for x, y in P]
    def pieces_of(items):
        res = []
        for i in items:
            p = names[i["id"]]; R = pt.sheet_ring(i)
            rec = dict(id=p["id"], name=p["name"], kind=p["kind"], look=p["look"], twin=p["twin"], w=round(i["w"], 1), h=round(i["h"], 1), outline=r2(R))
            if p["kind"] == "sleeve": rec.update(fx=fx[p["id"]], hem="bottom")
            res.append(rec)
        return res
    ch0 = {k: v for k, _, v in pt.measures(base)}
    sizes = {}
    for s in pt.SIZES:
        items, w, h = (its, W, H) if s == BASE else pt.place(pats[s], set(names))
        ms = pt.measures(pats[s]); ch = {k: v for k, _, v in ms}
        # k3 — во сколько раз изделие этого размера шире и длиннее самой 3D-модели (kf — подгонка базового размера под стандарт)
        kf = base.get("fit", 1.0)
        sizes[s] = dict(sheet=[round(w, 1), round(h, 1)], k3=[round(kf * ch["chest"] / ch0["chest"], 4), round(kf * ch["length"] / ch0["length"], 4)],
                        pieces=pieces_of(items), seams=pt.seam_pairs(items), chart=[[k, v] for k, _, v in ms])
        pt.cut_files(os.path.join(MODELS, "lekala", "%s_%s" % (mid, s)), title, s, items, w, h, pats[s], {k: v["name"] for k, v in names.items()}, fx, allow)
        print("%-5s " % s + "  ".join("%s %.1f" % (n, v) for _, n, v in ms[:4]) + "   лист %.0f × %.0f см" % (w, h))
    blender("export", src, out, out + ".info.json")
    info = json.load(open(out + ".info.json")); os.remove(out + ".info.json"); os.remove(out + ".uv.json")
    bands = base["bands"]
    json.dump(dict(id=mid, title=title, atlas=A, height=round(info["height"], 4), base=BASE, order=pt.SIZES,
                   chart=[[k, n] for k, n, _ in pt.measures(base)],
                   allow=dict(seam=allow["seam"], hem=allow["seam"] if bands["hem"] else allow["hem"], sleeve_hem=allow["seam"] if bands["cuff"] else allow["sleeve_hem"],
                              neck=allow["neck"], strip=allow["strip"]),
                   sizes=sizes), open(out + ".json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    for p in sizes[BASE]["pieces"]: print("%-9s %-22s %5.1f × %5.1f см  точек %d" % (p["id"], p["name"], p["w"], p["h"], len(p["outline"])))
    print("%s: лист %.1f см, высота изделия %.1f см, вершин %d, модель %.0f КБ, описание %.0f КБ, лекала — models/lekala/%s_<размер>.svg и .dxf" % (
        mid, A, info["height"] * 100, info["verts"], os.path.getsize(out + ".glb") / 1024, os.path.getsize(out + ".json") / 1024, mid))


if __name__ == "__main__":
    try:
        import bpy  # noqa: F401
        in_blender()
    except ImportError:
        main()
