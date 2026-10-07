"""User-invoked masked credential entry. No HTTP server, browser automation or password logs."""
from pathlib import Path
import importlib.util
import json
import tkinter as tk
from tkinter import messagebox

root_path = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('credential_backend', root_path / 'runtime/native_dsh/capabilities/credentials.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
credential_ref = 'DL_BLUESKY_TEST_APP_PASSWORD'
report = root_path / 'reports/bluesky/test-credential-status.json'
window = tk.Tk()
window.title('Bluesky 受控验收账号 · 隐藏密码输入')
window.geometry('610x280')
tk.Label(window, text='账号：nefelibata5136.bsky.social', font=('Microsoft YaHei UI', 12)).pack(pady=14)
tk.Label(window, text='优先输入允许访问私信的 App Password；也可输入此测试账号登录密码。\n密码只保存到 Windows 凭据管理器，不交给人格或写入文件。', justify='left').pack(pady=6)
entry = tk.Entry(window, show='●', width=48, font=('Segoe UI', 12))
entry.pack(pady=12)
entry.focus_set()
def save():
    value = entry.get()
    if not value:
        return
    try:
        result = backend.operation('set', credential_ref, value)
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps({'configured': result['configured'], 'reference': credential_ref,
                                      'account': 'nefelibata5136.bsky.social', 'source': 'windows-credential-manager'}), encoding='utf-8')
        entry.delete(0, tk.END)
        window.destroy()
    except Exception:
        messagebox.showerror('未保存', 'Windows 凭据保存失败。密码未写入文件。')
tk.Button(window, text='安全保存并关闭', command=save, width=22).pack(pady=8)
window.bind('<Return>', lambda _: save())
window.mainloop()
