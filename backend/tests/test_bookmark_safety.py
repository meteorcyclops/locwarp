import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from services.bookmarks import BookmarkManager


class BookmarkSafetyTests(TestCase):
    def test_schema_invalid_json_is_preserved_before_default_store_can_write(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "bookmarks.json"
            original = json.dumps({
                "categories": [],
                "bookmarks": [{"name": "keep-me", "lat": "bad", "lng": 121.5}],
            })
            path.write_text(original, encoding="utf-8")

            with patch("services.bookmarks.BOOKMARKS_FILE", path):
                manager = BookmarkManager()

            self.assertEqual(manager.list_bookmarks(), [])
            backups = list(path.parent.glob("bookmarks.json.bak-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(encoding="utf-8"), original)
            self.assertEqual(path.read_text(encoding="utf-8"), original)
