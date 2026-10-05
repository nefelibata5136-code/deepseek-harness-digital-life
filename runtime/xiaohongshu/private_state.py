"""Windows DPAPI encrypted reference store. No plaintext credential files or logs."""
import ctypes
from ctypes import wintypes
import json,os
from pathlib import Path

class Blob(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]

def transform(data, decrypt=False):
    if os.name!='nt':raise RuntimeError('WINDOWS_DPAPI_REQUIRED')
    buffer=ctypes.create_string_buffer(data)
    source=Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)))
    output=Blob()
    crypt=ctypes.WinDLL('crypt32',use_last_error=True)
    fn=crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    fn.restype=wintypes.BOOL
    # CRYPTPROTECT_UI_FORBIDDEN; user-bound encryption, never machine-wide.
    if not fn(ctypes.byref(source),None,None,None,None,1,ctypes.byref(output)):
        raise RuntimeError('DPAPI_FAILED')
    try:return ctypes.string_at(output.data,output.size)
    finally:
        kernel=ctypes.WinDLL('kernel32');kernel.LocalFree.argtypes=[ctypes.c_void_p]
        kernel.LocalFree(ctypes.cast(output.data,ctypes.c_void_p))

class PrivateState:
    def __init__(self,root):
        self.path=Path(root)/'references.dpapi'
        self.path.parent.mkdir(parents=True,exist_ok=True)
        self.error=None
        self.previous=None
        self.generation=0
    def load(self):
        valid=[];present=False
        for path in [self.path,self.path.with_name('references.0.dpapi'),self.path.with_name('references.1.dpapi')]:
            if not path.exists():continue
            present=True
            try:
                if path.stat().st_size>32*1024*1024:raise ValueError('too large')
                value=json.loads(transform(path.read_bytes(),True))
                if value.get('version')!=1:raise ValueError('version')
                valid.append(value)
            except Exception:pass
        if valid:
            value=max(valid,key=lambda x:x.get('generation',0))
            self.generation=value.get('generation',0)
            self.previous=json.dumps({k:v for k,v in value.items() if k!='generation'},ensure_ascii=False,separators=(',',':')).encode()
            return value
        if present:
            self.error='REFERENCE_STORE_UNREADABLE'
        return {}
    def save(self,value):
        # If unreadable, preserve the original for diagnosis; never overwrite it.
        if self.error:raise RuntimeError(self.error)
        plain=json.dumps({'version':1,**value},ensure_ascii=False,separators=(',',':')).encode()
        if plain==self.previous:return
        if len(plain)>24*1024*1024:raise RuntimeError('REFERENCE_STORE_LIMIT')
        generation=self.generation+1
        encrypted=transform(json.dumps({'generation':generation,**json.loads(plain)},ensure_ascii=False,separators=(',',':')).encode())
        # Alternate two complete encrypted generations. A torn write always
        # leaves the preceding valid generation; no cross-volume rename needed.
        path=self.path.with_name(f'references.{generation%2}.dpapi')
        with open(path,'wb') as f:f.write(encrypted);f.flush();os.fsync(f.fileno())
        if json.loads(transform(path.read_bytes(),True))['generation']!=generation:raise RuntimeError('REFERENCE_STORE_VERIFY_FAILED')
        self.previous=plain
        self.generation=generation
