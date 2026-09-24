# -*- coding: utf-8 -*-
"""
课表大屏展示系统 —— 静态课表生成脚本

用途：
    由 GitHub Actions 定时执行（见 .github/workflows/update-timetable.yml），
    登录正方教务系统拉取课表，把结果写入 public/data/timetable.json。
    该文件随 public/ 一起发布到 GitHub Pages，前端直接读取这个同源静态文件，
    因此线上完全不需要后端服务器（也就绕开了 *.vercel.app 在国内被屏蔽的问题）。

本地手动生成：
    python scripts/fetch_timetable.py
    凭据取自项目根目录的 .env（ZF_BASE_URL / ZF_USERNAME / ZF_PASSWORD）

安全约束：
    凭据只从环境变量读取；生成的数据文件已被 .gitignore 忽略，不会提交到仓库。
"""

import json
import os
import sys

# 复用 api/ 下已经验证过的登录、拉取、标准化、教学周过滤逻辑
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api"))

import timetable  # noqa: E402  —— 必须在 sys.path 处理之后再导入

OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "timetable.json"
)


def main():
    # force_refresh 在本脚本里恒为真（每次执行都是新进程，缓存本来就是空的），
    # 写出来只是表明意图：这里永远拉最新数据，不复用任何缓存。
    payload = timetable.get_timetable(force_refresh=True)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("已生成 {0}：{1} 门课程，数据时间 {2}".format(
        os.path.relpath(OUTPUT_PATH), len(payload.get("courses") or []), payload.get("updatedAt")
    ))


if __name__ == "__main__":
    main()