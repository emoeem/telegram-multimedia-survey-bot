#!/usr/bin/env python3
"""Tests for the URL survey importer (scripts/survey_import).

Run with:
    uv run python scripts/test_import_survey_from_url.py
"""

from __future__ import annotations

import http.server
import json
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from urllib.parse import urlparse
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
FIXTURE_PDF = PROJECT_ROOT / "tests" / "fixtures" / "情景-沉沦的欲望.pdf"
sys.path.insert(0, str(SCRIPT_DIR))

from survey_import.document import download_document  # noqa: E402
from survey_import.errors import SurveyImportError  # noqa: E402
from survey_import.microsoft import (  # noqa: E402
    forms_definition_to_survey,
    is_forms_url,
    is_onedrive_or_sharepoint_url,
    resolve_download_url,
)
from survey_import.schema import validate_survey_json  # noqa: E402
from survey_import.url_importer import import_survey_from_url, run_cli  # noqa: E402


SAMPLE_FORM_DEFINITION = {
    "id": "form-1",
    "title": "测试问卷",
    "description": "测试描述",
    "questions": [
        {
            "id": "q1",
            "type": "Question.Choice",
            "title": "您的性别？",
            "required": True,
            "order": 1000500,
            "questionInfo": json.dumps(
                {
                    "Choices": [
                        {"Description": "男"},
                        {"Description": "女"},
                    ],
                    "ChoiceType": 1,
                    "AllowOtherAnswer": False,
                }
            ),
            "image": {
                "resourceUrl": "https://example.invalid/img.png",
                "contentType": "image/png",
                "width": 100,
                "height": 50,
            },
        },
        {
            "id": "q2",
            "type": "Question.Choice",
            "title": "请选择喜欢的颜色（多选）",
            "required": False,
            "order": 2000500,
            "allowMultipleValues": True,
            "questionInfo": json.dumps(
                {
                    "Choices": [
                        {"Description": "红"},
                        {"Description": "蓝"},
                        {"Description": "绿"},
                    ],
                    "ChoiceType": 3,
                    "AllowOtherAnswer": True,
                    "ChoiceRestrictionType": "AtLeast",
                    "ChoiceMinBoundary": 2,
                }
            ),
        },
        {
            "id": "q3",
            "type": "Question.Choice",
            "title": "是否满意？",
            "required": True,
            "order": 3000500,
            "questionInfo": json.dumps(
                {
                    "Choices": [
                        {"Description": "是"},
                        {"Description": "否"},
                    ],
                    "ChoiceType": 1,
                    "AllowOtherAnswer": False,
                }
            ),
        },
        {
            "id": "q4",
            "type": "Question.TextField",
            "title": "请填写建议",
            "subtitle": "选填",
            "required": False,
            "order": 4000500,
            "questionInfo": json.dumps({"Multiline": True}),
        },
        {
            "id": "q5",
            "type": "Question.Rating",
            "title": "打分",
            "required": True,
            "order": 5000500,
            "questionInfo": json.dumps({"Length": 5}),
        },
    ],
}


SAMPLE_FORM_PAGE = """<!doctype html><html><head><title>Microsoft Forms</title></head><body>
<script type="text/javascript">
window.OfficeFormServerInfo = {"antiForgeryToken":"tok","serverSessionId":"sess","prefetchFormUrl":"http://127.0.0.1:__API_PORT__/formapi"};
</script>
</body></html>"""


