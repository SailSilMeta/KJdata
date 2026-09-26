# 课表大屏展示系统

面向安卓手机竖屏的「最近一节课」大屏：一屏看清 **下一节课在哪、还有多久、还剩多久下课**，数据自动从正方教务系统拉取，并支持在手机上临时改教室 / 跳过调课。

---

## 一、项目简介

| 项目 | 说明 |
| --- | --- |
| 前端 | 原生 HTML + CSS + JavaScript，纯静态，部署到 GitHub Pages |
| 数据来源 | GitHub Actions 定时登录正方拉课表，生成静态 JSON 随前端一起发布到 Pages |
| 后端 | 线上**不需要**任何后端服务器；`api/` 里的 Python 版本只用于本地调试 |
| 手动调课 | 前端 localStorage 覆盖层，优先级高于正方课表数据 |
| 账号安全 | 学号 / 密码只存在于 Actions Secrets 与本地 `.env`，前端代码中不出现 |

### 功能清单

- 顶部实时日期、中文星期、每秒刷新的时钟
- 卡片三态自动切换：**待上课（极淡蓝）** / **上课中（极淡绿）** / **较长假期（极淡红）**，各带图标、小标题、正文与底部提示小字
- 卡片底部带极淡的校园线稿插画（纯 CSS + 内联 SVG，无任何图片）：待上课为教学楼与榕树，上课中为长排教学楼立面，较长假期为「江门侨乡水岸长卷」（开平碉楼 + 骑楼 + 榕树 + 水面天光）
- 倒计时每秒刷新，数字变化带平滑脉冲动画；进度条每秒平滑推进
- 距离下一节课超过 **48 小时** 时自动进入假期态：隐藏倒计时与进度条，展示假期文案
- 日间 / 夜间主题一键切换，选择记忆在浏览器中；夜间自动适配深色底与浅色文字，插画同步切换天空、水面与零星亮灯的窗
- 手动调课覆盖层：新增临时课程、修改课程、临时跳过、一键清除
- GitHub Actions 每小时更新一次课表数据，无需人工干预

### 目录结构

```
timetable-system/
├── public/                     # 前端静态资源（发布到 GitHub Pages）
│   ├── index.html              # 首页大屏
│   ├── css/style.css           # 全局样式（日间 / 夜间主题变量）
│   ├── js/
│   │   ├── main.js             # 大屏核心逻辑：数据请求、课程筛选、倒计时、进度条、主题切换
│   │   └── override.js         # 手动调课覆盖层：localStorage 增删改查、数据合并
│   └── data/timetable.json     # 课表数据（Actions 定时生成，不入库）
├── scripts/
│   └── fetch_timetable.py      # 登录正方 → 拉课表 → 标准化 → 写出上面的 JSON
├── .github/workflows/
│   └── update-timetable.yml    # 定时抓取 + 把 public/ 发布到 gh-pages 分支
├── api/                        # 仅本地调试用的 Python 版本（线上不部署）
│   ├── timetable.py            # 本地 HTTP 入口：python api/timetable.py
│   ├── config.py               # 配置常量：学年学期、教学周起始、作息时间表
│   └── zfn_api.py              # 正方接口库源码（已内联，无需 pip 安装）
├── requirements.txt            # Python 依赖（requests / rsa / pyquery）
├── .env.example                # 环境变量模板（复制为 .env 使用）
└── README.md
```

### 数据流

```
【每小时】GitHub Actions
   └─▶ scripts/fetch_timetable.py ──▶ 登录正方教务系统 ──▶ 标准化 JSON
                                       （按当前教学周过滤）
   └─▶ public/data/timetable.json ──▶ 随 public/ 一起发布到 gh-pages 分支

【打开页面】浏览器（GitHub Pages，国内可直连）
   └─▶ 读取同源静态文件 data/timetable.json
   └─▶ 与 localStorage 手动调课覆盖层合并（覆盖层优先）──▶ 渲染大屏
```

### 数据文件

