"""Run one CI build/test group with the operator's memory/time limits."""
import os,signal,subprocess,sys,time
from pathlib import Path
def free_gib():
    fields=dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
    return int(fields['MemAvailable'].split()[0])/1048576
if free_gib()<6:
    sys.exit('RAM below 6 GiB; not starting')
p=subprocess.Popen(sys.argv[1:],start_new_session=True)
start=time.monotonic()
while p.poll() is None:
    time.sleep(1)
    if free_gib()<6 or time.monotonic()-start>540:
        print('Stopping: RAM below 6 GiB or nine-minute limit',flush=True)
        os.killpg(p.pid,signal.SIGTERM)
        p.wait()
        sys.exit(3)
sys.exit(p.returncode)
