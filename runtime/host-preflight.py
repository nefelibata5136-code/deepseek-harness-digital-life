"""Protected credential transfer to the Host through captured stdio only."""
import json
import sys
from start_persona import check_environment
from file_tools import api_key
check_environment()
if '--check-environment' in sys.argv:
    print(json.dumps({'ready': True}))
else:
    print(json.dumps({'credential': api_key()}))
