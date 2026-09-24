# 课表大屏展示系统 · 完整运行原理说明

> 本文说明项目的整体架构、文件清单、后端与前端代码的运行逻辑、本地启动流程、线上部署运行机制与关键注意事项。
> 面向需要二次开发或排障的人，按模块分段，不回省略关键环节。

---

## 一、整体项目架构

**一句话**：一个纯静态前端 + 一个「Python 数据生成器」，线上没有任何常驻后端服务器。

| 层 | 技术 | 在哪里运行 | 职责 |
| --- | --- | --- | --- |
| 展示层 | 原生 HTML/CSS/JS（`public/`） | 用户手机浏览器（GitHub Pages 托管） | 算「最近一节课」、倒计时、进度条、主题、手动调课覆盖 |
| 数据生成层 | Python 3 + zfn_api（`api/` + `scripts/`） | ① GitHub Actions 每小时一次 ② 本地手动 | 登录正方 → 拉课表 → 标准化 → 产出 JSON |
| 数据载体 | 静态文件 `public/data/timetable.json` | 随 `public/` 一起发布到 `gh-pages` 分支 | 前端与后端的唯一交接面 |
| 配置层 | 环境变量（本地 `.env` / 线上 Actions Secrets） | 不下发到浏览器 | 学号、密码、正方地址、学年学期、作息表 |

### 两条数据链路（理解整个项目的关键）

```
线上（生产）
GitHub Actions（每小时 / 手动 / push main）
   └─ scripts/fetch_timetable.py ─ 复用 api/timetable.py 全部逻辑
         └─ 生成 public/data/timetable.json
               └─ 把整个 public/ 覆盖发布到 gh-pages 分支
                     └─ 浏览器打开 https://<user>.github.io/KJdata/
                           └─ 同源读取 data/timetable.json（无跨域、无后端）
                                 └─ 与 localStorage 覆盖层合并 ─▶ 渲染大屏

本地（开发）
python api/timetable.py（127.0.0.1:8000，自己会登录正方）
   └─ 浏览器打开 public/index.html 或 python -m http.server 8080 --directory public
         └─ 读 http://127.0.0.1:8000/api/timetable
```

### 为什么不用 Vercel

`*.vercel.app` 在国内是 SNI 层面被屏蔽（IP 本身可达但握手被重置）。改成「静态 JSON + GitHub Pages」后前端完全不依赖被墙域名；代价是数据有最长 1 小时的延迟。

---

## 二、全部文件目录清单

```
KJdata/
├── public/                                  # 前端静态资源（gh-pages 分支的内容就是这个目录）
│   ├── index.html                           # 唯一页面：顶部栏 + 课程卡片 + 手动调课弹层
│   ├── css/
│   │   └── style.css                        # 全部样式：亮/暗两套 CSS 变量、三态卡片配色
│   ├── js/
│   │   ├── override.js                      # 手动调课覆盖层（先加载）
│   │   └── main.js                          # 大屏核心逻辑（后加载，依赖 override 暴露的接口）
│   └── data/
│       └── timetable.json                   # 【运行时产物，不入库】Actions/脚本生成的课表 JSON
├── scripts/
│   └── fetch_timetable.py                   # Actions 的入口：登录正方 → 写出上面的 JSON
├── .github/workflows/
│   └── update-timetable.yml                 # 定时抓取 + 发布 public/ 到 gh-pages
├── api/                                     # 仅本地调试用的 Python 接口（线上不部署）
│   ├── timetable.py                         # 本地 HTTP 服务 + 全部业务逻辑（登录/拉取/标准化/缓存）
│   ├── config.py                            # 配置：环境变量读取、地址归一、教学周起始、作息表
│   └── zfn_api.py                           # 正方接口库源码（已内联，所以不用 pip install zfn_api）
├── requirements.txt                         # 三个依赖：requests / rsa / pyquery
├── .env.example                             # 环境变量模板（复制成 .env 使用）
├── .gitignore                               # 忽略 .env、__pycache__、public/data/
├── .trae/rules/项目结构规范.md              # 项目规范（架构、命名、字号层级、硬约束）
├── requirements.md                          # 原始业务需求文档（功能、UI、验收标准）
└── README.md                                # 本地开发 / Actions 密钥 / Pages 部署 全套步骤
```

各部分作用要点：

