"""Windows terminal using the current user token without an Agent sandbox."""
from __future__ import annotations

import os
from pathlib import Path
import threading

PROTECTION = "Full access under the current Windows user token; no Agent sandbox"
AVAILABLE = True
SUPPORTED = ["cmd.exe", "Node.js", "Python", "PowerShell"]
LIMITATIONS = "Windows account ACLs and UAC still apply; no automatic administrator elevation."
_MAX_OUTPUT = 1024 * 1024
MAX_OUTPUT_CHARS = 32000


def _environment(workspace: Path) -> dict[str, str]:
    # Normal user locations; the caller excludes injected service credentials.
    env = dict(os.environ)
    env.update(PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    return env


def run(command: str, workspace, timeout: float = 30) -> dict:
    """Run without restricted tokens, integrity downgrade or path ACL changes."""
    result = probe_run(command, workspace, timeout, separate_desktop=False)
    result.update(available=result.get("returncode") != -1, supported=SUPPORTED,
                  limitations=LIMITATIONS, workspace=str(Path(workspace).absolute()))
    return result


def probe_run(command: str, workspace, timeout: float = 30, *, separate_desktop=False) -> dict:
    """Normal current-user process; timeout cleanup still covers descendants."""
    if os.name != "nt":
        return {"stdout": "", "stderr": "Windows-only terminal", "returncode": -1,
                "protection": PROTECTION, "restricted": False}
    import win32api
    import win32con
    import win32event
    import win32file
    import win32pipe
    import win32process
    import pywintypes

    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be nonempty text")
    timeout = min(max(float(timeout), 0.1), 120.0)
    workspace = Path(workspace).absolute()
    handles = []
    readers = []
    streams = [bytearray(), bytearray()]
    truncated = [False, False]
    created = False
    try:
        env = _environment(workspace)
        sa = pywintypes.SECURITY_ATTRIBUTES()
        sa.bInheritHandle = True
        stdout_read, stdout_write = win32pipe.CreatePipe(sa, 0)
        stderr_read, stderr_write = win32pipe.CreatePipe(sa, 0)
        stdin_read, stdin_write = win32pipe.CreatePipe(sa, 0)
        handles += [stdout_read, stdout_write, stderr_read, stderr_write, stdin_read, stdin_write]
        for handle in (stdout_read, stderr_read, stdin_write):
            win32api.SetHandleInformation(handle, win32con.HANDLE_FLAG_INHERIT, 0)
        startup = win32process.STARTUPINFO()
        startup.dwFlags = win32con.STARTF_USESTDHANDLES | win32con.STARTF_USESHOWWINDOW
        startup.wShowWindow = win32con.SW_HIDE
        startup.hStdInput, startup.hStdOutput, startup.hStdError = stdin_read, stdout_write, stderr_write
        executable = str(Path(os.environ["SYSTEMROOT"]) / "System32/cmd.exe")
        cmdline = f'"{executable}" /d /s /c "{command}"'
        flags = win32con.CREATE_UNICODE_ENVIRONMENT | win32con.CREATE_NO_WINDOW | win32con.CREATE_SUSPENDED
        process, thread, pid, tid = win32process.CreateProcess(
            executable, cmdline, None, None, True, flags, env, str(workspace), startup)
        handles += [process, thread]
        created = True
        for handle in (stdout_write, stderr_write, stdin_read, stdin_write):
            handle.Close()
            handles.remove(handle)

        def collect(handle, index):
            while True:
                try:
                    _, chunk = win32file.ReadFile(handle, 16384)
                except pywintypes.error:
                    break
                if not chunk:
                    break
                remaining = _MAX_OUTPUT - len(streams[index])
                streams[index].extend(chunk[:max(0, remaining)])
                if len(chunk) > remaining:
                    truncated[index] = True

        for index, handle in enumerate((stdout_read, stderr_read)):
            reader = threading.Thread(target=collect, args=(handle, index), daemon=True)
            reader.start()
            readers.append(reader)
        win32process.ResumeThread(thread)
        waited = win32event.WaitForSingleObject(process, int(timeout * 1000))
        timed_out = waited == win32con.WAIT_TIMEOUT
        if timed_out:
            import subprocess
            subprocess.run(["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            win32event.WaitForSingleObject(process, 5000)
        code = win32process.GetExitCodeProcess(process)
        for reader in readers:
            reader.join(5)
        def decode_output(raw):
            try:
                return raw.decode("utf-8")
            except UnicodeDecodeError:
                return raw.decode("mbcs", errors="replace")

        stdout = decode_output(streams[0])
        stderr = decode_output(streams[1])
        output_truncated = any(truncated) or len(stdout) > MAX_OUTPUT_CHARS or len(stderr) > MAX_OUTPUT_CHARS
        return {"stdout": stdout[:MAX_OUTPUT_CHARS],
                "stderr": stderr[:MAX_OUTPUT_CHARS],
                "returncode": code, "timeout": timed_out, "persistent_children_allowed": True,
                "output_truncated": output_truncated, "max_output_chars_per_stream": MAX_OUTPUT_CHARS,
                "restricted": False,
                "protection": PROTECTION, "read_isolation": "none",
                "integrity_level": "inherited-current-user",
                "shell": "cmd.exe", "separate_desktop": separate_desktop}
    except Exception as exc:
        if created:
            try:
                win32process.TerminateProcess(process, 125)
            except Exception:
                pass
        return {"stdout": "", "stderr": f"Full-access terminal unavailable: {exc}",
                "returncode": -1, "restricted": False, "protection": PROTECTION}
    finally:
        for handle in reversed(handles):
            try:
                handle.Close()
            except Exception:
                pass
