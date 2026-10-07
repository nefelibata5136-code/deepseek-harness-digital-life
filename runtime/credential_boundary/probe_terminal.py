"""Windows terminal with a write-restricted token and inherited child restrictions.

Requires the already installed pywin32 package. This is an OS access-control
boundary for ordinary file writes, not a hostile-code security sandbox or a
read/privacy boundary. No fallback to an unrestricted subprocess is permitted.
Microsoft documentation:
https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken
https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import struct
import threading
import uuid

PROTECTION = "Windows WRITE_RESTRICTED token; cmd and Node.js terminal"
AVAILABLE = True
SUPPORTED = ["cmd.exe", "Node.js"]
LIMITATIONS = (
    "This is a filesystem write restriction, not privacy/read isolation or a "
    "hostile-code sandbox. Python and PowerShell initialization fail on this host. "
    "Node child processes must use inherited stdio. No unrestricted fallback."
)
_MAX_OUTPUT = 1024 * 1024
MAX_OUTPUT_CHARS = 32000


def _sid_for(workspace: Path):
    import win32security
    digest = hashlib.sha256(str(workspace).casefold().encode("utf-8")).digest()
    words = struct.unpack("<III", digest[:12])
    return win32security.ConvertStringSidToSid(
        "S-1-5-21-" + "-".join(str(x) for x in words) + "-42604"
    )


def _prepare_workspace(workspace: Path, sid) -> None:
    """Grant only this new workspace's restriction SID inheritable Modify."""
    import win32security
    import win32con
    workspace.mkdir(parents=True, exist_ok=True)
    # Junction/symlink roots would accidentally grant writes to their target.
    if workspace.is_symlink() or os.path.isjunction(workspace):
        raise ValueError("Workspace must be an ordinary directory, not a link")
    info = win32security.GetNamedSecurityInfo(
        str(workspace), win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION,
    )
    dacl = info.GetSecurityDescriptorDacl()
    if dacl is None:
        raise ValueError("Workspace has a NULL DACL; refusing terminal")
    mask = 0x1301BF  # FILE_GENERIC_READ/WRITE/EXECUTE plus DELETE; no WRITE_DAC
    for index in range(dacl.GetAceCount()):
        ace = dacl.GetAce(index)
        if ace[0][0] == win32security.ACCESS_ALLOWED_ACE_TYPE and ace[2] == sid:
            if ace[1] & mask == mask:
                return
    dacl.AddAccessAllowedAceEx(
        win32security.ACL_REVISION,
        win32con.OBJECT_INHERIT_ACE | win32con.CONTAINER_INHERIT_ACE,
        mask, sid,
    )
    win32security.SetNamedSecurityInfo(
        str(workspace), win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION, None, None, dacl, None,
    )


