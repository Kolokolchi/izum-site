// Швы изделия. На 3D-модели детали кроя сшиты: точка края одной детали лежит там же, где точка края соседней.
// Отсюда берётся только одно — какие точки контуров сшиваются между собой (бок, плечо, пройма, шов рукава).
// Как принт переходит через шов, дальше решается на плоских лекалах, от печати (constructor.js), а не по форме модели.
const TOL = 0.1;          // см: края деталей ближе этого — один шов (в моделях они совпадают до 0,0 мм)
function inPoly(x, y, o) {
  let c = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const [x1, y1] = o[i], [x2, y2] = o[j];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) c = !c;
  }
  return c;
}
function polyDist(x, y, o) {
  let best = 1e9;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const [x1, y1] = o[j], [x2, y2] = o[i], dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x1 + t * dx - x, y1 + t * dy - y));
  }
  return best;
}

// geo — сетка модели, pieces — детали с контурами на текстуре (p.t.o, см), A — сторона текстуры (см).
// Отдаёт пары точек шва [деталь a, деталь b, x, y на текстуре у a, x, y на текстуре у b, вершина a, вершина b] —
// каждую в обе стороны.
// Отделка (бейка, манжеты, пояс) — другая ткань, через её швы принт не идёт.
export function seamPairs(geo, pieces, A) {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const I = geo.index ? geo.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
  const nV = pos.count, nT = I.length / 3;
  const T = new Float32Array(nV * 2), vP = new Int16Array(nV);
  const box = pieces.map((p) => { const xs = p.t.o.map((q) => q[0]), ys = p.t.o.map((q) => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; });
  for (let v = 0; v < nV; v++) {
    const x = uv.getX(v) * A, y = uv.getY(v) * A;
    T[2 * v] = x; T[2 * v + 1] = y;
    let k = -1;
    for (let i = 0; i < pieces.length && k < 0; i++) { const b = box[i]; if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inPoly(x, y, pieces[i].t.o)) k = i; }
    if (k < 0) {                                  // край развёртки чуть за контуром (до 3 мм) — ближайшая деталь
      let bd = 0.3;
      pieces.forEach((p, i) => { const b = box[i]; if (x < b[0] - 1 || x > b[2] + 1 || y < b[1] - 1 || y > b[3] + 1) return; const d = polyDist(x, y, p.t.o); if (d < bd) { bd = d; k = i; } });
    }
    vP[v] = k;                                    // -1: вне всех деталей (лента молнии, фурнитура) — не шов
  }
  // вершины одной детали в одной точке и в одном месте развёртки — один узел (сетка бывает сварена по шву рукава:
  // точка одна, а на развёртке это два края детали — они должны остаться разными узлами)
  const key = new Map(), vN = new Int32Array(nV), first = [];
  for (let v = 0; v < nV; v++) {
    const k = Math.round(pos.getX(v) * 1e5) + "," + Math.round(pos.getY(v) * 1e5) + "," + Math.round(pos.getZ(v) * 1e5) + "|" + vP[v] + "|" + Math.round(T[2 * v]) + "," + Math.round(T[2 * v + 1]);
    let n = key.get(k);
    if (n === undefined) { n = first.length; key.set(k, n); first.push(v); }
    vN[v] = n;
  }
  const nN = first.length;
  // край детали — рёбра, у которых один треугольник
  const ecount = new Map();
  for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
    const a = vN[I[3 * t + e]], b = vN[I[3 * t + ((e + 1) % 3)]];
    if (a === b) continue;
    const k = a < b ? a * nN + b : b * nN + a;
    ecount.set(k, (ecount.get(k) || 0) + 1);
  }
  const edge = new Uint8Array(nN);
  for (const [k, c] of ecount) if (c === 1) { edge[Math.floor(k / nN)] = 1; edge[k % nN] = 1; }
  // Края, совпадающие в пространстве, — шов (и края одной детали — нижний шов рукава). У подмышки сетка частая, и в 1 мм
  // от точки бывает несколько точек другого края, в том числе соседних по шву (на 2–3 мм дальше): пара — только ближайшие
  // для обеих точек на том краю (с запасом 0,2 мм — совпадающие точки одной детали остаются все).
  const cand = [], grid = new Map(), cell = (x) => Math.floor(x / TOL);
  const P = (n, i) => (i === 0 ? pos.getX(first[n]) : i === 1 ? pos.getY(first[n]) : pos.getZ(first[n])) * 100;
  for (let n = 0; n < nN; n++) {
    const pa = vP[first[n]];
    if (!edge[n] || pa < 0 || pieces[pa].kind === "trim") continue;
    const x = P(n, 0), y = P(n, 1), z = P(n, 2), cx = cell(x), cy = cell(y), cz = cell(z);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const l = grid.get((cx + i) + "," + (cy + j) + "," + (cz + k));
      if (!l) continue;
      for (const m of l) {
        const d = Math.hypot(P(m, 0) - x, P(m, 1) - y, P(m, 2) - z);
        if (d > TOL) continue;
        const va = first[n], vb = first[m];
        const duv = Math.hypot(T[2 * va] - T[2 * vb], T[2 * va + 1] - T[2 * vb + 1]);
        if (vP[vb] === pa && duv < 1) continue;                                                            // та же точка детали
        cand.push([n, m, d, duv]);
      }
    }
    const k = cx + "," + cy + "," + cz;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(n);
  }
  // «край» партнёра: другая деталь, а у той же детали — дальний край (шов рукава) или рядом (подгибка)
  const side = (n, m, duv) => vP[first[m]] + (vP[first[m]] === vP[first[n]] ? (duv >= 8 ? "f" : "n") : "");
  const best = new Map(), keep = (n, m, d, duv) => {
    const k = n + "|" + side(n, m, duv);
    best.set(k, Math.min(best.has(k) ? best.get(k) : 1e9, d));
  };
  for (const [n, m, d, duv] of cand) { keep(n, m, d, duv); keep(m, n, d, duv); }
  const out = [];
  for (const [n, m, d, duv] of cand) {
    if (d > best.get(n + "|" + side(n, m, duv)) + 0.02 || d > best.get(m + "|" + side(m, n, duv)) + 0.02) continue;   // см
    const va = first[n], vb = first[m], pa = vP[va], pb = vP[vb];
    out.push([pa, pb, T[2 * va], T[2 * va + 1], T[2 * vb], T[2 * vb + 1], va, vb], [pb, pa, T[2 * vb], T[2 * vb + 1], T[2 * va], T[2 * va + 1], vb, va]);
  }
  // Деталь, сшитая сама с собой рядом, — подгибка низа (край загнут на 2–4 см внутрь), а не шов для печати.
  // Полоса подгибки на сшитой вещи внутри: точки швов в ней (там края сходятся крест-накрест) отбрасываются.
  const fold = new Map();
  for (const [a, b, ax, ay, bx, by] of out) {
    const d = Math.hypot(bx - ax, by - ay);
    if (a !== b || d >= 8 || d < 1.5) continue;            // ближе 1,5 см — складка сетки у края, а не подгибка
    if (!fold.has(a)) fold.set(a, []);
    fold.get(a).push([ax, ay, bx, by]);
  }
  const inFold = (p, x, y) => (fold.get(p) || []).some(([x1, y1, x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x1 + t * dx - x, y1 + t * dy - y) < 0.4;
  });
  return out.filter(([a, b, ax, ay, bx, by]) => !(a === b && Math.hypot(bx - ax, by - ay) < 8) && !inFold(a, ax, ay) && !inFold(b, bx, by));
}
