/**
 * 课表大屏展示系统 - 首页逻辑
 * 职责：
 *   1. 顶部日期 / 中文星期 / 实时时钟（每秒更新）
 *   2. 课程筛选：查找距离当前时间最近的一节课（核心逻辑）
 *   3. 倒计时每秒刷新，数字变化带平滑动画（核心逻辑）
 *   4. 日间 / 夜间主题一键切换
 */

// ============================================================
// 常量与状态
// ============================================================

// JS 的 getDay()：0=周日、1=周一 …… 6=周六
// 顶部栏展示格式：XXXX年X月X日 星期X
const WEEK_TEXT = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// 线上后端的正式域名（部署 Vercel 后改成自己的域名）
const PROD_API_BASE = 'https://your-vercel-app.vercel.app';

// 课表接口地址自动判断：
//   - 本地打开（localhost / 127.0.0.1，或直接双击 html 用 file:// 打开）→ 指向本机后端
//   - 其它情况（部署到 GitHub Pages）→ 指向线上后端
// 本机后端启动方式：项目根目录执行 `python api/timetable.py`，监听 127.0.0.1:8000
const API_BASE = (() => {
  const host = location.hostname;
  const isLocal = location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1';
  return isLocal ? 'http://127.0.0.1:8000' : PROD_API_BASE;
})();

const THEME_KEY = 'timetable-theme'; // 主题记忆的存储键
const DATA_REFRESH_MS = 60000;       // 课程数据定时刷新间隔（保证后台改课后首页能同步）
const TICK_MS = 1000;                // 倒计时刷新间隔：1 秒
const LONG_GAP_MS = 48 * 60 * 60 * 1000; // 长间隔阈值：48 小时（2880 分钟）

// 三种状态的卡片文案：图标 / 小标题 / 底部小字
// 对应的卡片配色由类名 is-pending / is-ongoing / is-holiday 控制（见 style.css）
const CARD_VIEW = {
  pending: { icons: '⏰ 📖', subtitle: '即将开课', foot: '做好准备，不要迟到' },
  ongoing: { icons: '✏️ 📚', subtitle: '上课进行中', foot: '专心听讲，认真学习' },
  holiday: { icons: '📅 🌙 ☁️', subtitle: '较长假期', foot: '当前暂无课程安排，可安心休息～' }
};

let courses = [];        // 合并本地覆盖层后、用于展示的课程列表
let baseCourses = [];    // 正方接口返回的基础课表（未合并覆盖层）
let currentKey = null;   // 当前展示课程的唯一标识，用于避免每秒重复重绘静态内容
let lastNumText = '';    // 上一次倒计时数字，用于触发数字变化动画
let loadError = '';      // 接口失败原因（非空时在卡片上提示，但不丢弃上一次成功的数据）
let isLoading = true;    // 首次数据是否仍在加载中

