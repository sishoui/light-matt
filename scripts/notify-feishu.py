#!/usr/bin/env python
"""把本次会话的任务总结发到飞书群（交互卡片）。

规则来自 AGENTS.md「会话收尾」：每次会话结束都要发。凭证只留在本机，
**不进 git**。读取顺序：

1. 真实环境变量（CI / 临时覆盖用）
2. 仓库根的 `.env`（已被 .gitignore 忽略，日常就配在这里）

    FEISHU_APP_ID      应用 App ID（cli_ 开头）
    FEISHU_APP_SECRET  应用 App Secret
    FEISHU_CHAT_ID     目标群 chat_id（默认见 DEFAULT_CHAT_ID）

为什么用应用凭证而不是自定义机器人 Webhook：Webhook 只能发到「它被添加的那个群」，
不能指定 chat_id；这里要发到固定群，所以走 `im/v1/messages`。

用法：

    python scripts/notify-feishu.py --title "会话总结" --body-file summary.md
    python scripts/notify-feishu.py --title "任务完成" --body "六层全绿"
    python scripts/notify-feishu.py --dry-run --title T --body B     # 只打印卡片

退出码：0 已发送 / 1 发送失败 / 2 缺凭证 / 3 文件读不到。
没配凭证时**不静默通过**——它会明确说缺什么，因为「没发」和「发过了」必须长得不一样。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://open.feishu.cn/open-apis"
DEFAULT_CHAT_ID = "oc_19c2c88a44e0ae537b82d72712afbf53"

# 仓库根的 .env（已被 .gitignore 忽略）。凭证存在这里，脚本自动加载，
# 不必每次在 shell 里 export；真实环境变量优先级更高。
ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def load_env_file(path=ENV_FILE):
    """把 `KEY=value` 逐行读进 os.environ（已存在的变量不覆盖）。"""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def post(url, payload, token=None):
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"code": exc.code, "msg": exc.read().decode("utf-8", "replace")}
    except urllib.error.URLError as exc:
        return {"code": -1, "msg": str(exc)}


def build_card(title, body, status="green"):
    """把 markdown 正文切成飞书卡片的段落。

    飞书单个 lark_md 元素有长度上限，按空行分段更稳，也更像「总结」而不是一堵字墙。
    """
    chunks, buf = [], []
    for line in body.splitlines():
        if line.strip():
            buf.append(line)
        elif buf:
            chunks.append("\n".join(buf))
            buf = []
    if buf:
        chunks.append("\n".join(buf))

    elements = []
    for i, chunk in enumerate(chunks):
        if i:
            elements.append({"tag": "hr"})
        elements.append({"tag": "div", "text": {"tag": "lark_md", "content": chunk}})
    elements.append({"tag": "note", "elements": [
        {"tag": "plain_text", "content": "由 scripts/notify-feishu.py 自动发送"}]})

    return {
        "config": {"wide_screen_mode": True},
        "header": {"template": status, "title": {"tag": "plain_text", "content": title}},
        "elements": elements,
    }


def main():
    load_env_file()
    ap = argparse.ArgumentParser(description="把任务总结发到飞书群")
    ap.add_argument("--title", default="lumen 会话总结")
    ap.add_argument("--body", help="正文（markdown）")
    ap.add_argument("--body-file", help="正文文件路径（与 --body 二选一）")
    ap.add_argument("--chat-id", default=os.environ.get("FEISHU_CHAT_ID", DEFAULT_CHAT_ID))
    ap.add_argument("--status", default="green", choices=["green", "blue", "orange", "red"],
                    help="卡片顶栏颜色：通过 green / 有失败 red / 部分 orange")
    ap.add_argument("--dry-run", action="store_true", help="只打印卡片 JSON，不发送")
    args = ap.parse_args()

    if args.body_file:
        try:
            with open(args.body_file, encoding="utf-8") as fh:
                body = fh.read()
        except OSError as exc:
            print(f"读不到 --body-file：{exc}", file=sys.stderr)
            return 3
    elif args.body:
        body = args.body
    else:
        ap.error("需要 --body 或 --body-file")

    card = build_card(args.title, body, args.status)
    if args.dry_run:
        print(json.dumps(card, ensure_ascii=False, indent=2))
        return 0

    app_id = os.environ.get("FEISHU_APP_ID")
    app_secret = os.environ.get("FEISHU_APP_SECRET")
    if not app_id or not app_secret:
        print("缺凭证：请设置 FEISHU_APP_ID 与 FEISHU_APP_SECRET 环境变量。\n"
              "  PowerShell: $env:FEISHU_APP_ID='cli_xxx'; $env:FEISHU_APP_SECRET='xxx'\n"
              "  bash:       export FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx",
              file=sys.stderr)
        return 2

    tok = post(f"{BASE}/auth/v3/tenant_access_token/internal",
               {"app_id": app_id, "app_secret": app_secret})
    if tok.get("code") != 0:
        print(f"取 tenant_access_token 失败：{tok}", file=sys.stderr)
        return 1

    res = post(f"{BASE}/im/v1/messages?receive_id_type=chat_id",
               {"receive_id": args.chat_id,
                "msg_type": "interactive",
                "content": json.dumps(card, ensure_ascii=False)},
               token=tok["tenant_access_token"])
    if res.get("code") != 0:
        print(f"发送失败：{res}", file=sys.stderr)
        return 1
    print(f"已发送 → {args.chat_id}，message_id={res.get('data', {}).get('message_id')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
