/**
 * 今日全部课程抽屉
 * 职责：
 *   1. 「查看今日全部课程」按钮：点击展开 / 收起抽屉（默认收起，初始加载不展开）
 *   2. 抽屉内按「上午 / 下午」分组展示今日课程：时间段、课程名称、教室、老师
 *   3. 状态配色沿用大屏规则：待上课蓝色 / 上课中绿色 / 已结束灰色
 *   4. 高亮标记当前【最近一节课】（判定口径与主卡片完全一致）
 *
 * 设计约束：本文件只「读」大屏数据（window.TimetableMain 暴露的只读接口），
 *          不修改主卡片的课程筛选、倒计时、进度条、主题切换等任何原有逻辑。
 */
(function () {
  'use strict';

  // main.js 必须先执行并挂载只读接口；缺失时静默退出，保证原有大屏功能不受影响
  const api = window.TimetableMain;
  if (!api) return;

  const AM_END_HOUR = 12;  // 开始时间早于 12:00 归入「上午课程」，其余归入「下午课程」
  const REFRESH_MS = 1000; // 抽屉展开期间每秒刷新一次状态色与最近一节课标记

  const dom = {
    toggle: document.getElementById('todayToggle'),
    toggleIcon: document.getElementById('todayToggleIcon'),
    toggleText: document.getElementById('todayToggleText'),
    mask: document.getElementById('todayMask'),
    sheet: document.getElementById('todaySheet'),
    body: document.getElementById('todayBody'),
    refresh: document.getElementById('todayRefresh'),
    refreshText: document.getElementById('todayRefreshText')
  };
  if (!dom.toggle || !dom.sheet || !dom.body) return;

  const REFRESH_LABEL = '刷新课表'; // 按钮的常态文案
  let refreshTimer = null;  // 展开期间的每秒刷新定时器
  let lastSignature = '';   // 上一次渲染的「状态签名」，避免每秒无意义地重建 DOM
  let resetLabelTimer = null; // 刷新结束后把按钮文案复原的定时器
  let refreshing = false;   // 是否正在刷新，防止连点

  /** 取 "HH:mm" 的小时数，用于上午 / 下午分组 */
  function hourOf(hhmm) {
    return Number(String(hhmm).split(':')[0]) || 0;
  }

  /** 课程唯一标识（override.js 的 merge 已为每门课写入 id，这里再兜底一次） */
  function idOf(course) {
    return course.id || `${course.weekday}|${course.startTime}|${course.endTime}|${course.name}`;
  }

  /**
   * 单节课相对当前时间的状态（沿用大屏配色规则）
   *   待上课 pending = 蓝、上课中 ongoing = 绿、已结束 done = 灰
   */
  function statusOf(course, day) {
    const start = api.toDateTime(day, course.startTime);
    const end = api.toDateTime(day, course.endTime);
    if (day >= end) return 'done';
    if (day >= start) return 'ongoing';
    return 'pending';
  }

  /** 今日课程：按课表星期筛选当天的课，并按开始时间升序 */
  function todayCourses(day) {
    const weekday = api.weekdayOf(day);
    return api.getCourses()
      .filter((c) => Number(c.weekday) === weekday)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  }

  /** 单节课卡片：左侧时间段 + 右侧课程名 / 教室 / 老师，全用 textContent 写入，无注入面 */
  function renderItem(course, status, isNearest) {
    const li = document.createElement('li');
    li.className = `today-item is-${status}` + (isNearest ? ' is-nearest' : '');

    const time = document.createElement('div');
    time.className = 'today-time';
    time.textContent = `${course.startTime}-${course.endTime}`;
    li.appendChild(time);

    const main = document.createElement('div');
    main.className = 'today-main';

    const name = document.createElement('div');
    name.className = 'today-name';
    name.textContent = course.name || '未命名课程';
    // 最近一节课：在课程名后追加一枚小徽标
    if (isNearest) {
      const badge = document.createElement('span');
      badge.className = 'today-badge';
      badge.textContent = '最近一节';
      name.appendChild(badge);
    }
    main.appendChild(name);

    // 教室 · 老师（老师为空时只显示教室）
    const meta = document.createElement('div');
    meta.className = 'today-meta';
    meta.textContent = course.classroom
      ? (course.teacher ? `${course.classroom} · ${course.teacher}` : course.classroom)
      : (course.teacher || '地点待定');
    main.appendChild(meta);

    li.appendChild(main);
    return li;
  }

  /** 一个分组（上午 / 下午）：空分组不渲染，返回 null */
  function renderGroup(emoji, title, list, day, nearestId) {
    if (!list.length) return null;

    const section = document.createElement('section');
    section.className = 'today-group';

    const h3 = document.createElement('h3');
    h3.className = 'today-group-title';
    h3.textContent = `${emoji} ${title}`;

    const count = document.createElement('span');
    count.className = 'today-group-count';
    count.textContent = `${list.length} 门`;
    h3.appendChild(count);
    section.appendChild(h3);

    const ul = document.createElement('ul');
    ul.className = 'today-list';
    list.forEach((c) => {
      ul.appendChild(renderItem(c, statusOf(c, day), idOf(c) === nearestId));
    });
    section.appendChild(ul);
    return section;
  }

  /** 渲染整个抽屉：数据无变化时直接跳过，避免每秒重建 DOM */
  function render() {
    const day = api.nowDate();
    const list = todayCourses(day);

    // 最近一节课只在「它属于今天」时高亮，口径与主卡片一致
    const nearest = api.findNearestCourse(day);
    const nearestId = nearest && Number(nearest.course.weekday) === api.weekdayOf(day)
      ? idOf(nearest.course)
      : '';

    const signature = list.map((c) => `${idOf(c)}:${statusOf(c, day)}`).join(',') + '|' + nearestId;
    if (signature === lastSignature) return;
    lastSignature = signature;

    dom.body.textContent = ''; // 清空旧内容
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'today-empty';
      p.textContent = '今日暂无课程';
      dom.body.appendChild(p);
      return;
    }

    // 上午 = 12:00 前开课；下午 = 其余（含傍晚 / 晚上的课）
    const morning = list.filter((c) => hourOf(c.startTime) < AM_END_HOUR);
    const afternoon = list.filter((c) => hourOf(c.startTime) >= AM_END_HOUR);

    const frag = document.createDocumentFragment();
    const g1 = renderGroup('🌅', '上午课程', morning, day, nearestId);
    const g2 = renderGroup('🌤', '下午课程', afternoon, day, nearestId);
    if (g1) frag.appendChild(g1);
    if (g2) frag.appendChild(g2);
    dom.body.appendChild(frag);
  }

  /** 切换刷新按钮的忙碌态与文案 */
  function setRefreshLabel(label, busy) {
    if (!dom.refresh) return;
    dom.refresh.disabled = !!busy;
    dom.refresh.classList.toggle('is-busy', !!busy);
    if (dom.refreshText) dom.refreshText.textContent = label;
  }

  /**
   * 「刷新课表」：重新拉取课表数据 + 更新课表服务状态指示灯，然后重绘抽屉。
   * 拉取动作全部委托给 main.js 的 TimetableMain.refresh（内部复用 loadCourses 与
   * override.js 的状态灯刷新，失败时保留旧数据），这里只负责等待与重绘。
   */
  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    setRefreshLabel('刷新中…', true);

    let ok = true;
    try {
      await api.refresh();
      lastSignature = ''; // 数据可能已变化，强制重绘一次
      render();
    } catch (err) {
      ok = false;
      console.warn('刷新课表失败：', err);
    }

    refreshing = false;
    setRefreshLabel(ok ? '刷新完成' : '刷新失败', false);
    // 2 秒后把按钮文案复原；期间若再次点击刷新则不复原
    if (resetLabelTimer) clearTimeout(resetLabelTimer);
    resetLabelTimer = setTimeout(() => {
      if (!refreshing) setRefreshLabel(REFRESH_LABEL, false);
    }, 2000);
  }

  /** 展开抽屉：重置签名强制渲染一次，然后每秒刷新状态 */
  function open() {
    dom.mask.classList.add('is-open');
    dom.sheet.classList.add('is-open');
    dom.toggle.setAttribute('aria-expanded', 'true');
    dom.toggleIcon.textContent = '🔼';
    dom.toggleText.textContent = '收起今日课程';

    lastSignature = '';
    render();
    if (!refreshTimer) refreshTimer = setInterval(render, REFRESH_MS);
  }

  /** 收起抽屉：停止每秒刷新，省电 */
  function close() {
    dom.mask.classList.remove('is-open');
    dom.sheet.classList.remove('is-open');
    dom.toggle.setAttribute('aria-expanded', 'false');
    dom.toggleIcon.textContent = '📋';
    dom.toggleText.textContent = '查看今日全部课程';

    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function isOpen() {
    return dom.sheet.classList.contains('is-open');
  }

  function init() {
    // 展开 / 收起
    dom.toggle.addEventListener('click', () => (isOpen() ? close() : open()));
    // 刷新课表（重新拉取数据 + 更新服务状态指示灯）
    if (dom.refresh) dom.refresh.addEventListener('click', refreshAll);
    // 点击遮罩收起
    dom.mask.addEventListener('click', close);
    // Esc 收起
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
    // 手动调课改动后，若抽屉正开着则立即重渲染
    window.addEventListener('timetable:overrides-changed', () => {
      if (isOpen()) {
        lastSignature = '';
        render();
      }
    });
  }

  init();
})();