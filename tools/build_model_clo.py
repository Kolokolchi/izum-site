# Модель для «Конструктора» из готового изделия CLO / Marvelous Designer, у которого нет нашего чертежа (кепка, шопер).
#   python -I tools/build_model_clo.py "<файл.fbx>" <id> "<название>" <cap|tote>
#   пример: python -I tools/build_model_clo.py ../md/export/cap_clo.fbx cap "Кепка" cap
# Пишет models/<id>.glb и models/<id>.json (описание прежнего вида: один размер, без лекал).
# Что делается до обычного конвертера (tools/build_model_raw.py):
#   1) из сетки убирается фурнитура — у кепки кнопки застёжки дают три четверти всех граней, а на листе лежат в стороне;
#   2) развёртка оставшихся деталей растягивается на весь лист (у кепки детали занимали его треть — нанесение было бы мутным);
#   3) детали получают роли по материалу и месту на изделии (клинья кепки — передние, боковые, задние; у шопера — полотна,
#      дно, кайма верха, ручки), а не по чертежу, которого нет.
# Blender без окна готовит сцену (.blend) и выгружает грани с развёрткой; обычный Python находит детали и пишет роли.
import sys, os, json, math, subprocess

BLENDER = r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(os.path.dirname(HERE), "models")
KEEP = {"cap": ("Crown", "Snap_"), "tote": None}       # какие материалы — ткань изделия (None — все); «Snap button» — кнопки


def in_blender():
    import bpy, bmesh
    src, out, keep = sys.argv[sys.argv.index("--") + 1:][:3]
    keep = [k for k in keep.split(",") if k]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)
    ob = max((o for o in bpy.data.objects if o.type == "MESH"), key=lambda o: len(o.data.vertices))
    for o in list(bpy.data.objects):
        if o is not ob: bpy.data.objects.remove(o, do_unlink=True)
    me = ob.data
    names = [s.material.name if s.material else "" for s in ob.material_slots]
    bm = bmesh.new(); bm.from_mesh(me)
    if keep:
        drop = {i for i, n in enumerate(names) if not any(k in n for k in keep)}
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in drop], context="FACES")
    uvl = bm.loops.layers.uv.active
    us = [l[uvl].uv.x for f in bm.faces for l in f.loops]; vs = [l[uvl].uv.y for f in bm.faces for l in f.loops]
    u0, v0 = min(us), min(vs); S = max(max(us) - u0, max(vs) - v0); pad = 0.01
    for f in bm.faces:
        for l in f.loops:
            uv = l[uvl].uv; uv.x = pad + (uv.x - u0) / S * (1 - 2 * pad); uv.y = pad + (uv.y - v0) / S * (1 - 2 * pad)
    bm.verts.ensure_lookup_table()
    M = ob.matrix_world
    polys = []
    for f in bm.faces:
        polys.append(dict(m=names[f.material_index] if names else "", v=[l.vert.index for l in f.loops],
                          p=[[round(c, 5) for c in (M @ l.vert.co)] for l in f.loops], uv=[[round(l[uvl].uv.x, 6), round(l[uvl].uv.y, 6)] for l in f.loops]))
    bm.to_mesh(me); bm.free()
    json.dump(polys, open(out + ".polys.json", "w"))
    bpy.ops.wm.save_as_mainfile(filepath=out + ".tmp.blend", check_existing=False)