- `public/index.html`：纯结构，所有文案与状态由 JS 填充；末尾 `override.js` → `main.js` 的加载顺序不能反（后者使用 `window.TimetableOverride`）。
- `public/js/main.js`：时间计算、课程筛选、倒计时、进度条、主题、数据加载。
- `public/js/override.js`：localStorage 覆盖层的增删改查 + 数据合并 + 隐藏的编辑面板（长按 700ms 打开）。
- `public/css/style.css`：`:root` 定义亮色变量，`[data-theme="dark"]` 覆盖一套暗色变量；三种状态卡片通过 `--card-accent / --card-accent-soft / --card-accent-line` 三个变量换色。
- `api/timetable.py`：既是「本地 HTTP 服务」，也是被 Actions 复用的「业务库」。
- `api/config.py`：唯一读取环境变量的地方，所有容错都在这里。
- `scripts/fetch_timetable.py`：约 20 行，把 `timetable.get_timetable(force_refresh=True)` 的结果写进 `public/data/timetable.json`。
- `.github/workflows/update-timetable.yml`：定时/手动/push 触发，装依赖 → 跑脚本 → 把 `public/` 推到 `gh-pages`。

---

## 三、后端 `api/timetable.py` 运行逻辑

### 3.1 环境变量的读取（全部在 `config.py`）

1. **`_load_dotenv()`**：模块导入时用标准库手写解析项目根目录的 `.env`，逐行 `key=value`、去掉引号；**已存在的真实环境变量优先**（`if key and key not in os.environ`），所以在 CI 里 `.env` 不会覆盖平台注入的值。
2. **`_env(name, default)`**：统一取值并 `.strip()`，避免网页端粘贴时带入的换行/空格导致「配置看着没问题却登录失败」。
3. **`_normalize_base_url()`**：zfn_api 内部用 `urljoin(base_url, "xtgl/login_getPublicKey.html")`，而 `urljoin` 会替换 base_url 的最后一段路径，所以 base_url 必须停在应用根目录且以 `/` 结尾。它兼容三种粘贴写法：

   ```
   https://jwxt.gzus.edu.cn/jwglxt/xtgl/login_slogin.html  ->  https://jwxt.gzus.edu.cn/jwglxt/
   https://jwxt.gzus.edu.cn/jwglxt                         ->  https://jwxt.gzus.edu.cn/jwglxt/
   https://jwxt.gzus.edu.cn                                ->  https://jwxt.gzus.edu.cn/
   ```

   同时去掉粘贴时可能带上的 `?` 查询参数与 `#` 锚点。**写错的表现是登录失败 `code=2333`**，从报错完全看不出真实原因。
4. **`get_year_term()`**：`ZF_YEAR` / `ZF_TERM` 解析失败时回退到「当前年份 / 第 1 学期」，学期只接受 1、2，避免一个笔误让整个接口 500。
5. **`get_semester_start()`**：解析 `SEMESTER_START_DATE`（第一周周一），格式非法时返回 `None`（此时不做教学周过滤）。
6. **`RASPISANIE`**：12 节制作息表，索引 `i` 对应第 `i+1` 节，每项为 `[开始时间, 结束时间]`。
7. 其余：`CACHE_TTL_SECONDS=1800`、`REQUEST_TIMEOUT=8`、`ALLOWED_ORIGIN=*`（仅本地调试接口使用）。

### 3.2 登录正方

`fetch_from_zf()`：

- 先做配置自检：`ZF_BASE_URL / ZF_USERNAME / ZF_PASSWORD` 任一为空 → 直接抛 `RuntimeError("服务端未配置环境变量…")`（Actions 第一次跑失败时看到的就是这句）。
- `Client(cookies={}, base_url=..., timeout=...)`（来自内联的 `zfn_api.py`），然后 `client.login(学号, 密码)`。
- 返回码处理：`1000` 成功；`1001` = 学校开启了验证码 → 抛出「Serverless 环境无法交互处理」的明确提示（这种情况需要改用在本地浏览器登录后导出 cookies 的方式）；其它码 → `登录失败：{msg}（code=xxx）`。
- 失败时抛的是 `RuntimeError`，由 `_handle_request()` 统一转成 **HTTP 502 + `{error: 可读原因}`**，因此报错信息会出现在页面卡片上，而不只是留在日志里。

### 3.3 拉取课表

`client.get_schedule(year, term)`，同样校验 `code == 1000`，然后取 `data.courses` 作为原始课程列表（**全学期、1~18 周的所有课**）。

### 3.4 数据标准化（核心）

`normalize_courses()` 逐条处理，规则如下：

