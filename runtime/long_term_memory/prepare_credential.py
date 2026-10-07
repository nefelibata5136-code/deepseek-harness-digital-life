"""Reuse the existing Qwen credential through an official capability reference."""
import importlib.util
from pathlib import Path
from qwen_legacy import resolve_api_key
p=Path(__file__).resolve().parents[1]/'native_dsh/capabilities/credentials.py'
s=importlib.util.spec_from_file_location('native_credentials',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ref='DL_QWEN_API_KEY'
if not m.operation('describe',ref)['configured']:
    key,source=resolve_api_key()
    if not key:raise RuntimeError('Existing Qwen credential unavailable')
    m.operation('set',ref,key)
print({'reference':ref,**m.operation('describe',ref)})