def islands(polys):
    """Острова развёртки: связные по общим точкам (одна вершина сетки в одном месте листа)."""
    par = {}
    def find(k):
        while par.setdefault(k, k) != k: par[k] = par[par[k]]; k = par[k]
        return k
    keys = []
    for f in polys:
        ks = [(v, round(u, 5), round(w, 5)) for v, (u, w) in zip(f["v"], f["uv"])]; keys.append(ks)
        for k in ks[1:]: par[find(k)] = find(ks[0])
    out = {}
    for f, ks in zip(polys, keys):
        d = out.setdefault(find(ks[0]), dict(m=f["m"], n=0, a3=0.0, a2=0.0, c=[0.0, 0.0, 0.0], lo=[9, 9], hi=[-9, -9]))
        P, U = f["p"], f["uv"]
        for j in range(1, len(P) - 1):
            a = [P[j][k] - P[0][k] for k in range(3)]; b = [P[j + 1][k] - P[0][k] for k in range(3)]
            s3 = 0.5 * math.sqrt((a[1] * b[2] - a[2] * b[1]) ** 2 + (a[2] * b[0] - a[0] * b[2]) ** 2 + (a[0] * b[1] - a[1] * b[0]) ** 2)
            s2 = 0.5 * abs((U[j][0] - U[0][0]) * (U[j + 1][1] - U[0][1]) - (U[j][1] - U[0][1]) * (U[j + 1][0] - U[0][0]))
            d["a3"] += s3; d["a2"] += s2
            for k in range(3): d["c"][k] += s3 * (P[0][k] + P[j][k] + P[j + 1][k]) / 3
        d["n"] += 1
        for u, w in U:
            d["lo"] = [min(d["lo"][0], u), min(d["lo"][1], w)]; d["hi"] = [max(d["hi"][0], u), max(d["hi"][1], w)]
    res = []
    for d in out.values():
        if d["a3"] <= 0: continue
        d["c"] = [c / d["a3"] for c in d["c"]]; d["uv"] = [(d["lo"][0] + d["hi"][0]) / 2, (d["lo"][1] + d["hi"][1]) / 2]
        res.append(d)
    return res


def roles_cap(isl):
    """Кепка: козырёк — самая низкая деталь ткани; шесть клиньев — по два спереди, по бокам и сзади; ремешки застёжки."""
    crown = [d for d in isl if "Crown" in d["m"]]; out = []
    visor = min(crown, key=lambda d: d["c"][2]); out.append((visor, "visor"))
    gores = sorted((d for d in crown if d is not visor), key=lambda d: d["c"][1])          # перед смотрит в -Y
    assert len(gores) == 6, "у кепки ждали шесть клиньев, найдено %d" % len(gores)
    out += [(d, r) for d, r in zip(gores, ("cap_front", "cap_front", "cap_side", "cap_side", "cap_back", "cap_back"))]
    out += [(d, "strap") for d in isl if "Snap_" in d["m"]]
    return out


def roles_tote(isl):
    """Шопер: дно — самая низкая деталь, два полотна — самые большие, остальное из ткани — кайма верха; стропа — ручки."""
    cloth = [d for d in isl if "Webbing" not in d["m"]]; out = []
    bottom = min(cloth, key=lambda d: d["c"][2]); out.append((bottom, "bottom"))
    rest = sorted((d for d in cloth if d is not bottom), key=lambda d: -d["a3"])
    out += [(d, "panel") for d in rest[:2]] + [(d, "topband") for d in rest[2:]]
    out += [(d, "handle") for d in isl if "Webbing" in d["m"]]
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    src, mid, title, kind = sys.argv[1:5]
    out = os.path.join(MODELS, mid)
    r = subprocess.run([BLENDER, "-b", "--python", os.path.abspath(__file__), "--", os.path.abspath(src), out, ",".join(KEEP[kind] or ())],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not os.path.exists(out + ".polys.json"):
        print(r.stdout[-3000:], r.stderr[-2000:]); sys.exit("Blender не подготовил модель")
    polys = json.load(open(out + ".polys.json")); os.remove(out + ".polys.json")
    isl = islands(polys)
    picked = {"cap": roles_cap, "tote": roles_tote}[kind](isl)
    # сантиметров в единице листа — по ткани деталей: площадь на изделии против площади на листе
    atlas = math.sqrt(sum(d["a3"] for d, _ in picked) / sum(d["a2"] for d, _ in picked)) * 100
    roles = dict(atlas=round(atlas, 2), pieces=[dict(name="%s %d" % (role, k), role=role, uv=[round(d["uv"][0], 5), round(d["uv"][1], 5)]) for k, (d, role) in enumerate(picked)])
    print("граней %d, островов развёртки %d, деталей %d, лист %.1f см" % (len(polys), len(isl), len(picked), atlas))
    path = out + ".roles.json"
    json.dump(roles, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    try:
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "build_model_raw.py"), out + ".tmp.blend", mid, title, path])
    finally:
        for p in (path, out + ".tmp.blend", out + ".tmp.blend1"):
            if os.path.exists(p): os.remove(p)
    sys.exit(r.returncode)


if __name__ == "__main__":
    try:
        import bpy  # noqa: F401
        in_blender()
    except ImportError:
        main()
