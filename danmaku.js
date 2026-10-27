(function () {
    'use strict';

    /* ══════════════════════════════════════════════════════════════════
     *  FniuDM - 飞牛影视弹幕增强脚本 (Docker 注入版 v2.0)
     *  运行环境：通过反向代理注入到飞牛影视 HTML 页面中
     *  依赖：danmu-api (DM API) 提供弹幕数据
     * ══════════════════════════════════════════════════════════════════ */

    // ─── 服务端地址（由 server.js 替换 __DMAPI_PLACEHOLDER__ 为实际代理路径） ───
    const FNIU  = '';                         // 飞牛影视（同源，走代理）
    const DMAPI = window.__DMAPI__ || '/dm-api';

    // ─── 常量配置 ───
    const PSEL  = 'div.xgplayer';             // 飞牛播放器容器选择器
    const STORE = 'fn_dm_cfg_v72';             // localStorage 配置存储键名
    const FONT  = '"PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

    // ─── 默认配置 ───
    const DEF = {
        on: true,            // 弹幕总开关
        opacity: 0.85,       // 弹幕透明度
        area: 35,            // 弹幕显示区域（屏幕高度百分比）
        fontSize: 22,        // 弹幕字号（px）
        lineHeight: 1.8,     // 弹幕行间距（字号倍数）
        speed: 1,            // 滚动速度倍率
        outline: true,       // 文字描边开关
        density: 100,        // 弹幕密度（百分比，100=全量显示）
        maxActive: 40,       // 同屏最大弹幕数
        offset: 0            // 弹幕时间偏移（秒，正=延后，负=提前）
    };

    let cfg = { ...DEF };
    try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
    const save = () => localStorage.setItem(STORE, JSON.stringify(cfg));

    // ─── 画布 & 渲染状态 ───
    let cvs, ctx, lW, lH;        // canvas 元素、上下文、宽高
    let allDm = [], active = [];  // 全部弹幕、当前活跃弹幕
    let eIdx = 0, rowData = [];   // 发射索引、行数据（用于避让计算）
    let vid, raf = null;          // video 元素、requestAnimationFrame 句柄
    let injected = false;         // 脚本是否已注入到当前页面
    let showGuide = false;        // 是否显示弹幕区域参考线
    let playTime = 0, lastFrame = 0, lastDpr = 0;
    const texCache = new Map();   // 弹幕纹理缓存（避免重复测量和绘制）

    // ─── UI 元素引用 ───
    let sBar, sTxt, sSub;         // 状态提示条
    let cntEl;                    // 弹幕数量显示
    let uiEls = [];               // 所有自定义 UI 元素（用于自动隐藏）
    let tooltipEl = null;         // 弹幕点击时间提示
    let tipEl = null;             // 搜索面板 - 当前信息提示
    let searchInp = null;         // 搜索面板 - 搜索输入框

    // ─── 弹幕数据缓冲 ───
    let lastEpGuid = '';          // 上一集的 guid（用于检测换集）
    let rawDmBuf = null;          // 原始弹幕数据缓冲
    let dmDurBuf = 0;             // 弹幕对应的视频时长缓冲
    let fixedTopRow = [];         // 固定顶部弹幕行数据
    let fixedBotRow = [];         // 固定底部弹幕行数据


    /* ══════════════════════════════════════════════════════════════════
     *  工具函数
     * ══════════════════════════════════════════════════════════════════ */

    /** 创建 DOM 元素的快捷方法 */
    function $(tag, html, css) {
        const e = document.createElement(tag);
        if (html != null) e.innerHTML = html;
        if (css) e.style.cssText = css;
        return e;
    }

    /** HTTP 请求封装（注入版同源请求，无需 GM_ 前缀） */
    async function gmFetch(url, o = {}) {
        const opts = { method: o.method || 'GET', headers: o.headers || {} };
        if (o.data) opts.body = o.data;
        console.log('[请求]', opts.method, url);
        try {
            const r = await fetch(url, opts);
            console.log('[响应]', url, r.status, r.statusText);
            if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
            return r.json();
        } catch (e) {
            console.error('[请求失败]', url, e.message);
            throw e;
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕 API 封装
     * ══════════════════════════════════════════════════════════════════ */

    const api = {
        /** 搜索动漫 */
        search: kw => gmFetch(`${DMAPI}/api/v2/search/anime?keyword=${encodeURIComponent(kw)}`),

        /** 文件名智能匹配 */
        match: fn => gmFetch(`${DMAPI}/api/v2/match`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ fileName: fn })
        }),

        /** 获取番剧详情和剧集列表 */
        bangumi: id => gmFetch(`${DMAPI}/api/v2/bangumi/${id}`),

        /** 获取某集的弹幕数据 */
        async comment(cid) {
            const r = await gmFetch(`${DMAPI}/api/v2/comment/${cid}?format=json&duration=true`);
            return { comments: r.comments || (Array.isArray(r) ? r : []), videoDuration: r.videoDuration || 0 };
        }
    };


    /* ══════════════════════════════════════════════════════════════════
     *  飞牛影视信息获取
     * ══════════════════════════════════════════════════════════════════ */

    /** 从 URL 提取视频 GUID */
    function getGuid() {
        const m = location.pathname.match(/\/v\/video\/([a-f0-9]+)/i);
        return m ? m[1] : null;
    }

    /** 获取当前视频的元信息（标题、季、集） */
    async function getInfo() {
        const { execSync } = require('child_process');
        const url = `${FNIU}/v/api/v1/play/info`;
       
        const g = getGuid();
        if (!g) return null;
        console.log('[获取视频信息] GUID:', g);
         // 1) 用 Python 生成 authx（body 走 stdin，无引号转义问题）
        const authx = execSync(`python gen_authx.py POST "${url}"`, {
            input: JSON.stringify({ item_guid: g }),
            encoding: 'utf-8'
        }).trim();
        console.log('[获取authx] :', authx);
        const r = await gmFetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'authx': authx },
            data: JSON.stringify({ item_guid: g })
        });
        if (r.code !== 0 || !r.data?.item) {
            console.warn('[获取视频信息] 失败', r.code, r.msg);
            return null;
        }
        const t = r.data.item;
        lastEpGuid = t.guid || '';
        const info = {
            title: t.tv_title || t.title,
            season: t.season_number || 1,
            episode: t.episode_number || 1,
            isSeries: !!t.tv_title
        };
        console.log('[获取视频信息] 成功', JSON.stringify(info));
        return info;
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕解析 & 管理
     * ══════════════════════════════════════════════════════════════════ */

    /** 将 API 返回的弹幕原始数据解析为内部格式 */
    function parse(raw) {
        if (!Array.isArray(raw)) return [];
        return raw.map(it => {
            try {
                if (!it) return null;
                const p = String(it.p || '').split(',');
                const time = parseFloat(p[0]);
                if (isNaN(time)) return null;
                const mode = parseInt(p[1] || '1');          // 1=滚动 4=底部 5=顶部
                const ci = parseInt(p[2] || '16777215');      // 颜色整数（默认白色）
                const text = String(it.m || '').trim();
                if (!text) return null;
                return {
                    text,
                    color: '#' + ci.toString(16).padStart(6, '0'),
                    type: mode === 4 ? 1 : mode === 5 ? 2 : 0,  // 0=滚动 1=底部 2=顶部
                    time,
                    w: 0  // 渲染时测量
                };
            } catch { return null; }
        }).filter(Boolean).sort((a, b) => a.time - b.time);
    }

    /** 测量所有弹幕文字宽度 */
    function measureAll() {
        ctx.save();
        ctx.font = `bold ${cfg.fontSize}px ${FONT}`;
        allDm.forEach(d => d.w = ctx.measureText(d.text).width);
        active.forEach(d => d.w = ctx.measureText(d.text).width);
        ctx.restore();
    }

    /** 将缓冲的弹幕数据应用到渲染引擎（含时长校准） */
    function applyLoad() {
        if (!rawDmBuf) return;
        allDm = parse(rawDmBuf);
        console.log('[弹幕] 解析完成', allDm.length, '条');
        // 弹幕时长与视频实际时长不一致时，按比例校准时间轴
        if (dmDurBuf > 0 && vid && vid.duration > 0 && Math.abs(vid.duration - dmDurBuf) > 5) {
            const ratio = vid.duration / dmDurBuf;
            if (ratio > 0.5 && ratio < 2.0) {
                console.log('[弹幕] 时长校准', dmDurBuf.toFixed(1), '→', vid.duration.toFixed(1), 'ratio:', ratio.toFixed(3));
                allDm.forEach(d => d.time *= ratio);
                allDm.sort((a, b) => a.time - b.time);
            }
        }
        active = []; eIdx = 0; rowData = [];
        fixedTopRow = []; fixedBotRow = [];
        texCache.clear();
        measureAll(); refreshCnt();
        if (vid) onSeek();
        ensureLoop();
    }

    /** 加载弹幕数据到缓冲区并应用 */
    function loadDm(raw, danmakuDuration) {
        console.log('[弹幕] loadDm 收到', raw ? raw.length : 0, '条, 时长:', danmakuDuration);
        rawDmBuf = raw;
        dmDurBuf = danmakuDuration || 0;
        applyLoad();
    }

    /** 清除所有弹幕数据 */
    function clearDm() {
        console.log('[弹幕] 清除');
        allDm = []; active = []; eIdx = 0; rowData = [];
        fixedTopRow = []; fixedBotRow = [];
        texCache.clear(); rawDmBuf = null; dmDurBuf = 0;
        refreshCnt();
    }

    /** 更新弹幕计数显示 */
    function refreshCnt() {
        if (cntEl) cntEl.textContent = allDm.length ? ` (${allDm.length})` : '';
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕纹理（离屏 Canvas 缓存）
     * ══════════════════════════════════════════════════════════════════ */

    /** 获取弹幕文字的纹理（离屏绘制结果），带缓存 */
    function getTex(text, color) {
        const dpr = window.devicePixelRatio || 1;
        if (dpr !== lastDpr) { texCache.clear(); lastDpr = dpr; }
        const key = `${text}\x00${color}\x00${cfg.fontSize}\x00${cfg.outline}`;
        let e = texCache.get(key);
        if (e) return e;

        const fs = cfg.fontSize;
        const sw = cfg.outline ? Math.max(2, fs / 10) : 0;
        const pad = Math.ceil(sw / 2) + 1;

        const tc = document.createElement('canvas');
        const t = tc.getContext('2d');
        t.font = `bold ${fs}px ${FONT}`;
        const tw = t.measureText(text).width;
        const cW = Math.ceil(tw) + pad * 2;
        const cH = Math.ceil(fs * 1.35) + pad * 2;

        tc.width = cW * dpr;
        tc.height = cH * dpr;
        t.scale(dpr, dpr);
        t.font = `bold ${fs}px ${FONT}`;
        t.textBaseline = 'top';

        // 描边（黑色半透明轮廓，增强可读性）
        if (cfg.outline) {
            t.strokeStyle = 'rgba(0,0,0,0.7)';
            t.lineWidth = sw;
            t.lineJoin = 'round';
            t.strokeText(text, pad, pad);
        }

        // 填充文字
        t.fillStyle = color;
        t.fillText(text, pad, pad);

        e = { c: tc, w: cW, h: cH, pad };
        texCache.set(key, e);

        // 缓存上限 600 条，超出淘汰最早条目
        if (texCache.size > 600) texCache.delete(texCache.keys().next().value);

        return e;
    }


    /* ══════════════════════════════════════════════════════════════════
     *  Canvas 初始化 & 播放器事件绑定
     * ══════════════════════════════════════════════════════════════════ */

    /** 在播放器容器上创建弹幕 Canvas 并绑定事件 */
    function initCvs(container, video) {
        const c = $('canvas', null,
            'position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;');
        container.style.position = container.style.position || 'relative';
        container.appendChild(c);

        cvs = c;
        ctx = c.getContext('2d', { willReadFrequently: false, alpha: true });
        vid = video;

        function fit() {
            const r = container.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            lW = r.width;
            lH = r.height;
            c.width = lW * dpr;
            c.height = lH * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ensureLoop();
        }

        fit();
        new ResizeObserver(fit).observe(container);
        window.addEventListener('resize', fit);

        // 播放器事件绑定
        video.addEventListener('play',           () => { lastFrame = 0; ensureLoop(); });
        video.addEventListener('pause',          () => { ensureLoop(); });
        video.addEventListener('ended',          () => {});
        video.addEventListener('seeked',         () => onSeek());
        video.addEventListener('loadedmetadata', () => {
            playTime = video.currentTime;
            if (rawDmBuf && dmDurBuf > 0) applyLoad();
        });
        video.addEventListener('ratechange',     () => { lastFrame = 0; });

        ensureLoop();
    }

    /** 跳转时重置弹幕状态（二分定位到当前时间点） */
    function onSeek() {
        if (!vid) return;
        active = []; rowData = [];
        fixedTopRow = []; fixedBotRow = [];
        lastFrame = 0;
        playTime = vid.currentTime;

        // 二分查找当前时间对应的弹幕索引
        const t = vid.currentTime - cfg.offset;
        let lo = 0, hi = allDm.length;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            allDm[m].time <= t ? lo = m + 1 : hi = m;
        }
        eIdx = lo;
        ensureLoop();
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕渲染主循环
     * ══════════════════════════════════════════════════════════════════ */

    /** 确保渲染循环在运行 */
    function ensureLoop() {
        if (!raf) { lastFrame = 0; raf = requestAnimationFrame(tick); }
    }

    /** 每帧回调：时间同步 → 发射 → 裁剪 → 绘制 */
    function tick(ts) {
        const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.05) : 0;
        lastFrame = ts;
        const playing = vid && !vid.paused && !vid.ended;

        if (playing) {
            playTime += dt * (vid.playbackRate || 1);

            // 播放时间与系统时间漂移校正
            const drift = vid.currentTime - playTime;
            if (Math.abs(drift) > 1.5) {
                // 大漂移（拖拽/缓冲）→ 直接同步
                const delta = vid.currentTime - playTime;
                playTime = vid.currentTime;
                active.forEach(d => { d.born += delta; });
                rowData.forEach(r => { if (r) r.born += delta; });
                fixedTopRow.forEach(r => { if (r) r.born += delta; });
                fixedBotRow.forEach(r => { if (r) r.born += delta; });
            } else if (Math.abs(drift) > 0.02) {
                // 小漂移 → 渐进校正
                playTime += drift * 0.05;
            }

            // 发射新弹幕
            if (cfg.on && allDm.length && vid.currentTime > 0) emitNew();
        }

        pruneActive();
        draw();

        // 播放中或设置面板打开时持续渲染，否则停止节省资源
        if (playing || showGuide) { raf = requestAnimationFrame(tick); }
        else { raf = null; }
    }

    /** 统计当前可见弹幕数 */
    function countVisible() {
        let n = 0;
        for (const d of active) {
            if (d.paused) { n++; continue; }
            if (d.fixed) {
                if ((playTime - d.born) < d.life) n++;
            } else {
                const x = d.startX - (playTime - d.born) * d.spd;
                if (x + d.w > 0) n++;
            }
        }
        return n;
    }

    /** 发射当前时间窗口内需要显示的弹幕 */
    function emitNew() {
        const ct = vid.currentTime - cfg.offset;
        while (eIdx < allDm.length && allDm[eIdx].time <= ct + 0.2) {
            const dm = allDm[eIdx++];
            if (Math.random() * 100 >= cfg.density) continue;   // 密度过滤
            if (countVisible() >= cfg.maxActive) continue;       // 同屏上限
            fire(dm);
        }
    }

    /** 发射单条弹幕（滚动/顶部/底部） */
    function fire(dm) {
        const fs = cfg.fontSize;
        const lh = fs * cfg.lineHeight;  // 行高 = 字号 × 行间距倍率
        const maxR = Math.floor(lH * cfg.area / 100 / lh);
        if (maxR <= 0) return;

        if (dm.type === 0) {
            // ── 滚动弹幕 ──
            const r = findRow(dm.w, maxR);
            if (r < 0) return;
            const spd = (120 + Math.random() * 50) * cfg.speed;
            rowData[r] = { born: playTime, spd, w: dm.w };
            active.push({
                text: dm.text, color: dm.color, w: dm.w,
                startX: lW + 5, y: r * lh + fs,
                spd, fixed: false, born: playTime,
                time: dm.time, paused: false, highlight: false
            });
        } else {
            // ── 固定弹幕（顶部/底部） ──
            const bound = lH * cfg.area / 100;
            const life = 4;     // 固定弹幕持续时间（秒）
            const mfr = 4;      // 固定弹幕最大行数

            if (dm.type === 2) {
                // 顶部固定
                let r = -1;
                for (let i = 0; i < mfr; i++) {
                    if (!fixedTopRow[i] || (playTime - fixedTopRow[i].born >= fixedTopRow[i].life)) {
                        r = i; break;
                    }
                }
                if (r < 0) return;
                fixedTopRow[r] = { born: playTime, life };
                active.push({
                    text: dm.text, color: dm.color, w: dm.w,
                    x: (lW - dm.w) / 2, y: fs * 1.5 + r * lh,
                    fixed: true, born: playTime, life,
                    time: dm.time, paused: false, highlight: false
                });
            } else {
                // 底部固定
                let r = -1;
                for (let i = 0; i < mfr; i++) {
                    if (!fixedBotRow[i] || (playTime - fixedBotRow[i].born >= fixedBotRow[i].life)) {
                        r = i; break;
                    }
                }
                if (r < 0) return;
                fixedBotRow[r] = { born: playTime, life };
                active.push({
                    text: dm.text, color: dm.color, w: dm.w,
                    x: (lW - dm.w) / 2,
                    y: Math.max(fs * 2, bound - fs * 2 - r * lh),
                    fixed: true, born: playTime, life,
                    time: dm.time, paused: false, highlight: false
                });
            }
        }
    }

    /** 行避让算法：找到能容纳新弹幕的行号 */
    function findRow(nw, maxR) {
        let best = -1, bestClr = -1;
        for (let r = 0; r < maxR; r++) {
            const rd = rowData[r];
            if (!rd) return r;  // 空行直接用
            const elapsed = playTime - rd.born;
            if (elapsed < 0) continue;
            const rightEdge = (lW + 5) - elapsed * rd.spd + rd.w;
            if (rightEdge < 0) { rowData[r] = null; return r; }  // 已滚出屏幕
            const clr = lW - rightEdge;
            if (clr > nw + 40 && clr > bestClr) { bestClr = clr; best = r; }
        }
        return best;
    }

    /** 清理已消失的活跃弹幕 */
    function pruneActive() {
        active = active.filter(d => {
            if (d.paused) return true;
            if (d.fixed) return (playTime - d.born) < d.life;
            const x = d.startX - (playTime - d.born) * d.spd;
            return x > -(lW * 2);
        });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  绘制
     * ══════════════════════════════════════════════════════════════════ */

    /** 每帧绘制所有活跃弹幕 + 区域参考线 */
    function draw() {
        ctx.clearRect(0, 0, lW, lH);

        // 绘制弹幕
        if (cfg.on && active.length) {
            ctx.save();
            ctx.globalAlpha = cfg.opacity;
            for (const d of active) {
                let x;
                if (d.paused) {
                    x = d.pauseX;
                } else if (d.fixed) {
                    if ((playTime - d.born) > d.life) continue;
                    x = d.x;
                } else {
                    x = d.startX - (playTime - d.born) * d.spd;
                    if (x > lW + 10) continue;
                }
                const tex = getTex(d.text, d.color);
                const dx = x - tex.pad;
                const dy = d.y - tex.pad;

                // 高亮背景（点击暂停时显示）
                if (d.highlight) {
                    const p = 4;
                    ctx.fillStyle = 'rgba(79,140,255,0.25)';
                    ctx.beginPath();
                    if (ctx.roundRect) {
                        ctx.roundRect(dx - p, dy - p, tex.w + p * 2, tex.h + p * 2, 6);
                    } else {
                        ctx.rect(dx - p, dy - p, tex.w + p * 2, tex.h + p * 2);
                    }
                    ctx.fill();
                }
                ctx.drawImage(tex.c, dx, dy);
            }
            ctx.restore();
        }

        // 绘制弹幕区域参考线（设置面板打开时）
        if (showGuide) {
            const gy = lH * cfg.area / 100;
            ctx.save();
            ctx.fillStyle = 'rgba(79,140,255,0.06)';
            ctx.fillRect(0, 0, lW, gy);
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = '#4f8cff';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 5]);
            ctx.beginPath();
            ctx.moveTo(0, gy);
            ctx.lineTo(lW, gy);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#4f8cff';
            ctx.globalAlpha = 0.8;
            ctx.font = `12px ${FONT}`;
            ctx.textBaseline = 'top';
            ctx.fillText(`弹幕区域 ${cfg.area}%`, 10, gy + 6);
            ctx.restore();
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  UI 自动隐藏
     * ══════════════════════════════════════════════════════════════════ */

    /** 设置 UI 元素的可见性 */
    function setUIVis(vis) {
        uiEls.forEach(el => {
            el.style.opacity = vis ? '1' : '0';
            el.style.pointerEvents = vis ? (el._dmPE || 'none') : 'none';
        });
    }

    /** 播放器控制条显示/隐藏联动 */
    function setupAutoHide(container) {
        let timer, onUI = false;
        function show() {
            if (onUI) return;
            setUIVis(true);
            clearTimeout(timer);
            timer = setTimeout(() => setUIVis(false), 3000);
        }
        function hide() {
            if (onUI) return;
            clearTimeout(timer);
            setUIVis(false);
        }

        container.addEventListener('mousemove', show);
        container.addEventListener('mouseleave', hide);

        // 监听播放器控制条的显示/隐藏
        let ctrlObs = false;
        function tryObs() {
            if (ctrlObs) return;
            const ctrl = container.querySelector('.xgplayer-controls');
            if (!ctrl) return;
            ctrlObs = true;
            const chk = () => {
                if (!onUI) {
                    parseFloat(getComputedStyle(ctrl).opacity) > 0.1 ? show() : hide();
                }
            };
            ctrl.addEventListener('transitionend', chk);
            new MutationObserver(chk).observe(ctrl, { attributes: true, attributeFilter: ['class', 'style'] });
        }
        new MutationObserver(tryObs).observe(container, { childList: true });
        tryObs();

        // 自定义 UI 元素鼠标悬浮时不隐藏
        uiEls.forEach(el => {
            el.addEventListener('mouseenter', () => { onUI = true; clearTimeout(timer); });
            el.addEventListener('mouseleave', () => {
                onUI = false;
                timer = setTimeout(() => setUIVis(false), 3000);
            });
        });

        show();
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕点击交互
     * ══════════════════════════════════════════════════════════════════ */

    /** 点击弹幕暂停 3 秒并显示时间戳 */
    function setupDanmakuTouch(container) {
        tooltipEl = $('div', null,
            'position:absolute;z-index:999998;background:rgba(0,0,0,.85);color:#fff;' +
            'padding:6px 14px;border-radius:8px;font-size:14px;font-weight:bold;' +
            'pointer-events:none;opacity:0;transition:opacity .3s;white-space:nowrap;backdrop-filter:blur(8px);');
        container.appendChild(tooltipEl);

        container.addEventListener('click', (e) => {
            // 忽略 UI 元素上的点击
            for (const el of uiEls) { if (el.contains(e.target)) return; }
            if (!cfg.on || !active.length || !vid) return;

            const rect = container.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const fs = cfg.fontSize;

            // 从后往前遍历（后绘制的在上层）
            for (let i = active.length - 1; i >= 0; i--) {
                const d = active[i];
                if (d.paused) continue;
                let x;
                if (d.fixed) {
                    if ((playTime - d.born) > d.life) continue;
                    x = d.x;
                } else {
                    x = d.startX - (playTime - d.born) * d.spd;
                }
                // 碰撞检测
                if (cx >= x - 4 && cx <= x + d.w + 4 && cy >= d.y - 4 && cy <= d.y + fs * 1.35 + 4) {
                    d.paused = true;
                    d.pauseX = x;
                    d.pauseTime = playTime;
                    d.highlight = true;

                    // 显示时间戳
                    const t = d.time;
                    tooltipEl.textContent =
                        `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
                    tooltipEl.style.left = Math.min(Math.max(x, 0), lW - 80) + 'px';
                    tooltipEl.style.top = Math.max(d.y - 30, 0) + 'px';
                    tooltipEl.style.opacity = '1';

                    // 3 秒后恢复
                    setTimeout(() => {
                        d.paused = false;
                        d.highlight = false;
                        d.born += (playTime - d.pauseTime);
                        tooltipEl.style.opacity = '0';
                    }, 3000);

                    e.stopPropagation();
                    return;
                }
            }
        });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  换集监听（拦截 XHR / fetch）
     * ══════════════════════════════════════════════════════════════════ */

    /** 拦截飞牛的 play/info API 调用，自动检测换集 */
    function setupEpWatch() {
        function handle(item) {
            if (!item) return;
            const guid = item.guid || '';
            if (guid === lastEpGuid) return;  // 同一集不重复加载
            lastEpGuid = guid;

            const info = {
                title: item.tv_title || item.title,
                season: item.season_number || 1,
                episode: item.episode_number || 1,
                isSeries: !!item.tv_title
            };

            console.log('[换集检测]', JSON.stringify(info));
            clearDm();
            if (vid) { playTime = vid.currentTime; lastFrame = 0; }
            autoMatch(info);

            // 更新搜索面板的当前集数信息
            if (tipEl) {
                tipEl.innerHTML = info.isSeries
                    ? `当前：${info.title} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
                    : `当前：${info.title}`;
            }
            if (searchInp) {
                searchInp.value = info.title;
            }
        }

        // 拦截 XMLHttpRequest
        const _o = XMLHttpRequest.prototype.open;
        const _s = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) {
            this._fnU = u;
            return _o.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (b) {
            if (this._fnU && this._fnU.includes('/v/api/v1/play/info')) {
                this.addEventListener('load', function () {
                    try {
                        const r = JSON.parse(this.responseText);
                        if (r.code === 0 && r.data?.item) handle(r.data.item);
                    } catch {}
                });
            }
            return _s.apply(this, arguments);
        };

        // 拦截 fetch
        if (window.fetch) {
            const _f = window.fetch;
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : input?.url || '';
                if (url.includes('/v/api/v1/play/info')) {
                    return _f.apply(this, arguments).then(resp => {
                        resp.clone().json().then(d => {
                            if (d.code === 0 && d.data?.item) handle(d.data.item);
                        }).catch(() => {});
                        return resp;
                    });
                }
                return _f.apply(this, arguments);
            };
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  状态提示条
     * ══════════════════════════════════════════════════════════════════ */

    /** 显示一条状态提示（自动消失） */
    function flash(msg, err, sub) {
        if (!sBar) return;
        sTxt.textContent = msg;
        sTxt.style.color = err ? '#ff6666' : '#fff';
        sSub.textContent = sub || '';
        clearTimeout(sBar._t);
        sBar.style.opacity = '1';
        sBar._t = setTimeout(() => sBar.style.opacity = '0', 8000);
    }

    /** 创建状态提示条 */
    function mkStatus(c) {
        sBar = $('div', null,
            'position:absolute;left:20px;bottom:60px;z-index:99999;background:rgba(0,0,0,.75);' +
            'padding:10px 18px;border-radius:10px;font-size:14px;pointer-events:none;' +
            'transition:opacity .4s;opacity:0;backdrop-filter:blur(6px);display:flex;flex-direction:column;gap:4px;');
        sTxt = $('div', null, 'font-weight:500;color:#fff;');
        sSub = $('div', null, 'font-size:12px;color:#aaa;');
        sBar.append(sTxt, sSub);
        c.appendChild(sBar);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕控制面板
     * ══════════════════════════════════════════════════════════════════ */

    /** 创建弹幕控制面板（搜索 + 设置两个 Tab） */
    function mkPanel(c, info) {
        // 弹幕按钮
        const btn = $('div', '弹幕',
            'position:absolute;top:14px;right:70px;z-index:999999;background:rgba(20,20,20,.85);' +
            'backdrop-filter:blur(10px);color:#fff;border-radius:10px;padding:8px 16px;cursor:pointer;' +
            'font-size:14px;transition:opacity .3s,transform .2s;border:1px solid rgba(255,255,255,.08);' +
            'box-shadow:0 2px 12px rgba(0,0,0,.4);pointer-events:auto;');
        btn._dmPE = 'auto';

        cntEl = $('span', '', 'font-size:12px;color:#aaa;margin-left:4px;');
        btn.appendChild(cntEl);
        btn.onmouseenter = () => btn.style.transform = 'scale(1.05)';
        btn.onmouseleave = () => btn.style.transform = 'scale(1)';

        // 面板容器
        const pn = $('div', null,
            'position:absolute;top:58px;right:70px;width:400px;max-width:calc(100% - 20px);' +
            'height:560px;max-height:calc(100% - 70px);z-index:999999;background:rgba(18,18,18,.95);' +
            'backdrop-filter:blur(20px);border-radius:16px;overflow:hidden;' +
            'border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 40px rgba(0,0,0,.6);' +
            'pointer-events:none;display:none;flex-direction:column;transition:opacity .3s;');
        pn._dmPE = 'auto';

        // Tab 栏
        const tabBar = $('div', null,
            'display:flex;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;');
        const tabS = $('div', '弹幕搜索',
            'flex:1;text-align:center;padding:14px;cursor:pointer;font-size:15px;font-weight:bold;' +
            'color:#fff;border-bottom:2px solid #4f8cff;');
        const tabG = $('div', '&#9881; 设置',
            'flex:1;text-align:center;padding:14px;cursor:pointer;font-size:15px;font-weight:bold;color:#888;');
        tabBar.append(tabS, tabG);

        // Tab 内容区
        const vS = $('div', null, 'flex:1;overflow:hidden;display:flex;flex-direction:column;');
        const vG = $('div', null, 'flex:1;overflow-y:auto;display:none;padding:16px;box-sizing:border-box;');

        buildSearch(vS, info);
        buildSettings(vG);

        // Tab 切换逻辑
        function sw(t) {
            const isS = t === 's';
            tabS.style.color = isS ? '#fff' : '#888';
            tabS.style.borderBottom = isS ? '2px solid #4f8cff' : 'none';
            tabG.style.color = isS ? '#888' : '#fff';
            tabG.style.borderBottom = isS ? 'none' : '2px solid #4f8cff';
            vS.style.display = isS ? 'flex' : 'none';
            vG.style.display = isS ? 'none' : 'block';
            // 设置面板打开时显示区域参考线
            showGuide = !isS;
            ensureLoop();
        }
        tabS.onclick = () => sw('s');
        tabG.onclick = () => sw('g');

        pn.append(tabBar, vS, vG);

        // 按钮点击切换面板
        btn.onclick = () => {
            const vis = pn.style.display === 'none';
            pn.style.display = vis ? 'flex' : 'none';
            showGuide = vis && tabG.style.color === 'rgb(255, 255, 255)';
            ensureLoop();
        };

        c.append(btn, pn);
        uiEls.push(btn, pn);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  搜索面板
     * ══════════════════════════════════════════════════════════════════ */

    /** 构建弹幕搜索面板 */
    function buildSearch(root, info) {
        const wrap = $('div', null, 'padding:14px;display:flex;gap:10px;flex-shrink:0;');

        const inp = document.createElement('input');
        inp.placeholder = '输入动漫名称';
        inp.style.cssText =
            'flex:1;background:#2b2b2b;border:none;outline:none;color:#fff;border-radius:10px;' +
            'padding:12px;font-size:14px;';

        const go = $('button', '搜索',
            'background:#4f8cff;border:none;color:#fff;border-radius:10px;padding:0 18px;cursor:pointer;font-size:14px;');
        wrap.append(inp, go);

        const tip = $('div', null, 'padding:0 14px 8px;color:#999;font-size:13px;flex-shrink:0;');
        const list = $('div', null, 'flex:1;overflow-y:auto;padding:0 10px 10px;');

        root.append(wrap, tip, list);

        // 保存全局引用（换集时更新）
        tipEl = tip;
        searchInp = inp;

        /** 执行搜索 */
        async function doSearch(kw) {
            if (!kw) return;
            list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">搜索中...</div>';
            try {
                const r = await api.search(kw);
                const animes = r.animes || [];
                list.innerHTML = '';
                if (!animes.length) {
                    list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">无结果</div>';
                    return;
                }
                for (const a of animes) {
                    const it = $('div', null,
                        'background:#252525;border-radius:12px;margin-bottom:10px;padding:14px;cursor:pointer;transition:background .2s;');
                    it.onmouseenter = () => it.style.background = '#303030';
                    it.onmouseleave = () => it.style.background = '#252525';
                    it.innerHTML = `<div style="color:#fff;font-size:15px;font-weight:bold;">${a.animeTitle || a.title || a.name}</div>`;

                    it.onclick = async () => {
                        list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">加载剧集...</div>';
                        const bg = await api.bangumi(a.animeId || a.id);
                        const eps = (bg.bangumi?.episodes || bg.episodes || bg.data?.episodes || [])
                            .sort((x, y) => (parseInt(x.episodeNumber) || 0) - (parseInt(y.episodeNumber) || 0));
                        list.innerHTML = '';
                        if (!eps.length) {
                            list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">暂无剧集</div>';
                            return;
                        }
                        for (const ep of eps) {
                            const lb = `S${ep.seasonId?.split('-').pop() || '?'} E${ep.episodeNumber || '?'}`;
                            const ed = $('div', `<div style="color:#fff;font-size:14px;">${lb}</div>`,
                                'background:#252525;border-radius:10px;margin-bottom:8px;padding:12px;cursor:pointer;');

                            ed.onclick = async () => {
                                ed.innerHTML = '<div style="color:#4f8cff">加载中...</div>';
                                const desc = `${a.animeTitle || a.title} ${lb}`;
                                flash('正在加载弹幕…', false, desc);
                                try {
                                    const result = await api.comment(ep.episodeId);
                                    if (result.comments.length) {
                                        clearDm();
                                        loadDm(result.comments, result.videoDuration);
                                        flash(`加载成功，${result.comments.length} 条弹幕`, false, desc);
                                    } else {
                                        flash('该集暂无弹幕', true, desc);
                                    }
                                } catch (e) {
                                    console.error('[手动加载弹幕失败]', e.message);
                                    flash('加载失败：' + e.message, true, desc);
                                } finally {
                                    ed.innerHTML = `<div style="color:#fff;font-size:14px;">${lb}</div>`;
                                }
                            };
                            list.appendChild(ed);
                        }
                    };
                    list.appendChild(it);
                }
            } catch (e) {
                console.error('[搜索失败]', e.message);
                list.innerHTML = '<div style="color:#ff6666;padding:20px;text-align:center;">搜索失败</div>';
            }
        }

        go.onclick = () => doSearch(inp.value.trim());
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(inp.value.trim()); });

        // 初始化时填充当前视频信息
        if (info) {
            inp.value = info.title;
            tip.innerHTML = info.isSeries
                ? `当前：${info.title} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
                : `当前：${info.title}`;
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  设置面板
     * ══════════════════════════════════════════════════════════════════ */

    /** 构建设置面板（滑块 + 开关） */
    function buildSettings(root) {
        // 一行设置项：左侧标签 + 右侧控件
        function row(l, el) {
            const r = $('div', null,
                'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;');
            r.append($('span', l, 'color:#ccc;font-size:13px;min-width:70px;'), el);
            return r;
        }

        // 滑块控件
        function sld(min, max, step, val, fmt, cb) {
            const s = document.createElement('input');
            s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = val;
            s.style.cssText = 'flex:1;margin:0 10px;accent-color:#4f8cff;height:6px;';
            const v = $('span', fmt(val), 'color:#fff;font-size:13px;min-width:52px;text-align:right;');
            s.oninput = () => { v.textContent = fmt(+s.value); cb(+s.value); };
            const w = $('div', null, 'display:flex;align-items:center;flex:1;');
            w.append(s, v);
            return w;
        }

        // 开关控件
        function tgl(get, flip) {
            const t = $('div', null,
                'width:42px;height:24px;border-radius:12px;cursor:pointer;transition:background .3s;position:relative;flex-shrink:0;');
            const d = $('div', null,
                'width:18px;height:18px;border-radius:50%;background:#fff;position:absolute;top:3px;transition:left .3s;');
            t.appendChild(d);
            const u = () => {
                t.style.background = get() ? '#4f8cff' : '#444';
                d.style.left = get() ? '21px' : '3px';
            };
            t.onclick = () => { flip(); u(); };
            u();
            return t;
        }

        // 清除弹幕按钮
        const clr = $('button', '清除当前弹幕',
            'width:100%;background:#333;border:none;color:#ccc;border-radius:8px;padding:10px;cursor:pointer;font-size:13px;margin-top:8px;');
        clr.onmouseenter = () => clr.style.background = '#444';
        clr.onmouseleave = () => clr.style.background = '#333';
        clr.onclick = () => { clearDm(); flash('弹幕已清除'); };

        root.append(
            // ── 显示 ──
            $('div', '显示', 'color:#666;font-size:11px;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;'),
            row('弹幕开关', tgl(() => cfg.on, () => { cfg.on = !cfg.on; save(); ensureLoop(); })),
            row('透明度',   sld(0, 1, 0.05, cfg.opacity, v => v.toFixed(2), v => { cfg.opacity = v; save(); ensureLoop(); })),
            row('显示区域', sld(10, 80, 5, cfg.area, v => v + '%', v => { cfg.area = v; save(); ensureLoop(); })),
            row('文字描边', tgl(() => cfg.outline, () => { cfg.outline = !cfg.outline; save(); texCache.clear(); ensureLoop(); })),

            // ── 密度 ──
            $('div', '密度', 'color:#666;font-size:11px;margin:6px 0 10px;text-transform:uppercase;letter-spacing:1px;'),
            row('字号',     sld(14, 40, 1, cfg.fontSize, v => v + 'px', v => { cfg.fontSize = v; save(); texCache.clear(); measureAll(); ensureLoop(); })),
            row('行间距',   sld(1.2, 3.0, 0.1, cfg.lineHeight, v => v.toFixed(1) + 'x', v => { cfg.lineHeight = v; save(); })),
            row('滚动速度', sld(0.5, 2.5, 0.1, cfg.speed, v => v.toFixed(1) + 'x', v => { cfg.speed = v; save(); })),
            row('弹幕密度', sld(10, 100, 5, cfg.density, v => v + '%', v => { cfg.density = v; save(); })),
            row('同屏上限', sld(10, 80, 5, cfg.maxActive, v => v + '条', v => { cfg.maxActive = v; save(); })),

            // ── 时间 ──
            $('div', '时间', 'color:#666;font-size:11px;margin:6px 0 10px;text-transform:uppercase;letter-spacing:1px;'),
            row('偏移量', sld(-30, 30, 0.5, cfg.offset,
                v => (v > 0 ? '+' : '') + v.toFixed(1) + 's', v => { cfg.offset = v; save(); })),
            $('div', '正数=延后  负数=提前',
                'color:#555;font-size:11px;margin:-8px 0 14px;padding-left:70px;'),

            // ── 操作 ──
            clr
        );
    }


    /* ══════════════════════════════════════════════════════════════════
     *  自动匹配弹幕
     * ══════════════════════════════════════════════════════════════════ */

    /** 根据视频信息自动匹配并加载弹幕 */
    async function autoMatch(info) {
        if (!info) return;
        const fn = info.isSeries
            ? `${info.title} S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
            : info.title;
        console.log('[自动匹配] 开始', fn);
        flash('正在自动匹配…', false, fn);
        try {
            const m = await api.match(fn);
            console.log('[自动匹配] API返回', JSON.stringify(m).substring(0, 500));
            if (!m.success || !m.isMatched) {
                console.warn('[自动匹配] 未匹配', 'success:', m.success, 'isMatched:', m.isMatched);
                flash('自动匹配失败', true, fn);
                return;
            }
            const f = m.matches?.[0];
            if (!f) { flash('无匹配结果', true, fn); return; }
            const desc = `${f.animeTitle || '?'} ${f.episodeTitle || '?'}`;
            console.log('[自动匹配] 匹配到', desc, 'episodeId:', f.episodeId);
            const result = await api.comment(f.episodeId);
            console.log('[自动匹配] 弹幕数', result.comments.length);
            if (result.comments.length) {
                clearDm();
                loadDm(result.comments, result.videoDuration);
                flash(`匹配成功，${result.comments.length} 条弹幕`, false, desc);
            } else {
                flash('匹配到但无弹幕', true, desc);
            }
        } catch (e) {
            console.error('[自动匹配] 异常', e.message, e.stack);
            flash('匹配异常：' + e.message, true);
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  注入主逻辑
     * ══════════════════════════════════════════════════════════════════ */

    /** 注入弹幕系统到当前页面 */
    async function inject() {
        if (injected) return;
        const container = document.querySelector(PSEL);
        if (!container) return;
        const video = container.querySelector('video');
        if (!video) { setTimeout(inject, 500); return; }

        injected = true;
        console.log('[注入] 开始注入弹幕系统');
        initCvs(container, video);
        const info = await getInfo();
        console.log('[注入] 视频信息', JSON.stringify(info));
        mkStatus(container);
        mkPanel(container, info);
        setupAutoHide(container);
        setupDanmakuTouch(container);
        setupEpWatch();
        autoMatch(info);
        console.log('[注入] 完成');
    }


    /* ══════════════════════════════════════════════════════════════════
     *  SPA 导航监听 & 启动
     *  飞牛影视是 SPA 应用，页面间跳转不触发完整刷新，
     *  需要监听 pushState / replaceState / popstate 来检测 URL 变化
     * ══════════════════════════════════════════════════════════════════ */

    let lastPath = location.pathname;

    /** 检测 URL 变化，重置注入状态并重新注入 */
    function checkUrlChange() {
        if (location.pathname !== lastPath) {
            const oldPath = lastPath;
            lastPath = location.pathname;
            console.log('[URL变化]', oldPath, '→', lastPath);

            // 清理旧 UI 和状态
            injected = false;
            uiEls.forEach(el => el.remove());
            uiEls = [];
            if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
            if (sBar) { sBar.remove(); sBar = null; sTxt = null; sSub = null; }
            if (cvs) { cvs.remove(); cvs = null; }
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            clearDm();
            playTime = 0;
            lastFrame = 0;
            tipEl = null;
            searchInp = null;

            // 延迟注入（等待新页面 DOM 渲染）
            setTimeout(inject, 100);
        }
    }

    /** 启动所有监听 */
    function startWatch() {
        const target = document.body || document.documentElement;

        // DOM 变化监听（播放器容器动态加载）
        new MutationObserver(() => {
            if (document.querySelector(PSEL) && !injected) inject();
        }).observe(target, { childList: true, subtree: true });

        // 拦截 pushState / replaceState 检测 SPA 路由变化
        const origPush = history.pushState;
        const origReplace = history.replaceState;

        history.pushState = function () {
            origPush.apply(this, arguments);
            setTimeout(checkUrlChange, 100);
        };
        history.replaceState = function () {
            origReplace.apply(this, arguments);
            setTimeout(checkUrlChange, 100);
        };
        window.addEventListener('popstate', () => setTimeout(checkUrlChange, 100));

        // 兜底：每 2 秒检查一次 URL（防止遗漏）
        setInterval(checkUrlChange, 2000);

        // 首次注入
        inject();
    }

    // 确保 DOM 就绪后启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startWatch);
    } else {
        startWatch();
    }
})();
