"""URL-based survey importer (Microsoft Forms / OneDrive / SharePoint / PDF).

This package reuses ``scripts/forms_pdf_to_survey.py`` for PDF parsing and
emits the exact same survey.json structure the web admin import accepts.
"""

from .url_importer import ImportResult, import_survey_from_url

__all__ = ["ImportResult", "import_survey_from_url"]