| 步骤 | 说明 |
| --- | --- |
| 星期校验 | `weekday` 必须是 1~7 的整数，缺失或异常的数据直接丢弃 |
| 节次 → 时间 | `_period_range()` 用正则从 `sessions`（如 `"1-2"`、`"3-4节"`、`"1-2,5-6"`）取首数字与末数字；`_period_to_time()` 查 `RASPISANIE` 得到起止时间。**故意不使用 zfn_api 自带的 `time` 字段** —— 其 `display_course_time()` 存在下标偏移，会把第 1 节算成第 3 节的时间 |
| 教学周过滤 | `_current_teaching_week()` 算出当前是第几周（`(今天 - 第一周周一).days // 7 + 1`；学期尚未开始时返回 `None`，此时不过滤以避免空白），再拿 `list_weeks` 判断本周是否开课；`list_weeks` 缺失或格式异常时**不过滤**（宁可多显示，也不误删课程） |
| 教室清理 | `place` 可能是一天多个场地的 `"A<br/>B"`，取第一段并去掉标签 |
| 排序 | 按 `(weekday, startTime)` 升序，便于前端顺序取「下一节课」 |
| 去重 | 正方会把同一门课按单双周拆成两条（如 `1-17周(单)` 与 `2-18周(双)`，两条字段完全一致），用「名称 + 星期 + 起止时间 + 教室 + 老师」做 key 合并 |

输出字段固定为 `name / weekday / startTime / endTime / classroom / teacher`。

### 3.5 TTL 缓存

`_cache` 是模块级字典 `{data, expire_at}`；`get_timetable(force_refresh)` 的逻辑：

- 未过期且 `force_refresh=False` → 直接返回缓存（本地调试时默认 30 分钟内不会重复登录正方，降低被风控风险）；
- 过期或强制刷新 → 调 `fetch_from_zf()`，组装 `{courses, updatedAt, source: "zf_api"}` 写入缓存，`expire_at = now + CACHE_TTL_SECONDS`；
- **线上链路每次都是 `force_refresh=True`**（Actions 每次是新进程，也不应读缓存）；
- `updatedAt` 是数据实际拉取时间，前端与编辑面板据此判断数据新旧。

### 3.6 入口函数

三个入口共用 `_handle_request()`，它把异常收敛成 `(状态码, 字典)`：`RuntimeError` → 502（业务/配置类错误，信息可读）；其它异常 → 500（并把 `traceback` 打到 stderr）。

| 入口 | 用途 | 说明 |
| --- | --- | --- |
| `app(environ, start_response)` | 标准 WSGI 入口 | 处理 OPTIONS 预检（204 + CORS 头），只接管 `/api` 开头的路径，其余返回 404 |
| `handler(event, context)` | AWS Lambda 风格适配入口 | 支持 `rawQueryString` / `queryStringParameters` 判断 `?refresh=1`，返回 `{statusCode, headers, body}`，为将来迁移到其它平台保留 |
| `DebugHandler` | 本地 `python api/timetable.py` 使用 | `BaseHTTPRequestHandler` 子类，支持 `?refresh=1` 跳过缓存，访问日志打到 stderr |

本地启动（文件末尾 `__main__`）：`HTTPServer(("127.0.0.1", PORT), DebugHandler)`，默认端口 8000，可用环境变量 `PORT` 覆盖。

---

## 四、前端 `public/` 代码运行逻辑

### 4.1 页面结构（`index.html`）

- `.topbar`：`#dateText`（日期 + 中文星期）、`#clock`（每秒时钟）、`#themeToggle`（🌞/🌙 切换按钮）。**整块 `.topbar-info` 同时是手动调课面板的隐藏入口**。
- `.course-card#courseCard`：内含 `.status-badge`（图标 + 小标题）、`#courseName`、`#classroom`、`#courseTime`、`#teacher`、倒计时区（`#countdownHint` + `#countdownNum` + `#holidayTip`）、`#progress`、`#cardFoot`；卡片外的 `#emptyTip` 负责空态 / 错误态。
- `#overrideMask > .override-sheet`：手动调课弹层（表单 + 课程列表 + 清除按钮）。
- 脚本顺序：`override.js` → `main.js`。

### 4.2 主循环与「最近一节课」筛选

`tick()` 每秒执行：更新顶部栏 → `findNearestCourse(now)` → `renderCourse()`。**面板打开时直接 return**（弹层遮住大屏，继续每秒做课程筛选 + DOM 写入纯属浪费，也是此前移动端面板卡顿的根因之一）。