前端线上读取的是同源静态文件 `data/timetable.json`（仓库里的 `public/data/timetable.json`）；
本地开发时改读 `http://127.0.0.1:8000/api/timetable`（见第二节）。

```json
{
  "courses": [
    {
      "name": "高等数学II（理）",
      "weekday": 1,
      "startTime": "09:00",
      "endTime": "10:20",
      "classroom": "H4-307(江)",
      "teacher": "何启茹"
    }
  ],
  "updatedAt": "2026-09-24 15:07:27",
  "source": "zf_api"
}
```

`updatedAt` 是数据实际拉取的时间，可以据此判断课表数据有多新。

---

## 二、本地开发环境搭建

### 1. 准备

- Python 3.9 及以上
- 任意现代浏览器

### 2. 安装 Python 依赖

在项目根目录执行：

```bash
pip install -r requirements.txt
```

> `zfn_api` 上游仓库没有 `setup.py`、也未发布到 PyPI，无法通过 pip 安装，
> 其源码已直接内联在 `api/zfn_api.py`（MPL-2.0），所以这里只需装它自身依赖的三个库。

### 3. 配置环境变量

```powershell
# Windows PowerShell
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

然后用编辑器打开 `.env`，按下一节说明填入真实信息。`.env` 已在 `.gitignore` 中忽略，不会被提交。

### 4. 启动本地后端

```bash
python api/timetable.py
```

- 接口地址：<http://127.0.0.1:8000>
- 跳过缓存强制拉取：<http://127.0.0.1:8000/?refresh=1>
- 用浏览器直接打开该地址即可看到返回的 JSON，便于确认字段是否正确

本地跑的就是线上同一套拉取与标准化逻辑（`scripts/fetch_timetable.py` 直接复用这个模块）。

### 5. 打开前端

方式一：直接用浏览器打开 `public/index.html`（`file://` 也可，后端已放行跨域）

方式二：起一个本地静态服务（端口别和 8000 冲突）

```bash
python -m http.server 8080 --directory public
```

然后访问 <http://127.0.0.1:8080>。

> `public/js/main.js` 顶部的 `DATA_URL` 会自动判断：本机打开（`localhost` / `127.0.0.1` / `file://`）指向
> `http://127.0.0.1:8000/api/timetable`，线上指向同源静态文件 `data/timetable.json`，两种情况都无需改代码。

> 修改前端文件后请 **Ctrl + F5 强制刷新**，手机浏览器可能缓存旧的 CSS / JS。

### 6. 本地验证 Actions 要跑的那一步（可选）

不必等 GitHub，先在本地把静态数据生成一遍，确认能正常登录并拿到课程：

```bash
python scripts/fetch_timetable.py
```

成功会打印「已生成 public\data\timetable.json：N 门课程」；失败会直接给出可读的错误原因
（例如「登录失败：…」、`ZF_BASE_URL` 写错导致的 `code=2333`）。
生成的 `public/data/` 已被 `.gitignore` 忽略，不会误提交。

---

## 三、环境变量配置说明

在项目根目录的 `.env` 中配置（本地开发用）；线上则配置到 GitHub 仓库的
**Settings → Secrets and variables → Actions**（见第四节），**不要把 `.env` 提交到仓库**。

| 变量名 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `ZF_BASE_URL` | 是 | 正方教务系统地址，只填到域名或应用根路径，**不要带具体页面路径** | `https://jwxt.gzus.edu.cn/` |
| `ZF_USERNAME` | 是 | 学号 | `2024xxxxxxxx` |
| `ZF_PASSWORD` | 是 | 密码 | `********` |
| `ZF_YEAR` | 否 | 学年（正方接口里通常等于「开课年份」），不填取当前年份 | `2026` |
| `ZF_TERM` | 否 | 学期，只能是 `1` 或 `2`，不填为 `1` | `1` |
| `SEMESTER_START_DATE` | 是 | 本学期**第一周的周一**日期，用于算出当前教学周，只显示本周实际开课的课程。**换学期务必修改** | `2026-08-31` |
| `CACHE_TTL_SECONDS` | 否 | 内存缓存有效期（秒），默认 `1800`；**仅 `api/` 本地调试用** | `1800` |
| `ZF_REQUEST_TIMEOUT` | 否 | 调用正方接口超时（秒），默认 `8` | `8` |
| `ALLOWED_ORIGIN` | 否 | 允许跨域的前端来源，默认 `*`；**仅 `api/` 本地调试用** | `https://your-name.github.io` |

