"""Public upstream examples must not exempt later printer data."""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import check_identifiers


class IdentifierCheckTests(unittest.TestCase):
    def test_upstream_example_exemption_requires_exact_path_and_content(self):
        relative = "klipper/config/sample-cartographer-v3.cfg"
        original = (check_identifiers.REPO_ROOT / relative).read_bytes()
        synthetic = ("\ncanbus_uuid: " + format(17, "012x") + "\n").encode()
        cases = (
            (relative, original, 0),
            (relative, original + synthetic, 1),
            ("klipper/config/new-example.cfg", synthetic, 1),
            ("klipper/docs/new-example.md", synthetic, 1),
            ("config/example.cfg", original, 1),
        )
        for name, data, expected in cases:
            with self.subTest(name=name, expected=expected), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                target = root / name
                target.parent.mkdir(parents=True)
                target.write_bytes(data)
                with patch.object(check_identifiers, "REPO_ROOT", root), \
                     patch.object(check_identifiers, "repository_files", return_value=[name]), \
                     contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(check_identifiers.main(), expected)
