# -*- coding: utf-8 -*-
"""
课表大屏展示系统 —— 后端配置常量

安全约束：
    学号、密码、教务系统地址一律从环境变量读取，
    严禁硬编码在本文件或任何会提交到公开仓库的代码中。

配置位置：
    本地开发 —— 在项目根目录 .env 中配置，本文件会自动加载
    GitHub Actions —— 由仓库的 Secrets / Variables 注入（见 .github/workflows/）
"""

import os
from datetime import datetime, timedelta, timezone

# 统一使用北京时间（东八区）：
# GitHub Actions 的 runner 跑在 UTC，直接用 datetime.now() 会比北京时间慢 8 小时，
# 会让「当前教学周」「学年」在凌晨时段算错（例如周一 00:00~08:00 会被当成上一周），
# 输出的 updatedAt 也会与本地运行的结果相差 8 小时。
BEIJING_TZ = timezone(timedelta(hours=8))


def now_bj():
    """当前北京时间（东八区），全项目统一用它取「现在」"""
    return datetime.now(BEIJING_TZ)


def _load_dotenv():
    """把项目根目录下的 .env 载入环境变量。

    只用标准库实现，避免为了读一个配置文件就引入 python-dotenv。
    .env 已在 .gitignore 中忽略，不会被提交到公开仓库；
    在 Actions 里运行时走的是 Secrets / Variables 注入的环境变量，不会执行到这里。
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    if not os.path.isfile(path):
        return

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, _, value = line.partition("=")
            key = key.strip()
            # 去掉值两端可能写的引号
            value = value.strip().strip('"').strip("'")

            # 已存在的真实环境变量优先，避免本地 .env 覆盖平台注入的值
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()


def _env(name, default=""):
    """读取环境变量并去掉首尾空白。

    在网页端粘贴环境变量时很容易带上换行或空格，统一清理掉，
    避免出现「配置看起来没问题、但登录一直失败」的排查困难。
    """
    return (os.environ.get(name) or default).strip()


# ============================================================
# 一、正方教务系统连接信息（敏感，只允许来自环境变量）
# ============================================================
def _normalize_base_url(url):
    """把粘贴进来的地址规范成 zfn_api 需要的「应用根路径」。

    zfn_api 内部用 urljoin(base_url, "xtgl/login_getPublicKey.html") 拼接口地址，
    而 urljoin 的特性是「替换掉 base_url 的最后一段路径」，所以 base_url
    必须停在应用根目录并且以 / 结尾。否则会拼出 .../xtgl/xtgl/xxx.html 这种
    多一层目录的地址，服务端返回 302 跳转到登录页，解析 JSON 失败后被库
    兜底成 code=2333（错误提示完全看不出真实原因）。

    因此这里统一兼容三种常见写法：
        https://jwxt.gzus.edu.cn/jwglxt/xtgl/login_slogin.html  -> https://jwxt.gzus.edu.cn/jwglxt/
        https://jwxt.gzus.edu.cn/jwglxt                         -> https://jwxt.gzus.edu.cn/jwglxt/
        https://jwxt.gzus.edu.cn                                -> https://jwxt.gzus.edu.cn/
    """
    if not url:
        return ""

    url = url.strip()

    # 去掉粘贴时可能带上的查询参数与锚点
    url = url.split("?")[0].split("#")[0]

    # 去掉登录页尾段，只保留应用根路径（兼容新旧两版正方的登录页命名）
    for tail in ("xtgl/login_slogin.html", "xtgl/login_slogin", "login_slogin.html"):
        if url.endswith(tail):
            url = url[: -len(tail)]
            break

    if not url.endswith("/"):
        url += "/"

    return url


ZF_BASE_URL = _normalize_base_url(_env("ZF_BASE_URL"))   # 例：https://jw.example.edu.cn/jwglxt/
ZF_USERNAME = _env("ZF_USERNAME")   # 学号
ZF_PASSWORD = _env("ZF_PASSWORD")   # 密码


# ============================================================
# 二、学年学期
# ============================================================
# 正方接口的学期只接受 1（第一学期）或 2（第二学期）。
# 默认取当前年份的第 1 学期；换学期时改环境变量即可，不需要动代码。
ZF_YEAR = _env("ZF_YEAR", str(now_bj().year))
ZF_TERM = _env("ZF_TERM", "1")


def get_year_term():
    """返回 (学年, 学期)。

    环境变量写错时不抛异常，而是回退到安全默认值，
    避免因为一个笔误导致整个接口 500。
    """
    try:
        year = int(ZF_YEAR)
    except (TypeError, ValueError):
        year = now_bj().year

    try:
        term = int(ZF_TERM)
    except (TypeError, ValueError):
        term = 1
    if term not in (1, 2):
        term = 1

    return year, term


# ============================================================
# 二·五、教学周起始日期
# ============================================================
# 本学期第一周的周一日期（格式 YYYY-MM-DD）。
#
# 为什么需要它：正方返回的是「全学期课表」，包含 1~18 周所有课程。
# 如果不做过滤，一门只在第 1~4 周上的课，到第 12 周打开大屏仍然会显示。
# 有了第一周起始日期，就能算出当前是第几教学周，只保留本周实际开课的课程。
#
# 换学期时务必同步修改（或改环境变量，不用动代码）。
SEMESTER_START_DATE = _env("SEMESTER_START_DATE", "2026-08-31")


def get_semester_start():
    """返回本学期第一周的周一日期；格式非法时返回 None（此时不做教学周过滤）。"""
    try:
        return datetime.strptime(SEMESTER_START_DATE, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


# ============================================================
# 三、节次上下课时间表
# ============================================================
# 正方课表返回的是「第几节」（例如 sessions="1-2"），需要映射成本校实际的上下课时间。
# 索引 i 对应第 i+1 节课，每项格式为 [开始时间, 结束时间]。
#
# ⚠️ 各校作息差异很大，务必按本校实际时间改成一致，否则大屏显示的起止时间会不对。
# 下面这张表已按本校实际作息填写（12 节制，第一节 09:00 开始）。
RASPISANIE = [
    ["09:00", "09:40"],   # 第 1 节
    ["09:40", "10:20"],   # 第 2 节
    ["10:40", "11:20"],   # 第 3 节
    ["11:20", "12:00"],   # 第 4 节
    ["12:30", "13:10"],   # 第 5 节
    ["13:10", "13:50"],   # 第 6 节
    ["14:00", "14:40"],   # 第 7 节
    ["14:40", "15:20"],   # 第 8 节
    ["15:30", "16:10"],   # 第 9 节
    ["16:10", "16:50"],   # 第 10 节
    ["17:00", "17:40"],   # 第 11 节
    ["17:40", "18:20"],   # 第 12 节
]

# 说明：zfn_api 自带的 display_course_time() 存在下标偏移
# （用 raspisanie[节次 + 1]，把第 1 节算成了第 3 节的时间），它返回的 time 字段不可信。
# 因此本项目不使用该字段，而是用上面这张表自行换算。


# ============================================================
# 四、缓存与请求
# ============================================================
# 内存缓存有效期（秒）。默认 30 分钟，避免每次访问都重新登录正方（登录较慢且可能被风控）。
CACHE_TTL_SECONDS = int(_env("CACHE_TTL_SECONDS", "1800"))

# 调用正方接口的超时时间（秒）。
REQUEST_TIMEOUT = int(_env("ZF_REQUEST_TIMEOUT", "8"))


# ============================================================
# 五、跨域
# ============================================================
# 本地调试时前端与服务不同源（页面在 8080 或 file://，服务在 8000），必须显式放行。
# 默认 * 只为了方便本地调试，接口不返回任何凭据，可放心保持。
ALLOWED_ORIGIN = _env("ALLOWED_ORIGIN", "*")