#!/usr/bin/env python3
"""Real Microsoft Forms PDF regression.

Run with:
    .venv/bin/python scripts/test_forms_pdf_regression.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
REAL_PDF = Path("/home/emo/Downloads/情景-沉沦的欲望.pdf")
sys.path.insert(0, str(SCRIPT_DIR))

from forms_pdf_to_survey import run_pipeline  # noqa: E402


@unittest.skipUnless(REAL_PDF.exists(), f"real fixture not found: {REAL_PDF}")
class RealFormsPdfRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.output_dir = Path(cls.tempdir.name)
        cls.output = run_pipeline(str(REAL_PDF), cls.output_dir)
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

    def test_question_number_integrity(self) -> None:
        numbers = [q["source_number"] for q in self.survey["questions"]]
        self.assertEqual(numbers, list(range(1, 94)))
        self.assertEqual(self.report["missing_question_numbers"], [])
        self.assertEqual(self.report["duplicate_question_numbers"], [])

    def test_required_pages(self) -> None:
        self.assertEqual(self.document["page_count"], 15)
        self.assertEqual(self.report["forms_pages"], 0)
        self.assertTrue(
            any(
                warning == "forms_page_detection_not_available"
                for warning in self.report["page_mapping_warnings"]
            )
        )

    def test_representative_questions(self) -> None:
        questions = {q["source_number"]: q for q in self.survey["questions"]}
        for number in [1, 2, 3, 5, 46, 47, 84, 90, 93]:
            self.assertIn(number, questions)
        self.assertEqual(len(questions[3]["options"]), 4)
        self.assertEqual(len(questions[5]["options"]), 4)
        self.assertEqual(questions[90]["type"], "yes_no")
        self.assertEqual(
            [option["text"].lower() for option in questions[90]["options"]],
            ["yes", "no"],
        )
        self.assertEqual(questions[79]["options"], [])
        self.assertEqual(questions[93]["options"], [])

    def test_unlabeled_options_are_generated(self) -> None:
        questions = {q["source_number"]: q for q in self.survey["questions"]}
        self.assertEqual(len(questions[82]["options"]), 7)
        self.assertEqual(len(questions[83]["options"]), 5)
        self.assertEqual(len(questions[84]["options"]), 8)
        self.assertTrue(
            all(
                option["label_source"] == "generated"
                for option in questions[82]["options"]
            )
        )

    def test_missing_explicit_option_label(self) -> None:
        questions = {q["source_number"]: q for q in self.survey["questions"]}
        self.assertEqual(len(questions[56]["options"]), 4)
        self.assertEqual(questions[56]["options"][-1]["label"], "D")
        self.assertEqual(questions[56]["options"][-1]["label_source"], "generated")

    def test_question_media_regression(self) -> None:
        questions = {q["source_number"]: q for q in self.survey["questions"]}
        expected = {
            1: 1,
            7: 1,
            27: 1,
            32: 1,
            43: 1,
            50: 1,
            53: 1,
            59: 1,
            61: 1,
            70: 1,
            75: 1,
            84: 1,
            85: 1,
            87: 2,
        }
        for number, count in expected.items():
            self.assertEqual(
                len(questions[number]["media"]),
                count,
                f"question media count for Q{number}",
            )
        self.assertEqual(self.report["question_media_count"], 15)

    def test_option_media_is_zero(self) -> None:
        self.assertEqual(self.report["option_media_count"], 0)

    def test_rating_is_not_invented(self) -> None:
        self.assertEqual(self.report["question_type_counts"].get("rating", 0), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