// ============================================================
// DOM 引用
// ============================================================
const $ = (id) => document.getElementById(id);
const dom = {
  dateText: $('dateText'),
  clock: $('clock'),
  themeToggle: $('themeToggle'),
  courseCard: $('courseCard'),
  cardContent: $('cardContent'),
  emptyTip: $('emptyTip'),
  statusIcons: $('statusIcons'),
  statusText: $('statusText'),
  cardFoot: $('cardFoot'),
  courseName: $('courseName'),
  classroom: $('classroom'),
  courseTime: $('courseTime'),
  teacher: $('teacher'),
  countdownHint: $('countdownHint'),
  countdownNum: $('countdownNum'),
  countdownMain: $('countdownMain'),
  holidayTip: $('holidayTip'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  overrideMask: $('overrideMask')
};

// ============================================================
// 工具函数
// ============================================================

/** 数字补零：9 -> "09" */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 顶部信息栏：日期 + 中文星期 + 实时时钟 */
function updateTopbar(now) {
  dom.dateText.textContent =
    `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEK_TEXT[now.getDay()]}`;
  dom.clock.textContent =
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/**
 * 把 "HH:MM" 的时间挂到指定日期上，生成完整的 Date 对象
 * @param {Date} day   基准日期
 * @param {string} hhmm 形如 "08:00"
 */
function toDateTime(day, hhmm) {
  const parts = String(hhmm).split(':');
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/** 把 JS 星期（0=周日）转换成课表里的星期编号（1=周一 …… 7=周日） */
function weekdayOf(date) {
  return date.getDay() === 0 ? 7 : date.getDay();
}

// ============================================================
// 核心逻辑：查找距离当前时间最近的一节课
// ============================================================
/**
 * 查找规则（从今天开始逐天向后查找，最多查 7 天，天然覆盖“周日结束后找周一”）：
 *   1. 优先判断当天是否有课程正在上课中：开始时间 <= 当前时间 < 结束时间
 *   2. 否则找当天「开始时间晚于当前时间」中最早的一节（待上课）
 *   3. 当天课程全部已结束时，继续查后一天的第一节课
 *
 * @param {Date} now 当前时间
 * @returns {{course:Object, start:Date, end:Date, status:'ongoing'|'pending', windowStart?:Date}|null}
 *          status 为 pending 时附带 windowStart（等待窗口起点），用于计算等待进度条
 */
function findNearestCourse(now) {
  for (let offset = 0; offset <= 7; offset++) {
    // 以今天为基准，向后偏移 offset 天
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    const weekday = weekdayOf(day);

    // 取出该天的所有课程，并按开始时间升序排列
    const dayCourses = courses
      .filter((c) => Number(c.weekday) === weekday)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

    if (!dayCourses.length) continue;

    // 1) 上课中：只要命中一节就直接返回（同一天的课程不会时间重叠）
    for (const c of dayCourses) {
      const start = toDateTime(day, c.startTime);
      const end = toDateTime(day, c.endTime);
      if (now >= start && now < end) {
        return { course: c, start, end, status: 'ongoing' };
      }
    }

    // 2) 待上课：当天最早的一节未开始课程
    for (let i = 0; i < dayCourses.length; i++) {
      const c = dayCourses[i];
      const start = toDateTime(day, c.startTime);
      if (now < start) {
        // 等待窗口起点：当天上一节课的结束时间；当天没有更早的课则取当天 00:00
        const windowStart = i > 0
          ? toDateTime(day, dayCourses[i - 1].endTime)
          : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
        return {
          course: c,
          start,
          end: toDateTime(day, c.endTime),
          status: 'pending',
          windowStart
        };
      }
    }

    // 3) 当天课程已全部结束 → 进入下一轮循环，查找后一天的课程
  }

  // 一周内都没有课程
  return null;
}

// ============================================================
// 渲染
// ============================================================

/**
 * 渲染最近一节课卡片与倒计时
 * @param {Date} now        当前时间
 * @param {Object|null} found findNearestCourse 的结果
 */
function renderCourse(now, found) {
  // 没有任何课程时的空状态：区分「加载中 / 接口失败 / 确实无课」三种情况
  if (!found) {
    dom.courseCard.className = 'course-card';
    dom.cardContent.hidden = true;
    dom.emptyTip.hidden = false;

    const tip = isLoading
      ? '正在加载课表…'
      : (loadError ? `课表加载失败：${loadError}` : '暂无课程数据');
    if (dom.emptyTip.textContent !== tip) dom.emptyTip.textContent = tip;

    currentKey = null;
    lastNumText = '';
    return;
  }

  dom.emptyTip.hidden = true;
  dom.cardContent.hidden = false;

  const course = found.course;
  const status = found.status;

  // ---------- 长间隔判断（核心逻辑） ----------
  // 待上课时，若「本节课开始时间 - 当前时间」超过 48 小时，
  // 则不展示分钟倒计时与进度条，卡片整体切换为「较长假期」状态
  const isLongGap = status === 'pending' && (found.start - now) > LONG_GAP_MS;

  // 卡片三态：较长假期 / 上课中 / 待上课（决定配色与图标、小标题、底部小字）
  const cardState = isLongGap ? 'holiday' : (status === 'ongoing' ? 'ongoing' : 'pending');

  // 只有「课程 + 状态」变化时才重绘静态内容，避免每秒刷新造成闪烁
  const key = `${course.id}-${found.start.getTime()}-${cardState}`;
  if (key !== currentKey) {
    currentKey = key;
    const view = CARD_VIEW[cardState];
    // 类名决定卡片配色：极淡渐变底 + 细边框（夜间自动切换深色底与提亮主色）
    dom.courseCard.className = 'course-card is-' + cardState;
    dom.statusIcons.textContent = view.icons;
    dom.statusText.textContent = view.subtitle;
    dom.cardFoot.textContent = view.foot;
    dom.courseName.textContent = course.name;
    dom.classroom.textContent = course.classroom;
    dom.courseTime.textContent = `${course.startTime} - ${course.endTime}`;
    dom.teacher.textContent = course.teacher || '';
    dom.teacher.hidden = !course.teacher;

    // 切换课程/状态时让进度条瞬移复位，避免从上一条课程的进度缓缓动画过来
    dom.progressFill.style.transition = 'none';
    dom.progressFill.style.transform = 'scaleX(0)';
    void dom.progressFill.offsetWidth; // 强制重排，使复位立即生效
    dom.progressFill.style.transition = '';
  }

  // ---------- 长间隔：只展示假期提示，隐藏分钟倒计时与进度条 ----------
  if (isLongGap) {
    dom.countdownHint.hidden = true;
    dom.countdownMain.hidden = true;
    dom.progress.hidden = true;
    dom.holidayTip.hidden = false;
    lastNumText = ''; // 退出假期模式后重新播放一次数字动画
    return;
  }

  dom.countdownHint.hidden = false;
  dom.countdownMain.hidden = false;
  dom.progress.hidden = false;
  dom.holidayTip.hidden = true;

  // ---------- 倒计时计算（每秒调用一次） ----------
  let numText;
  let hint;

  if (status === 'pending') {
    // 待上课：距离上课剩余时长 = 开始时间 - 当前时间，向上取整为分钟，
    // 保证还剩几秒时仍显示 1 分钟而不是 0
    hint = '距离上课还有';
    numText = String(Math.max(0, Math.ceil((found.start - now) / 60000)));
  } else {
    // 上课中：距离下课剩余时长 = 结束时间 - 当前时间，向上取整为分钟
    hint = '距离下课还有';
    numText = String(Math.max(0, Math.ceil((found.end - now) / 60000)));
  }

  dom.countdownHint.textContent = hint;

  // ---------- 进度条计算（每秒调用一次，配合 CSS 的 1s 线性过渡实现平滑动画） ----------
  let ratio;
  if (status === 'pending') {
    // 待上课：显示「剩余等待比例」，从接近 100% 逐渐减少，到上课时间清零
    // 等待窗口 = [上一节课结束时间 或 当天 00:00, 本节课开始时间]
    const total = found.start - found.windowStart;
    ratio = total > 0 ? (found.start - now) / total : 0;
  } else {
    // 上课中：显示「本节课已上比例」，从左往右逐渐填满
    const total = found.end - found.start;
    ratio = total > 0 ? (now - found.start) / total : 1;
  }
  ratio = Math.min(1, Math.max(0, ratio)); // 边界保护
  // 用 scaleX 而非 width：不会触发逐帧布局，移动端更流畅
  dom.progressFill.style.transform = `scaleX(${ratio.toFixed(4)})`;

  // 数字变化时才更新并播放一次平滑脉冲动画
  if (numText !== lastNumText) {
    lastNumText = numText;
    dom.countdownNum.textContent = numText;
    dom.countdownNum.classList.remove('tick');
    void dom.countdownNum.offsetWidth; // 强制重排，让动画可以重新播放
    dom.countdownNum.classList.add('tick');
  }
}

// ============================================================
// 每秒刷新
// ============================================================
function tick() {
  // 手动调课面板打开时暂停刷新：
  // 面板遮住了大屏，继续每秒做课程筛选 + DOM 写入纯属浪费，
  // 还会让浏览器在弹层背后反复重绘，是面板卡顿的来源之一。
  if (dom.overrideMask && !dom.overrideMask.hidden) return;

  const now = new Date();
  updateTopbar(now);
  renderCourse(now, findNearestCourse(now));
}

// ============================================================
// 主题切换
// ============================================================

/** 应用主题：dark / light，并同步按钮图标 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // 日间显示🌙（点击进入夜间），夜间显示🌞
  dom.themeToggle.textContent = theme === 'dark' ? '🌞' : '🌙';
}

/** 初始化主题：读取本地记忆，并绑定切换事件 */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved === 'dark' ? 'dark' : 'light');

  dom.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });
}