def _environment(workspace: Path) -> dict[str, str]:
    # An allowlist is simpler and stronger than guessing every secret's name.
    permitted = {"SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC",
                 "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"}
    env = {key: value for key, value in os.environ.items()
           if key.upper() in permitted}
    temp = workspace / ".terminal-tmp"
    temp.mkdir(exist_ok=True)
    env.update(TEMP=str(temp), TMP=str(temp), HOME=str(workspace),
               USERPROFILE=str(workspace), APPDATA=str(temp), LOCALAPPDATA=str(temp),
               PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    return env


def run(command: str, workspace, timeout: float = 30) -> dict:
    """Run the accepted cmd/Node terminal without weakening its restricted token."""
    result = probe_run(command, workspace, timeout, separate_desktop=True)
    result.update(available=bool(result.get("restricted")), supported=SUPPORTED,
                  limitations=LIMITATIONS, workspace=str(Path(workspace).absolute()))
    return result


def probe_run(command: str, workspace, timeout: float = 30, *, separate_desktop=True) -> dict:
    """Restricted-token implementation and explicit maintainer desktop probe.

    The directory passed here must be the Agent's dedicated writable workspace
    or a newly created verification directory. Its SID gets inheritable Modify.
    The Harness must use its fixed workspace config, never a model-chosen root.
    """
    """Run cmd.exe under a write-restricted token; fail closed on API errors.

    PowerShell's CLR cannot initialize under this host's restriction settings;
    cmd plus ordinary Python/Node programs provides the terminal without CLR.
    """
    if os.name != "nt":
        return {"stdout": "", "stderr": "Windows-only terminal", "returncode": -1,
                "protection": PROTECTION, "restricted": False}
    import win32api
    import win32con
    import win32event
    import win32file
    import win32job
    import win32pipe
    import win32process
    import win32security
    import win32service
    import pywintypes

    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be nonempty text")
    timeout = min(max(float(timeout), 0.1), 120.0)
    workspace = Path(workspace).absolute()
    sid = _sid_for(workspace)
    handles = []
    desktop = None
    job = None
    readers = []
    streams = [bytearray(), bytearray()]
    truncated = [False, False]
    created = False
    try:
        _prepare_workspace(workspace, sid)
        env = _environment(workspace)
        env["PATH"] = str(Path(__file__).parent / "node") + ";" + str(Path(os.environ["SYSTEMROOT"]) / "System32")
        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32con.TOKEN_ALL_ACCESS)
        handles.append(token)
        restricted = win32security.CreateRestrictedToken(
            token, 0x1, [], [], [(sid, 0), (win32security.ConvertStringSidToSid("S-1-1-0"), 0), (win32security.ConvertStringSidToSid("S-1-5-32-545"), 0)] + [(group, 0) for group, attrs in win32security.GetTokenInformation(token, win32security.TokenGroups) if attrs & 0xC0000000 == 0xC0000000])
        handles.append(restricted)
        win32security.SetTokenInformation(restricted, win32security.TokenIntegrityLevel, (win32security.ConvertStringSidToSid("S-1-16-4096"), 0x20))
        user_sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        default_dacl = win32security.GetTokenInformation(token, win32security.TokenDefaultDacl)
        if default_dacl is None:
            default_dacl = win32security.ACL()
            default_dacl.AddAccessAllowedAce(win32security.ACL_REVISION, win32con.GENERIC_ALL, user_sid)
        default_dacl.AddAccessAllowedAce(win32security.ACL_REVISION, win32con.GENERIC_ALL, sid)
        win32security.SetTokenInformation(restricted, win32security.TokenDefaultDacl, default_dacl)
        # A separate desktop prevents window-message interactions with the user's
        # unrestricted desktop, as required by Microsoft's restricted-token guide.
        desk_name = "PersonaTerminal_" + uuid.uuid4().hex
        desk_sa = pywintypes.SECURITY_ATTRIBUTES()
        desk_dacl = win32security.ACL()
        desk_dacl.AddAccessAllowedAce(win32security.ACL_REVISION, win32con.GENERIC_ALL, user_sid)
        desk_dacl.AddAccessAllowedAce(win32security.ACL_REVISION, win32con.GENERIC_ALL, sid)
        desk_sd = win32security.SECURITY_DESCRIPTOR()
        desk_sd.SetSecurityDescriptorDacl(1, desk_dacl, 0)
        label = win32security.ACL()
        label.AddMandatoryAce(win32security.ACL_REVISION, 0, 1, win32security.ConvertStringSidToSid("S-1-16-4096"))
        desk_sd.SetSecurityDescriptorSacl(1, label, 0)
        desk_sa.SECURITY_DESCRIPTOR = desk_sd
        if separate_desktop:
            desktop = win32service.CreateDesktop(desk_name, 0, win32con.GENERIC_ALL, desk_sa)

        sa = pywintypes.SECURITY_ATTRIBUTES()
        sa.bInheritHandle = True
        sa.SECURITY_DESCRIPTOR = desk_sd
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
        if separate_desktop:
            startup.lpDesktop = desk_name
        executable = str(Path(os.environ["SYSTEMROOT"]) / "System32/cmd.exe")
        cmdline = f'"{executable}" /d /s /c "{command}"'
        flags = win32con.CREATE_UNICODE_ENVIRONMENT | win32con.CREATE_NO_WINDOW | win32con.CREATE_SUSPENDED
        process, thread, pid, tid = win32process.CreateProcessAsUser(
            restricted, executable, cmdline, None, None, True, flags, env, str(workspace), startup)
        handles += [process, thread]
        created = True
        # A job covers descendants and kills them on timeout/handle close.
        job = win32job.CreateJobObject(None, "")
        limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        limits["BasicLimitInformation"]["LimitFlags"] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
        win32job.AssignProcessToJobObject(job, process)
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
            win32job.TerminateJobObject(job, 124)
            win32event.WaitForSingleObject(process, 5000)
        code = win32process.GetExitCodeProcess(process)
        job.Close()
        job = None
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
                "returncode": code, "timeout": timed_out,
                "output_truncated": output_truncated, "max_output_chars_per_stream": MAX_OUTPUT_CHARS,
                "restricted": True,
                "protection": PROTECTION, "read_isolation": False,
                "shell": "cmd.exe", "separate_desktop": separate_desktop}
    except Exception as exc:
        if created:
            try:
                win32process.TerminateProcess(process, 125)
            except Exception:
                pass
        return {"stdout": "", "stderr": f"Restricted terminal unavailable: {exc}",
                "returncode": -1, "restricted": False, "protection": PROTECTION}
    finally:
        if job is not None:
            job.Close()
        for handle in reversed(handles):
            try:
                handle.Close()
            except Exception:
                pass
        if desktop is not None:
            try:
                desktop.CloseDesktop()
            except Exception:
                pass