def _minimal_docx_bytes() -> bytes:
    buffer = tempfile.SpooledTemporaryFile()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
        )
        archive.writestr(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
        )
        paragraphs = "".join(
            f'<w:p><w:r><w:t xml:space="preserve">{line}</w:t></w:r></w:p>'
            for line in [
                "问卷调查",
                "1. 您的性别是？",
                "A. 男",
                "B. 女",
            ]
        )
        archive.writestr(
            "word/document.xml",
            f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{paragraphs}</w:body>
</w:document>""",
        )
    buffer.seek(0)
    return buffer.read()


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    fixtures: dict[str, tuple[bytes, str]] = {}

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/slow":
            time.sleep(1.5)
        fixture = self.fixtures.get(path)
        if fixture is None:
            self.send_response(404)
            self.end_headers()
            return
        body, content_type = fixture
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command == "GET":
            self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


class FixtureServer:
    def __init__(self, fixtures: dict[str, tuple[bytes, str]]) -> None:
        self._httpd = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            FixtureHandler,
        )
        FixtureHandler.fixtures = fixtures
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            daemon=True,
        )

    def __enter__(self) -> "FixtureServer":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"


class UrlResolutionTests(unittest.TestCase):
    def test_valid_and_invalid_urls(self) -> None:
        with self.assertRaises(SurveyImportError) as ctx:
            import_survey_from_url("")
        self.assertEqual(ctx.exception.code, "INVALID_URL")
        with self.assertRaises(SurveyImportError) as ctx:
            import_survey_from_url("not-a-url")
        self.assertEqual(ctx.exception.code, "INVALID_URL")
        with self.assertRaises(SurveyImportError) as ctx:
            import_survey_from_url("ftp://example.com/file.pdf")
        self.assertEqual(ctx.exception.code, "INVALID_URL")

    def test_forms_url_detection(self) -> None:
        self.assertTrue(is_forms_url("https://forms.office.com/r/abc123"))
        self.assertTrue(
            is_forms_url(
                "https://forms.cloud.microsoft/pages/responsepage.aspx?id=x"
            )
        )
        self.assertTrue(is_forms_url("https://forms.microsoft.com/Pages/ResponsePage.aspx?id=x"))
        self.assertFalse(is_forms_url("https://example.com/r/abc123"))

    def test_onedrive_and_sharepoint_detection(self) -> None:
        self.assertTrue(is_onedrive_or_sharepoint_url("https://1drv.ms/abc"))
        self.assertTrue(
            is_onedrive_or_sharepoint_url(
                "https://onedrive.live.com/redir?resid=x&authkey=y"
            )
        )
        self.assertTrue(
            is_onedrive_or_sharepoint_url(
                "https://contoso.sharepoint.com/:w:/r/sites/x/doc.docx?e=abc"
            )
        )
        self.assertFalse(is_onedrive_or_sharepoint_url("https://example.com/file.docx"))

    def test_download_param_appended(self) -> None:
        resolved = resolve_download_url(
            "https://contoso.sharepoint.com/:w:/r/sites/x/doc.docx?e=abc"
        )
        self.assertIn("download=1", resolved.url)
        self.assertEqual(resolved.source_kind, "sharepoint")

        resolved = resolve_download_url(
            "https://onedrive.live.com/redir?resid=x&authkey=y"
        )
        self.assertIn("download=1", resolved.url)
        self.assertEqual(resolved.source_kind, "onedrive")

        already = resolve_download_url(
            "https://onedrive.live.com/download?resid=x&authkey=y&download=1"
        )
        self.assertEqual(already.url.count("download=1"), 1)

    def test_office_online_src_extracted(self) -> None:
        resolved = resolve_download_url(
            "https://officeapps.live.com/op/view.aspx?src="
            "https%3A%2F%2Fcontoso.sharepoint.com%2F%3Aw%3A%2Fr%2Fsites%2Fx%2Fdoc.docx"
        )
        self.assertIn("contoso.sharepoint.com", resolved.url)
        self.assertIn("download=1", resolved.url)
        self.assertEqual(resolved.source_kind, "office_online")


class DownloadTests(unittest.TestCase):
    def test_pdf_download_200(self) -> None:
        pdf_bytes = FIXTURE_PDF.read_bytes() if FIXTURE_PDF.exists() else b"%PDF-1.4 fake"
        with FixtureServer({"/form.pdf": (pdf_bytes, "application/pdf")}) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                path, content_type, kind = download_document(
                    server.url("/form.pdf"),
                    Path(temp_dir),
                )
                self.assertEqual(kind, "pdf")
                self.assertIn("application/pdf", content_type)
                self.assertEqual(path.read_bytes(), pdf_bytes)

    def test_http_404(self) -> None:
        with FixtureServer({}) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                with self.assertRaises(SurveyImportError) as ctx:
                    download_document(server.url("/missing.pdf"), Path(temp_dir))
                self.assertEqual(ctx.exception.code, "HTTP_404")

    def test_http_403(self) -> None:
        class ForbiddenHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(403)
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ForbiddenHandler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                with self.assertRaises(SurveyImportError) as ctx:
                    download_document(f"http://127.0.0.1:{port}/x.pdf", Path(temp_dir))
                self.assertEqual(ctx.exception.code, "HTTP_403")
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_timeout(self) -> None:
        with FixtureServer({"/slow": (b"x", "application/octet-stream")}) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                with self.assertRaises(SurveyImportError) as ctx:
                    download_document(
                        server.url("/slow"),
                        Path(temp_dir),
                        timeout=0.2,
                    )
                self.assertEqual(ctx.exception.code, "NETWORK_ERROR")

    def test_html_response_is_unsupported_format(self) -> None:
        with FixtureServer({"/doc": (b"<html>sign in</html>", "text/html")}) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                with self.assertRaises(SurveyImportError) as ctx:
                    import_survey_from_url(
                        server.url("/doc"),
                        output_dir=Path(temp_dir),
                    )
                self.assertEqual(ctx.exception.code, "UNSUPPORTED_FORMAT")


class FormsExtractionTests(unittest.TestCase):
    def test_forms_definition_conversion(self) -> None:
        survey = forms_definition_to_survey(SAMPLE_FORM_DEFINITION)
        self.assertEqual(survey["schema_version"], 1)
        self.assertEqual(survey["survey"]["title"], "测试问卷")
        self.assertEqual(
            survey["survey"]["metadata"]["source"],
            "microsoft_forms",
        )
        self.assertEqual(validate_survey_json(survey), [])

        questions = {q["id"]: q for q in survey["survey"]["questions"]}
        self.assertEqual(questions["q1"]["type"], "single")
        self.assertEqual(
            [option["value"] for option in questions["q1"]["options"]],
            ["男", "女"],
        )
        self.assertEqual(questions["q1"]["required"], True)
        self.assertEqual(questions["q1"]["media"][0]["url"], "https://example.invalid/img.png")

        self.assertEqual(questions["q2"]["type"], "multiple")
        self.assertEqual(
            [option["value"] for option in questions["q2"]["options"]],
            ["红", "蓝", "绿", "其他"],
        )
        self.assertEqual(questions["q2"]["validation"]["min_selections"], 2)

        self.assertEqual(questions["q3"]["type"], "yes_no")
        self.assertEqual(
            [option["value"] for option in questions["q3"]["options"]],
            ["是", "否"],
        )

        self.assertEqual(questions["q4"]["type"], "long_text")
        self.assertEqual(questions["q4"]["description"], "选填")

        self.assertEqual(questions["q5"]["type"], "rating")
        self.assertEqual(
            [option["value"] for option in questions["q5"]["options"]],
            ["1", "2", "3", "4", "5"],
        )

    def test_forms_end_to_end(self) -> None:
        definition = json.dumps(SAMPLE_FORM_DEFINITION, ensure_ascii=False).encode(
            "utf-8"
        )
        page = SAMPLE_FORM_PAGE.encode("utf-8")

        with FixtureServer(
            {
                "/form": (page, "text/html; charset=utf-8"),
                "/formapi": (definition, "application/json; charset=utf-8"),
            }
        ) as server:
            page = page.replace(b"__API_PORT__", str(server.port).encode())
            FixtureHandler.fixtures["/form"] = (page, "text/html; charset=utf-8")
            with patch("survey_import.url_importer.is_forms_url", return_value=True):
                with tempfile.TemporaryDirectory() as temp_dir:
                    result = import_survey_from_url(
                        server.url("/form"),
                        output_dir=Path(temp_dir),
                    )
                    self.assertEqual(result.source_kind, "microsoft_forms")
                    self.assertEqual(result.question_count, 5)
                    self.assertEqual(result.title, "测试问卷")
                    self.assertTrue(result.output_path.is_file())
                    saved = json.loads(result.output_path.read_text(encoding="utf-8"))
                    self.assertEqual(validate_survey_json(saved), [])


class PdfImportRegressionTests(unittest.TestCase):
    @unittest.skipUnless(FIXTURE_PDF.exists(), "PDF fixture missing")
    def test_direct_pdf_url_import_matches_pipeline(self) -> None:
        pdf_bytes = FIXTURE_PDF.read_bytes()
        with FixtureServer({"/form.pdf": (pdf_bytes, "application/pdf")}) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                result = import_survey_from_url(
                    server.url("/form.pdf"),
                    output_dir=Path(temp_dir),
                )
                self.assertEqual(result.source_kind, "pdf")
                self.assertGreater(result.question_count, 0)
                saved = json.loads(result.output_path.read_text(encoding="utf-8"))
                self.assertEqual(validate_survey_json(saved), [])
                # Reuse the pipeline directly and compare the survey core.
                from forms_pdf_to_survey import run_pipeline

                pipeline_dir = Path(temp_dir) / "pipeline"
                run_pipeline(str(FIXTURE_PDF), pipeline_dir)
                pipeline_survey = json.loads(
                    (pipeline_dir / "survey.json").read_text(encoding="utf-8")
                )
                self.assertEqual(
                    saved["survey"]["title"],
                    pipeline_survey["survey"]["title"],
                )
                self.assertEqual(
                    len(saved["survey"]["questions"]),
                    len(pipeline_survey["survey"]["questions"]),
                )

    @unittest.skipUnless(
        __import__("shutil").which("soffice") or __import__("shutil").which("libreoffice"),
        "LibreOffice not installed",
    )
    def test_office_document_converted_and_imported(self) -> None:
        docx_bytes = _minimal_docx_bytes()
        with FixtureServer(
            {"/survey.docx": (docx_bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
        ) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                result = import_survey_from_url(
                    server.url("/survey.docx"),
                    output_dir=Path(temp_dir),
                )
                self.assertEqual(result.source_kind, "office")
                self.assertGreaterEqual(result.question_count, 1)
                saved = json.loads(result.output_path.read_text(encoding="utf-8"))
                self.assertEqual(validate_survey_json(saved), [])

    def test_json_url_import(self) -> None:
        survey = {
            "schema_version": 1,
            "survey": {
                "title": "JSON 问卷",
                "questions": [
                    {
                        "id": "jq1",
                        "type": "single",
                        "title": "测试",
                        "required": True,
                        "options": [
                            {"id": "o1", "label": "1", "text": "A", "value": "A", "order": 1, "media": []},
                            {"id": "o2", "label": "2", "text": "B", "value": "B", "order": 2, "media": []},
                        ],
                        "media": [],
                    }
                ],
            },
        }
        with FixtureServer(
            {"/survey.json": (json.dumps(survey).encode(), "application/json")}
        ) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                result = import_survey_from_url(
                    server.url("/survey.json"),
                    output_dir=Path(temp_dir),
                )
                self.assertEqual(result.source_kind, "json")
                self.assertEqual(result.question_count, 1)


class SchemaValidationTests(unittest.TestCase):
    def test_valid_survey_passes(self) -> None:
        survey = forms_definition_to_survey(SAMPLE_FORM_DEFINITION)
        self.assertEqual(validate_survey_json(survey), [])

    def test_invalid_surveys_report_issues(self) -> None:
        base = forms_definition_to_survey(SAMPLE_FORM_DEFINITION)

        bad_version = json.loads(json.dumps(base))
        bad_version["schema_version"] = 2
        self.assertTrue(validate_survey_json(bad_version))

        no_title = json.loads(json.dumps(base))
        no_title["survey"]["title"] = ""
        self.assertTrue(validate_survey_json(no_title))

        empty_questions = json.loads(json.dumps(base))
        empty_questions["survey"]["questions"] = []
        self.assertTrue(validate_survey_json(empty_questions))

        bad_type = json.loads(json.dumps(base))
        bad_type["survey"]["questions"][0]["type"] = "not_a_type"
        issues = validate_survey_json(bad_type)
        self.assertTrue(any("type must be one of" in issue for issue in issues))

        bad_matrix = json.loads(json.dumps(base))
        bad_matrix["survey"]["questions"][0] = {
            "id": "m1",
            "type": "matrix",
            "title": "矩阵",
            "required": True,
            "options": [{"id": "r1", "label": "1", "text": "行", "value": "行", "media": []}],
            "media": [],
            "settings": {"columns": ["仅一列"]},
        }
        issues = validate_survey_json(bad_matrix)
        self.assertTrue(any("matrix questions require" in issue for issue in issues))

        relative_media = json.loads(json.dumps(base))
        relative_media["survey"]["questions"][0]["media"] = [
            {
                "id": "m1",
                "type": "photo",
                "source": "url",
                "url": "assets/img.png",
            }
        ]
        issues = validate_survey_json(relative_media)
        self.assertTrue(any("相对路径" in issue for issue in issues))

        absolute_media = json.loads(json.dumps(base))
        absolute_media["survey"]["questions"][0]["media"] = [
            {
                "id": "m1",
                "type": "photo",
                "source": "url",
                "url": "data:image/png;base64,aGVsbG8=",
            }
        ]
        self.assertEqual(validate_survey_json(absolute_media), [])


class CliTests(unittest.TestCase):
    def test_cli_success_and_failure(self) -> None:
        cli_survey = {
            "schema_version": 1,
            "survey": {
                "title": "CLI 测试",
                "questions": [
                    {
                        "id": "q1",
                        "type": "text",
                        "title": "问题",
                        "required": True,
                        "options": [],
                        "media": [],
                    }
                ],
            },
        }
        with FixtureServer(
            {
                "/survey.json": (
                    json.dumps(cli_survey, ensure_ascii=False).encode("utf-8"),
                    "application/json",
                )
            }
        ) as server:
            with tempfile.TemporaryDirectory() as temp_dir:
                output = Path(temp_dir) / "out.json"
                code = run_cli(
                    [server.url("/survey.json"), "--output", str(output)]
                )
                self.assertEqual(code, 0)
                self.assertTrue(output.is_file())

        code = run_cli(["not-a-url"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
