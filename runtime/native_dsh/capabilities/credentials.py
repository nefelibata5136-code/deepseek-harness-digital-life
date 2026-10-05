"""Windows Credential Manager backend. Secret inputs and outputs use pipes only."""
import getpass
import json
import re
import sys

PREFIX = "Persona/Capabilities/"


def address(name):
    if not re.fullmatch(r"DL_[A-Z0-9_]+", name):
        raise ValueError("Expected a DL_ credential reference")
    return PREFIX + name


def operation(action, name, value=None):
    import win32cred
    import pywintypes
    target = address(name)
    if action in ("resolve", "describe"):
        try:
            record = win32cred.CredRead(target, win32cred.CRED_TYPE_GENERIC)
        except pywintypes.error as exc:
            if exc.winerror != 1168:
                raise
            record = None
        if action == "describe":
            return {"configured": record is not None, "writable": True,
                    **({"source": "windows-credential-manager"} if record else {})}
        if record is None:
            return None
        blob = record["CredentialBlob"]
        return {"value": blob.decode("utf-16-le") if isinstance(blob, bytes) else blob,
                "source": "windows-credential-manager"}
    if action == "set":
        if not isinstance(value, str) or not value:
            raise ValueError("Credential must be nonempty")
        win32cred.CredWrite({"Type": win32cred.CRED_TYPE_GENERIC,
                            "TargetName": target, "CredentialBlob": value,
                            "Persist": win32cred.CRED_PERSIST_LOCAL_MACHINE,
                            "UserName": "Persona capability reference"})
        return {"configured": True, "writable": True, "source": "windows-credential-manager"}
    if action == "unset":
        try:
            win32cred.CredDelete(target, win32cred.CRED_TYPE_GENERIC)
        except pywintypes.error as exc:
            if exc.winerror != 1168:
                raise
        return {"configured": False, "writable": True}
    raise ValueError("Unsupported credential operation")


def main():
    if len(sys.argv) == 3 and sys.argv[1] in ("set", "describe", "unset"):
        action, name = sys.argv[1:]
        value = getpass.getpass("Secret (hidden; never written to a file): ") if action == "set" else None
        result = operation(action, name, value)
    else:
        request = json.loads(sys.stdin.read(65536))
        result = operation(request["action"], request["name"], request.get("value"))
    print(json.dumps({"ok": True, "result": result}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # OS/parser errors may include secret bytes. The caller gets only a code.
        print(json.dumps({"ok": False, "error": "CREDENTIAL_OPERATION_FAILED"}))
        sys.exit(1)
