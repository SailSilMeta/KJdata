# 课表大屏展示系统

面向安卓手机竖屏的「最近一节课」大屏：一屏看清 **下一节课在哪、还有多久、还剩多久下课**，数据自动从正方教务系统拉取，并支持在手机上临时改教室 / 跳过调课。

---

## 一、项目简介

| 项目 | 说明 |
| --- | --- |
| 前端 | 原生 HTML + CSS + JavaScript，纯静态，部署到 GitHub Pages |
| 后端 | Vercel Serverless Functions（Python），调用 `zfn_api` 拉取正方课表 |
| 手动调课 | 前端 localStorage 覆盖层，优先级高于正方课表数据 |
| 账号安全 | 学号 / 密码只存在于环境变量，前端代码中不出现 |

### 功能清单

- 顶部实时日期、中文星期、每秒刷新的时钟
- 卡片三态自动切换：**待上课（极淡蓝）** / **上课中（极淡绿）** / **较长假期（极淡红）**，各带图标、小标题、正文与底部提示小字
- 倒计时每秒刷新，数字变化带平滑脉冲动画；进度条每秒平滑推进
- 距离下一节课超过 **48 小时** 时自动进入假期态：隐藏倒计时与进度条，展示假期文案
- 日间 / 夜间主题一键切换，选择记忆在浏览器中；夜间自动适配深色底与浅色文字
- 手动调课覆盖层：新增临时课程、修改课程、临时跳过、一键清除
- 后端 30 分钟内存缓存，避免频繁登录教务系统

### 目录结构

```
timetable-system/
├── public/                     # 前端静态资源（部署 GitHub Pages）
│   ├── index.html              # 首页大屏
│   ├── css/style.css           # 全局样式（日间 / 夜间主题变量）
│   └── js/
│       ├── main.js             # 大屏核心逻辑：接口请求、课程筛选、倒计时、进度条、主题切换
│       └── override.js         # 手动调课覆盖层：localStorage 增删改查、数据合并
├── api/                        # Vercel Serverless Functions（Python）
│   ├── timetable.py            # GET /api/timetable：登录正方 → 拉课表 → 标准化 → 缓存 → 返回
│   ├── config.py               # 配置常量：学年学期、教学周起始、作息时间表、缓存 TTL
│   └── zfn_api.py              # 正方接口库源码（已内联，无需 pip 安装）
├── requirements.txt            # Python 依赖（requests / rsa / pyquery）
├── vercel.json                 # Vercel 配置（函数超时 30s）
├── .env.example                # 环境变量模板（复制为 .env 使用）
└── README.md
```

### 数据流

```
浏览器 ──GET /api/timetable──▶ Vercel 函数 ──▶ 登录正方教务系统
   ▲                                               │
   └── 标准化 JSON ◀── 30 分钟内存缓存 ◀── 全学期课表（按当前教学周过滤）
   │
   └─▶ 与 localStorage 手动调课覆盖层合并（覆盖层优先）──▶ 渲染大屏
```

### 接口

`GET /api/timetable`（无参数；`?refresh=1` 跳过缓存强制拉取）

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

失败时返回非 200 与 `{"error": "错误说明"}`（前端会直接展示该说明）。

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

### 4. 启动后端

```bash
python api/timetable.py
```

- 接口地址：<http://127.0.0.1:8000>
- 跳过缓存强制拉取：<http://127.0.0.1:8000/?refresh=1>
- 用浏览器直接打开该地址即可看到返回的 JSON，便于确认字段是否正确

该本地入口复用的就是 Vercel 线上同一个 `handler`，所以本地看到的结构和错误信息与线上一致。

### 5. 打开前端

方式一：直接用浏览器打开 `public/index.html`（`file://` 也可，后端已放行跨域）

方式二：起一个本地静态服务（端口别和 8000 冲突）

```bash
python -m http.server 8080 --directory public
```

然后访问 <http://127.0.0.1:8080>。

> `public/js/main.js` 顶部的 `API_BASE` 会自动判断：本机打开（`localhost` / `127.0.0.1` / `file://`）自动指向
> `http://127.0.0.1:8000`，无需改代码；部署到线上时才需要改 `PROD_API_BASE`（见第五节）。

> 修改前端文件后请 **Ctrl + F5 强制刷新**，手机浏览器可能缓存旧的 CSS / JS。

---

## 三、环境变量配置说明

在项目根目录的 `.env` 中配置（线上则在 Vercel 控制台配置同名变量）。

| 变量名 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `ZF_BASE_URL` | 是 | 正方教务系统地址，只填到域名或应用根路径，**不要带具体页面路径** | `https://jwxt.gzus.edu.cn/` |
| `ZF_USERNAME` | 是 | 学号 | `2024xxxxxxxx` |
| `ZF_PASSWORD` | 是 | 密码 | `********` |
| `ZF_YEAR` | 是 | 学年（正方接口里通常等于「开课年份」） | `2026` |
| `ZF_TERM` | 是 | 学期，只能是 `1` 或 `2` | `1` |
| `SEMESTER_START_DATE` | 是 | 本学期**第一周的周一**日期，用于算出当前教学周，只显示本周实际开课的课程。**换学期务必修改** | `2026-08-31` |
| `CACHE_TTL_SECONDS` | 否 | 内存缓存有效期（秒），默认 `1800` | `1800` |
| `ZF_REQUEST_TIMEOUT` | 否 | 调用正方接口超时（秒），默认 `8` | `8` |
| `ALLOWED_ORIGIN` | 否 | 允许跨域的前端来源，默认 `*`；前端上 Pages 后建议改成具体地址 | `https://your-name.github.io` |

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

