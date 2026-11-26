#!/usr/bin/env python3
"""Asks for the support bundle on bug reports that don't have it attached.

Run by .github/workflows/support-bundle-reminder.yml on issue and comment events. A bug report (label `bug`: the Bug
report and QIDI Box problem forms) from someone outside the project gets one reminder comment and the
`needs-support-bundle` label until a `valve-oil-support-….zip` is attached to the issue or one of its comments. Once
it is, the label comes off and the reminder is deleted. The reminder isn't posted twice, so taking the label off by
hand keeps it off.

Reports from before Valve Oil was installed (`Not installed yet`) can't have a bundle and are left alone.

  python3 scripts/support_bundle_reminder.py --issue 426    # what it would do on issue 426, changing nothing
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

REPOSITORY = os.environ.get("GITHUB_REPOSITORY") or "thelegendtubaguy/valve-oil"
API = "https://api.github.com"
BUG_LABEL = "bug"
LABEL = "needs-support-bundle"
LABEL_COLOR = "d93f0b"
LABEL_DESCRIPTION = "A bug report waiting for its valve-oil-support zip"
MARKER = "<!-- valve-oil:support-bundle-reminder -->"
BOT = "github-actions[bot]"
# The project's own issues are trackers, not reports from a printer.
EXEMPT_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
# An attachment GitHub stored for this issue: drag a file into an issue or comment and GitHub links it here.
BUNDLE = re.compile(
    r"https://github\.com/(?:user-attachments/files|[\w.-]+/[\w.-]+/files)/\d+/valve-oil-support-[^\s)\]]*?\.zip",
    re.IGNORECASE,
)
NOT_INSTALLED = re.compile(r"^### How did you install Valve Oil\?\s+Not installed yet\s*$", re.MULTILINE)

REMINDER = f"""{MARKER}
Thanks for the report. The support bundle isn't attached yet, and most problems can't be tracked down without it. It has `klippy.log`, `moonraker.log`, and Valve Oil's reports from the printer.

1. Get the bundle from the printer, either way:
   - Valve Oil UI: **Updates → Report a problem**, or **System → Diagnostics → Download support bundle**.
   - Fluidd: **Settings → Valve Oil → Report a problem**.

   It saves `valve-oil-support-….zip` to your browser's downloads folder.
2. Drag that zip into a comment here, or into **Logs and files** when you edit the report.

This reminder goes away by itself once the zip is attached. If neither Valve Oil UI nor Fluidd opens, say so here and attach `klippy.log` instead.
"""


def has_bundle(texts: list[str]) -> bool:
    return any(BUNDLE.search(t or "") for t in texts)


def decide(issue: dict, comments: list[dict]) -> str:
    """What to do: 'remind', 'resolve', or 'none'."""
    if issue.get("pull_request") or issue.get("state") != "open":
        return "none"
    labels = {label["name"] for label in issue.get("labels", [])}
    reminded = any(_is_reminder(c) for c in comments)
    if has_bundle([issue.get("body") or ""] + [c.get("body") or "" for c in comments]):
        return "resolve" if reminded or LABEL in labels else "none"
    if BUG_LABEL not in labels or issue.get("author_association") in EXEMPT_ASSOCIATIONS:
        return "none"
    if NOT_INSTALLED.search(issue.get("body") or ""):
        return "none"
    return "none" if reminded else "remind"


def _is_reminder(comment: dict) -> bool:
    return (comment.get("user") or {}).get("login") == BOT and MARKER in (comment.get("body") or "")


class GitHub:
    def __init__(self, token: str | None):
        self.token = token

    def call(self, method: str, path: str, body: object = None) -> object:
        request = urllib.request.Request(
            API + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "valve-oil-support-bundle-reminder",
                **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
        return json.loads(data) if data else None

    def comments(self, number: int) -> list[dict]:
        found: list[dict] = []
        page = 1
        while True:
            batch = self.call("GET", f"/repos/{REPOSITORY}/issues/{number}/comments?per_page=100&page={page}")
            found += batch
            if len(batch) < 100:
                return found
            page += 1


def apply(gh: GitHub, issue: dict, comments: list[dict], action: str) -> None:
    number = issue["number"]
    labels = {label["name"] for label in issue.get("labels", [])}
    if action == "remind":
        gh.call("POST", f"/repos/{REPOSITORY}/issues/{number}/comments", {"body": REMINDER})
        try:
            gh.call("POST", f"/repos/{REPOSITORY}/labels",
                    {"name": LABEL, "color": LABEL_COLOR, "description": LABEL_DESCRIPTION})
        except urllib.error.HTTPError as e:
            if e.code != 422:  # 422: the label already exists
                raise
        gh.call("POST", f"/repos/{REPOSITORY}/issues/{number}/labels", {"labels": [LABEL]})
    elif action == "resolve":
        if LABEL in labels:
            gh.call("DELETE", f"/repos/{REPOSITORY}/issues/{number}/labels/{LABEL}")
        for comment in comments:
            if _is_reminder(comment):
                gh.call("DELETE", f"/repos/{REPOSITORY}/issues/comments/{comment['id']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--issue", type=int, help="check this issue and print what would be done, changing nothing")
    args = parser.parse_args()
    gh = GitHub(os.environ.get("GITHUB_TOKEN"))

    if args.issue is not None:
        issue = gh.call("GET", f"/repos/{REPOSITORY}/issues/{args.issue}")
        print(f"#{args.issue}: {decide(issue, gh.comments(args.issue))}")
        return 0

    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
        event = json.load(f)
    issue = event["issue"]
    # The event's copy of the issue can be stale by the time a queued run starts; read it again.
    issue = gh.call("GET", f"/repos/{REPOSITORY}/issues/{issue['number']}")
    comments = gh.comments(issue["number"])
    action = decide(issue, comments)
    print(f"#{issue['number']}: {action}")
    apply(gh, issue, comments, action)
    return 0


if __name__ == "__main__":
    sys.exit(main())
