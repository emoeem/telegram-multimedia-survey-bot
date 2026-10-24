"""Structured errors shared by the URL importer layers."""

from __future__ import annotations


class SurveyImportError(Exception):
    """An import failure with a stable machine-readable code.

    Codes follow the naming used by the web admin API (e.g. HTTP_404,
    DOCUMENT_REQUIRES_AUTH) so both channels surface the same vocabulary.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: object = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def __str__(self) -> str:
        return self.message