`findNearestCourse()` 的规则（从今天开始最多向后查 7 天，天然覆盖「周日结束后找周一」）：

1. 当天有课正在上（`start <= now < end`）→ 立即返回，状态 `ongoing`；
2. 否则取当天「开始时间晚于当前时间」中最早的一节，状态 `pending`，并附带 `windowStart` = 上一节课的结束时间（当天没有更早的课则取当天 00:00），用于计算等待进度；
3. 当天课程全部结束 → 查下一天；
4. 7 天内都没有课程 → 返回 `null`，走空态。

### 4.3 三种状态卡片

卡片 class 由 `cardState` 决定，CSS 中三组变量决定配色，文案来自 `CARD_VIEW`：

| 状态 | class | 图标 / 小标题 / 底部小字 | 配色（日间 / 夜间） | 触发条件 |
| --- | --- | --- | --- | --- |
| 待上课 | `.is-pending` | ⏰ 📖 / 即将开课 / 做好准备，不要迟到 | 极淡蓝底 + 细蓝边框 / 深底 + 提亮蓝字 | 命中规则 2 |
| 上课中 | `.is-ongoing` | ✏️ 📚 / 上课进行中 / 专心听讲，认真学习 | 极淡绿底 + 细绿边框 / 深底 + 提亮绿字 | 命中规则 1 |
| 较长假期 | `.is-holiday` | 📅 🌙 ☁️ / 较长假期 / 当前暂无课程安排，可安心休息～ | 极淡红底 + 细红边框 / 深红底 + 亮红字 | 待上课且 `start - now > 48 小时` |

静态内容的重绘条件：`key = 课程 id + 开始时间戳 + 状态`，只有 key 变化时才重写文本，避免每秒闪烁。

**48 小时长间隔**：进入假期态时隐藏 `#countdownMain` 与 `#progress`，只显示 `#holidayTip`；退出时清空 `lastNumText`，让数字动画重新播放一次。

### 4.4 倒计时与进度条

- **倒计时**：待上课时为 `ceil((start - now) / 60000)`；上课中改用 `end`（提示语相应变为「距离下课还有」）。向上取整可保证最后几秒仍显示 1 分钟而不是 0。
- 数字变化时才写 DOM，并重播一次 `tick` 脉冲动画（移除 class → 强制重排 → 加回 class）。
- **进度条**：待上课 = 剩余等待比例 `(start - now) / (start - windowStart)`（从接近 100% 递减到 0）；上课中 = 已上比例 `(now - start) / (end - start)`。
- 渲染使用 `transform: scaleX(ratio)` 而不是 `width`（不触发逐帧布局，移动端更流畅）；切换课程/状态时先关掉 transition 复位到 0，再恢复，避免从上一条课程的进度缓缓动画过来。

### 4.5 日间 / 夜间主题

`applyTheme()` 给 `<html>` 打上 `data-theme="dark|light"`，CSS 侧用 `[data-theme="dark"]` 覆盖整套变量：背景径向渐变、卡片底/边框/阴影、主副文字色、三态配色、按钮与表单控件（含 `--field-bg / --field-text` 与自绘 SVG 下拉箭头，解决夜间原生 `select` 白底浅字看不清的问题）。用户选择存 `localStorage['timetable-theme']`；按钮图标反向显示（日间显示 🌙）。

### 4.6 localStorage 手动调课覆盖层

存储键 `timetable-overrides`，结构（见 `override.js` 头部注释）：

```json
{
  "version": 1,
  "updatedAt": "2026-09-24 12:00:00",
  "edits":   { "<课程key>": { "classroom": "H4-307" } },
  "skipped": { "<课程key>": "2026-09-24" },
  "added":   [ { "id": "local-1758...", "name": "...", "weekday": 3, "startTime": "10:40", "endTime": "12:00", "classroom": "...", "teacher": "..." } ]
}
```

- **课程 key** = `星期|开始时间|结束时间|课程名`（`courseKey()`）。这几项在正方课表里最稳定，所以只改教室/老师时 key 不变，修改记录不会丢失；反之如果教务系统把某节课的上课时间改了，原记录会失配，需要重新编辑。
- **合并逻辑 `merge()`**：
  1. `skipped` 命中的课程直接从结果中剔除；
  2. `edits` 里的字段补丁用 `Object.assign` 覆盖正方原始字段；
  3. `added` 中的本地新增课程追加到结果末尾。
  每项带 `id` 与 `source`（`base` / `edited` / `added`）。**本地覆盖层优先级始终高于正方数据。**
