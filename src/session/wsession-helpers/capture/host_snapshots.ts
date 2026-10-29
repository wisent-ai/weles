// One-shot OS-level snapshots at session start: what the host's processes,
// network, DNS, power and sockets looked like when the session began. Each
// probe that fails is recorded with its error in place of its output.

import { execSync } from 'node:child_process';

export function captureHostSnapshots(ws: any): void {
  const probe = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: 'utf8' });
    } catch (e: any) {
      return 'ERR: ' + String(e?.message ?? e);
    }
  };
  const isMac = process.platform === 'darwin';
  ws._instHostSnapshots = {
    ps: probe(
      isMac ? 'ps -axo pid,ppid,user,command' : 'ps -axo pid,ppid,user,cmd',
    ),
    ifconfig: probe(isMac ? 'ifconfig' : 'ip -j addr'),
    route: probe(isMac ? 'netstat -rn' : 'ip -j route'),
    netstat: probe(isMac ? 'netstat -an -p tcp' : 'ss -tan'),
    top: probe(
      isMac
        ? 'top -l 1 -n 20 -stats pid,command,cpu,mem,state'
        : 'top -bn1 -w 200 | head -30',
    ),
    vmstat: probe(isMac ? 'vm_stat' : 'free -m'),
    uptime: probe('uptime'),
    resolv: probe(
      isMac
        ? 'scutil --dns 2>/dev/null || cat /etc/resolv.conf'
        : 'cat /etc/resolv.conf',
    ),
    pmset: probe(
      isMac
        ? 'pmset -g batt; pmset -g therm'
        : 'cat /sys/class/power_supply/BAT0/uevent 2>/dev/null || echo no-battery',
    ),
    sysctl_net: probe(
      isMac
        ? 'sysctl -a 2>/dev/null | grep -E "net\\." | head -200'
        : 'sysctl -a 2>/dev/null | grep -E "net\\." | head -200',
    ),
    launchctl: isMac
      ? probe('launchctl list | head -100')
      : probe(
          'systemctl list-units --type=service --state=running | head -100',
        ),
    arp: probe(isMac ? 'arp -an' : 'ip neigh'),
    dns_cache: isMac
      ? probe(
          'dscacheutil -cachedump -entries 2>/dev/null || echo cache-disabled',
        )
      : probe('resolvectl statistics 2>/dev/null || echo no-resolvectl'),
    thermal: isMac
      ? probe(
          'powermetrics -n 1 -i 100 --samplers smc 2>/dev/null | head -50 || echo needs-sudo',
        )
      : probe('sensors 2>/dev/null || echo no-sensors'),
    lsof_node: probe(
      `lsof -p ${process.pid} 2>/dev/null | head -100 || echo lsof-failed`,
    ),
    sockstat: isMac
      ? probe('netstat -an -p tcp -p udp 2>/dev/null | head -80')
      : probe('ss -tani 2>/dev/null | head -80'),
    captured_at: new Date().toISOString(),
  };
}
