/* ad.archive 새 기능 시연 재생기.
   장면 = 실제 앱(가짜 데이터)을 녹화한 화면 변화(rrweb) + 대본 시각표(자막·카메라·클릭·키).
   player.html?s=<장면>&v=<버전>[&at=<초>] — at 이 있으면 그 시각에 멈춘 한 장면(확인·미리보기용).
   설명서 본문에 iframe 으로 들어가면 본문이 보일 때만 재생한다(postMessage 'wn-visible'). */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const q = new URLSearchParams(location.search);
  const id = q.get('s') || '', ver = q.get('v') || '';
  const staticAt = q.has('at') ? Math.max(0, Number(q.get('at')) || 0) : null;
  const embedded = window.parent !== window;
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const base = new URL('.', location.href).href.replace(/\/$/, '');
  document.body.classList.toggle('embedded', embedded);
  document.body.classList.toggle('solo', !embedded);
  $('#big').href = `player.html?s=${encodeURIComponent(id)}&v=${encodeURIComponent(ver)}`;

  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 5 11 7-11 7Z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
  };
  let data, rep, cams = [], clicks = [], keys = [], caps = [], touches = [], fss = [], dur = 1;
  let phone = false, screenEl = null, phoneEl = null;   // 휴대폰 장면(viewport.mobile) — 틀 안에 휴대폰을 세우고 그 화면에 무대를 담는다
  let want = !embedded && staticAt === null && !RM.matches;   // 사용자가 원하는 상태(재생/일시정지)
  let visible = !embedded, ready = false, running = false, holdTm = 0, lastT = -1, raf = 0, userSet = false;
  let ended = false;        // 끝에 닿아 「끝 장면 잠깐 보여 주기」 중 — 이때 재생하면 언제나 처음부터
  let fromPoster = false;   // 동작 줄이기로 대표 장면에 멈춰 연 상태 — 첫 재생은 처음부터

  const ease = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const lerp = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  // 카메라: 시각표의 지시를 차례로 따라가며 그 시각의 사각형을 구한다(옮기는 중에 새 지시가 오면 지금 자리에서 이어 간다)
  function camAt(t) {
    if (!cams.length) return [0, 0, data.viewport.width, data.viewport.height];
    let from = cams[0].rect, to = cams[0].rect, t0 = 0, d = 0;
    for (const c of cams) {
      if (c.at > t) break;
      const k = d ? Math.min(1, (c.at - t0) / d) : 1;
      from = lerp(from, to, ease(k)); to = c.rect; t0 = c.at; d = (c.ms || 0) / 1000;
    }
    return lerp(from, to, ease(d ? Math.min(1, Math.max(0, (t - t0) / d)) : 1));
  }
  const now = () => !rep ? 0 : ended ? dur : Math.min(dur, Math.max(0, rep.getCurrentTime() / 1000));

  /* 휴대폰 크기 — 틀 높이의 92% 안에서 화면 비율(390×844)을 지키고, 폭이 모자라면 폭에 맞춘다. 화면 모서리 곡률은 폭의 11.5% */
  function fitPhone() {
    if (!phone) return;
    const F = $('#frame'), fh = F.clientHeight, fw = F.clientWidth, vp = data.viewport;
    const bez = Math.max(5, Math.round(Math.min(fw, fh) * 0.014));
    let sh = Math.floor(fh * 0.92) - bez * 2, sw = sh * vp.width / vp.height;
    if (sw + bez * 2 > fw * 0.94) { sw = fw * 0.94 - bez * 2; sh = sw * vp.height / vp.width; }
    sw = Math.round(sw); sh = Math.round(sh);
    const sr = Math.round(sw * 0.115);
    Object.assign(screenEl.style, { width: sw + 'px', height: sh + 'px', borderRadius: sr + 'px' });
    Object.assign(phoneEl.style, { padding: bez + 'px', borderRadius: (sr + bez) + 'px' });
  }
  // 손가락 — 터치 신호의 자취(pts · 두 손가락이면 pts2)를 시각 t 에서 보간. 누르는 동안 보이고, 떼면 살짝 커지며 사라진다(0.35초)
  function drawFingers(t, map) {
    const tc = touches.findLast(c => c.at <= t && t <= c.at + c.dur + 0.35);
    [['f1', 'pts'], ['f2', 'pts2']].forEach(([id, key]) => {
      const el = $('#' + id);
      if (!tc || !tc[key]) { el.style.opacity = '0'; return; }
      const k = t - tc.at, P = tc[key];
      let i = 0; while (i < P.length - 1 && P[i + 1][0] <= k) i++;
      const a = P[i], b = P[Math.min(i + 1, P.length - 1)], u = b[0] > a[0] ? Math.min(1, Math.max(0, (k - a[0]) / (b[0] - a[0]))) : 0;
      const [x, y] = map(a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
      const down = k <= tc.dur, after = k - tc.dur;
      const op = down ? Math.min(1, k / 0.06) : Math.max(0, 1 - after / 0.35);
      const sc = down ? (tc.mode === 'hold' ? 1 - Math.min(1, k / 0.42) * 0.14 : 1) : 1 + after * 1.4;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${sc.toFixed(3)})`;
      el.style.opacity = op.toFixed(3);
      el.classList.toggle('held', tc.mode === 'hold' && down && k >= 0.42);   // 앱의 꾹 판정 시간(0.42초)을 넘기면 진한 테두리
    });
  }

  function draw(t) {
    const fw = (phone ? screenEl : $('#frame')).clientWidth, r = camAt(t), s = fw / r[2];
    $('#stage').style.transform = `scale(${s}) translate(${-r[0]}px, ${-r[1]}px)`;
    const map = (x, y) => [(x - r[0]) * s, (y - r[1]) * s];
    // 클릭 물결(0.5초) · 우클릭 표시(1.1초)
    const c = clicks.findLast(c => c.at <= t && t - c.at < 1.1), ring = $('#ring'), badge = $('#badge');
    if (c && t - c.at < 0.5) { const [x, y] = map(c.x, c.y), k = (t - c.at) / 0.5; ring.style.transform = `translate(${x}px, ${y}px) scale(${0.45 + k * 0.9})`; ring.style.opacity = String((1 - k) * 0.9); }
    else ring.style.opacity = '0';
    if (c && c.kind === 'rclick') { const [x, y] = map(c.x, c.y), k = t - c.at, a = Math.min(1, k / 0.12) * Math.min(1, (1.1 - k) / 0.2); badge.style.transform = `translate(${x + 14}px, ${y - 40 - Math.min(1, k / 0.18) * 4}px)`; badge.style.opacity = String(a); }
    else badge.style.opacity = '0';
    // 키 표시(1초) — 처음 0.14초는 눌린 모양
    const kc = keys.findLast(k => k.at <= t && t - k.at < 1.0), key = $('#key');
    if (kc) { const k = t - kc.at; key.textContent = kc.key; key.classList.toggle('down', k < 0.14); key.style.opacity = String(Math.min(1, k / 0.08) * Math.min(1, (1.0 - k) / 0.25)); }
    else key.style.opacity = '0';
    if (touches.length) drawFingers(t, map);
    if (fss.length) {   // 전체화면 흉내 — 녹화 때 브라우저 전체화면이었던 구간에 재생 문서 뿌리에 wn-fs(아래 insertStyleRules)
      const f = fss.findLast(c => c.at <= t), doc = rep.iframe && rep.iframe.contentDocument;
      if (doc && doc.documentElement) doc.documentElement.classList.toggle('wn-fs', !!(f && f.on));
    }
    const cap = caps.findLast(c => c.at <= t + 0.05);
    const text = cap ? cap.text : '';
    if ($('#cap').textContent !== text) $('#cap').textContent = text;
    $('#meter').style.width = (Math.min(1, t / dur) * 100).toFixed(2) + '%';
    document.body.dataset.t = t.toFixed(2);
  }
  function tick() {
    raf = 0;
    if (!rep) return;
    const t = now();
    if (t !== lastT || running) { draw(t); lastT = t; }
    if (running) raf = requestAnimationFrame(tick);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function setBtn() {
    const on = want;
    // 이름 = 보이는 글자 그대로(아이콘은 aria-hidden). 따로 붙인 「시연 재생」은 「이어서 재생」과 달라 음성 입력이 안 통했다(11-18 회사 검수)
    $('#play').innerHTML = (on ? ICON.pause : ICON.play) + (on ? '일시정지' : (now() > 0.05 && !fromPoster && !ended ? '이어서 재생' : '재생'));
  }
  // 재생 여부 = 사용자가 원함 + 화면에 보임 + 준비됨
  function sync() {
    setBtn();
    if (!ready) return;
    const go = want && visible && !document.hidden;
    if (go && !running) {
      clearTimeout(holdTm);
      const t = now();
      rep.play(ended || fromPoster || t >= dur - 0.05 ? 0 : t * 1000);
      ended = false; fromPoster = false;
      running = true; kick();
    } else if (!go && running) {
      rep.pause(); running = false; clearTimeout(holdTm); kick();
    }
  }
  // 정지 화면(at · 동작 줄이기): 그 시각으로 감고, 감는 사이 막 시작된 CSS 모션은 끝 모습으로
  function still(t) {
    rep.pause(t * 1000);
    const doc = rep.iframe && rep.iframe.contentDocument;
    setTimeout(() => { try { doc.getAnimations().forEach(a => { try { a.finish(); } catch (e) { /* 무한 반복 애니메이션 */ } }); } catch (e) {} fixMedia(t); draw(t); }, 60);
    draw(t);
  }
  /* 정지 화면의 영상 시간 — rrweb 는 그 시각까지 감을 때(가상 DOM) 영상 조작 기록(재생·멈춤·탐색·배속 = source 7)을 건너뛰어,
     영상이 녹화 시작 때 상태에서 흐른 시간만큼만 간다(±5초·2배속이 빠진다). 마지막 조작 기록에서 다시 계산해 맞춘다.
     보통 재생은 조작이 차례로 적용되므로 손대지 않는다(정지 화면 = ?at= · 동작 줄이기 대표 장면만) */
  function fixMedia(t) {
    if (!data || !data.events) return;
    const t0 = data.events[0].timestamp, upTo = t0 + t * 1000, last = new Map();
    for (const e of data.events) {
      if (e.timestamp > upTo) break;
      if (e.type !== 3 || e.data.source !== 7) continue;
      const prev = last.get(e.data.id) || { playing: true, rate: 1 };
      const playing = e.data.type === 0 ? true : e.data.type === 1 ? false : prev.playing;   // 0 재생 · 1 멈춤 · 2 탐색 · 3 음량 · 4 배속
      last.set(e.data.id, { ts: e.timestamp, ct: typeof e.data.currentTime === 'number' ? e.data.currentTime : prev.ct, rate: e.data.playbackRate || prev.rate, playing });
    }
    last.forEach((s, id) => {
      const v = rep.getMirror && rep.getMirror().getNode(id);
      if (!v || typeof s.ct !== 'number' || !('currentTime' in v)) return;
      const go = () => { try { v.currentTime = s.ct + (s.playing ? (upTo - s.ts) / 1000 * s.rate : 0); v.pause(); } catch (e) {} };
      if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
    });
  }

  /* 사용자가 누른 재생은 「보인다」로 친다 — 시연 위쪽이 화면 밖이라 본문이 「45% 미만 보임」을 알린 상태에서도 단추가 먹게.
     본문에도 알려(wn-user) 다음에 완전히 벗어날 때 「안 보임」이 다시 오게 한다 */
  const userPlay = () => { if (embedded && !visible) { visible = true; parent.postMessage({ type: 'wn-user' }, location.origin); } };
  $('#play').addEventListener('click', () => { userSet = true; want = !want; if (want) userPlay(); sync(); });
  $('#replay').addEventListener('click', () => {
    userSet = true; want = true; userPlay(); clearTimeout(holdTm); ended = false; fromPoster = false;
    if (ready) { rep.play(0); running = !document.hidden; if (!running) rep.pause(0); kick(); }
    setBtn();
  });
  document.addEventListener('visibilitychange', sync);
  // 자막 칸 높이는 지금 폭에서 가장 긴 자막에 맞춰 둔다 — 자막마다 줄 수가 달라 띠 높이가 바뀌면 본문 iframe 이 출렁이고 아래 글이 오르내린다
  const fitCap = () => {
    if (!caps.length) return;
    const el = $('#cap'), keep = el.textContent; el.style.minHeight = ''; let h = 0;
    for (const c of caps) { el.textContent = c.text; h = Math.max(h, el.getBoundingClientRect().height); }
    el.textContent = keep; el.style.minHeight = Math.ceil(h) + 'px';
  };
  window.addEventListener('resize', () => { if (rep) { fitPhone(); fitCap(); draw(now()); } });
  window.addEventListener('message', e => {
    if (e.source !== parent || e.origin !== location.origin || !e.data || e.data.type !== 'wn-visible') return;
    visible = !!e.data.on;
    if (e.data.autoplay && !userSet && !RM.matches && staticAt === null) want = true;   // 본문이 처음 보여 줄 때만 — 사용자가 멈췄으면 그 뜻을 따른다
    sync();
  });
  RM.addEventListener('change', e => { if (e.matches) { want = false; sync(); } });

  // 본문에 들어가 있으면 내 높이를 알린다(틀 16:10 + 아래 띠 — 좁은 화면에선 띠가 두 줄)
  if (embedded) {
    let lastH = 0;
    new ResizeObserver(() => { const h = Math.ceil($('.wn').getBoundingClientRect().height); if (h && h !== lastH) { lastH = h; parent.postMessage({ type: 'wn-size', h }, location.origin); } }).observe($('.wn'));
  }
  const fail = () => { $('#load').innerHTML = '<button type="button">시연 다시 불러오기</button>'; $('#load').querySelector('button').onclick = () => location.reload(); };
  setBtn();
  fetch(`scenes/${encodeURIComponent(id)}.json?v=${encodeURIComponent(ver)}`).then(r => { if (!r.ok) throw Error(r.status); return r.text(); }).then(async text => {
    data = JSON.parse(text.replaceAll('__WN__', base));
    dur = data.duration;
    document.body.dataset.dur = dur.toFixed(2);   // 확인 스크립트용(장면마다 길이가 다르다)
    for (const c of data.cues) {
      if (c.kind === 'camera') cams.push(c);
      else if (c.kind === 'click' || c.kind === 'rclick') clicks.push(c);
      else if (c.kind === 'key') keys.push(c);
      else if (c.kind === 'caption') caps.push(c);
      else if (c.kind === 'touch') touches.push(c);
      else if (c.kind === 'fs') fss.push(c);
    }
    const vp = data.viewport;
    Object.assign($('#stage').style, { width: vp.width + 'px', height: vp.height + 'px' });
    if (vp.mobile) {   // 휴대폰 틀: 틀(정사각 · 좁은 화면은 세로형) 가운데에 휴대폰을 세우고 무대·겹침 표시를 그 화면으로 옮긴다
      phone = true; document.body.classList.add('phone');
      phoneEl = document.createElement('div'); phoneEl.className = 'wn-phone'; phoneEl.id = 'phone';
      screenEl = document.createElement('div'); screenEl.className = 'wn-screen'; screenEl.id = 'screen';
      phoneEl.appendChild(screenEl); $('#frame').insertBefore(phoneEl, $('#load'));
      screenEl.append($('#stage'), $('.wn-ovl'));
      fitPhone();
    }
    /* 끝 표시 — rrweb 는 「마지막 기록 + 50ms」에 끝(finish)을 낸다. 마지막 화면 변화가 대본 끝보다 이르면(이 장면은 0.65초)
       끝 줌아웃이 도중에 튀고, 끝난 뒤 다시 틀면 처음으로 안 돌아가며, 그 50ms 안에 멈추면 영영 굳는다(검수 실측) → 대본 끝에 빈 기록을 하나 둔다 */
    { const ev = data.events, endTs = ev[0].timestamp + Math.round(dur * 1000);
      if (ev[ev.length - 1].timestamp < endTs) ev.push({ type: 5, timestamp: endTs, data: { tag: 'wn-end', payload: null } }); }
    rep = new rrweb.Replayer(data.events, {
      root: $('#stage'), mouseTail: false, showWarning: false, showDebug: false, triggerFocus: false, skipInactive: false,
      pauseAnimation: true, UNSAFE_replayCanvas: false, speed: 1,
      insertStyleRules: ['*, *::before, *::after { cursor: none !important; }',
        // 재생 iframe 은 스크립트가 꺼진 샌드박스 — 브라우저는 스크립트가 없으면 영상에 기본 조작 막대를 강제로 붙인다(앱은 자기 막대를 쓴다)
        'video::-webkit-media-controls, video::-webkit-media-controls-enclosure, video::-webkit-media-controls-panel, video::-webkit-media-controls-start-playback-button, video::-webkit-media-controls-overlay-play-button { display: none !important; -webkit-appearance: none !important; }',
        // 전체화면 흉내 — 앱의 .player-stage:fullscreen 과 같은 모양(검은 바탕 · 영상 꽉 차게).
        // 조상에 transform·will-change·filter 가 있으면 fixed 가 화면이 아니라 그 조상 기준이 된다 → 전체화면 구간에만 조상들(:has)에서 끈다
        '.wn-fs *:has(.player-stage) { transform: none !important; will-change: auto !important; filter: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; contain: none !important; perspective: none !important; }',
        '.wn-fs .player-stage { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; margin: 0 !important; z-index: 2147483000 !important; border-radius: 0 !important; background: #000 !important; transform: none !important; }',
        '.wn-fs .player-stage video { width: 100% !important; height: 100% !important; max-height: none !important; object-fit: contain !important; transform: none !important; }'],
    });
    /* 녹화가 시작될 때 앱에서는 이미 끝나 있던 애니메이션(로고 그리기 등 첫 등장 모션)이, 재생기가 화면을 새로 세우면 처음부터 다시 돈다
       → 첫 장면을 세울 때마다(처음·반복) 그 자리에서 끝 모습으로 맞춘다. 무한 반복 애니메이션은 그대로 둔다 */
    const settle = () => {
      try {
        rep.iframe.contentDocument.getAnimations().forEach(a => {
          const it = a.effect && a.effect.getTiming ? a.effect.getTiming().iterations : 1;
          if (it === Infinity) return;
          try { a.finish(); } catch (e) {}
        });
      } catch (e) {}
    };
    rep.on('fullsnapshot-rebuilded', settle);
    rep.on('finish', () => {
      // 끝에 닿기 전에 온 끝 알림(멈췄다 다시 튼 사이 늦게 도착한 지난 바퀴의 END) — 재생 중이면 그 자리에서 잇는다
      if (rep.getCurrentTime() < dur * 1000 - 100) { if (running) rep.play(rep.getCurrentTime()); return; }
      ended = true; running = false; draw(dur);
      clearTimeout(holdTm);
      holdTm = setTimeout(() => { if (want && visible && !document.hidden) { ended = false; rep.play(0); running = true; kick(); } }, 1600);   // 끝 장면을 잠깐 보여 주고 처음부터
    });
    rep.pause(0);
    settle();
    /* 글꼴(동적 서브셋)을 받은 뒤 시작해야 첫 장면에서 글자가 바뀌어 보이지 않는다.
       rrweb 는 첫 장면을 setTimeout(…, 1) 안에서 세운다 → 그 뒤에 글자를 한 번 배치해 글꼴 요청을 일으키고, 그때의 ready 를 기다린다 */
    await new Promise(r => setTimeout(r, 20));
    try { const fd = rep.iframe.contentDocument; fd.documentElement.getBoundingClientRect(); await Promise.race([fd.fonts.ready, new Promise(r => setTimeout(r, 2500))]); } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
    fitCap(); document.fonts.ready.then(fitCap);
    const poster = data.cues.find(c => c.kind === 'poster');
    if (staticAt !== null) still(Math.min(staticAt, dur));
    else if (RM.matches && poster) { still(poster.at); fromPoster = true; }
    else draw(0);
    $('#load').classList.add('gone');
    ready = true;
    document.documentElement.dataset.sceneReady = 'true';
    if (embedded) parent.postMessage({ type: 'wn-ready', scene: id }, location.origin);
    sync();
  }).catch(fail);
})();
