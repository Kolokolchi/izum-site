# Модель для «Конструктора» из изделия, собранного в Marvelous Designer по чертежу md/garments/<вещь>_geo.py.
#   python -I tools/build_model_md.py <вещь> <men|women> <id> "<название>"
#   пример: python -I tools/build_model_md.py hoodie men hoodie_male "Мужское"
# Берёт md/export/<вещь>_<men|women>.fbx (развёртка = раскладка деталей чертежа), пишет models/<id>.glb и models/<id>.json.
# Сама работа — в tools/build_model_raw.py; здесь из чертежа собирается список деталей: роль каждой (перед, рукав, манжета,
# капюшон, карман, полочка…) и её место в раскладке. Левая/правая сторона изделия определяется уже по 3D-модели:
# в чертежах _l / _r — сторона листа, а не изделия.
# Затем tools/pattern_md.py по тому же чертежу строит размерный ряд S–XXXL и лекала models/lekala/<id>_<размер>.svg|.dxf
# (сама 3D-модель — одного размера: мужская L, женская M).
import sys, os, json, subprocess, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
MD = os.path.join(os.path.dirname(SITE), "md")
ROLE = {"front": "front", "back": "back", "front_l": "front_half", "front_r": "front_half", "sleeve_l": "sleeve", "sleeve_r": "sleeve",
        "cuff_l": "cuff", "cuff_r": "cuff", "band_l": "cuff", "band_r": "cuff", "hem_f": "hem", "hem_b": "hem", "hem": "hem",
        "hood_l": "hood", "hood_r": "hood", "pocket": "pocket", "neckband": "neckband", "collar": "collar", "leaf": "collar",
        "stand": "collar_stand", "placket": "placket", "zip": "zip"}


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.dont_write_bytecode = True
    kind, size, mid, title = sys.argv[1:5]
    spec = importlib.util.spec_from_file_location(kind + "_geo", os.path.join(MD, "garments", kind + "_geo.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    g = getattr(m, kind)(size)
    box = {n: (min(q[0] for q in p["pts"]), min(q[1] for q in p["pts"]), max(q[0] for q in p["pts"]), max(q[1] for q in p["pts"]))
           for n, p in g["pieces"].items()}
    x0, y0 = min(b[0] for b in box.values()), min(b[1] for b in box.values())
    S = max(max(b[2] for b in box.values()) - x0, max(b[3] for b in box.values()) - y0)
    roles = [dict(name=n, role=ROLE[n], at=[round(((b[0] + b[2]) / 2 - x0) / S, 5), round(((b[1] + b[3]) / 2 - y0) / S, 5)]) for n, b in box.items()]
    path = os.path.join(SITE, "models", mid + ".roles.json")
    json.dump(roles, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    try:
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "build_model_raw.py"),
                            os.path.join(MD, "export", "%s_%s.fbx" % (kind, size)), mid, title, path])
    finally:
        os.remove(path)
    if r.returncode: sys.exit(r.returncode)
    sys.path.insert(0, HERE)
    import pattern_md
    pattern_md.build(kind, size, mid, title)        # размерный ряд S–XXXL и лекала под раскрой


if __name__ == "__main__":
    main()
