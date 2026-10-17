#!/bin/sh
# Scheduling evidence for one trading day, from the systemd journal (not from the
# database): did the timer start finance-ashare-daily.service near 18:40 and 21:10
# CST, and did each run finish successfully?  Usage: check-schedule.sh YYYYMMDD
# A start is counted as scheduled when it falls within the timer's window
# (OnCalendar + RandomizedDelaySec=120, allowing 5 minutes); manual starts at
# other times are listed but not counted.
set -eu
D="${1:?usage: check-schedule.sh YYYYMMDD}"
DAY="$(echo "$D" | sed 's/\(....\)\(..\)\(..\)/\1-\2-\3/')"
UNIT=finance-ashare-daily.service
LINES="$(TZ=Asia/Shanghai journalctl --user -u "$UNIT" --since "$DAY 00:00:00" --until "$DAY 23:59:59" -o short-iso --no-pager 2>/dev/null \
  | grep -E "systemd\[[0-9]+\]: (Start(ing|ed)|Finished|Failed|$UNIT: (Main process exited|Failed))" || true)"
echo "$LINES"
starts="$(echo "$LINES" | grep -E 'systemd\[[0-9]+\]: Starting' | sed -E 's/^[0-9-]+T([0-9]{2}:[0-9]{2}).*/\1/' || true)"
in_window() { echo "$starts" | awk -v lo="$1" -v hi="$2" '$0 >= lo && $0 <= hi { found = 1 } END { exit !found }'; }
r1=no; r2=no
in_window 18:40 18:45 && r1=yes
in_window 21:10 21:15 && r2=yes
finished="$(echo "$LINES" | grep -c 'Finished' || true)"
failed="$(echo "$LINES" | grep -cE 'Failed|status=[1-9]' || true)"
TZ=Asia/Shanghai systemctl --user show finance-ashare-daily.timer -p UnitFileState -p ActiveState -p LastTriggerUSec -p NextElapseUSecRealtime --no-pager
echo "trade_date=$D run_1840=$r1 run_2110=$r2 finished=$finished failed_lines=$failed"
[ "$r1" = yes ] && [ "$r2" = yes ] && [ "$failed" = 0 ] && [ "$finished" -ge 2 ] && echo "schedule=PASS" && exit 0
echo "schedule=FAIL"
exit 1
