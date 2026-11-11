// Первый экран Izum: очередь вещей → выбранная подлетает к камере → на неё можно примерить
// свой логотип или паттерн и выбрать цвет. Вырос из presentation/falcon/app.js.
//
// Вещь рисуется шейдером (WebGL2): он перекрашивает жёлтые пиксели в выбранный цвет и кладёт
// нанесение как в мокапе — в размеченную зону печати, по маске поверхности, с изгибом по складкам.
(() => {
  "use strict";

  const ITEMS = window.IZUM_ITEMS, COLORS = window.IZUM_COLORS, METHODS = window.IZUM_METHODS;
  const N = ITEMS.length;
  const STEP = 0.38;               // угол между соседями на дуге, рад
  const THICK = 18;                // «толщина» плоской вырезки, px
  const LAYERS = 5;
  const CH_ANGLE = [8, 20, 0];     // поворот вещи в каждом разделе, градусы (только от исходной позы вперёд);
                                   // в разделе «Ваш логотип» вещь стоит строго лицом
  const CHAPTERS = CH_ANGLE.length;
  const CUSTOM = 2;                // раздел с примеркой логотипа
  const HI_FRAMES = 14;            // столько первых кадров есть в полном размере (tools/make_turntable.py: HI_KEEP)
  const WHATSAPP = "77771737475";

  const $ = (id) => document.getElementById(id);
  const app = $("app"), stage = $("stage");
  const pedTop = document.querySelector(".pedestal-top"), pedBottom = document.querySelector(".pedestal-bottom");

  const S = {
    pos: 0, target: 0,      // позиция очереди (дробная) и цель
    active: -1,             // индекс вещи в режиме презентации
    chapter: 0,
    g: 0,                   // 0 — очередь, 1 — презентация
    flat: 0,                // 0 — вещь слегка наклонена, 1 — стоит ровно (примерка)
    shown: -1,              // индекс, подписанный внизу
    W: 0, H: 0, mobile: false, size: 0, R: 0,
    color: null,            // выбранный цвет {id, name, hex, t:[r,g,b] 0..1, lum}
    visible: true,          // первый экран в зоне видимости
  };

  // Нанесение пользователя
  const C = {
    src: null,              // canvas с логотипом (обрезан по содержимому)
    mono: false,            // логотип набран текстом — цвет подбирается под поверхность
    mode: "logo",           // logo | pattern
    tint: "orig",           // orig | white | black | custom (цвет ink)
    ink: "#e5007d",
    text: "", font: "gotham",
    pat: "brick",           // раскладка паттерна, см. PATTERNS
    part: 1,                // где печатать паттерн: 1 — снаружи, 2 — внутри, 3 — везде
    scale: 1,               // 1 — логотип занимает 80% зоны печати, 1.25 — всю зону
    ver: 0,                 // растёт при любом изменении — текстуры нанесения пересобираются
    off: ITEMS.map(() => ({})),               // сдвиг логотипа внутри зоны печати: off[вещь][место] = {x, y} в долях зоны
    zone: "front",          // место, которое сейчас настраивается
    places: { front: true, back: false, sleeve: false },   // где логотип стоит
  };

  // Места нанесения каждой вещи: «спереди» (print) и, если заданы в data.js, спина и рукав (places).
  // k — кадр оборота, на котором место смотрит в камеру.
  const PLACE_NAMES = { front: "Спереди", back: "Спина", sleeve: "Рукав" };
  const ZONES = ITEMS.map((it) => [{ id: "front", k: 0, ...it.print }, ...Object.entries(it.places || {}).map(([id, z]) => ({ id, ...z }))]);
  const curZone = (i) => ZONES[i].find((z) => z.id === C.zone) || ZONES[i][0];
  const off = (i, id) => C.off[i][id] || (C.off[i][id] = { x: 0, y: 0 });
  // кадры, которые есть в полном размере: лицевые и кадры мест с соседями (tools/make_turntable.py: is_hi)
  const hiFrames = (i, n) => { const ks = new Set(); for (let k = 0; k < HI_FRAMES; k++) ks.add(k); for (const z of ZONES[i]) if (z.k) for (const d of [-1, 0, 1]) ks.add(mod(z.k + d, n)); return [...ks]; };

  const mod = (a, n) => ((a % n) + n) % n;
  const wrap = (d) => { d = mod(d, N); return d > N / 2 ? d - N : d; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const smooth = (t) => t * t * (3 - 2 * t);
  const pad = (n) => String(n).padStart(2, "0");

  // ---------- шейдер ----------
  const VS = `#version 300 es
in vec2 p; out vec2 v;
void main() { v = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;
  const FS = `#version 300 es
precision highp float;
uniform sampler2D uF, uP, uT;      // кадр вещи, зона печати с логотипом, плитка паттерна
uniform vec3 uCol;                 // выбранный цвет
uniform float uRec;                // 1 — перекрашивать
uniform mat3 uH;                   // кадр → зона печати
uniform float uArc, uK, uSurf, uSurfB, uAxis, uShift, uSquash, uDisp;
uniform vec4 uEb, uEx;             // эллипсы внутренней части: центр и полуоси в долях кадра
uniform vec2 uPart;                // паттерн: печатать снаружи (x) и внутри (y)
uniform int uMode;                 // 0 — без нанесения, 1 — логотип, 2 — паттерн
uniform vec2 uSize, uTile, uRot;   // uRot — косинус и синус наклона паттерна
in vec2 v; out vec4 o;
float L(vec3 c) { return dot(c, vec3(.3, .59, .11)); }
float ell(vec4 e) { return 1. - smoothstep(.94, 1.04, length((v - e.xy) / e.zw)); }
void main() {
  vec4 s = texture(uF, v);
  s.rgb = s.a > 0. ? s.rgb / s.a : vec3(0.);   // кадр хранится с предумноженной прозрачностью
  s.a *= smoothstep(.04, .16, s.a);   // слабый шум альфы по краям (сжатие ролика) давал крапинки на цветном фоне
  // светлый полупрозрачный ореол (отсвет вещи на белом фоне съёмки) на цветной заливке читается грязью — убираем;
  // тёмные полупрозрачные пиксели — это тень под вещью, они остаются
  s.a *= mix(1., smoothstep(.45, .92, s.a), smoothstep(.5, .75, dot(s.rgb, vec3(.3, .59, .11))));
  if (s.a < .004) { o = vec4(0.); return; }
  vec3 c = s.rgb * 255.;
  // Вещи сняты в чёрном с жёлтым. Пиксель раскладывается на «белую» часть (канал B) и «жёлтую»
  // (max(R,G) − B); жёлтая заменяется выбранным цветом.
  float y = (c.r + c.g) * .5 - c.b;
  float m = clamp((y - 12.) / 28., 0., 1.);
  vec3 rec = vec3(c.b) + (max(c.r, c.g) - c.b) * uCol;
  vec3 base = mix(c, rec, m * uRec) / 255.;

  if (uMode > 0 && uK > 0.) {
    // складки и фактура ткани: локальная яркость относительно размытой
    float l0 = L(textureLod(uF, v, 1.).rgb), l5 = L(textureLod(uF, v, 5.).rgb);
    float lr = L(s.rgb), l2 = L(textureLod(uF, v, 2.5).rgb);
    float fa = clamp(l0 / max(l5, .04), .55, 1.22) * clamp(lr / max(l2, .04), .9, 1.1);            // цветная ткань
    float fd = clamp(1. + (l0 - l5) * 2.5, .62, 1.35) * clamp(1. + (lr - l2) * 2., .86, 1.2);       // чёрная ткань
    float f = mix(fd, fa, m);                                                                        // + мелкое плетение
    // Части вещи. Класс поверхности — по цвету пикселя: цветная ткань (ac) или чёрная (dk; тень под вещью не в счёт).
    // Там, где внутренняя часть того же цвета, что и наружная (горловина футболки), её задаёт эллипс uEx.
    // Шнурки, молнии, пуговицы, канты не попадают ни в одну часть и остаются поверх нанесения.
    float ac = m, dk = (1. - smoothstep(110., 170., L(c))) * (1. - m) * smoothstep(.75, .95, s.a);
    float cA = uSurf < .5 ? ac : dk, cB = uSurfB < .5 ? ac : dk;
    float eb = uEb.z > 0. ? ell(uEb) : 1., ex = uEx.z > 0. ? ell(uEx) : 0.;
    float mA = cA * (1. - ex), mB = max(cB * eb, ac * ex);                                           // снаружи и внутри
    float surf = uMode == 1 ? mA : clamp(uPart.x * mA + uPart.y * mB, 0., 1.);
    // сдвиг по рельефу: рисунок чуть «плывёт» вместе со складками
    vec2 e = 3. / uSize;
    vec2 g = vec2(L(textureLod(uF, v + vec2(e.x, 0.), 2.).rgb) - L(textureLod(uF, v - vec2(e.x, 0.), 2.).rgb),
                  L(textureLod(uF, v + vec2(0., e.y), 2.).rgb) - L(textureLod(uF, v - vec2(0., e.y), 2.).rgb));
    vec4 pr; float la;
    if (uMode == 1) {
      vec2 q = v; q.x = uAxis + (q.x - uAxis - uShift) / uSquash;   // вещь повернулась — зона уезжает вместе с ней
      vec3 h = uH * vec3(q, 1.); vec2 pp = h.xy / h.z;
      float cx = 2. * pp.x - 1.;
      pp.y -= uArc * (1. - cx * cx);
      pp += g * uDisp;
      vec2 d = min(pp, 1. - pp);
      pr = texture(uP, pp); la = pr.a * smoothstep(0., .006, min(d.x, d.y));
    } else {
      vec2 px = v * uSize;
      pr = texture(uT, vec2(uRot.x * px.x + uRot.y * px.y, -uRot.y * px.x + uRot.x * px.y) / uTile + g * uDisp); la = pr.a * .92;
    }
    la *= surf * uK;
    base = mix(base, clamp(pr.rgb / max(pr.a, .001) * pow(f, .9), 0., 1.), la);
  }
  o = vec4(base * s.a, s.a);
}`;

  function makeGL(canvas) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const name of ["uF", "uP", "uT", "uCol", "uRec", "uH", "uArc", "uK", "uSurf", "uSurfB", "uEb", "uEx", "uPart", "uAxis", "uShift", "uSquash", "uDisp", "uMode", "uSize", "uTile", "uRot"]) u[name] = gl.getUniformLocation(prog, name);
    const tex = (unit, wrapMode, mips) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return t;
    };
    const texF = tex(0, gl.CLAMP_TO_EDGE, true), texP = tex(1, gl.CLAMP_TO_EDGE, true), texT = tex(2, gl.REPEAT, true);
    gl.uniform1i(u.uF, 0); gl.uniform1i(u.uP, 1); gl.uniform1i(u.uT, 2);
    return { gl, u, texF, texP, texT };
  }
  function tryGL(canvas) {
    try { const G = makeGL(canvas); if (G) return G; glErrors.push("нет контекста"); }
    catch (e) { glErrors.push(String(e && e.message)); }
    return null;
  }
  // Контекст может пропасть (драйвер, нехватка видеопамяти, сон ноутбука) или не создаться с первого раза.
  // Тогда вещь рисуется как есть, без перекраски и нанесения, — поэтому пробуем поднять WebGL заново.
  function watchGL(t, canvas) {
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); t.dirty = true; });
    if (!t.G && t.glTries < GL_TRIES) setTimeout(() => { t.dirty = true; }, GL_RETRY + 50);
  }
  function resetCanvas(t) {
    const old = t.canvas, c = document.createElement("canvas");
    c.className = old.className; c.width = old.width; c.height = old.height; c.style.cssText = old.style.cssText;
    t.glAt = performance.now(); t.glTries++;
    t.G = tryGL(c); t.ctx = t.G ? null : c.getContext("2d");
    t.canvas = c; t.texImg = null; t.printKey = ""; t.tileKey = ""; t.dirty = true;
    old.replaceWith(c);
    watchGL(t, c);
  }
  function upload(G, unit, texture, source, premultiply) {
    const gl = G.gl;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  // Матрица «кадр → зона печати» по четырём углам зоны (TL, TR, BR, BL в долях кадра).
  function homography(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
    const den = dx1 * dy2 - dx2 * dy1, g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
    const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
    // обратная к [[a,b,c],[d,e,f],[g,h,1]]
    const A = e - f * h, B = c * h - b, Cc = b * f - c * e, D = f * g - d, E = a - c * g, F = c * d - a * f, G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
    return new Float32Array([A, D, G, B, E, Hh, Cc, F, I]);   // по столбцам, как ждёт WebGL
  }

  // ---------- сборка сцены ----------
  const turnQueue = [];   // вещи, чьи кадры оборота ещё не загружены
  let turnBusy = false;
  const GL_TRIES = 12, GL_RETRY = 1500;
  const glErrors = [];    // почему не поднялся WebGL (для диагностики: izumHero.glErrors)
  const nodes = ITEMS.map((it, i) => {
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.i = i;
    for (let k = 0; k < LAYERS; k++) {
      const img = new Image();
      img.src = it.img;
      img.alt = k === 0 ? it.name : "";
      img.decoding = "async";
      img.draggable = false;
      img.style.transform = `translateZ(${THICK / 2 - (THICK * k) / (LAYERS - 1)}px)`;
      if (k > 0 && k < LAYERS - 1) img.className = "mid";
      el.appendChild(img);
    }
    const sh = document.createElement("div");
    sh.className = "shadow";
    stage.append(sh, el);
    const node = { el, sh, h: 0, rot: 0, rotT: 0, rotGoal: 0, rotFrom: 0, rotT0: 0, rotDur: 1, w: 0, hgt: 0, heroK: 1, turn: null };
    return node;
  });

  // Кадры оборота: номер кадра задаётся углом поворота, поэтому вещь реально вращается.
  // Три набора: sm — кадры около исходной позы в четверть размера (хватает для очереди);
  // md — весь оборот в половинном размере (у вещи в центре и у выбранной);
  // hi — первые кадры в полном размере (выбранная вещь, когда она стоит у камеры).
  const frameUrl = (turn, tier, k) => `${turn.dir}/${tier}/${String(k).padStart(3, "0")}.webp`;
  // Кадры держим с предумноженной прозрачностью: иначе при уменьшении и сглаживании цвет прозрачных
  // пикселей затекает в контур вещи (тёмная рваная кайма, серый ореол). Шейдер делит цвет на альфу обратно.
  const bitmap = (blob, opts) => createImageBitmap(blob, { premultiplyAlpha: "premultiply", ...opts });
  // Холст вещи поднимается сразу — из картинки, которая уже стоит на странице. Перекраска и нанесение
  // работают с первой секунды и не ждут кадров оборота: по плохой сети те могут идти минутами.
  function startTurn(node) {
    const turn = ITEMS[nodes.indexOf(node)].turn, img = node.el.querySelector("img");
    if (!turn) return;
    const lw = Math.max(1, Math.floor(turn.fw / 2)), lh = Math.max(1, Math.floor(turn.fh / 2));
    img.decode().then(() => bitmap(img, { resizeWidth: Math.max(1, Math.round(lw / 2)), resizeQuality: "high" })).then((first) => {
      const canvas = document.createElement("canvas");
      canvas.className = "turn";
      canvas.width = lw; canvas.height = lh;
      const G = tryGL(canvas);
      const t = { ...turn, canvas, G, ctx: G ? null : canvas.getContext("2d"), glAt: performance.now(), glTries: 0, lw, lh, blobs: new Array(turn.n), sm: new Array(turn.n), md: new Array(turn.n), hi: new Array(turn.n),
                  complete: false, full: false, busy: false, drop: false, hiState: 0, dirty: true, shown: null, pk: "", printKey: "", tileKey: "", tile: [1, 1], rot: [1, 0],
                  zg: {} };
      for (const z of ZONES[nodes.indexOf(node)]) t.zg[z.id] = { H: homography(z.quad) };
      t.sm[0] = first;
      watchGL(t, canvas);
      node.turn = t;
      node.el.append(canvas);
      node.el.classList.add("turning");
      layout();
      turnQueue.push({ node, turn, phase: 1 });
      nextTurn();
    }, () => {                                   // картинка не дошла — запрашиваем заново
      setTimeout(() => {
        for (const im of node.el.querySelectorAll("img")) im.src = im.src.split("?")[0] + "?r=" + Date.now();
        startTurn(node);
      }, 3000);
    });
  }
  function nextTurn() {
    if (turnBusy || !turnQueue.length) return;
    turnQueue.sort((p, q) => p.phase - q.phase || dist(p.node) - dist(q.node));
    const job = turnQueue.shift(), { node, turn } = job;
    turnBusy = true;
    let work;
    const t = node.turn, ks = [];
    if (job.phase === 1) {                       // кадры около исходной позы — в четверть размера, показываем по мере прихода
      for (const k of restFrames(t.n)) if (!t.blobs[k]) ks.push(k);
      const half = Math.max(1, Math.round(t.lw / 2));
      work = fetchAll(ks.map((k) => frameUrl(turn, "lo", k)), (j, blob) => {
        const k = ks[j];
        t.blobs[k] = blob;
        bitmap(blob, { resizeWidth: half, resizeQuality: "high" }).then((bm) => { if (t.sm[k]) t.sm[k].close(); t.sm[k] = bm; t.dirty = true; }, () => {});
      }).then(() => { turnQueue.push({ node, turn, phase: 2 }); });
    } else {                                     // остальной оборот
      for (let k = 0; k < t.n; k++) if (!t.blobs[k]) ks.push(k);
      work = fetchAll(ks.map((k) => frameUrl(turn, "lo", k)), (j, blob) => { t.blobs[ks[j]] = blob; }).then(() => { t.complete = true; });
    }
    // сеть срывается — пробуем снова, пока не получится (с паузой, чтобы не молотить впустую)
    work.catch(() => { job.tries = (job.tries || 0) + 1; setTimeout(() => { turnQueue.push(job); nextTurn(); }, Math.min(8000, 1200 * job.tries)); })
        .finally(() => { turnBusy = false; nextTurn(); });
  }

  // Не больше 8 запросов сразу и до 4 попыток на файл — по сети отдельные запросы срываются.
  // each(j, blob) вызывается сразу, как пришёл файл: при срыве остальных уже полученное не пропадает.
  async function fetchAll(urls, each) {
    const out = new Array(urls.length);
    let next = 0;
    const one = async (u) => {
      for (let attempt = 0; ; attempt++) {
        const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 12000);   // зависший запрос не должен держать очередь
        try { const r = await fetch(u, { signal: ac.signal }); if (r.ok) return await r.blob(); throw new Error(r.status); }
        catch (err) { if (attempt >= 3) throw err; await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); }
        finally { clearTimeout(timer); }
      }
    };
    const worker = async () => { while (next < urls.length) { const k = next++; out[k] = await one(urls[k]); if (each) each(k, out[k]); } };
    await Promise.all(Array.from({ length: 8 }, worker));
    return out;
  }

  const REST = 20;
  const restFrames = (n) => { const ks = []; for (let j = -2; j <= REST; j++) ks.push(mod(j, n)); return ks; };
  async function decodeFull(t) {      // весь оборот в половинном размере — заранее, чтобы вращение не запиналось
    if (t.full || t.busy || !t.complete) return;
    t.busy = true;
    for (let s = 0; s < t.n && !t.drop; s += 12) {
      const ks = [];
      for (let k = s; k < Math.min(t.n, s + 12); k++) if (!t.md[k]) ks.push(k);
      await Promise.all(ks.map(async (k) => { t.md[k] = await bitmap(t.blobs[k]); }));
      t.dirty = true;
    }
    t.busy = false;
    if (t.drop) freeFull(t); else t.full = true;
  }
  function freeFull(t) {
    for (const b of t.md) if (b) b.close();
    t.md = new Array(t.n); t.full = false; t.drop = false; t.dirty = true;
  }
  async function loadHi(t, i) {       // кадры полного размера — только у выбранной вещи
    if (t.hiState) return;
    t.hiState = 1;
    try {
      const ks = hiFrames(i, t.n);
      const got = await fetchAll(ks.map((k) => frameUrl(t, "hi", k)));
      await Promise.all(ks.map(async (k, j) => { t.hi[k] = await bitmap(got[j]); }));
      if (t.hiState === 1) { t.hiState = 2; t.dirty = true; } else freeHi(t);
    } catch (e) { t.hiState = 0; }
  }
  function freeHi(t) {
    for (const b of t.hi) if (b) b.close();
    t.hi = new Array(t.n); t.hiState = 0; t.dirty = true;
  }
  function frameOf(t, k, sharp) {        // t.at — номер кадра, который реально отдан
    t.at = k;
    if (sharp && t.hi[k]) return t.hi[k];
    if (t.md[k]) return t.md[k];
    if (t.sm[k]) return t.sm[k];
    for (let j = 1; j < t.n; j++) {         // нужный кадр ещё не загружен — берём ближайший готовый
      const a = mod(k - j, t.n), b = mod(k + j, t.n);
      if (t.md[a] || t.sm[a]) { t.at = a; return t.md[a] || t.sm[a]; }
      if (t.md[b] || t.sm[b]) { t.at = b; return t.md[b] || t.sm[b]; }
    }
    return null;
  }

  const dist = (node) => { const i = nodes.indexOf(node); return i === S.active ? -1 : Math.abs(wrap(i - S.pos)); };

  // ---------- цвет ----------
  const hexRgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));
  const mixHex = (rgb, k) => "#" + rgb.map((v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, "0")).join("");
  function setColor(id) {
    const c = COLORS.find((x) => x.id === id) || COLORS[0];
    const rgb = hexRgb(c.hex);
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    S.color = { ...c, t: rgb.map((v) => v / 255), lum };
    const st = document.documentElement.style;
    st.setProperty("--accent", c.hex);
    st.setProperty("--accent-hi", mixHex(rgb, 0.3));
    st.setProperty("--on", lum > 0.55 ? "#0d0d0d" : "#ffffff");
    st.setProperty("--accent-ink", lum < 0.3 ? mixHex(rgb, 0.38) : c.hex);
    // сцена презентации: тёмный тон цвета вещи — на нём вещь читается, а не сливается с заливкой
    const tone = (k, add) => "#" + rgb.map((v) => Math.round(v * k + add).toString(16).padStart(2, "0")).join("");
    const soft = rgb.map((v) => Math.round(v + (255 - v) * 0.35)).join(", ");
    st.setProperty("--stage", tone(0.2, 9));
    st.setProperty("--stage-hi", tone(0.27, 14));
    st.setProperty("--lit", lum < 0.45 ? mixHex(rgb, 0.45) : c.hex);
    st.setProperty("--glow", `rgba(${soft}, .42)`);
    st.setProperty("--glow-2", `rgba(${soft}, .16)`);
    st.setProperty("--glow-d", `rgba(${soft}, .78)`);
    st.setProperty("--glow-d2", `rgba(${soft}, .36)`);
    app.dataset.on = lum > 0.55 ? "dark" : "light";
    document.querySelectorAll("[data-swatches] button").forEach((b) => b.classList.toggle("on", b.dataset.id === c.id));
    try { localStorage.setItem("izum-color", c.id); } catch (e) { /* хранилище недоступно — не страшно */ }
  }

  // ---------- нанесение ----------
  const PRINT_W = 1024, ZERO4 = [0, 0, 0, 0];
  // Раскладки паттерна: gx, gy — шаг по горизонтали и зазор между рядами в ширинах логотипа,
  // brick — второй ряд сдвинут на полшага, k — размер, ang — наклон, flip — второй ряд перевёрнут.
  const PATTERNS = {
    brick: { gx: 1.6, gy: 0.42, brick: true, k: 1, ang: 0.2 },
    grid: { gx: 1.5, gy: 0.5, brick: false, k: 1, ang: 0 },
    diagonal: { gx: 1.7, gy: 0.55, brick: true, k: 1.1, ang: 0.62 },
    dense: { gx: 1.22, gy: 0.16, brick: true, k: 0.58, ang: 0.2 },
    lines: { gx: 1.08, gy: 0.5, brick: true, k: 0.8, ang: 0 },
    flip: { gx: 1.45, gy: 0.3, brick: true, k: 1, ang: 0, flip: true },
  };
  const tmp = document.createElement("canvas"), tmpX = tmp.getContext("2d");

  // Логотип в нужном цвете: «как в файле», белый или чёрный; текст — контрастно к поверхности вещи.
  function inked(i, z) {
    let tint = C.tint;
    if (tint === "orig" && C.mono) {               // текст — контрастно к той части вещи, куда он ложится
      const inside = C.mode === "pattern" && C.part === 2;
      const surf = inside ? (ITEMS[i].inner || {}).surf || "accent" : z.surf;
      tint = surf === "dark" || S.color.lum <= 0.55 ? "white" : "black";
    }
    if (tint === "orig") return C.src;
    tmp.width = C.src.width; tmp.height = C.src.height;
    tmpX.globalCompositeOperation = "source-over";
    tmpX.clearRect(0, 0, tmp.width, tmp.height);
    tmpX.drawImage(C.src, 0, 0);
    tmpX.globalCompositeOperation = "source-in";
    tmpX.fillStyle = tint === "white" ? "#f5f5f1" : tint === "custom" ? C.ink : "#151515";
    tmpX.fillRect(0, 0, tmp.width, tmp.height);
    return tmp;
  }
  // Зона печати — отдельный холст: логотип вписывается в неё целиком и не может выйти за край.
  const printCv = document.createElement("canvas"), printX = printCv.getContext("2d");
  function fitLogo(i, t, z) {
    const o = off(i, z.id), W = PRINT_W, H = Math.round(PRINT_W / t.zg[z.id].aspect);
    const box = Math.min(1, 0.8 * C.scale);
    const k = Math.min((W * box) / C.src.width, (H * box) / C.src.height);
    const w = C.src.width * k, h = C.src.height * k;
    const mx = (W - w) / 2 / W, my = (H - h) / 2 / H;        // насколько можно сдвинуть, не выходя из зоны
    o.x = clamp(o.x, -mx, mx); o.y = clamp(o.y, -my, my);
    return { W, H, w, h, x: W * (0.5 + o.x) - w / 2, y: H * (0.5 + o.y) - h / 2 };
  }
  function syncPrint(i, t, z) {
    const key = C.ver + "|" + C.pat + "|" + z.id + "|" + (C.mono && C.tint === "orig" ? S.color.id : "");
    if (C.mode === "logo") {
      if (t.printKey === key) return;
      t.printKey = key;
      const b = fitLogo(i, t, z);
      printCv.width = b.W; printCv.height = b.H;
      printX.clearRect(0, 0, b.W, b.H);
      printX.imageSmoothingQuality = "high";
      printX.drawImage(inked(i, z), b.x, b.y, b.w, b.h);
      upload(t.G, 1, t.G.texP, printCv, true);
    } else {
      if (t.tileKey === key) return;
      t.tileKey = key;
      // Плитка паттерна — два ряда; раскладка задаёт шаг, сдвиг второго ряда, размер и переворот.
      const P = PATTERNS[C.pat] || PATTERNS.brick;
      const w = t.fw * 0.15 * C.scale * P.k, h = (w * C.src.height) / C.src.width;
      const tw = w * P.gx, rowH = h + w * P.gy, th = 2 * rowH, q = 260 / w;
      printCv.width = Math.max(2, Math.round(tw * q)); printCv.height = Math.max(2, Math.round(th * q));
      printX.clearRect(0, 0, printCv.width, printCv.height);
      printX.imageSmoothingQuality = "high";
      const src = inked(i, z), W = printCv.width, H = printCv.height, lw = w * q, lh = h * q;
      const put = (cx, cy, flip) => {
        printX.save(); printX.translate(cx, cy); if (flip) printX.rotate(Math.PI);
        printX.drawImage(src, -lw / 2, -lh / 2, lw, lh); printX.restore();
      };
      put(W / 2, H * 0.25, false);
      if (P.brick) { put(0, H * 0.75, P.flip); put(W, H * 0.75, P.flip); } else put(W / 2, H * 0.75, P.flip);
      upload(t.G, 2, t.G.texT, printCv, true);
      t.tile = [tw, th]; t.rot = [Math.cos(P.ang), Math.sin(P.ang)];
    }
  }

  // Один кадр вещи. z — место нанесения, которое сейчас смотрит в камеру; theta — на сколько градусов
  // вещь от него отвёрнута (со знаком).
  function paint(i, t, img, lk, theta, z) {
    if (t.G && t.G.gl.isContextLost()) { t.G = null; t.ctx = null; t.glTries = Math.min(t.glTries, GL_TRIES - 3); }
    if (!t.G && (!t.ctx || (t.glTries < GL_TRIES && performance.now() - t.glAt > GL_RETRY))) resetCanvas(t);
    if (!t.G) {                                  // нет WebGL2 — показываем вещь как есть, без перекраски и нанесения
      t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
      t.ctx.drawImage(img, 0, 0, t.canvas.width, t.canvas.height);
      return;
    }
    const { gl, u } = t.G, pr = z || ZONES[i][0], zg = t.zg[pr.id];
    if (t.texImg !== img) { t.texImg = img; upload(t.G, 0, t.G.texF, img, false); }
    const on = lk > 0 && C.src;
    if (on) syncPrint(i, t, pr);
    gl.viewport(0, 0, t.canvas.width, t.canvas.height);
    gl.uniform3fv(u.uCol, S.color.t);
    gl.uniform1f(u.uRec, S.color.id === "yellow" ? 0 : 1);
    gl.uniform1i(u.uMode, !on ? 0 : C.mode === "pattern" ? 2 : 1);
    gl.uniform1f(u.uK, lk * 0.97);
    gl.uniform1f(u.uSurf, pr.surf === "dark" ? 1 : 0);
    const inn = ITEMS[i].inner || {};
    gl.uniform1f(u.uSurfB, inn.surf === "dark" ? 1 : 0);
    gl.uniform4fv(u.uEb, inn.in || ZERO4);
    gl.uniform4fv(u.uEx, inn.cut || ZERO4);
    gl.uniform2f(u.uPart, C.part & 1 ? 1 : 0, C.part & 2 ? 1 : 0);
    gl.uniformMatrix3fv(u.uH, false, zg.H);
    gl.uniform1f(u.uArc, pr.arc || 0);
    gl.uniform1f(u.uDisp, (C.mode === "pattern" ? 0.1 : 0.07) * (pr.surf === "dark" ? 0.35 : 1));   // на чёрном стёганом рельеф резкий — сдвигаем слабее
    gl.uniform2f(u.uSize, t.fw, t.fh);
    gl.uniform2f(u.uTile, t.tile[0], t.tile[1]);
    gl.uniform2f(u.uRot, t.rot[0], t.rot[1]);
    // вещь — примерно цилиндр: при повороте зона печати уезжает вбок и сжимается
    const phi = ((pr.phi || 0) * Math.PI) / 180, a = phi + ((pr.dir || 1) * theta * Math.PI) / 180;
    gl.uniform1f(u.uAxis, zg.axis);
    gl.uniform1f(u.uShift, (pr.r || 0) * (Math.sin(a) - Math.sin(phi)));
    gl.uniform1f(u.uSquash, clamp(Math.cos(a) / Math.cos(phi), 0.2, 1.7));
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function logoChanged() {
    C.ver++;
    app.dataset.logo = C.src ? "1" : "0";
    app.dataset.pattern = C.mode === "pattern" ? "1" : "0";
    showZones(S.active);
    $("toolHint").textContent = !C.src ? "Загрузите файл или напишите название — логотип сразу ляжет в зону печати."
      : C.mode === "pattern" ? "Паттерн покрывает вещь целиком. Размер — ползунком или колесом мыши над вещью."
      : "Двигайте логотип прямо на вещи — за зону печати он не выйдет. Размер — ползунком или колесом мыши.";
  }

  // Картинка → canvas: уменьшаем, у непрозрачных файлов с белым фоном убираем фон, обрезаем поля.
  function useImage(img) {
    const iw = img.naturalWidth || img.width || 512, ih = img.naturalHeight || img.height || 512;
    const k = Math.min(1, 1600 / Math.max(iw, ih));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(iw * k)); cv.height = Math.max(1, Math.round(ih * k));
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, cv.width, cv.height);
    const im = g.getImageData(0, 0, cv.width, cv.height), d = im.data, W = cv.width, H = cv.height;
    let opaque = true;
    for (let p = 3; p < d.length; p += 4) if (d[p] < 250) { opaque = false; break; }
    if (opaque) {
      // Фон убираем, только если он действительно белый: смотрим на рамку картинки.
      // У фотографии с тёмным или цветным фоном ничего не трогаем — она ляжет прямоугольным принтом.
      let white = 0, cnt = 0;
      const probe = (x, y) => { const p = (y * W + x) * 4; cnt++; if (Math.min(d[p], d[p + 1], d[p + 2]) >= 244) white++; };
      for (let x = 0; x < W; x += 3) { probe(x, 0); probe(x, H - 1); }
      for (let y = 0; y < H; y += 3) { probe(0, y); probe(W - 1, y); }
      if (white / cnt > 0.9) {
        for (let p = 0; p < d.length; p += 4) {
          const mn = Math.min(d[p], d[p + 1], d[p + 2]);
          d[p + 3] = mn >= 250 ? 0 : mn <= 215 ? 255 : Math.round(((250 - mn) / 35) * 255);
        }
      }
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return false;                          // пустая картинка
    g.putImageData(im, 0, 0);
    const out = document.createElement("canvas");
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext("2d").drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    C.src = out; C.mono = false;
    logoChanged();
    return true;
  }
  function useFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { useImage(img); URL.revokeObjectURL(url); C.text = ""; $("textLogo").value = ""; if (S.active < 0) open(Math.round(S.target), CUSTOM); else setChapter(CUSTOM); };
    img.onerror = () => { URL.revokeObjectURL(url); $("toolHint").textContent = "Не получилось прочитать файл. Подойдёт PNG, SVG или JPG."; };
    img.src = url;
  }
  // Свой текст: до двух строк, выбранным шрифтом. Цвет — как у любого нанесения (авто, белый, чёрный, свой).
  const FONTS = {
    gotham: { css: 'italic 900 300px "Gotham Pro", Arial, sans-serif', upper: true },
    bold: { css: '700 300px "Gotham Pro", Arial, sans-serif', upper: false },
    serif: { css: 'italic 700 300px Georgia, "Times New Roman", serif', upper: false },
    impact: { css: '400 300px Impact, "Arial Narrow", sans-serif', upper: true },
  };
  async function useText(s) {
    C.text = s;
    const f = FONTS[C.font] || FONTS.gotham;
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2).map((l) => (f.upper ? l.toUpperCase() : l));
    if (!lines.length) { if (C.mono) { C.src = null; logoChanged(); } return; }
    try { await document.fonts.load(f.css, lines.join("")); } catch (e) { /* возьмём запасной шрифт */ }
    if (C.text !== s) return;                           // пока грузился шрифт, текст уже изменили
    const cv = document.createElement("canvas"), g = cv.getContext("2d");
    g.font = f.css;
    const LH = 330, w = Math.max(...lines.map((l) => g.measureText(l).width));
    cv.width = Math.ceil(w) + 120; cv.height = LH * lines.length + 60;
    g.font = f.css; g.textBaseline = "middle"; g.textAlign = "center"; g.fillStyle = "#141414";
    lines.forEach((l, k) => g.fillText(l, cv.width / 2, 30 + LH * (k + 0.5)));
    C.src = cv; C.mono = true;
    logoChanged();
  }

  // ---------- геометрия ----------
  function layout() {
    S.W = app.clientWidth; S.H = app.clientHeight;
    S.mobile = S.W <= 820;
    S.size = S.mobile ? Math.min(S.W * 0.44, S.H * 0.28) : Math.min(S.H * 0.3, S.W * 0.2);
    S.R = S.size / STEP * (S.mobile ? 1.15 : 1.02);
    const boxW = S.mobile ? S.W * 0.66 : S.W * 0.4;
    const boxH = S.mobile ? S.H * 0.25 : S.H * 0.62;
    ITEMS.forEach((it, i) => {
      const n = nodes[i];
      const long = Math.max(it.w, it.h), short = Math.min(it.w, it.h);
      const k = (S.size / long) * Math.min(1.28, Math.pow(long / short, 0.3));
      n.w = it.w * k; n.hgt = it.h * k;
      n.el.style.width = n.w + "px"; n.el.style.height = n.hgt + "px";
      n.el.style.margin = `${-n.hgt / 2}px 0 0 ${-n.w / 2}px`;
      n.heroK = Math.min(boxW / n.w, boxH / n.hgt);
      if (n.turn) {   // совмещаем вещь в кадре с рамкой вырезки
        const t = n.turn, q = n.hgt / t.oh, c = t.canvas.style;
        c.width = t.fw * q + "px"; c.height = t.fh * q + "px";
        c.left = (n.w - t.ow * q) / 2 - t.ox * q + "px"; c.top = -t.oy * q + "px";
        // размеры зоны печати в пикселях кадра: по ним считаются пропорции холста нанесения и перетаскивание
        const len = (a, b) => Math.hypot((a[0] - b[0]) * t.fw, (a[1] - b[1]) * t.fh);
        for (const z of ZONES[i]) {
          const Q = z.quad, g = t.zg[z.id];
          g.areaW = (len(Q[0], Q[1]) + len(Q[3], Q[2])) / 2; g.areaH = (len(Q[0], Q[3]) + len(Q[1], Q[2])) / 2;
          g.aspect = g.areaW / g.areaH;
          g.axis = (Q[0][0] + Q[1][0] + Q[2][0] + Q[3][0]) / 4;
        }
      }
    });
    const cy = S.H * 0.44;
    pedTop.style.top = cy - S.size * 0.92 + "px";
    pedBottom.style.top = cy + S.size * 0.74 + "px";
  }

  // ---------- кадр ----------
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!S.visible) return;
    const t = now / 1000;
    const { W, H, size, R } = S;

    S.pos += (S.target - S.pos) * (1 - Math.exp(-dt * 7));
    S.g += ((S.active >= 0 ? 1 : 0) - S.g) * (1 - Math.exp(-dt * 5));
    S.flat += ((S.active >= 0 && S.chapter === CUSTOM ? 1 : 0) - S.flat) * (1 - Math.exp(-dt * 5));

    const heroX = S.mobile ? 0 : W * 0.19;
    const heroY = S.mobile ? -H * 0.27 : H * 0.03;
    const baseY = -H * 0.06;

    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      n.h = clamp(n.h + (i === S.active ? dt / 1.15 : -dt / 0.85), 0, 1);
      if (n.rotT !== n.rotGoal) {            // новая цель — новый отрезок движения
        n.rotGoal = n.rotT; n.rotFrom = n.rot; n.rotT0 = t;
        n.rotDur = clamp((Math.abs(n.rotT - n.rot) / 360) * 2.1, 0.7, 2.4);
      }
      const u = clamp((t - n.rotT0) / n.rotDur, 0, 1);
      n.rot = lerp(n.rotFrom, n.rotT, u * u * u * (u * (u * 6 - 15) + 10));
      if (n.h === 0 && u === 1) { n.rot = n.rotT = n.rotGoal = n.rotFrom = 0; }
      const e = ease(n.h);

      // положение в очереди
      const d = wrap(i - S.pos), ad = Math.abs(d), ang = d * STEP;
      const near = smooth(clamp(1 - ad, 0, 1));
      let x = Math.sin(ang) * R;
      let z = (Math.cos(ang) - 1) * R * 0.8;
      let y = baseY + Math.sin(t * 0.9 + i * 1.3) * size * 0.04 * (1 - near * 0.6);
      let sc = 0.8 + 0.42 * near;
      let rz = (Math.sin(i * 2.1) * 10 + Math.sin(t * 0.5 + i) * 3.5) * (1 - near * 0.9);
      // Вещи с кадрами оборота поворачиваются только вперёд от исходной позы и без покачивания по углу.
      let ry = n.turn ? (Math.abs(ang) * 0.3 * 180) / Math.PI
                      : (-ang * 0.3 * 180) / Math.PI + Math.sin(t * 0.4 + i * 0.7) * 5 * (1 - near);
      let op = clamp((3.9 - ad) / 1.2, 0, 1);

      // остальные вещи отступают, когда одна выбрана
      const away = S.g * (1 - e);
      op *= 1 - away;
      z -= away * 520;
      y += away * H * 0.06;

      // подлёт к камере
      if (e > 0) {
        const arc = Math.sin(e * Math.PI);
        x = lerp(x, heroX, e);
        y = lerp(y, heroY + Math.sin(t * 1.1) * 7 * (1 - S.flat * 0.7), e) - arc * H * 0.05;
        z = lerp(z, 60, e) + arc * 300;
        sc = lerp(sc, n.heroK, e);
        rz = lerp(rz, (-6 + Math.sin(t * 0.7) * 1.4) * (1 - S.flat), e);
        ry = lerp(ry, n.turn ? 0 : Math.sin(t * 0.6) * 5, e);
        op = lerp(op, 1, e);
      }
      ry += n.rot;

      if (n.turn) {   // весь оборот держим только у вещи в центре и у выбранной; полный размер — только у выбранной
        const tt = n.turn, mine = i === S.active || n.h > 0, want = mine || (S.active < 0 && ad < 0.6);
        if (want) { tt.drop = false; if (!tt.full && !tt.busy) decodeFull(tt); }
        else if (ad > 1.6) { if (tt.busy) tt.drop = true; else if (tt.full || tt.md.some(Boolean)) freeFull(tt); }
        if (i === S.active) loadHi(tt, i);
        else if (!mine && tt.hiState) { if (tt.hiState === 2) freeHi(tt); else tt.hiState = 3; }
        const cw = mine ? tt.fw : tt.lw, chh = mine ? tt.fh : tt.lh;      // у камеры холст в полном размере
        if (tt.canvas.width !== cw) { tt.canvas.width = cw; tt.canvas.height = chh; tt.dirty = true; }
      }

      const vis = op > 0.01;
      n.el.style.visibility = n.sh.style.visibility = vis ? "visible" : "hidden";
      if (!vis) continue;
      n.el.style.opacity = op;
      n.el.style.zIndex = e > 0 ? 5 : 1;
      n.el.style.pointerEvents = op > 0.5 ? "auto" : "none";
      if (n.turn) {
        const tt = n.turn;
        // Всегда один чёткий кадр — ближайший к углу (смесь соседних даёт двойной контур).
        const want = mod(Math.round((ry / 360) * tt.n), tt.n);
        const img = frameOf(tt, want, true), kf = tt.at;
        // Пока нужного кадра нет (медленная сеть), показываем ближайший загруженный и доворачиваем его
        // в объёме на недостающий угол — вещь вращается с первой секунды, а не стоит плоской картинкой.
        let lack = ry - (kf / tt.n) * 360; lack = mod(lack + 180, 360) - 180;
        if (kf === want) lack = 0;
        // Логотип держится на вещи, пока его место смотрит в камеру, и растворяется при развороте.
        // Паттерн идёт по всей вещи и виден с любой стороны.
        let zone = null, theta = 0, lk = 0;
        if (C.src && C.mode === "pattern") lk = 1;
        else if (C.src) {
          let best = 1e9;
          for (const zz of ZONES[i]) {
            if (!C.places[zz.id]) continue;
            let dk = mod(kf - zz.k, tt.n); if (dk > tt.n / 2) dk -= tt.n;
            if (Math.abs(dk) < best) { best = Math.abs(dk); zone = zz; theta = (dk / tt.n) * 360; }
          }
          if (zone) lk = Math.round(clamp(((zone.r ? 36 : 19) - Math.abs(theta)) / 10, 0, 1) * 20) / 20;
        }
        if (Math.abs(lack) > 75 && C.mode !== "pattern") lk = 0;   // довёрнутый «спиной» кадр — без зеркального логотипа
        const pk = S.color.id + "|" + (lk ? C.ver + ":" + lk + ":" + kf + ":" + (zone ? zone.id : "") : "");
        if (img && (tt.dirty || img !== tt.shown || pk !== tt.pk)) {
          tt.shown = img; tt.dirty = false; tt.pk = pk;
          paint(i, tt, img, lk, theta, zone);
        }
        n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg)${lack ? ` rotateY(${lack}deg)` : ""} scale(${sc})`;
        n.sh.style.visibility = "hidden";   // тень уже есть в кадрах
        continue;
      }
      n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg) rotateY(${ry}deg) scale(${sc})`;

      const flatK = Math.abs(Math.cos((ry * Math.PI) / 180));
      const sy = lerp(baseY + size * 0.78, heroY + (n.hgt * n.heroK) / 2 + 34, e);
      const sw = (n.w * sc * (0.25 + 0.75 * flatK)) / 100;
      n.sh.style.opacity = op * lerp(0.9, 0.55, e);
      n.sh.style.transform = `translate3d(${x}px,${sy}px,${z - 2}px) scale(${sw},${0.26 * sc})`;
    }

    const idx = mod(Math.round(S.pos), N);
    if (idx !== S.shown) showCaption(idx);
  }

  // ---------- подписи ----------
  const capName = $("capName"), capSet = $("capSet");
  function showCaption(idx) {
    S.shown = idx;
    const it = ITEMS[idx];
    capName.textContent = it.name; capSet.textContent = it.set;
    for (const el of [capName, capSet]) { el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); }
    $("count").textContent = `${pad(idx + 1)} / ${pad(N)}`;
    $("railDot").style.left = (idx / (N - 1)) * 100 + "%";
  }

  function fillPanel(i) {
    const it = ITEMS[i];
    $("dNum").textContent = pad(i + 1);
    $("dSet").textContent = it.set;
    $("dTitle").textContent = it.name;
    $("dText").textContent = it.text;
    $("dKit").innerHTML = METHODS.map((k) => `<li>${k}</li>`).join("");
    $("dSpecs").innerHTML = it.specs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    const names = (it.inner && it.inner.names) || ["Снаружи", "Внутри"];      // у каждой вещи свои названия частей
    $("segPart").querySelector('[data-v="1"]').textContent = names[0];
    $("segPart").querySelector('[data-v="2"]').textContent = names[1];
  }

  // ---------- действия ----------
  const hint = $("hint");
  const touched = () => hint.classList.add("off");

  function go(dir) { S.target = Math.round(S.target) + dir; touched(); }

  function showChapter(c) {
    S.chapter = c;
    app.dataset.chapter = c;
    $("more").style.visibility = c === CHAPTERS - 1 ? "hidden" : "visible";
  }
  // В примерке вещь стоит тем местом к камере, которое сейчас настраивается.
  const zoneAngle = (i) => (curZone(i).k / ITEMS[i].turn.n) * 360;
  const chAngle = (c, i) => (c === CUSTOM ? zoneAngle(i) : CH_ANGLE[c]);
  function setChapter(c) {
    c = clamp(c, 0, CHAPTERS - 1);
    const n = nodes[S.active];
    if (n && c !== S.chapter) n.rotT += (c > S.chapter ? 360 : -360) + chAngle(c, S.active) - chAngle(S.chapter, S.active);
    showChapter(c);
  }

  // Выбор места: вещь поворачивается к нему кратчайшим путём, логотип появляется там.
  // Повторное нажатие на текущее место убирает логотип оттуда.
  function setZone(id) {
    const i = S.active;
    if (i >= 0 && !ZONES[i].some((z) => z.id === id)) return;
    if (id === C.zone && i >= 0) C.places[id] = !C.places[id];
    else {
      const before = i >= 0 ? zoneAngle(i) : 0;
      C.zone = id; C.places[id] = true;
      if (i >= 0 && S.chapter === CUSTOM) nodes[i].rotT += mod(zoneAngle(i) - before + 180, 360) - 180;
    }
    logoChanged();
  }
  function showZones(i) {
    $("segZone").querySelectorAll("button").forEach((b) => {
      const has = i >= 0 && ZONES[i].some((z) => z.id === b.dataset.v);
      b.hidden = !has;
      b.classList.toggle("on", b.dataset.v === curZone(Math.max(i, 0)).id);
      b.classList.toggle("has", !!C.places[b.dataset.v]);
    });
    app.dataset.zones = i >= 0 && ZONES[i].length > 1 ? "1" : "0";
  }

  function release(i) {
    const n = nodes[i];
    n.rotT = Math.round(n.rot / 360) * 360;   // вещь доворачивается лицом и уходит в очередь
  }

  function open(i, ch = 0) {
    i = mod(i, N);
    if (S.active === i) { setChapter(ch); return; }
    if (S.active >= 0) release(S.active);
    S.target = Math.round(S.pos + wrap(i - S.pos));
    S.active = i;
    app.dataset.body = ITEMS[i].print && ITEMS[i].print.surf === "dark" ? "dark" : "light";   // чёрной вещи нужна подсветка сильнее
    if (!ZONES[i].some((z) => z.id === C.zone)) C.zone = "front";   // у этой вещи такого места нет
    const n = nodes[i];
    n.rotT = Math.round(n.rot / 360) * 360 + 360 + chAngle(ch, i);
    fillPanel(i);
    showZones(i);
    showChapter(ch);
    app.dataset.mode = "detail";
    touched();
  }

  function close() {
    if (S.active < 0) return;
    release(S.active);
    S.active = -1;
    app.dataset.mode = "browse";
  }

  // ---------- заявка с макетом ----------
  function mockup() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1400;
    const g = cv.getContext("2d");
    g.fillStyle = S.color.hex; g.fillRect(0, 0, 1400, 1400);
    const glow = g.createRadialGradient(700, 670, 0, 700, 670, 670);
    glow.addColorStop(0, "rgba(255,255,255,.9)"); glow.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = glow; g.fillRect(0, 0, 1400, 1400);
    const i = S.active, t = nodes[i] && nodes[i].turn;
    if (t) {
      const z = curZone(i), img = frameOf(t, C.mode === "logo" && C.places[z.id] ? z.k : 0, true);
      if (img) paint(i, t, img, C.src ? 1 : 0, 0, z);   // кадр выбранного места; рисуем и сразу читаем, пока буфер WebGL не сброшен
      const k = Math.min(1100 / t.fw, 1100 / t.fh);
      g.imageSmoothingQuality = "high";
      g.drawImage(t.canvas, (1400 - t.fw * k) / 2, (1400 - t.fh * k) / 2, t.fw * k, t.fh * k);
      t.dirty = true;
    }
    return cv;
  }
  const order = $("lead");
  let shotBlob = null;
  function openOrder() {
    if (S.active < 0) return;
    const it = ITEMS[S.active], cv = mockup();
    const url = cv.toDataURL("image/png");
    $("leadImg").src = url;
    $("leadSave").href = url;
    cv.toBlob((b) => { shotBlob = b; });
    const where = ZONES[S.active].filter((z) => C.places[z.id]).map((z) => PLACE_NAMES[z.id].toLowerCase()).join(", ");
    const how = !C.src ? "без нанесения" : C.mode === "pattern" ? "паттерн" : "логотип" + (where ? ": " + where : "");
    $("leadSum").textContent = `${it.name} · ${S.color.name.toLowerCase()} · ${how}`;
    order.hidden = false;
    order.querySelector("input").focus();
  }
  const closeOrder = () => { order.hidden = true; };
  $("leadBtn").addEventListener("click", openOrder);
  $("leadX").addEventListener("click", closeOrder);
  order.addEventListener("pointerdown", (ev) => { if (ev.target === order) closeOrder(); });
  $("leadForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target), it = ITEMS[S.active];
    const lines = [
      "Здравствуйте! Хочу получить расчёт.",
      `Изделие: ${it.name}`,
      `Цвет: ${S.color.name.toLowerCase()}`,
      `Нанесение: ${!C.src ? "нет" : C.mode === "pattern" ? "паттерн" : "логотип (" + ZONES[S.active].filter((z) => C.places[z.id]).map((z) => PLACE_NAMES[z.id].toLowerCase()).join(", ") + ")"}`,
      f.get("qty") ? `Тираж: ${f.get("qty")}` : "",
      f.get("company") ? `Компания: ${f.get("company")}` : "",
      `Имя: ${f.get("name")}`,
      `Телефон: ${f.get("phone")}`,
    ].filter(Boolean);
    // Когда появится приём заявок на сервере, достаточно задать window.IZUM_LEAD_ENDPOINT —
    // туда уйдут поля формы и картинка макета. Пока его нет, заявка открывается в WhatsApp.
    if (window.IZUM_LEAD_ENDPOINT) {
      f.append("item", it.name); f.append("color", S.color.name);
      if (shotBlob) f.append("mockup", shotBlob, "izum-maket.png");
      const note = $("leadNote");
      try {
        const r = await fetch(window.IZUM_LEAD_ENDPOINT, { method: "POST", body: f });
        if (!r.ok) throw new Error(r.status);
        note.textContent = "Заявка отправлена. Менеджер свяжется с вами в рабочее время.";
      } catch (e) { note.textContent = "Не получилось отправить заявку. Напишите нам в WhatsApp: +7 (777) 173 74 75."; }
      return;
    }
    window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener");
  });

  // ---------- ввод ----------
  let wheelLock = 0;
  app.addEventListener("wheel", (ev) => {
    const now = performance.now();
    const horiz = Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
    if (S.active < 0) {                      // в очереди колесо листает страницу; горизонтальная прокрутка — очередь
      if (!horiz) return;
      ev.preventDefault();
      if (Math.abs(ev.deltaX) < 4 || now < wheelLock) return;
      wheelLock = now + 170;
      go(ev.deltaX > 0 ? 1 : -1);
      return;
    }
    ev.preventDefault();
    const delta = horiz ? ev.deltaX : ev.deltaY;
    if (S.chapter === CUSTOM && C.src && pick(ev.clientX, ev.clientY) === S.active) {   // над вещью — размер нанесения
      setScale(C.scale * Math.exp(-delta * 0.0016));
      return;
    }
    if (Math.abs(delta) < 4 || now < wheelLock) return;
    wheelLock = now + 650;
    const c = S.chapter + (delta > 0 ? 1 : -1);
    if (c < 0 || c >= CHAPTERS) close(); else setChapter(c);
  }, { passive: false });

  // Вещь под курсором ищем по её экранному прямоугольнику: боковые стоят глубже плоскости сцены,
  // и обычный hit-test браузера до них не доходит.
  function pick(px, py) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const el = nodes[i].el;
      if (el.style.visibility === "hidden" || +el.style.opacity < 0.5) continue;
      const r = el.getBoundingClientRect();
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue;
      const d = i === S.active ? -1 : Math.abs(wrap(i - S.pos));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  let drag = null;
  stage.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const hit = pick(ev.clientX, ev.clientY);
    drag = { x: ev.clientX, y: ev.clientY, start: S.target, moved: false, hit, id: ev.pointerId, logo: null };
    if (S.active >= 0 && S.chapter === CUSTOM && C.src && C.mode === "logo" && hit === S.active) {
      const o = off(S.active, curZone(S.active).id);
      drag.logo = { x: o.x, y: o.y };
      stage.classList.add("moving");
    }
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 7) {
      if (!drag.logo && S.active < 0 && Math.abs(dy) > Math.abs(dx) * 1.3 && ev.pointerType !== "mouse") { drag = null; return; }   // вертикальный свайп — прокрутка страницы
      drag.moved = true; touched();
      if (!drag.logo) stage.classList.add("dragging");
    }
    if (!drag.moved) return;
    if (drag.logo) {                         // логотип едет за курсором внутри зоны печати
      const i = S.active, t = nodes[i].turn;
      const z = curZone(i), g = t.zg[z.id], r = t.canvas.getBoundingClientRect(), o = off(i, z.id);
      o.x = drag.logo.x + (dx / r.width) * (t.fw / g.areaW);
      o.y = drag.logo.y + (dy / r.height) * (t.fh / g.areaH);
      fitLogo(i, t, z);                      // не даём выйти за край зоны
      C.ver++;
    } else if (S.active < 0) S.target = drag.start - dx / (S.R * STEP);
  });
  stage.addEventListener("mousemove", (ev) => {
    if (drag) return;
    const hit = pick(ev.clientX, ev.clientY);
    stage.style.cursor = hit < 0 ? "" : hit === S.active && S.chapter === CUSTOM && C.src && C.mode === "logo" ? "move" : "pointer";
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    stage.classList.remove("dragging", "moving");
    if (d.logo) return;
    if (d.moved) {
      if (S.active >= 0) { const dx = ev.clientX - d.x; if (Math.abs(dx) > 60) open(S.active + (dx < 0 ? 1 : -1), S.chapter); }
      else S.target = Math.round(S.target);
    } else if (d.hit >= 0) {
      if (S.active !== d.hit) open(d.hit);
      else if (S.chapter !== CUSTOM) close();
    }
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  window.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (!order.hidden) { if (k === "Escape") closeOrder(); return; }
    if (!S.visible || ev.target.closest("input, select, textarea")) return;
    if (S.active >= 0) {
      if (k === "Escape") close();
      else if (k === "ArrowRight") open(S.active + 1, S.chapter);
      else if (k === "ArrowLeft") open(S.active - 1, S.chapter);
      else if (k === "ArrowDown" || k === "PageDown") { ev.preventDefault(); S.chapter === CHAPTERS - 1 ? close() : setChapter(S.chapter + 1); }
      else if (k === "ArrowUp" || k === "PageUp") { ev.preventDefault(); S.chapter === 0 ? close() : setChapter(S.chapter - 1); }
    } else if (window.scrollY < 40) {
      if (k === "ArrowRight") go(1);
      else if (k === "ArrowLeft") go(-1);
      else if (k === "Enter" && !ev.target.closest("a, button")) open(Math.round(S.target));
    }
  });

  $("prev").addEventListener("click", () => go(-1));
  $("next").addEventListener("click", () => go(1));
  $("openBtn").addEventListener("click", () => open(Math.round(S.target), CUSTOM));
  $("tryBtn").addEventListener("click", () => setChapter(CUSTOM));
  $("back").addEventListener("click", close);
  $("more").addEventListener("click", () => setChapter(S.chapter + 1));
  $("dPrev").addEventListener("click", () => open(S.active - 1, S.chapter));
  $("dNext").addEventListener("click", () => open(S.active + 1, S.chapter));
  $("dots").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setChapter(+b.dataset.ch); });

  // цвет
  document.querySelectorAll("[data-swatches]").forEach((box) => {
    box.innerHTML = COLORS.map((c) => `<button type="button" data-id="${c.id}" style="--c:${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join("");
    box.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) { setColor(b.dataset.id); touched(); } });
  });

  // примерка
  const sizeIn = $("size");
  function setScale(v) { C.scale = clamp(v, 0.3, 1.25); sizeIn.value = Math.round(C.scale * 100); C.ver++; }
  sizeIn.addEventListener("input", () => { C.scale = sizeIn.value / 100; C.ver++; });
  $("file").addEventListener("change", (ev) => { useFile(ev.target.files[0]); ev.target.value = ""; });
  $("textLogo").addEventListener("input", (ev) => useText(ev.target.value));
  const seg = (id, key) => $(id).addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    C[key] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    logoChanged();
  });
  seg("segMode", "mode"); seg("segTint", "tint"); seg("segPat", "pat");
  $("segZone").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setZone(b.dataset.v); });
  $("segPart").addEventListener("click", (ev) => {              // маска паттерна: снаружи / внутри / везде
    const b = ev.target.closest("button"); if (!b) return;
    C.part = +b.dataset.v;
    $("segPart").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    logoChanged();
  });
  $("segFont").addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    C.font = b.dataset.v;
    $("segFont").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    if (C.text) useText(C.text);
  });
  $("ink").addEventListener("input", (ev) => {                  // свой цвет нанесения
    C.ink = ev.target.value; C.tint = "custom";
    $("segTint").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    $("ink").parentElement.classList.add("on");
    logoChanged();
  });
  $("segTint").addEventListener("click", () => $("ink").parentElement.classList.remove("on"));
  $("clearBtn").addEventListener("click", () => { C.src = null; C.text = ""; $("textLogo").value = ""; C.off = ITEMS.map(() => ({})); C.places = { front: true, back: false, sleeve: false }; setZone("front"); C.places.front = true; logoChanged(); });

  // файл можно бросить прямо на первый экран
  let dropDepth = 0;
  app.addEventListener("dragenter", (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes("Files")) { dropDepth++; app.classList.add("dropping"); } });
  app.addEventListener("dragleave", () => { if (--dropDepth <= 0) { dropDepth = 0; app.classList.remove("dropping"); } });
  app.addEventListener("dragover", (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes("Files")) ev.preventDefault(); });
  app.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
    ev.preventDefault(); dropDepth = 0; app.classList.remove("dropping");
    useFile(ev.dataTransfer.files[0]);
  });

  if ("IntersectionObserver" in window) new IntersectionObserver((es) => { S.visible = es[0].isIntersecting; }).observe(app);
  window.addEventListener("resize", layout);

  let saved = null;
  try { saved = localStorage.getItem("izum-color"); } catch (e) { /* нет доступа к хранилищу */ }
  setColor(saved || COLORS[0].id);
  logoChanged();
  layout();
  nodes.forEach(startTurn);
  requestAnimationFrame(frame);

  // Для проверки из консоли. grid() кладёт в зону печати разметочную сетку — по ней подгоняются углы зоны в data.js.
  function grid() {
    const cv = document.createElement("canvas"); cv.width = 800; cv.height = 800;
    const g = cv.getContext("2d");
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? "#e6007e" : "#ffffff"; g.fillRect(x * 100, y * 100, 100, 100); }
    g.strokeStyle = "#000"; g.lineWidth = 16; g.strokeRect(8, 8, 784, 784);
    g.beginPath(); g.moveTo(400, 0); g.lineTo(400, 800); g.moveTo(0, 400); g.lineTo(800, 400); g.lineWidth = 6; g.stroke();
    C.src = cv; C.mono = false; C.scale = 1.25; logoChanged();
  }
  window.izumHero = { open, close, go, setChapter, setColor, setZone, useText, useImage, grid, state: S, custom: C, nodes, glErrors };
})();
