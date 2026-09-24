/**
 * 课表大屏展示系统 - 手动调课覆盖层
 *
 * 职责：
 *   1. localStorage 增删改查：新增临时课程 / 修改课程 / 临时跳过课程 / 清除全部手动修改
 *   2. 数据合并（核心逻辑）：正方接口基础课表 + 本地覆盖层，本地覆盖层优先级更高
 *   3. 隐藏入口：长按顶部日期区域进入手动编辑面板
 *
 * localStorage 存储结构（键：timetable-overrides）：
 * {
 *   version: 1,
 *   updatedAt: '2026-09-24 12:00:00',
 *   edits:   { '<课程key>': { classroom, teacher, startTime, ... } }, // 字段级补丁，只存与正方原始数据不同的字段
 *   skipped: { '<课程key>': '2026-09-24' },                          // 值为跳过日期，仅用于界面展示
 *   added:   [ { id, name, weekday, startTime, endTime, classroom, teacher } ]
 * }
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'timetable-overrides'; // localStorage 键名
  const STORE_VERSION = 1;
  const LONG_PRESS_MS = 700;                 // 长按进入编辑面板的时长
  const WEEK_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // 参与「修改」的字段，顺序与表单一致
  const EDITABLE_FIELDS = ['name', 'weekday', 'startTime', 'endTime', 'classroom', 'teacher'];

  // 最近一次合并所用的正方基础课表，供编辑面板展示与比对
  let lastBase = [];
  // 当前正在编辑的对象：null=新增；'local-xxx'=本地新增课程；其他=正方课程 key
  let editingKey = null;

  // ============================================================
  // 工具函数
  // ============================================================

  const $ = (id) => document.getElementById(id);

  /** 数字补零：9 -> "09" */
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** 格式化为 'YYYY-MM-DD HH:MM:SS' */
  function formatDateTime(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  /** 今天的日期字符串 'YYYY-MM-DD' */
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /**
   * 课程唯一标识（key）
   * 用于把「本地修改 / 跳过记录」关联到「正方课表里的某一节课」。
   * 取 星期 + 开始时间 + 结束时间 + 课程名 —— 这些是正方课表里相对稳定的字段，
   * 即使本地修改了教室/老师，key 依然不变，因此修改记录不会丢失。
   */
  function courseKey(c) {
    return `${c.weekday}|${c.startTime}|${c.endTime}|${c.name}`;
  }

  /** 广播「本地调课数据已变化」，首页据此立即重新合并渲染 */
  function notifyChanged() {
    window.dispatchEvent(new CustomEvent('timetable:overrides-changed'));
  }

  // ============================================================
  // localStorage 读写
  // ============================================================

  function emptyStore() {
    return { version: STORE_VERSION, updatedAt: '', edits: {}, skipped: {}, added: [] };
  }

  /** 读取本地覆盖层数据，任何异常都退回空结构，保证首页不受影响 */
  function readStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyStore();
      const parsed = JSON.parse(raw);
      return {
        version: parsed.version || STORE_VERSION,
        updatedAt: parsed.updatedAt || '',
        edits: parsed.edits && typeof parsed.edits === 'object' ? parsed.edits : {},
        skipped: parsed.skipped && typeof parsed.skipped === 'object' ? parsed.skipped : {},
        added: Array.isArray(parsed.added) ? parsed.added : []
      };
    } catch (err) {
      console.warn('本地调课数据解析失败，已忽略：', err.message);
      return emptyStore();
    }
  }

  /** 写入本地覆盖层数据并广播变化 */
  function writeStore(store) {
    store.version = STORE_VERSION;
    store.updatedAt = formatDateTime(new Date());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    notifyChanged();
  }

  // ============================================================
  // 核心逻辑：数据合并
  // ============================================================
  /**
   * 合并规则（本地覆盖层优先级高于正方接口数据）：
   *   1. 被标记「临时跳过」的课程 → 直接从结果中剔除
   *   2. 被修改过的课程 → 用本地字段补丁覆盖正方原始字段
   *   3. 本地新增的临时课程 → 追加到结果中
   *
   * @param {Array} baseCourses 正方接口返回的基础课表
   * @returns {Array} 合并后的课程列表，每项带 id 与 source（base / edited / added）
   */
  function merge(baseCourses) {
    const store = readStore();
    const base = Array.isArray(baseCourses) ? baseCourses : [];
    lastBase = base; // 缓存，供编辑面板使用

    const result = [];

    for (const c of base) {
      const key = courseKey(c);
      if (store.skipped[key]) continue; // 临时跳过 → 不展示
      const patch = store.edits[key];
      result.push(Object.assign({}, c, patch || {}, {
        id: key,
        source: patch ? 'edited' : 'base'
      }));
    }

    for (const a of store.added) {
      result.push(Object.assign({}, a, { source: 'added' }));
    }

    return result;
  }

  // ============================================================
  // 编辑面板：列表
  // ============================================================

  /** 组装面板列表数据：正方课程（含被修改/被跳过的）+ 本地新增课程 */
  function buildPanelList() {
    const store = readStore();
    const items = [];

    for (const c of lastBase) {
      const key = courseKey(c);
      const patch = store.edits[key];
      items.push({
        key,
        data: Object.assign({}, c, patch || {}),
        source: patch ? 'edited' : 'base',
        skipped: !!store.skipped[key],
        skipDate: store.skipped[key] || ''
      });
    }

    for (const a of store.added) {
      items.push({ key: a.id, data: a, source: 'added', skipped: false, skipDate: '' });
    }

    // 按 星期 → 开始时间 排序，便于查找
    items.sort((x, y) => (Number(x.data.weekday) - Number(y.data.weekday)) ||
      String(x.data.startTime).localeCompare(String(y.data.startTime)));

    return items;
  }

  /** 创建一个小按钮 */
  function makeBtn(text, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** 渲染单条课程（全部用 textContent 赋值，避免用户输入被当作 HTML 解析） */
  function renderItem(item) {
    const d = item.data;
    const li = document.createElement('li');
    li.className = 'override-item' + (item.skipped ? ' is-skipped' : '');

    const info = document.createElement('div');
    info.className = 'override-item-info';

    const title = document.createElement('div');
    title.className = 'override-item-title';
    title.textContent = d.name;
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'override-item-meta';
    meta.textContent = `${WEEK_TEXT[Number(d.weekday)] || ''} ${d.startTime}-${d.endTime} · ${d.classroom}` +
      (d.teacher ? ` · ${d.teacher}` : '');
    info.appendChild(meta);

    // 状态标记：已跳过 / 本地新增 / 已修改
    if (item.skipped || item.source !== 'base') {
      const badge = document.createElement('span');
      badge.className = 'override-badge' + (item.skipped ? ' is-skipped' : '');
      badge.textContent = item.skipped
        ? `已跳过（${item.skipDate}）`
        : (item.source === 'added' ? '本地新增' : '已修改');
      info.appendChild(badge);
    }

    li.appendChild(info);

    const ops = document.createElement('div');
    ops.className = 'override-item-ops';

    if (item.skipped) {
      ops.appendChild(makeBtn('恢复', 'override-btn-sm', () => restoreItem(item.key)));
    } else {
      ops.appendChild(makeBtn('编辑', 'override-btn-sm', () => startEdit(item)));
      if (item.source === 'added') {
        ops.appendChild(makeBtn('删除', 'override-btn-sm is-danger', () => removeAdded(item.key)));
      } else {
        ops.appendChild(makeBtn('跳过', 'override-btn-sm is-danger', () => skipItem(item.key)));
      }
    }

    li.appendChild(ops);
    return li;
  }

  function renderList() {
    const listEl = $('overrideList');
    const items = buildPanelList();

    // 用 DocumentFragment 先离线组装，最后一次性挂载：
    // 避免「清空 + 逐条 append」造成多次重排，移动端列表较多时更明显
    const frag = document.createDocumentFragment();

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'override-empty';
      li.textContent = '暂无课程数据';
      frag.appendChild(li);
    } else {
      for (const item of items) frag.appendChild(renderItem(item));
    }

    listEl.textContent = ''; // 清空旧节点
    listEl.appendChild(frag); // 一次性插入

    const store = readStore();
    const count = Object.keys(store.edits).length + Object.keys(store.skipped).length + store.added.length;
    $('overrideStatus').textContent = count
      ? `本机已保存 ${count} 处手动修改 · 更新于 ${store.updatedAt}`
      : '所有修改仅保存在本机浏览器';
  }

  // ============================================================
  // 编辑面板：表单
  // ============================================================

  function showError(msg) {
    const el = $('overrideError');
    el.textContent = msg;
    el.hidden = false;
  }

  /** 重置表单为「新增临时课程」模式 */
  function resetForm() {
    editingKey = null;
    $('overrideForm').reset();
    $('overrideFormTitle').textContent = '新增临时课程';
    $('ovSubmit').textContent = '新增课程';
    $('overrideError').hidden = true;
  }

  /** 载入某节课的数据到表单，进入编辑模式 */
  function startEdit(item) {
    const d = item.data;
    editingKey = item.key;
    $('ovName').value = d.name || '';
    $('ovWeekday').value = String(d.weekday || 1);
    $('ovStart').value = d.startTime || '';
    $('ovEnd').value = d.endTime || '';
    $('ovClassroom').value = d.classroom || '';
    $('ovTeacher').value = d.teacher || '';
    $('overrideFormTitle').textContent = item.source === 'added'
      ? '编辑本地新增课程'
      : '修改正方课表课程';
    $('ovSubmit').textContent = '保存修改';
    $('overrideError').hidden = true;
    $('overrideForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * 生成字段补丁：只记录与正方原始数据不同的字段
   * 这样「已修改」标记才准确，且把字段全部改回原值时能自动移除覆盖
   */
  function buildPatch(baseCourse, form) {
    const patch = {};
    for (const f of EDITABLE_FIELDS) {
      const before = f === 'weekday' ? Number(baseCourse[f]) : String(baseCourse[f] || '');
      const after = f === 'weekday' ? Number(form[f]) : String(form[f] || '');
      if (before !== after) patch[f] = form[f];
    }
    return patch;
  }

  function onSubmit(e) {
    e.preventDefault();

    const form = {
      name: $('ovName').value.trim(),
      weekday: Number($('ovWeekday').value),
      startTime: $('ovStart').value,
      endTime: $('ovEnd').value,
      classroom: $('ovClassroom').value.trim(),
      teacher: $('ovTeacher').value.trim()
    };

    // 表单校验
    if (!form.name) return showError('请填写课程名称');
    if (!form.startTime || !form.endTime) return showError('请选择开始时间和结束时间');
    if (form.endTime <= form.startTime) return showError('结束时间必须晚于开始时间');
    if (!form.classroom) return showError('请填写教室');

    const store = readStore();

    if (editingKey === null) {
      // 新增临时课程
      store.added.push(Object.assign({ id: 'local-' + Date.now() }, form));
    } else if (String(editingKey).startsWith('local-')) {
      // 编辑本地新增的课程
      const idx = store.added.findIndex((a) => a.id === editingKey);
      if (idx >= 0) store.added[idx] = Object.assign({ id: editingKey }, form);
    } else {
      // 修改正方课表里的课程：只保存与原始数据不同的字段
      const baseCourse = lastBase.find((c) => courseKey(c) === editingKey);
      if (baseCourse) {
        const patch = buildPatch(baseCourse, form);
        if (Object.keys(patch).length) store.edits[editingKey] = patch;
        else delete store.edits[editingKey]; // 全部改回原值 → 移除覆盖
      }
    }

    writeStore(store);
    resetForm();
    renderList();
  }

  // ============================================================
  // 编辑面板：跳过 / 恢复 / 删除 / 清空
  // ============================================================

  /** 临时跳过某节课：记录跳过日期，合并时该课程不展示 */
  function skipItem(key) {
    const store = readStore();
    store.skipped[key] = todayStr();
    writeStore(store);
    renderList();
  }

  /** 取消跳过 */
  function restoreItem(key) {
    const store = readStore();
    delete store.skipped[key];
    writeStore(store);
    renderList();
  }

  /** 删除本地新增的课程 */
  function removeAdded(key) {
    const store = readStore();
    store.added = store.added.filter((a) => a.id !== key);
    writeStore(store);
    renderList();
  }

  /** 清除全部手动修改 */
  function clearAll() {
    if (!window.confirm('确定清除全部手动修改吗？此操作不可撤销。')) return;
    localStorage.removeItem(STORAGE_KEY);
    notifyChanged();
    resetForm();
    renderList();
  }

  // ============================================================
  // 编辑面板：开关与隐藏入口
  // ============================================================

  function openPanel() {
    $('overrideMask').hidden = false;
    resetForm();
    renderList();
    document.body.classList.add('override-open');
  }

  function closePanel() {
    $('overrideMask').hidden = true;
    document.body.classList.remove('override-open');
    // 通知首页立即恢复刷新（面板打开期间大屏刷新是暂停的）
    window.dispatchEvent(new Event('timetable:resume'));
  }

  /** 隐藏入口：长按顶部日期区域 700ms 进入手动编辑面板 */
  function bindLongPress() {
    const trigger = document.querySelector('.topbar-info');
    let timer = null;

    const start = () => {
      clearTimeout(timer);
      timer = setTimeout(openPanel, LONG_PRESS_MS);
    };
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };

    trigger.addEventListener('pointerdown', start);
    trigger.addEventListener('pointerup', cancel);
    trigger.addEventListener('pointercancel', cancel);
    trigger.addEventListener('pointerleave', cancel);
    // 阻止移动端长按弹出系统菜单 / 选中文字
    trigger.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ============================================================
  // 初始化
  // ============================================================

  function init() {
    $('overrideForm').addEventListener('submit', onSubmit);
    $('overrideClose').addEventListener('click', closePanel);
    $('ovReset').addEventListener('click', resetForm);
    $('overrideClear').addEventListener('click', clearAll);

    // 点击遮罩空白处关闭面板
    $('overrideMask').addEventListener('click', (e) => {
      if (e.target === $('overrideMask')) closePanel();
    });
    // Esc 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('overrideMask').hidden) closePanel();
    });

    bindLongPress();
  }

  // 暴露给 main.js 使用
  window.TimetableOverride = {
    merge,
    courseKey,
    readStore,
    openPanel,
    closePanel
  };

  init();
})();