### 注意事项

1. **`ZF_BASE_URL` 的写法**：代码会自动兼容下面三种写法，统一规范成 zfn_api 需要的「应用根路径」。
   若填成带 `xtgl/login_slogin.html` 的登录页地址，`urljoin` 会拼出多一层目录的地址，
   表现为 **登录失败 code=2333** 这种看不出真实原因的报错。

   ```
   https://jwxt.gzus.edu.cn/jwglxt/xtgl/login_slogin.html  ✅ 自动截断
   https://jwxt.gzus.edu.cn/jwglxt                          ✅ 自动补 /
   https://jwxt.gzus.edu.cn                                ✅ 自动补 /
   ```

2. **作息时间表**：`api/config.py` 中的 `RASPISANIE` 是「第几节 → 上下课时间」的映射表。
   **各校差异很大，必须按本校实际作息核对修改**，否则大屏显示的起止时间会不对。

3. **安全**：学号密码只允许写在本地 `.env` 与 GitHub Actions Secrets 中。
   `.env` 已被 `.gitignore` 忽略，前端代码与公开仓库里不出现任何凭据。

---

## 四、配置自动更新课表（GitHub Actions，必做）

线上的课表数据由 GitHub Actions 定时抓取生成，**不配置这一节，页面就拿不到任何课程**。

### 1. 添加密钥

仓库 **Settings → Secrets and variables → Actions**：

| 位置 | 名称 | 说明 |
| --- | --- | --- |
| Secrets | `ZF_BASE_URL` | 同第三节表格，只填到域名或应用根路径 |
| Secrets | `ZF_USERNAME` | 学号 |
| Secrets | `ZF_PASSWORD` | 密码 |
| Variables（可选） | `ZF_YEAR` | 学年；不填则取运行时的当前年份 |
| Variables（可选） | `ZF_TERM` | 学期 `1` / `2`；不填则为 `1` |
| Variables（可选） | `SEMESTER_START_DATE` | 第一周周一日期；不填则用 `api/config.py` 里的默认值 |

> Secrets 添加后无法再查看内容，只能覆盖重填，也绝不会打印到日志里。
> 换学期时改 `ZF_YEAR` / `ZF_TERM` / `SEMESTER_START_DATE` 即可，不必动代码。

### 2. 手动跑一次

仓库 **Actions → 「更新课表并发布到 GitHub Pages」→ Run workflow**。
跑完后 `gh-pages` 分支会多出 `data/timetable.json`，GitHub Pages 随即自动重新发布。

### 3. 之后都是自动的

| 触发方式 | 时机 |
| --- | --- |
| `schedule` | 每小时一次（GitHub 的定时任务可能有几分钟延迟） |
| `push` | 推送到 `main` 分支时——改了前端样式/逻辑会自动发布，不必再手动推 `gh-pages` |
| `workflow_dispatch` | 手动触发，教务系统改课后想立刻生效时用 |

### 4. 注意事项

- **拉取失败时不会发布**：Workflow 直接报错（Actions 页面可见），`gh-pages` 保持上一次的成功数据，
  不会把课表刷成空白。下次定时执行会自动重试。
- GitHub 会在仓库连续 60 天无活动后暂停定时任务，届时到 Actions 页面点一下 **Enable workflow** 即可。
- 教务系统的登录接口不宜高频调用，默认每小时一次，请勿把 `cron` 改得过于频繁。

---

## 五、GitHub Pages 设置

`gh-pages` 分支已经建好，并且**由第四节的 Workflow 自动维护**（每次执行都会把整个 `public/` 重新发布上去），
所以平时不需要手动发布前端。

只需确认仓库的分支发布配置正确：**Settings → Pages → Build and deployment**：

