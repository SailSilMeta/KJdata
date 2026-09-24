# -*- coding: utf-8 -*-
"""
课表大屏展示系统 —— 课表接口

GET /api/timetable
    登录正方教务系统 → 拉取课表 → 标准化 → 内存 TTL 缓存 → 返回 JSON

安全约束：
    1. 学号 / 密码 / 教务系统地址全部来自环境变量，代码中不出现任何凭据
    2. 只返回标准化后的字段，不向前端暴露正方原始数据

缓存策略：
    Vercel 的 Python 函数在被复用（warm）时模块级变量会保留，
    因此使用模块级字典做进程内缓存；实例冷启动会重建，属预期行为。
"""

import json
import os
import re
import sys
import time
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler

# 保证同目录下的 config.py 与 zfn_api.py 能被导入
# （Vercel 以 api/ 内单个文件作为函数入口，默认不把该目录加入 sys.path）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
from zfn_api import Client


# ============================================================
# 内存缓存
# ============================================================
_cache = {"data": None, "expire_at": 0.0}


def _now_str():
    """当前时间，格式 YYYY-MM-DD HH:MM:SS"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _current_teaching_week():
    """按「本学期第一周周一」推算当前是第几教学周；无法判断时返回 None。

    例：第一周周一为 2026-08-31，则 2026-09-24 落在第 4 周
    （差值 24 天 // 7 = 3，再 +1）。
    学期尚未开始时返回 None，此时不做过滤，避免大屏一片空白。
    """
    start = config.get_semester_start()
    if not start:
        return None

    days = (datetime.now().date() - start).days
    if days < 0:
        return None

    return days // 7 + 1


# ============================================================
# 数据标准化（核心逻辑）
# ============================================================
def _period_range(sessions):
    """从正方的节次字符串中取出「首节」和「末节」。

    正方返回的 sessions 形如 "1-2"、"3-4节"；
    也存在一天内多段上课被合并成 "1-2,5-6" 的情况。
    这里统一取第一个数字作为起始节、最后一个数字作为结束节。
    """
    if not sessions:
        return None, None
    nums = re.findall(r"\d+", str(sessions))
    if not nums:
        return None, None
    return int(nums[0]), int(nums[-1])


def _period_to_time(sessions):
    """把节次换算成 (开始时间, 结束时间)；无法换算时返回 (None, None)。

    不使用 zfn_api 的 time 字段：该字段的换算存在下标偏移，结果不可信。
    """
    first, last = _period_range(sessions)
    if first is None:
        return None, None

    table = config.RASPISANIE
    if not (1 <= first <= len(table)) or not (1 <= last <= len(table)):
        return None, None

    return table[first - 1][0], table[last - 1][1]


def normalize_courses(raw_courses, current_week=None):
    """把正方课程列表转换成前端约定的标准格式。

    正方字段（zfn_api get_schedule 的 data.courses）：
        title      课程名称
        teacher    任课教师
        place      上课场地（同一门课多个场地时用 <br/> 分隔）
        weekday    星期几（整数 1~7）
        sessions   上课节次（如 "1-2"）
        list_weeks 该课程实际开课的周次列表（如 [1, 3, 5] 表示单周）

    输出字段：
        name / weekday / startTime / endTime / classroom / teacher

    current_week：
        当前教学周。传入时会丢弃本周不开课的课程（例如只在第 1~4 周上的课，
        到第 12 周就不会再出现在大屏上）；传 None 则不做教学周过滤。
    """
    result = []

    for item in raw_courses or []:
        # 星期几必须是 1~7 的整数，缺失或异常的数据直接丢弃
        try:
            weekday = int(item.get("weekday"))
        except (TypeError, ValueError):
            continue
        if not 1 <= weekday <= 7:
            continue

        # 节次换算成本校实际上下课时间，换算不出来说明数据不完整，丢弃
        start_time, end_time = _period_to_time(item.get("sessions"))
        if not start_time or not end_time:
            continue

        # ---- 教学周过滤 ----
        # 正方返回的是全学期课表，需要按当前教学周筛掉本学期其它周的课。
        # list_weeks 缺失或格式异常时不参与过滤（宁可多显示，也不误删课程）。
        if current_week:
            weeks = item.get("list_weeks")
            if isinstance(weeks, list) and weeks:
                try:
                    week_set = {int(w) for w in weeks}
                except (TypeError, ValueError):
                    week_set = None
                if week_set and current_week not in week_set:
                    continue

        # 一门课可能有多个场地，正方用 <br/> 拼接，这里取第一个并去掉标签
        classroom = (item.get("place") or "").split("<br/>")[0].strip()

        result.append({
            "name": (item.get("title") or "").strip(),
            "weekday": weekday,
            "startTime": start_time,
            "endTime": end_time,
            "classroom": classroom,
            "teacher": (item.get("teacher") or "").strip(),
        })

    # 按 星期 → 开始时间 排序，方便前端顺序取「下一节课」
    result.sort(key=lambda c: (c["weekday"], c["startTime"]))

    # 去重：正方会把同一门课按单双周拆成两条记录
    #（例如「AI辅助应用开发」会同时返回 1-17周(单) 与 2-18周(双)，
    # 两条的名称、星期、开始/结束时间、教室、老师完全一致）。
    # 对「显示最近一节课」而言两条没有区分意义，合并掉避免列表出现重复项。
    deduped = []
    seen = set()
    for course in result:
        key = (
            course["name"], course["weekday"], course["startTime"],
            course["endTime"], course["classroom"], course["teacher"],
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(course)

    return deduped


# ============================================================
# 拉取正方课表
# ============================================================
def fetch_from_zf():
    """登录正方并拉取课表，返回标准化后的课程列表；失败时抛 RuntimeError。"""
    if not (config.ZF_BASE_URL and config.ZF_USERNAME and config.ZF_PASSWORD):
        raise RuntimeError(
            "服务端未配置环境变量：需要 ZF_BASE_URL / ZF_USERNAME / ZF_PASSWORD"
        )

    year, term = config.get_year_term()

    client = Client(
        cookies={},
        base_url=config.ZF_BASE_URL,
        timeout=config.REQUEST_TIMEOUT,
    )

    # ---- 登录 ----
    login_result = client.login(config.ZF_USERNAME, config.ZF_PASSWORD)
    code = login_result.get("code")

    if code == 1001:
        # 学校开启了验证码。Serverless 无人交互，无法输入验证码，
        # 必须改用在本地浏览器登录后把 cookies 写进环境变量的方式。
        raise RuntimeError(
            "教务系统要求输入验证码，Serverless 环境无法交互处理。"
            "请先在本地浏览器登录教务系统，导出 cookies 后改用 cookies 方式访问。"
        )
    if code != 1000:
        raise RuntimeError(
            "登录失败：{}（code={}）".format(login_result.get("msg"), code)
        )

    # ---- 拉课表 ----
    schedule_result = client.get_schedule(year, term)
    if schedule_result.get("code") != 1000:
        raise RuntimeError(
            "获取课表失败：{}（code={}）".format(
                schedule_result.get("msg"), schedule_result.get("code")
            )
        )

    data = schedule_result.get("data") or {}
    return normalize_courses(data.get("courses"), _current_teaching_week())


def get_timetable(force_refresh=False):
    """读取课表，带 TTL 内存缓存。

    force_refresh=True 时跳过缓存强制拉取，便于调试。
    """
    now = time.time()

    if not force_refresh and _cache["data"] and _cache["expire_at"] > now:
        return _cache["data"]

    courses = fetch_from_zf()
    payload = {
        "courses": courses,
        "updatedAt": _now_str(),
        "source": "zf_api",
    }

    _cache["data"] = payload
    _cache["expire_at"] = now + config.CACHE_TTL_SECONDS
    return payload


# ============================================================
# 请求处理（本地与线上两个入口共用同一套逻辑）
# ============================================================
_STATUS_TEXT = {
    200: "OK",
    204: "No Content",
    404: "Not Found",
    500: "Internal Server Error",
    502: "Bad Gateway",
}


def _handle_request(force_refresh=False):
    """执行业务逻辑，返回 (HTTP 状态码, 响应字典)。

    两个入口（本地 BaseHTTPRequestHandler / 线上 WSGI app）都走这里，
    保证本地看到的返回结构与错误信息与线上完全一致。
    """
    try:
        return 200, get_timetable(force_refresh=force_refresh)
    except RuntimeError as err:
        # 业务 / 配置类错误：提示信息对用户可读
        return 502, {"error": str(err)}
    except Exception as err:  # noqa: BLE001 —— 兜底，避免函数直接崩溃
        traceback.print_exc()
        return 500, {"error": "服务端异常：" + str(err)}


# ============================================================
# Vercel Serverless 入口
# ============================================================
# Vercel 的 Python 运行时在 api/*.py 中识别以下顶层名字作为入口：
#     app         → ASGI 或 WSGI 应用（本项目用的就是这个，纯标准库实现）
#     application → WSGI 应用
#     handler     → 必须是继承 BaseHTTPRequestHandler 的「类」（注意是类，不是函数）
#
# 所以线上真正生效的入口是本文件里的 WSGI app()，下面的 handler(event, context)
# 只是按需求额外提供的适配函数（Vercel 并不会用这个签名调用它）。
#
# WSGI 入口
def app(environ, start_response):
    """WSGI 入口：GET /api/timetable，返回标准化课表 JSON。"""
    method = (environ.get("REQUEST_METHOD") or "GET").upper()
    path = environ.get("PATH_INFO") or "/"
    query = environ.get("QUERY_STRING") or ""

    headers = [
        ("Access-Control-Allow-Origin", config.ALLOWED_ORIGIN),
        ("Access-Control-Allow-Methods", "GET, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
    ]

    # 跨域预检
    if method == "OPTIONS":
        start_response("204 No Content", headers)
        return [b""]

    # 只接管 /api 下的请求；其余路径（如 Vercel 托管的静态页）不拦截
    if path.startswith("/api"):
        status, payload = _handle_request("refresh=1" in query)
    else:
        status, payload = 404, {"error": "接口不存在，课表接口为 GET /api/timetable"}

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    start_response(
        "{} {}".format(status, _STATUS_TEXT.get(status, "OK")),
        headers + [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
        ],
    )
    return [body]


# AWS Lambda 风格的适配入口
# 注意：Vercel 的 Python 运行时没有 handler(event, context) 这种调用约定，
# 它只认 app / application / handler(类)。保留该函数是为了：
#   1. 满足「用 handler(event, context) 调现有逻辑并返回 JSON」的需求；
#   2. 以后若要迁移到 Lambda / 函数计算等平台，可直接复用同一套业务逻辑。
def handler(event, context):
    """handler(event, context) 适配入口，复用 _handle_request() 的业务逻辑。

    :param event:   事件对象，支持 Lambda proxy 风格
                    （读 queryStringParameters / rawQueryString 判断是否 ?refresh=1）
    :param context: 平台上下文对象，本函数不使用
    :return: Lambda 风格响应字典 {"statusCode", "headers", "body"}
    """
    query = ""
    if isinstance(event, dict):
        query = event.get("rawQueryString") or ""
        if not query:
            params = event.get("queryStringParameters") or {}
            query = "&".join("{}={}".format(k, v) for k, v in params.items())

    status, payload = _handle_request("refresh=1" in query)

    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": config.ALLOWED_ORIGIN,
        },
        "body": json.dumps(payload, ensure_ascii=False),
    }


class DebugHandler(BaseHTTPRequestHandler):
    """本地调试入口（python api/timetable.py）使用的 HTTP 处理类。"""

    def do_GET(self):
        # ?refresh=1 跳过缓存强制刷新，方便调试
        status, payload = _handle_request(force_refresh="refresh=1" in (self.path or ""))
        self._send_json(status, payload)

    def do_OPTIONS(self):
        """跨域预检请求"""
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ---------- 内部方法 ----------
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", config.ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        """把访问日志打到 stderr，方便在 Vercel 日志里排查"""
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


# ============================================================
# 本地调试入口
# ============================================================
# 直接运行本文件即可在本地起一个 HTTP 服务，用浏览器查看返回的 JSON：
#     python api/timetable.py
#     然后打开 http://127.0.0.1:8000
#
# 这里复用的就是上面的 DebugHandler 与 _handle_request()，与线上 Vercel 函数
# 执行的是同一套逻辑，因此本地看到的返回结构和错误信息与线上一致。
# 部署到 Vercel 时本段不会执行（平台通过 WSGI app() 来调用）。
if __name__ == "__main__":
    from http.server import HTTPServer

    _port = int(os.environ.get("PORT", "8000"))
    print("课表接口已启动：")
    print("  http://127.0.0.1:{0}/".format(_port))
    print("  http://127.0.0.1:{0}/?refresh=1   跳过缓存强制拉取".format(_port))
    print("按 Ctrl+C 停止\n")
    HTTPServer(("127.0.0.1", _port), DebugHandler).serve_forever()