"""AM Storage Company — high-concurrency FastAPI Storage Bridge.

This package is the public API boundary for gramunnayan.com. It validates the
dashboard-managed Custom API Keys, streams multipart PDFs into private Cloudflare
R2 with its own credentials, and registers document metadata through the AM
Storage gateway. Client websites never see R2 (or Firestore) credentials.
"""
