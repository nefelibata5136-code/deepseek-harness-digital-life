"""Interactive account setup. No secrets in command args, files, logs or stdout."""
import importlib.util
import json
import os
from pathlib import Path
import re
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import urllib.request
import urllib.error
import urllib.parse

ROOT = Path(__file__).resolve().parent
WORKSPACE_ID = "UNCONFIGURED_ACCOUNT"
CHANNEL_ID = "UNCONFIGURED_ACCOUNT"
REF = "DL_DOTS_SLACK_TOKEN"
CREDENTIALS = ROOT.parent / "native_dsh" / "capabilities" / "credentials.py"


def api(token, method, payload):
    request = urllib.request.Request("https://slack.com/api/" + method,
        data=urllib.parse.urlencode(payload).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"})
    # Reuse the local network route; do not read browser auth or Cookie storage.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({
        "https": "http://127.0.0.1:7897", "http": "http://127.0.0.1:7897"}))
    try:
        with opener.open(request, timeout=10) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise ValueError("SLACK_RESPONSE_TOO_LARGE")
        value = json.loads(body)
    except urllib.error.HTTPError as error:
        raise ValueError("SLACK_HTTP_" + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        raise ValueError("SLACK_CONNECTION_FAILED") from None
    if not value.get("ok"):
        code = value.get("error", "API_REJECTED")
        raise ValueError("SLACK_" + (code.upper() if re.fullmatch(r"[a-z_]+", code) else "API_REJECTED"))
    return value


def save_credential(token):
    spec = importlib.util.spec_from_file_location("persona_capability_credentials", CREDENTIALS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.operation("set", REF, token)


def main():
    window = tk.Tk()
    window.title("人格 ↔ Dots：Slack 正式连接")
    window.geometry("720x480")
    window.resizable(False, False)
    frame = ttk.Frame(window, padding=20)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="先安装 Persona Research Bridge，并将它和 Dot 加入同一私有频道。", wraplength=670).pack(anchor="w")
    ttk.Label(frame, text="Token 只写入 Windows 凭据管理器；这里不发研究任务。", wraplength=670).pack(anchor="w", pady=(4, 14))
    token = tk.StringVar()
    channel = tk.StringVar(value=f"https://app.slack.com/client/{WORKSPACE_ID}/{CHANNEL_ID}")
    for label, variable, masked in [("频道链接（可以改为刚创建的私有频道）", channel, False),
                                    ("Bot User OAuth Token（应用 OAuth & Permissions 页面，xoxb- 开头）", token, True)]:
        ttk.Label(frame, text=label).pack(anchor="w", pady=(8, 2))
        ttk.Entry(frame, textvariable=variable, show="*" if masked else "", width=88).pack(anchor="w")
    status = tk.StringVar(value="点击检查后，从频道成员中选择你自己的 Dot。")
    ttk.Label(frame, textvariable=status, wraplength=670).pack(anchor="w", pady=12)
    selected = tk.StringVar()
    chooser = ttk.Combobox(frame, textvariable=selected, state="readonly", width=80)
    chooser.pack(anchor="w")
    state = {}

    def error(code):
        check_button.config(state="normal")
        status.set(code)

    def checked(value):
        state.update(value)
        chooser["values"] = list(value["members"])
        check_button.config(state="normal")
        status.set(f"已核实：{value['team_id']} / #{value['channel_name']}，私有频道。请选择你的 Dot，然后保存。")
        save_button.config(state="normal")

    def check():
        credential = token.get().strip()
        match = re.fullmatch(r"https://app\.slack\.com/client/(T[A-Z0-9]+)/(C[A-Z0-9]+)(?:[/?#].*)?", channel.get().strip())
        if not credential.startswith("xoxb-") or not match:
            error("需要完整频道链接与 Bot User OAuth Token。不要用浏览器 Cookie。")
            return
        team_id, channel_id = match.groups()
        if team_id != WORKSPACE_ID:
            error("工作区与本次确认目标不符；请回到已确认的工作区。")
            return
        check_button.config(state="disabled")
        save_button.config(state="disabled")
        status.set("正在检查官方 Slack 接口与频道成员……")

        def work():
            try:
                auth = api(credential, "auth.test", {})
                if auth.get("team_id") != team_id:
                    raise ValueError("SLACK_WORKSPACE_MISMATCH")
                info = api(credential, "conversations.info", {"channel": channel_id})["channel"]
                if not info.get("is_private") or info.get("is_shared") or info.get("is_ext_shared") or info.get("is_archived"):
                    raise ValueError("请创建专用私有频道；当前频道不是符合要求的私有频道。")
                if not info.get("is_member"):
                    raise ValueError("请先在频道中添加 Persona Research Bridge 应用。")
                ids = api(credential, "conversations.members", {"channel": channel_id, "limit": 200})
                if ids.get("response_metadata", {}).get("next_cursor"):
                    raise ValueError("此频道成员过多；请使用专用小型私有频道。")
                members = {}
                for user_id in ids.get("members", []):
                    if user_id == auth.get("user_id"):
                        continue
                    user = api(credential, "users.info", {"user": user_id})["user"]
                    profile = user.get("profile", {})
                    label = f"{profile.get('display_name') or profile.get('real_name') or user.get('name') or user_id} [{user_id}]" + ("（应用）" if user.get("is_bot") else "")
                    members[label] = {"user_id": user_id, "bot_id": profile.get("bot_id")}
                if not members:
                    raise ValueError("频道没有可选成员，请先加入 Dot。")
                window.after(0, checked, {"token": credential, "team_id": team_id, "channel_id": channel_id,
                    "channel_name": info["name"], "members": members})
            except ValueError as exc:
                window.after(0, error, str(exc))
            except Exception:
                window.after(0, error, "连接检查失败；没有保存凭据。")
        threading.Thread(target=work, daemon=True).start()

    def save():
        member = state.get("members", {}).get(selected.get())
        if not member:
            status.set("请明确选择你的 Dot；不会自动挑选其他成员。")
            return
        try:
            path = ROOT / "protected" / "connection.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                old = json.loads(path.read_text(encoding="utf-8"))
                if old.get("team_id") != state["team_id"] or old.get("channel_id") != state["channel_id"]:
                    raise ValueError("已有连接属于其他频道，请由维护者核查后再切换。")
            value = {"transport": "slack", "team_id": state["team_id"], "channel_id": state["channel_id"],
                "dot_user_id": member["user_id"], "dot_bot_id": member["bot_id"], "bot_trigger_verified": False}
            if value["dot_bot_id"] is None:
                del value["dot_bot_id"]
            save_credential(state["token"])
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, path)
            state.pop("token", None)
            token.set("")
            status.set("连接已保存到本机。尚未证明 Dot 会响应程序消息；下一步由 Codex 实际验收。")
            save_button.config(state="disabled")
            messagebox.showinfo("已保存", "凭据已进入 Windows 凭据管理器。可以关闭这个窗口并回到 Codex。")
        except ValueError as exc:
            status.set(str(exc))
        except Exception:
            status.set("保存失败，请由维护者检查本机状态；没有输出秘密。")

    buttons = ttk.Frame(frame)
    buttons.pack(anchor="w", pady=14)
    check_button = ttk.Button(buttons, text="检查频道并列出成员", command=check)
    check_button.pack(side="left", padx=(0, 10))
    save_button = ttk.Button(buttons, text="保存正式连接", command=save, state="disabled")
    save_button.pack(side="left")
    window.mainloop()


if __name__ == "__main__":
    main()