- **只存差异 `buildPatch()`**：只记录与正方原始值不同的字段；把字段全部改回原值时会删除覆盖记录——这样「已修改」标记才准确。
- 面板操作：新增临时课程（`id: local-时间戳`）、编辑、跳过（记录跳过日期）、恢复、删除本地新增课程、一键清除（`localStorage.removeItem` + 二次确认）。
- 渲染细节：列表用 `DocumentFragment` 离线组装后一次性挂载（避免逐条 `append` 造成多次重排）；所有文本用 `textContent` 赋值（用户输入不会被当作 HTML 解析）。
- **隐蔽入口**：`.topbar-info` 上 `pointerdown` 起 700ms 定时器，`pointerup / pointercancel / pointerleave / contextmenu` 取消（长按不弹系统菜单、不选中文字）。
- **联动**：任何写入都会 `dispatchEvent('timetable:overrides-changed')` → `main.js` 立即重新合并并重绘；关闭面板时派发 `timetable:resume` → 立刻恢复每秒刷新。

### 4.7 数据加载与失败兜底

`loadCourses()` 的流程：

1. `DATA_URL` 由文件顶部判定：`localhost` / `127.0.0.1` / `file://` → `http://127.0.0.1:8000/api/timetable`；否则 → 同源 `data/timetable.json`（两种情况都无需改代码）。
2. 请求带 `?v=Date.now()`，避免浏览器 / GitHub Pages 的缓存让大屏读到旧数据。
3. 非 200 时优先读响应里的 `error` 字段（后端给的是中文可读原因），否则用 `HTTP <status>`。
4. **失败不清空**：`baseCourses` 保持上一次成功的数据，只把 `loadError` 交给空态显示（如「课表加载失败：无法连接课表服务，请检查网络」）。
5. 成功 → 合并覆盖层 → 立即 `tick()` 重绘。`init()` 里先渲染一次避免白屏，随后挂上 1 秒的 `tick` 与 5 分钟的 `loadCourses` 定时器。

---

## 五、本地完整启动步骤

```powershell
# 1. 安装依赖（只需三个第三方库，zfn_api 已内联在 api/zfn_api.py）
pip install -r requirements.txt

# 2. 配置环境变量
Copy-Item .env.example .env      # macOS / Linux: cp .env.example .env
#   打开 .env，填写：
#     ZF_BASE_URL           正方地址，只到域名或应用根路径（不要带登录页路径）
#     ZF_USERNAME / ZF_PASSWORD
#     ZF_YEAR / ZF_TERM / SEMESTER_START_DATE（换学期务必修改）

# 3. 启动本地后端（127.0.0.1:8000）
python api/timetable.py
#   浏览器打开 http://127.0.0.1:8000/            直接看到课表 JSON
#   浏览器打开 http://127.0.0.1:8000/?refresh=1  跳过 30 分钟缓存，强制重新拉取

# 4. 打开前端（二选一）
#   方式一：直接双击 public/index.html（file:// 也可用，后端已放行跨域）
#   方式二：起一个本地静态服务（端口别和 8000 冲突）
python -m http.server 8080 --directory public
#   然后访问 http://127.0.0.1:8080
```

可选第 5 步——**在本地先验证 Actions 要跑的那一步**（不必等 GitHub，也便于排查登录问题）：

```bash
python scripts/fetch_timetable.py
# 成功会打印「已生成 public\data\timetable.json：N 门课程，数据时间 ...」
```

排障顺序：

| 现象 | 处理 |
| --- | --- |
| 登录失败 `code=2333` | `ZF_BASE_URL` 没停在应用根路径（见 3.1 第 3 点） |
| 登录失败 `code=1002` | 学号或密码错误 |
| 时间显示不对 | 核对 `api/config.py` 的 `RASPISANIE` 与 `SEMESTER_START_DATE` |
| 某节课不该显示 / 该显示却没显示 | `SEMESTER_START_DATE` 是否与真实第一周周一一致 |
| 样式/逻辑没更新 | **Ctrl + F5 强制刷新**（手机浏览器同样要清缓存） |

---

## 六、线上部署运行流程

### 6.1 一次性配置

1. 建仓库并把代码推到 `main`（`.env` 已在 `.gitignore` 中，`git status` 里不该出现它）。
2. 仓库 **Settings → Secrets and variables → Actions** 配置：
   - Secrets：`ZF_BASE_URL`、`ZF_USERNAME`、`ZF_PASSWORD`
   - Variables（可选）：`ZF_YEAR`、`ZF_TERM`、`SEMESTER_START_DATE`（不填则用 `api/config.py` 的默认值）