3. **安全**：学号密码只允许写在 `.env` 或 Vercel 环境变量中。
   `.env` 已被 `.gitignore` 忽略，前端代码里不出现任何凭据。

---

## 四、Vercel 部署步骤

1. **推送代码到 GitHub**（若尚未初始化仓库）

   ```bash
   git init
   git add .
   git commit -m "feat: 课表大屏展示系统"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```

   推送前确认 `.env` 没有被加入（`git status` 里不应出现 `.env`）。

2. **导入项目**：打开 <https://vercel.com/new>，选择该 GitHub 仓库。

3. **配置构建**：
   - Framework Preset：`Other`
   - Root Directory：`./`
   - Build Command / Output Directory：留空

4. **配置环境变量**：展开 `Environment Variables`，把上一节表格里的变量逐条添加
   （`Environment` 至少勾选 `Production`，建议同时勾选 `Preview`）。
   **不要**上传 `.env` 文件。

5. **部署**：点击 `Deploy`，等待完成，得到形如 `https://xxx.vercel.app` 的域名。

6. **验证接口**：浏览器打开 `https://xxx.vercel.app/api/timetable`，
   能看到课表 JSON 即成功；报错信息会直接显示在 `error` 字段里。

### 说明

- `api/*.py` 会被自动识别为 Python Serverless Function，依赖从根目录的 `requirements.txt` 安装，无需额外配置运行时。
- `vercel.json` 中已把该函数的 `maxDuration` 放宽到 30 秒（登录正方较慢）。
- 首次访问较慢属正常（需要登录正方），之后 30 分钟内走缓存，响应很快。
- **修改环境变量后必须重新部署（Redeploy）才会生效。**
- 顺带一提：Vercel 会同时把 `public/` 作为静态站点发布，因此直接访问 `https://xxx.vercel.app/`
  也能用（前后端同源，最省事）；如果你更想用 GitHub Pages 打开前端，继续看下一节。

---

## 五、GitHub Pages 部署步骤

### 1. 先改前端接口地址

把 `public/js/main.js` 顶部的占位域名改成上一步拿到的 Vercel 域名：

```js
const PROD_API_BASE = 'https://xxx.vercel.app';
```

### 2. 发布 public 目录

GitHub Pages 的分支发布只支持仓库根目录或 `/docs`，而本项目前端在 `public/`，
所以用下面任一方式发布。

**方式一：GitHub Actions（推荐，改完自动发布）**

在仓库中新建文件 `.github/workflows/deploy-pages.yml`：

```yaml
name: Deploy frontend to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: public
      - id: deployment
        uses: actions/deploy-pages@v4
```

然后：仓库 **Settings → Pages → Build and deployment → Source 选 `GitHub Actions`**，
再手动跑一次该 Workflow（或推送一次提交）。

**方式二：只把 public 内容推到 gh-pages 分支**

```bash
git subtree push --prefix public origin gh-pages
```

然后：**Settings → Pages → Source 选 `Deploy from a branch` → 分支选 `gh-pages` / 目录选 `/(root)`**。

### 3. 访问并收尾

- Pages 地址形如 `https://<用户名>.github.io/<仓库名>/`，在 Settings → Pages 顶部可看到。
- 回到 Vercel，把环境变量 `ALLOWED_ORIGIN` 改成该 Pages 地址（例如 `https://your-name.github.io`），
  然后 **Redeploy**，避免前端跨域被拦。
- 首次打开若样式或数据不对，用 **Ctrl + F5 强制刷新**；手机端同理清一下浏览器缓存。

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
| 卡片显示「课表加载失败：无法连接课表服务」 | 后端没启动，或线上 `PROD_API_BASE` 填错 |
| 502 且提示「服务端未配置环境变量」 | 没配 `.env` / Vercel 变量漏配，或改了变量没 Redeploy |
| 登录失败 `code=2333` | `ZF_BASE_URL` 没停在应用根路径（见第三节注意事项 1） |
| 登录失败 `code=1002` | 学号或密码错误 |
| 时间显示不对 | 核对 `RASPISIANIE` 作息表与 `SEMESTER_START_DATE` |
| 手机上样式没更新 | 浏览器缓存，强制刷新或清理缓存后重试 |
| 某节课不该显示 / 该显示却没显示 | 检查 `SEMESTER_START_DATE` 是否正确，教学周过滤依赖它 |

> 提醒：教务系统的登录接口不建议高频调用，本项目已用 30 分钟缓存兜底，请勿把 `CACHE_TTL_SECONDS` 调得过小。