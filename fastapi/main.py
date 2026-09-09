"""Backwards-compatible entry point for the AM Storage Bridge.

Run from the fastapi/ directory:

    uvicorn main:app --host 0.0.0.0 --port 8000

The application code lives in the app/ package (see fastapi/README.md).
"""
import app.main as _main

app = _main.app