- Source 选 `Deploy from a branch`
- Branch 选 `gh-pages`，目录选 `/(root)`

本仓库当前已经是这个配置，一般不用再改。

### 检查与收尾

- Pages 地址形如 `https://<用户名>.github.io/<仓库名>/`，在 **Settings → Pages** 顶部可看到。
- 确认数据文件可访问：浏览器打开 `https://<用户名>.github.io/<仓库名>/data/timetable.json`，
  能看到 `courses` 数组即说明第四节的 Workflow 已经跑通。
- 首次打开若样式或数据不对，用 **Ctrl + F5 强制刷新**；手机端同理清一下浏览器缓存。
- 不要再手动推 `gh-pages`（例如 `git subtree push`），会和 Workflow 互相覆盖。

---

## 六、手动调课使用说明

### 打开面板

**长按顶部「日期 + 时钟」区域约 0.7 秒**（电脑上按住鼠标左键不放），会弹出「手动调课」面板。
关闭方式：右上角「关闭」/ 点击遮罩空白处 / 按 `Esc`。

### 可以做什么

| 操作 | 说明 |
| --- | --- |
| 新增临时课程 | 填写课程名称、星期、开始/结束时间、教室、老师（选填），点「新增课程」 |
| 修改课程 | 在课程列表点「编辑」，改完后提交；只会覆盖你改过的字段 |
| 临时跳过 | 点「跳过」，该课从大屏移除（如临时停课、调课）；列表中会标为「已跳过」 |
| 恢复 | 已跳过的课程点「恢复」即可还原 |
| 删除 | 本地新增的课程点「删除」 |
| 全部清除 | 面板底部「清除全部手动修改」，确认后一次性还原成正方原始课表 |

### 生效规则

- **覆盖层优先级高于正方课表**：新增的课程会参与「最近一节课」的计算，被跳过的课不再出现，
  被修改的教室 / 时间会立即体现在大屏卡片上（改完立刻生效，无需刷新）。
- 课程匹配依据是 **星期 + 开始时间 + 结束时间 + 课程名**。
  所以修改教室或老师不会丢失记录；但如果教务系统把某节课的上课时间改了，原修改记录会失配，需要重新编辑。

### 存储与影响范围

- 所有手动修改**只保存在当前浏览器的 localStorage**（键名 `timetable-overrides` 或 `timetable-theme`），
  不会上传到服务器，**更不会写回教务系统**——正方接口只做只读的「登录 + 拉课表」。
- 因此：换手机、换浏览器、清理浏览器数据后，都会恢复成正方的原始课表。
- 想彻底还原，除了面板里的「清除全部手动修改」，也可以在浏览器控制台执行
  `localStorage.removeItem('timetable-overrides')`。

---

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 线上卡片一直显示「课表加载失败：HTTP 404」或「暂无课程数据」 | 第四节的 Workflow 还没成功跑过，`gh-pages` 里没有 `data/timetable.json`；去 Actions 页面看失败原因 |
| Workflow 报「服务端未配置环境变量」 | Secrets 没配、名字写错或有多余空格（见第四节） |
| 本地卡片显示「课表加载失败：无法连接课表服务」 | 本地后端没启动：`python api/timetable.py` |
| 登录失败 `code=2333` | `ZF_BASE_URL` 没停在应用根路径（见第三节注意事项 1） |
| 登录失败 `code=1002` | 学号或密码错误 |
| 时间显示不对 | 核对 `api/config.py` 的 `RASPISANIE` 作息表与 `SEMESTER_START_DATE` |
| 课表改了但大屏还是旧的 | 等下一次定时执行，或到 Actions 页面手动 Run workflow |
| 手机上样式没更新 | 浏览器缓存，强制刷新或清理缓存后重试 |
| 某节课不该显示 / 该显示却没显示 | 检查 `SEMESTER_START_DATE` 是否正确，教学周过滤依赖它 |

> 提醒：教务系统的登录接口不建议高频调用，本项目默认每小时更新一次，请勿把 `.github/workflows/update-timetable.yml` 里的 `cron` 改得过密。