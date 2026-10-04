/* =====================================================================
   People Finder 데이터 처리 (서버·브라우저 공용)

   - 서버(server.js)에서는 storage/db.json 파일에 저장해요.
   - 서버 없이 정적 호스팅(Vercel, Cloudflare)에서 열면 같은 로직을
     브라우저 저장소(localStorage)로 돌려서 '보여주기용'으로 동작해요.

   저장 구조 (db.json)
   {
     version, seq: { user, connection, message },
     users:       [{ id, sampleId, name, dept, email, passHash, intro, work, interest,
                     status, profileDone, manner, feedbackCount, praise, recent, createdAt }],
     sessions:    { 토큰해시: { userId, createdAt } },
     keywords:    { 태그: { cat, createdBy, createdAt } },     // 사용자가 새로 등록한 키워드
     connections: [{ id, askerId, recipientId, topic, createdAt, updatedAt,
                     askerReadAt, recipientReadAt, autoReplied, feedback }],
     messages:    [{ id, connectionId, senderId, body, createdAt }]
   }
   ===================================================================== */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.PFCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const SESSION_TTL = 30 * DAY;
  const MANNER_START = 50;
  const MANNER_STEP = 0.1;                       // 피드백 1건마다 남은 점수의 10%
  const STATUS_NAMES = ['밝은 문어', '보통 문어', '뒤집힌 문어'];
  const DEPT_KEYS = ['감사', '택스', '딜', '디지털'];
  const CATS = ['업무', '언어', '직무', '취미'];
  const PRAISE_COUNT = 4;
  const REPLY_DELAY = [3000, 7000, 14000];       // 샘플 동료 자동 답변까지 걸리는 시간 (연락 상태별)
  const FIRST_USER_ID = 1001;                    // 샘플은 1~1000, 가입자는 1001부터

  function fail(status, code, message) {
    const e = new Error(message);
    e.status = status; e.code = code;
    return e;
  }

  function emptyDb() {
    return {
      version: 1,
      seq: { user: FIRST_USER_ID, connection: 1, message: 1 },
      users: [], sessions: {}, keywords: {}, connections: [], messages: []
    };
  }

  /* ---------- 샘플데이터 반영 ---------- */
  function countFromScore(s) {
    if (s <= MANNER_START) return 0;
    return Math.max(1, Math.round(Math.log((100 - s) / (100 - MANNER_START)) / Math.log(1 - MANNER_STEP)));
  }
  function seedFeedback(id, n, now) {
    const praise = [0, 0, 0, 0];
    for (let k = 0; k < n; k++) {
      const a = (id * 5 + k * 3) % 4;
      praise[a]++;
      if ((id + k) % 3 === 0) praise[(a + 1 + (id % 3)) % 4]++;
    }
    const recent = [];
    if (n > 0) recent.push({ item: (id * 5 + (n - 1) * 3) % 4, ts: now - (1 + id % 4) * DAY - (id % 7) * 3600000 });
    if (n > 1) recent.push({ item: (id * 5 + (n - 2) * 3) % 4, ts: now - (4 + id % 4 + id % 3) * DAY });
    return { praise, recent };
  }
  // 새 샘플은 추가하고, 기존 샘플은 이름·소속·소개·키워드·상태만 JSON에 맞춤 (매너지수·피드백은 유지)
  function syncSamples(db, sample, now) {
    let changed = false;
    for (const p of (sample && sample.profiles) || []) {
      const fields = {
        name: String(p.name || ''),
        dept: String(p.department || ''),
        intro: String(p.introduction || ''),
        work: (p.work_keywords || []).map(t => ({ tag: String(t), exp: '' })),
        interest: (p.interest_keywords || []).map(t => ({ tag: String(t), exp: '' })),
        status: Math.max(0, STATUS_NAMES.indexOf(p.contact_status))
      };
      const u = db.users.find(x => x.sampleId === p.id);
      if (u) {
        if (JSON.stringify(pick(u, Object.keys(fields))) !== JSON.stringify(fields)) { Object.assign(u, fields); changed = true; }
        continue;
      }
      const count = countFromScore(p.manner_score);
      const fb = seedFeedback(p.id, count, now);
      const id = (p.id < FIRST_USER_ID && !db.users.some(x => x.id === p.id)) ? p.id : db.seq.user++;
      db.users.push(Object.assign({
        id, sampleId: p.id, email: null, passHash: null, profileDone: true,
        manner: Number(p.manner_score) || MANNER_START, feedbackCount: count,
        praise: fb.praise, recent: fb.recent, createdAt: now
      }, fields));
      changed = true;
    }
    return changed;
  }
  function pick(o, keys) { const r = {}; keys.forEach(k => { r[k] = o[k]; }); return r; }

  /* ---------- 입력값 검사 ---------- */
  function text(v, max, label, required) {
    const s = String(v == null ? '' : v).trim();
    if (required && !s) throw fail(400, 'INVALID', `${label}을(를) 입력해주세요.`);
    if (s.length > max) throw fail(400, 'INVALID', `${label}은(는) ${max}자 이내로 입력해주세요.`);
    return s;
  }
  function keywordList(list, label) {
    if (!Array.isArray(list)) return [];
    if (list.length > 15) throw fail(400, 'INVALID', `${label}는 15개까지 등록할 수 있어요.`);
    const seen = new Set();
    return list.map(k => ({ tag: text(k && k.tag, 20, '키워드', true), exp: text(k && k.exp, 40, '한 줄 경험', false) }))
      .filter(k => !seen.has(k.tag) && seen.add(k.tag));
  }
  const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  /* ---------- 화면에 내보낼 형태 ---------- */
  function pub(u) {
    return {
      id: u.id, sampleId: u.sampleId, name: u.name, dept: u.dept, intro: u.intro,
      work: u.work, interest: u.interest, status: u.status,
      manner: u.manner, feedbackCount: u.feedbackCount, praise: u.praise, recent: u.recent
    };
  }
  function meView(u) { return Object.assign(pub(u), { email: u.email, profileDone: u.profileDone }); }
  function keywordMap(db) { const m = {}; Object.keys(db.keywords).forEach(t => { m[t] = db.keywords[t].cat; }); return m; }
  const userById = (db, id) => db.users.find(u => u.id === id);

  function msgsOf(db, cid) { return db.messages.filter(m => m.connectionId === cid); }
  function summary(db, c, me) {
    const msgs = msgsOf(db, c.id);
    const last = msgs[msgs.length - 1] || null;
    const readAt = c.askerId === me.id ? c.askerReadAt : c.recipientReadAt;
    return {
      id: c.id, askerId: c.askerId, recipientId: c.recipientId, topic: c.topic,
      createdAt: c.createdAt, updatedAt: c.updatedAt, feedback: c.feedback,
      replied: msgs.some(m => m.senderId === c.recipientId),
      unread: msgs.filter(m => m.senderId !== me.id && m.createdAt > readAt).length,
      last: last ? { body: last.body, senderId: last.senderId, createdAt: last.createdAt } : null
    };
  }
  function connectionsOf(db, me) {
    return db.connections.filter(c => c.askerId === me.id || c.recipientId === me.id)
      .sort((a, b) => b.updatedAt - a.updatedAt).map(c => summary(db, c, me));
  }
  function threadOf(db, c, me) {
    return Object.assign(summary(db, c, me), { messages: msgsOf(db, c.id) });
  }
  function fullState(db, me) {
    return {
      me: meView(me),
      people: db.users.filter(u => u.profileDone).map(pub),
      keywords: keywordMap(db),
      connections: connectionsOf(db, me)
    };
  }

  /* ---------- 샘플 동료 자동 답변 (실제 사람은 직접 답장) ---------- */
  function makeReply(status, topic) {
    const t = topic ? topic + ' 관련이면 ' : '';
    return [
      `네, 편하게 물어보세요! ${t}지금 잠깐 화면 공유로 같이 봐요.`,
      `확인했어요. 지금 회의 중이라 30분 뒤에 ${t}같이 확인해볼게요.`,
      `요즘 마감이라 답이 늦었어요. ${t}내일 오전에 5분 정도 시간 괜찮아요.`
    ][status] || '확인했어요.';
  }
  function autoReply(db, me, now) {
    let changed = false;
    for (const c of db.connections) {
      if (c.askerId !== me.id || c.autoReplied) continue;
      const r = userById(db, c.recipientId);
      if (!r || r.sampleId == null) continue;
      if (now - c.createdAt < (REPLY_DELAY[r.status] || 5000)) continue;
      db.messages.push({ id: db.seq.message++, connectionId: c.id, senderId: r.id, body: makeReply(r.status, c.topic), createdAt: now });
      c.autoReplied = true; c.updatedAt = now; changed = true;
    }
    return changed;
  }

  /* ---------- 로그인 세션 ---------- */
  function startSession(db, user, ctx) {
    const token = ctx.newToken();
    const now = ctx.now;
    Object.keys(db.sessions).forEach(h => { if (now - db.sessions[h].createdAt > SESSION_TTL) delete db.sessions[h]; });
    db.sessions[ctx.hashToken(token)] = { userId: user.id, createdAt: now };
    return token;
  }
  function userFromToken(db, token, ctx) {
    if (!token) return null;
    const s = db.sessions[ctx.hashToken(token)];
    if (!s || ctx.now - s.createdAt > SESSION_TTL) return null;
    return userById(db, s.userId) || null;
  }
  function participant(db, id, me) {
    const c = db.connections.find(x => x.id === Number(id));
    if (!c || (c.askerId !== me.id && c.recipientId !== me.id)) throw fail(404, 'NOT_FOUND', '대화를 찾지 못했어요.');
    return c;
  }
  function markRead(c, me, now) { if (c.askerId === me.id) c.askerReadAt = now; else c.recipientReadAt = now; }

  /* ---------- 요청 처리 ----------
     handle(db, body, ctx) → { data, changed }
     ctx: { now, newToken(), hashToken(t), hashPassword(pw), verifyPassword(pw, hash) } */
  const PUBLIC = new Set(['health', 'signup', 'login']);
  const ACTIONS = {
    health() { return { data: { ok: true } }; },

    signup(db, p, ctx) {
      const name = text(p.name, 20, '이름', true);
      const dept = text(p.dept, 10, '소속', true);
      if (!DEPT_KEYS.includes(dept)) throw fail(400, 'INVALID', '소속을 선택해주세요.');
      const email = text(p.email, 100, '이메일', true).toLowerCase();
      if (!isEmail(email)) throw fail(400, 'INVALID', '이메일 형식을 확인해주세요.');
      const password = String(p.password || '');
      if (password.length < 6) throw fail(400, 'INVALID', '비밀번호를 6자 이상 입력해주세요.');
      if (password.length > 100) throw fail(400, 'INVALID', '비밀번호가 너무 길어요.');
      if (db.users.some(u => u.email === email)) throw fail(409, 'EMAIL_TAKEN', '이미 가입된 이메일이에요. 로그인해주세요.');
      const user = {
        id: db.seq.user++, sampleId: null, name, dept, email, passHash: ctx.hashPassword(password),
        intro: '', work: [], interest: [], status: 0, profileDone: false,
        manner: MANNER_START, feedbackCount: 0, praise: [0, 0, 0, 0], recent: [], createdAt: ctx.now
      };
      db.users.push(user);
      const token = startSession(db, user, ctx);
      return { data: { token, state: fullState(db, user) }, changed: true };
    },

    login(db, p, ctx) {
      const email = String(p.email || '').trim().toLowerCase();
      const user = db.users.find(u => u.email === email && u.passHash);
      if (!user || !ctx.verifyPassword(String(p.password || ''), user.passHash)) {
        throw fail(401, 'BAD_LOGIN', '이메일 또는 비밀번호를 다시 확인해주세요.');
      }
      const token = startSession(db, user, ctx);
      autoReply(db, user, ctx.now);
      return { data: { token, state: fullState(db, user) }, changed: true };
    },

    logout(db, p, ctx, me, token) {
      delete db.sessions[ctx.hashToken(token)];
      return { data: { ok: true }, changed: true };
    },

    state(db, p, ctx, me) {
      const changed = autoReply(db, me, ctx.now);
      return { data: { state: fullState(db, me) }, changed };
    },

    saveProfile(db, p, ctx, me) {
      const status = Number(p.status);
      if (![0, 1, 2].includes(status)) throw fail(400, 'INVALID', '연락 가능 상태를 선택해주세요.');
      const work = keywordList(p.work, '업무 키워드');
      if (!work.length) throw fail(400, 'INVALID', '키워드를 1개 이상 골라주세요');
      const interest = keywordList(p.interest, '관심사 키워드');
      Object.assign(me, { intro: text(p.intro, 50, '한 줄 소개', false), work, interest, status, profileDone: true });
      // 새 키워드를 앱 전체 키워드 목록에 등록 (프로필에 실제로 쓴 것만)
      const used = new Set([...work, ...interest].map(k => k.tag));
      const nk = p.newKeywords && typeof p.newKeywords === 'object' ? p.newKeywords : {};
      Object.keys(nk).forEach(tag => {
        if (used.has(tag) && CATS.includes(nk[tag]) && !db.keywords[tag]) {
          db.keywords[tag] = { cat: nk[tag], createdBy: me.id, createdAt: ctx.now };
        }
      });
      return { data: { state: fullState(db, me) }, changed: true };
    },

    setStatus(db, p, ctx, me) {
      const status = Number(p.status);
      if (![0, 1, 2].includes(status)) throw fail(400, 'INVALID', '연락 가능 상태를 선택해주세요.');
      me.status = status;
      return { data: { state: fullState(db, me) }, changed: true };
    },

    people(db, p, ctx, me) {
      return { data: { people: db.users.filter(u => u.profileDone).map(pub), keywords: keywordMap(db), me: meView(me) } };
    },

    connections(db, p, ctx, me) {
      const changed = autoReply(db, me, ctx.now);
      return { data: { connections: connectionsOf(db, me) }, changed };
    },

    sendQuestion(db, p, ctx, me) {
      const to = userById(db, Number(p.to));
      if (!to || !to.profileDone) throw fail(404, 'NOT_FOUND', '동료를 찾지 못했어요.');
      if (to.id === me.id) throw fail(400, 'INVALID', '나에게는 질문을 보낼 수 없어요.');
      const body = text(p.body, 1000, '질문 내용', true);
      const now = ctx.now;
      const c = {
        id: db.seq.connection++, askerId: me.id, recipientId: to.id, topic: text(p.topic, 20, '분야', false) || null,
        createdAt: now, updatedAt: now, askerReadAt: now, recipientReadAt: 0, autoReplied: false, feedback: null
      };
      db.connections.push(c);
      db.messages.push({ id: db.seq.message++, connectionId: c.id, senderId: me.id, body, createdAt: now });
      return { data: { connectionId: c.id, thread: threadOf(db, c, me), connections: connectionsOf(db, me) }, changed: true };
    },

    thread(db, p, ctx, me) {
      const c = participant(db, p.id, me);
      const replied = autoReply(db, me, ctx.now);
      const before = c.askerId === me.id ? c.askerReadAt : c.recipientReadAt;
      const hasNew = msgsOf(db, c.id).some(m => m.senderId !== me.id && m.createdAt > before);
      if (hasNew) markRead(c, me, ctx.now);
      return { data: { thread: threadOf(db, c, me), connections: connectionsOf(db, me) }, changed: replied || hasNew };
    },

    sendMessage(db, p, ctx, me) {
      const c = participant(db, p.id, me);
      const body = text(p.body, 1000, '메시지', true);
      db.messages.push({ id: db.seq.message++, connectionId: c.id, senderId: me.id, body, createdAt: ctx.now });
      c.updatedAt = ctx.now;
      markRead(c, me, ctx.now);
      return { data: { thread: threadOf(db, c, me), connections: connectionsOf(db, me) }, changed: true };
    },

    feedback(db, p, ctx, me) {
      const c = participant(db, p.id, me);
      if (c.askerId !== me.id) throw fail(403, 'FORBIDDEN', '질문을 보낸 사람만 피드백을 남길 수 있어요.');
      if (c.feedback) throw fail(409, 'ALREADY', '이 연결에는 이미 피드백을 남겼어요.');
      if (!msgsOf(db, c.id).some(m => m.senderId === c.recipientId)) throw fail(400, 'NO_REPLY', '답변을 받은 뒤에 피드백을 남길 수 있어요.');
      const items = [...new Set((Array.isArray(p.items) ? p.items : []).map(Number))]
        .filter(i => Number.isInteger(i) && i >= 0 && i < PRAISE_COUNT).sort();
      if (!items.length) throw fail(400, 'INVALID', '칭찬 항목을 1개 이상 골라주세요');
      const r = userById(db, c.recipientId);
      const before = r.manner;
      r.manner = before + (100 - before) * MANNER_STEP;     // 소수점까지 저장, 화면에서만 반올림
      r.feedbackCount += 1;
      items.forEach(i => { r.praise[i] += 1; });
      r.recent = [{ item: items[0], ts: ctx.now }].concat(r.recent || []).slice(0, 2);
      c.feedback = { items, at: ctx.now, before, after: r.manner };
      return { data: { thread: threadOf(db, c, me), state: fullState(db, me) }, changed: true };
    }
  };

  function handle(db, body, ctx) {
    const action = body && body.action;
    const fn = ACTIONS[action];
    if (!fn) throw fail(400, 'UNKNOWN_ACTION', '알 수 없는 요청이에요.');
    if (PUBLIC.has(action)) return fn(db, body, ctx);
    const me = userFromToken(db, body.token, ctx);
    if (!me) throw fail(401, 'LOGIN_REQUIRED', '다시 로그인해주세요.');
    return fn(db, body, ctx, me, body.token);
  }

  return { handle, emptyDb, syncSamples, MANNER_START, MANNER_STEP };
});