// ============================================================
// 数据加载
// ============================================================

/**
 * 拉取课表数据并合并本地手动调课覆盖层
 *
 * 流程（核心逻辑）：
 *   1. 请求后端的 GET /api/timetable，拿正方教务的标准课表
 *   2. 交给 override.js 的 TimetableOverride.merge() 合并本地覆盖层
 *      —— 本地覆盖层优先级更高：被跳过的课剔除、被修改的字段覆盖、本地新增的课追加
 *   3. 接口失败时保留上一次成功的数据（避免网络抖动导致大屏突然空白），
 *      并把错误信息通过 loadError 交给空状态展示
 */
async function loadCourses() {
  try {
    const res = await fetch(`${API_BASE}/api/timetable`);
    // 后端出错时返回非 200 + { error: "..." }，优先取这个可读信息
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }

    // 兼容 { courses: [...] } 与直接返回数组两种格式
    baseCourses = Array.isArray(data) ? data : ((data && data.courses) || []);
    loadError = '';
  } catch (err) {
    // fetch 在网络层失败时抛的是英文 TypeError（如 "Failed to fetch"），换成可读中文
    loadError = err instanceof TypeError ? '无法连接课表服务，请检查网络' : (err.message || '未知错误');
    console.warn('课表接口请求失败：', loadError);
  }

  isLoading = false;
  applyOverrides();
  tick(); // 拿到数据后立刻重绘，不必等下一次定时刷新
}

/** 用最新的基础课表重新合并本地覆盖层，并强制重绘 */
function applyOverrides() {
  courses = TimetableOverride.merge(baseCourses);
  currentKey = null; // 数据变化后强制重绘卡片
}

// ============================================================
// 启动
// ============================================================
async function init() {
  initTheme();

  // 先渲染一次（此时可能还是空数据），避免等待接口期间白屏
  tick();

  await loadCourses(); // 内部已包含合并覆盖层 + 重绘

  // 倒计时与时钟：每 1 秒刷新
  setInterval(tick, TICK_MS);
  // 课表数据：定时刷新，保证正方课表更新后首页能同步展示
  setInterval(loadCourses, DATA_REFRESH_MS);

  // 手动调课面板里改动后，立即重新合并并重绘
  window.addEventListener('timetable:overrides-changed', () => {
    applyOverrides();
    tick();
  });

  // 关闭面板后立即恢复刷新，避免等待下一次 1 秒定时器
  window.addEventListener('timetable:resume', tick);
}

init();