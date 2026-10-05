"""Keep one Windows worker tree in a kill-on-close Job, with a memory bound."""
import json
import sys


def main():
    import win32api
    import win32con
    import win32job
    pid, memory_mb = map(int, sys.argv[1:])
    job = win32job.CreateJobObject(None, "")
    process = None
    try:
        limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        limits["BasicLimitInformation"]["LimitFlags"] = (
            win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | win32job.JOB_OBJECT_LIMIT_JOB_MEMORY)
        limits["JobMemoryLimit"] = memory_mb * 1024 * 1024
        win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
        process = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, pid)
        win32job.AssignProcessToJobObject(job, process)
        print(json.dumps({"ready": True}), flush=True)
        # The Host alone owns this pipe. Its exit closes the Job even if a plugin hangs.
        sys.stdin.buffer.read()
    finally:
        job.Close()
        if process is not None:
            process.Close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"ready": False, "error": "CAPABILITY_JOB_FAILED"}), flush=True)
        sys.exit(1)
