import os
from pathlib import Path
import sys
from snapshots import Versions

v = Versions(sys.argv[1], sys.argv[2])
v.begin('abrupt-exit-test-only', '1', os.getpid())
(Path(sys.argv[1]) / 'interrupted.txt').write_bytes(b'left behind after abrupt exit')
os._exit(23)