3. 仓库 **Settings → Pages**：Source = `Deploy from a branch`，Branch = `gh-pages`，目录 `/(root)`。
   `gh-pages` 分支由 Workflow 自动维护，**不要手动推**。

### 6.2 Workflow 每次执行做什么（`update-timetable.yml`）

触发方式：

| 触发 | 时机 |
| --- | --- |
| `schedule` | 每小时一次（`cron: '0 * * * *'`；GitHub 定时任务可能有几分钟延迟） |
| `push: main` | 改前端样式/逻辑会自动重新发布，不必手动推 `gh-pages` |
| `workflow_dispatch` | 手动触发，教务改课后想立刻生效时用 |

执行步骤（`concurrency` 串行化，避免两次执行互相覆盖）：

```
actions/checkout
  → actions/setup-python@v5（3.12，cache: pip）
  → pip install -r requirements.txt
  → env: 从 Secrets / Variables 注入 6 个变量
  → python scripts/fetch_timetable.py        # 登录正方，写出 public/data/timetable.json
  → git worktree 挂出 gh-pages → 清空其内容 → cp -r public/. 覆盖 → commit → push HEAD:gh-pages
```

最后一步推送成功后，GitHub Pages 自动重新发布，线上生效。整个过程约 20 秒。

### 6.3 前端与后端如何联动

- 后端（Actions）只负责「产出文件」，前端只负责「读同一域名下的那个文件」，二者之间**没有 API 调用、没有跨域、没有 token**。
- 所以后端失败也只是数据不更新：页面照常显示上一次的课表数据与 `updatedAt`。
- **抓取失败不发布**：登录/拉取出错时脚本非 0 退出，Workflow 直接变红停在抓取步骤，`gh-pages` 保持上一次成功的数据，**不会把课表刷成空白**；下一次定时执行自动重试。
- 最新数据最多滞后 1 小时；想立刻更新就到 Actions 页面点 **Run workflow**。
- 仓库连续 60 天无活动后，GitHub 会暂停定时任务，届时到 Actions 页面点一下 **Enable workflow** 即可。

---

## 七、关键注意事项

1. **手动调课只存在本机浏览器，绝不上传**：所有新增 / 修改 / 跳过都写进当前浏览器的 `localStorage['timetable-overrides']`，**不发送任何请求**；换手机、换浏览器、清理浏览器数据后都会恢复成正方原始课表。想彻底还原，可在面板点「清除全部手动修改」，或在控制台执行 `localStorage.removeItem('timetable-overrides')`。
2. **对正方系统只读**：后端只做「登录 + 拉课表」，从不写回教务系统；本地调试时 30 分钟内走内存缓存，不会高频登录（降低被风控的概率）。
3. **凭据绝不进前端 / 仓库**：学号、密码、正方地址只存在于本地 `.env`（已 gitignore）与 Actions Secrets；接口只返回标准化字段，不暴露正方原始数据。
4. **换学期必须改两处**：`ZF_YEAR` / `ZF_TERM`（学年学期）与 `SEMESTER_START_DATE`（第一周周一）。否则教学周过滤会失效——一门只上前 4 周的课会在第 12 周继续显示。
5. **作息表各校不同**：`api/config.py` 的 `RASPISANIE` 必须按本校实际作息核对（当前为 12 节制、第一节 09:00 开始），它决定大屏显示的起止时间。
6. **48 小时阈值是刻意设计**：距下一节课超过 48 小时即进入假期态（隐藏倒计时与进度条），不是缺数据；节假日前会看到红色假期卡片。
7. **数据新鲜度看 `updatedAt`**：它是数据实际拉取的时间；前端每 5 分钟重新读一次静态文件，Actions 每小时重写一次。
8. **不要手动推 `gh-pages`**（如 `git subtree push`），会和 Workflow 互相覆盖；前端改动直接推 `main` 即可自动发布。
9. **手机浏览器会缓存 CSS/JS**：样式没生效先 Ctrl + F5 或清缓存。页面已针对移动端优化：进度条用 `transform`、面板打开时暂停每秒 `tick`、列表一次性挂载。
10. **推送可能被网络干扰**：GitHub 的 HTTPS 443 在国内偶发被重置，本仓库 `origin` 已改为 SSH（`git@github.com:SailSilMeta/KJdata.git`），推送更稳定。