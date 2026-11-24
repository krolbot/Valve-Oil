#!/usr/bin/env python3
"""Check the repository for hardware identifiers and personal addresses that must not be published.

- A Klipper board's USB serial (`usb-Klipper_<chip>_<hex id>-if00`) or CAN bus UUID copied from a real printer.
- config/MCU_ID.cfg and config/box.cfg, which QIDI writes on each printer: every by-id serial is REDACTED.
- Kevin O'Connor's address outside the upstream Klipper GPL copyright headers that carry it.
"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

USB_SERIAL = re.compile(r"usb-Klipper_[\w.-]*?_([0-9A-Fa-f]{12,})-if\d+")
CANBUS_UUID = re.compile(r"canbus_uuid\s*[:=]\s*[0-9A-Fa-f]{12}\b")
KLIPPER_EMAIL = "kevin" + "@koconnor.net"  # split so this file doesn't hold the address
KLIPPER_COPYRIGHT = re.compile(r"^\s*(?:#|//)\s*Copyright \(C\) [\d, -]+\s+Kevin O'Connor <%s>\s*$"
                               % re.escape(KLIPPER_EMAIL))
REDACTED_FILES = ("config/MCU_ID.cfg", "config/box.cfg")
# Exact unmodified v0.14.0 files containing public example identifiers.
UPSTREAM_KLIPPER_IDENTIFIER_FILES = {
    'klipper/config/generic-bigtreetech-e3-rrf-v1.1.cfg': '34fc88ae8017d6475887d1a2a2b63ecad19415a9b4169f53357bf82cf76ff570',
    'klipper/config/generic-bigtreetech-skr-cr6-v1.0.cfg': '2d8b214b56d73db304b3ed3f6f6a0eef47f49df1485f5bee46f8893bd36871cd',
    'klipper/config/generic-bigtreetech-skr-e3-turbo.cfg': 'dbaa1b9c5202b166bc9f93b5fc03223d45d18cb9a4e0b2936f86b53f0254c2cd',
    'klipper/config/generic-mellow-fly-e3-v2.cfg': 'd6771574fcc42989577bc468001a19070453ce631c9c298defea466bc5372704',
    'klipper/config/generic-mks-monster8.cfg': '3161a3c2dd276ee9a9325a61abab09febb28d3e0839ceb46b8097953a133a8c4',
    'klipper/config/generic-mks-robin-nano-v3.cfg': 'b0e32b9838ae416778ae6024e290544c2c33d33bb47649432f95faee711b270d',
    'klipper/config/generic-prusa-buddy.cfg': 'd0c9d6b6c3dd7dd2bd6c5ea3350daef1d6725a6fb2be68d6cc482e214b1f3569',
    'klipper/config/generic-th3d-ezboard-lite-v1.2.cfg': 'c75929275b8ff6c7e0e6f074379360354f925898ef202643c87c84b7365538ff',
    'klipper/config/generic-th3d-ezboard-v2.0.cfg': '6a2a3a2c680ef7d0b83d4f3480f8aae379b47519235e206ebee59389f25cb5bd',
    'klipper/config/printer-biqu-b1-se-plus-2022.cfg': '16f27f1968af5b3456fd53b6528ea3f33793479a35d25b640926eb7814eb8d6e',
    'klipper/config/printer-prusa-mini-plus-2020.cfg': '8892f2286e1a8560281d053360d86837fe03b81acbf7c79a0ca1e1665d915cc4',
    'klipper/config/sample-bigtreetech-ebb-canbus-v1.0.cfg': '2c55eb1782518a93ec5e7e0352df5c397b408161d787fa7bac5753e0d5c8a0c2',
    'klipper/config/sample-bigtreetech-ebb-canbus-v1.1.cfg': 'e901f178343e1506e4d03e14e910068b7ed0f328562de93c70530e99bc38ecf4',
    'klipper/config/sample-bigtreetech-ebb-canbus-v1.2.cfg': '33f9837452286c68bc210844a38c25ac4ad2ab831454189053aa5b853427ccf7',
    'klipper/config/sample-bigtreetech-ebb-sb-canbus-v1.0.cfg': '80f618fd1989295b79db01694204142353db5effa4c6380eb01814354c060295',
    'klipper/config/sample-bigtreetech-hermit-crab-canbus.cfg': '67d40a01d21a9bfe0691a3bb114e6d1cfd43fded6412f1d284c6520dfe04747c',
    'klipper/config/sample-cartographer-v3.cfg': 'd95f8730ee86e4d2d9594fc7a04fe8741a2c1be50f4df561ddbe0fbf79b7a100',
    'klipper/config/sample-duet3-1lc.cfg': '7ec68c0d5ed66fc49a450c278fa71e1d5d28f9230c90be905bdbfbdc362cd96f',
    'klipper/config/sample-huvud-v0.61.cfg': '3ad2b0c60f08e0d37b2358ab597343a3f18a07b5febc34593c49d021154d1dff',
    'klipper/config/sample-mmu2s-diy.cfg': 'ea773752a0dc9c66826e9998f7d4a1dca59a4f09d51388d5deb3fd766e55d7bd',
    'klipper/docs/CANBUS.md': '9be5e9ee2f35ba83375e238f4727da47de48173bbc51dc910f023221add5f339',
    'klipper/docs/Measuring_Resonances.md': '260a7d950fc1724cba8259bda9ce5f385023b85c53671020747f6006c9fa12c2',
}
BY_ID_SERIAL = re.compile(r"^\s*serial\s*[:=]\s*(/dev/serial/by-id/\S+)")


def repository_files() -> list[str]:
    listed = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                            cwd=REPO_ROOT, check=True, capture_output=True, text=True).stdout
    return sorted(path for path in listed.split("\0") if path and (REPO_ROOT / path).is_file())


def main() -> int:
    failures: list[str] = []
    for path in repository_files():
        data = (REPO_ROOT / path).read_bytes()
        if b"\0" in data[:8192]:
            continue
        upstream_example = UPSTREAM_KLIPPER_IDENTIFIER_FILES.get(path) == hashlib.sha256(data).hexdigest()
        for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), start=1):
            if not upstream_example and (USB_SERIAL.search(line) or CANBUS_UUID.search(line)):
                failures.append(f"{path}:{number}: a board's serial or CAN UUID; replace the id with REDACTED")
            if KLIPPER_EMAIL in line and not KLIPPER_COPYRIGHT.match(line):
                failures.append(f"{path}:{number}: {KLIPPER_EMAIL} belongs only in Klipper's GPL copyright header")
            if path in REDACTED_FILES:
                match = BY_ID_SERIAL.match(line)
                if match and "REDACTED" not in match.group(1):
                    failures.append(f"{path}:{number}: replace the board's id in {match.group(1)} with REDACTED")
    if failures:
        print("Identifiers that must not be published:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print("no hardware identifiers or personal addresses found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
