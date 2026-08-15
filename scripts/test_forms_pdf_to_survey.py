#!/usr/bin/env python3
"""Regression tests for the semantic PDF survey parser.

Run with:
    .venv/bin/python scripts/test_forms_pdf_to_survey.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
FIXTURE = PROJECT_ROOT / "tests" / "fixtures" / "情景-沉沦的欲望.pdf"
sys.path.insert(0, str(SCRIPT_DIR))

from forms_pdf_to_survey import run_pipeline  # noqa: E402


class SemanticPdfParserRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not FIXTURE.exists():
            raise FileNotFoundError(f"missing regression fixture: {FIXTURE}")
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.output_dir = Path(cls.tempdir.name)
        cls.output = run_pipeline(str(FIXTURE), cls.output_dir)
        cls.document = json.loads(
            (cls.output_dir / "document.json").read_text(encoding="utf-8")
        )
        cls.survey = json.loads(
            (cls.output_dir / "survey.json").read_text(encoding="utf-8")
        )
        cls.report = json.loads(
            (cls.output_dir / "import-report.json").read_text(encoding="utf-8")
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tempdir.cleanup()

    def questions(self):
        return self.survey["survey"]["questions"]

    def test_question_numbers_and_order(self) -> None:
        questions = self.questions()
        self.assertEqual(
            [question["source_number"] for question in questions],
            [1, 2, 3, 4, 5, 6],
        )
        self.assertEqual(
            [question["order"] for question in questions],
            [1, 2, 3, 4, 5, 6],
        )

    def test_option_counts_and_labels(self) -> None:
        questions = {q["source_number"]: q for q in self.questions()}
        self.assertEqual(len(questions[1]["options"]), 4)
        self.assertEqual(
            [option["label"] for option in questions[1]["options"]],
            ["A", "B", "C", "D"],
        )
        self.assertEqual(len(questions[2]["options"]), 2)
        self.assertEqual(
            [option["label"] for option in questions[2]["options"]],
            ["是", "否"],
        )
        self.assertEqual(len(questions[3]["options"]), 0)
        self.assertEqual(len(questions[4]["options"]), 5)
        self.assertEqual(len(questions[5]["options"]), 3)
        self.assertEqual(len(questions[6]["options"]), 0)

    def test_types_and_open_questions(self) -> None:
        questions = {q["source_number"]: q for q in self.questions()}
        self.assertEqual(questions[1]["type"], "single")
        self.assertEqual(questions[2]["type"], "yes_no")
        self.assertEqual(questions[3]["type"], "long_text")
        self.assertEqual(questions[4]["type"], "rating")
        self.assertEqual(questions[5]["type"], "multiple")
        self.assertEqual(questions[6]["type"], "long_text")
        self.assertEqual(questions[3]["options"], [])
        self.assertEqual(questions[6]["options"], [])

    def test_long_option_continuation(self) -> None:
        questions = {q["source_number"]: q for q in self.questions()}
        option = questions[5]["options"][0]
        self.assertIn("\n", option["text"])
        self.assertGreater(len(option["text_lines"]), 1)

    def test_page_ranges_and_forms_page_mapping(self) -> None:
        questions = {q["source_number"]: q for q in self.questions()}
        self.assertEqual(questions[1]["source_page_start"], 1)
        self.assertEqual(questions[1]["source_page_end"], 1)
        self.assertEqual(questions[3]["source_page_start"], 2)
        self.assertEqual(questions[3]["source_page_end"], 2)
        self.assertEqual(questions[6]["source_page_start"], 3)
        self.assertEqual(questions[6]["source_page_end"], 3)
        self.assertTrue(
            all(page.get("forms_page_id") is None for page in self.document["pages"])
        )

    def test_image_extraction_and_assets(self) -> None:
        self.assertGreaterEqual(len(self.document["image_resources"]), 2)
        self.assertEqual(len(self.document["image_instances"]), 3)
        assets_dir = self.output_dir / "assets"
        assets = list(assets_dir.glob("*"))
        self.assertTrue(assets)
        self.assertTrue(all(asset.stat().st_size > 0 for asset in assets))

    def test_media_association(self) -> None:
        questions = {q["source_number"]: q for q in self.questions()}
        self.assertGreaterEqual(len(questions[1]["media"]), 1)
        self.assertGreaterEqual(len(questions[5]["media"]), 1)
        self.assertEqual(self.report["question_media_count"], 2)
        self.assertEqual(self.report["option_media_count"], 0)
        self.assertGreaterEqual(len(self.report["unattached_media"]), 1)

    def test_uncertainty_is_reported(self) -> None:
        low_ids = {item["id"] for item in self.report["low_confidence_questions"]}
        questions = {q["source_number"]: q for q in self.questions()}
        self.assertIn(questions[3]["id"], low_ids)
        self.assertIn(questions[6]["id"], low_ids)

    def test_header_footer_and_number_integrity(self) -> None:
        self.assertGreater(self.report["header_lines_removed"], 0)
        self.assertGreater(self.report["footer_lines_removed"], 0)
        self.assertEqual(self.report["missing_question_numbers"], [])
        self.assertEqual(self.report["duplicate_question_numbers"], [])

    def test_required_is_not_defaulted(self) -> None:
        questions = {q["source_number"]: q for q in self.questions()}
        self.assertTrue(questions[1]["required"])
        self.assertIsNone(questions[2]["required"])
        self.assertGreaterEqual(questions[1]["required_confidence"], 0.7)


if __name__ == "__main__":
    unittest.main(verbosity=2)
