#!/usr/bin/env python3
# A stand-in for the shell's notification daemon, for tests/notify.test.js.
# Run inside dbus-run-session: it owns org.freedesktop.Notifications on that
# private bus, starts notify.pl with the payload on stdin, and while the helper
# waits for its answer reads the helper's command line from /proc. Prints one
# JSON object with what arrived and what the command line showed.
#
#   fake-notifications.py <notify.pl> <payload-file> [--no-server]

import json
import subprocess
import sys

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

helper, payload_file = sys.argv[1], sys.argv[2]
serve = "--no-server" not in sys.argv[3:]

DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
loop = GLib.MainLoop()
seen = {"calls": []}


def cmdline_of(sender):
    pid = int(bus.get_object("org.freedesktop.DBus", "/org/freedesktop/DBus")
              .GetConnectionUnixProcessID(sender, dbus_interface="org.freedesktop.DBus"))
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        return [part.decode("utf-8", "replace") for part in f.read().split(b"\0") if part]


class Server(dbus.service.Object):
    @dbus.service.method("org.freedesktop.Notifications", in_signature="susssasa{sv}i",
                         out_signature="u", sender_keyword="sender")
    def Notify(self, app, replaces, icon, summary, body, actions, hints, timeout, sender=None):
        seen["calls"].append({
            "app": str(app), "replaces": int(replaces), "icon": str(icon),
            "summary": str(summary), "body": str(body), "actions": [str(a) for a in actions],
            "hints": {str(k): (int(v) if isinstance(v, dbus.Byte) else str(v)) for k, v in hints.items()},
            "hintTypes": {str(k): type(v).__name__ for k, v in hints.items()},
            "timeout": int(timeout),
            "cmdline": cmdline_of(sender),
        })
        return dbus.UInt32(replaces or 42)


if serve:
    name = dbus.service.BusName("org.freedesktop.Notifications", bus)
    Server(bus, "/org/freedesktop/Notifications")

with open(payload_file, "rb") as f:
    payload = f.read()

proc = subprocess.Popen(["perl", "--", helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
proc.stdin.write(payload)
proc.stdin.close()


def check():
    if proc.poll() is None:
        return True
    seen["exit"] = proc.returncode
    seen["stdout"] = proc.stdout.read().decode()
    loop.quit()
    return False


GLib.timeout_add(20, check)
GLib.timeout_add_seconds(15, loop.quit)
loop.run()
print(json.dumps(seen))
